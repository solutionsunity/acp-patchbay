// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Agents are developer-env, not code-env: stored in the machine store
// (file-kv.ts),
// never a repo-committed file, visible everywhere on this machine.
// Deliberately global-only — per-workspace binding may return later as an
// opt-in (workspaces, not repos), but until then one visibility rule, no
// scope machinery.
import { z } from "zod";
import { MODE_KNOB_ID } from "../knobs";
import type { PatchbayAgentId } from "../../shared/ids";
import { savedId } from "./saved-id";
import { NamedRecordStore } from "./global-record-store";
import type { KV } from "./kv";
import { STORAGE_KEYS } from "./storage-keys";

/** `options` is keyed by knob id (the agent's own config-option id, or
 * knobs.ts's MODE_KNOB_ID on the modes-fallback surface), never by semantic
 * category — ACP defines category as UX-only, forbidden as a correctness
 * dependency. (Supersedes the earlier {model, mode, effort} triple, which
 * required categories to map back to options.) */
const agentDefaultsSchema = z.object({
  // boolean covers boolean-typed options (a thinking toggle); the wire call
  // (session/set_config_option) carries both shapes natively.
  options: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
});

const envSchema = z.record(z.string(), z.string());

/** A registry agent's link: the version it is pinned to — what the update
 * fact compares against the registry's latest — and the registry's recipe
 * for it. Linked to the registry entry its agent's `origin` names.
 *
 * `distribution`: the registry's recipe for the pinned version on this
 * machine's platform, exactly as the registry published it — kept because
 * the registry lists only each agent's latest version, so once it moves on
 * this copy is the only record of what the agent was added or upgraded
 * from. Written whole with the link it belongs to, whenever a link is
 * written; never edited. Absent on records written before it was kept. A `binary`
 * one carries the archive a connect (re)acquires the executable from, and
 * the archive's `sha256` when one was published — the copy a re-download
 * is checked against once the registry has moved on. Its `args` and `env`
 * are absent on records written while only the archive was kept —
 * unknown, never assumed empty. */
const pinnedVersion = { pinnedVersion: z.string().min(1) };
const agentLinkSchema = z.discriminatedUnion("distributionKind", [
  z.object({
    ...pinnedVersion,
    distributionKind: z.enum(["npx", "uvx"]),
    distribution: z.object({ package: z.string().min(1), args: z.array(z.string()), env: envSchema }).optional(),
  }),
  z.object({
    ...pinnedVersion,
    distributionKind: z.literal("binary"),
    distribution: z
      .object({
        archive: z.string().min(1),
        cmd: z.string().min(1),
        args: z.array(z.string()).optional(),
        env: envSchema.optional(),
        sha256: z.string().optional(),
      })
      .optional(),
  }),
]);

export const agentConfigSchema = z.object({
  id: savedId<PatchbayAgentId>(),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  // No env here on purpose: env values are how agents commonly take API
  // keys, so they live in SecretStorage (stores/secret-env.ts), joined onto
  // the LaunchSpec at spawn time — never in the machine store.
  /** Connect this agent when a window opens (orchestrator's
   * connectStartupAgents). Per-agent and opt-in — superseded the native
   * `acpPatchbay.defaultAgent` setting, whose only semantic this generalizes. */
  autoConnect: z.boolean().default(false),
  defaults: agentDefaultsSchema.default({}),
  /** The ACP registry entry the agent was added from — kept through an
   * edit of its command, the way back to the registry (Reset). Null for an
   * agent added as a custom command. */
  origin: z.string().min(1).nullable().default(null),
  /** Null once the command was edited: what was typed is what runs, and no
   * Upgrade writes the registry's line over it. Never set without an
   * `origin`. */
  link: agentLinkSchema.nullable().default(null),
  /** The link an Upgrade replaced — one level back, an exact rollback since
   * it holds the old recipe whole. Cleared once used, by an edit, and
   * replaced by the next Upgrade. Kept only when its recipe rebuilds the
   * launch. */
  previous: agentLinkSchema.nullable().default(null),
  /** `agentInfo.version` last captured at connect — the version-keyed
   * used-capability cache (capability-tracker.ts) is seeded against
   * this, not against `link.pinnedVersion`: reality (the version that
   * actually answered `initialize`) is the source of truth, the pinned
   * version is only what we asked for. The two are different naming
   * schemes (a registry `0.36.0` may report `0.36.0 (commit 7c61e5bb)`),
   * so they are shown side by side, never compared. */
  lastSeenVersion: z.string().nullable().default(null),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentLink = z.infer<typeof agentLinkSchema>;

const KEY = STORAGE_KEYS.agents;

/** Two agents from one executable or one registry entry are told apart by
 * name: no two agents hold one. */
export class AgentConfigStore extends NamedRecordStore<AgentConfig> {
  /** Every record goes — the earlier version's copy with them. */
  override async wipe(): Promise<void> {
    await super.wipe();
    await this.machine.update(STORAGE_KEYS.agentsBefore090, undefined);
  }

  private readonly machine: KV;

  constructor(kv: KV) {
    super(kv, KEY, agentConfigSchema);
    this.machine = kv;
    // Once, at construction: the agents as an earlier version kept them are
    // copied, never moved — a window still on that version keeps its own
    // key, and writes there never reach this one. The migrations below take
    // the copy to the current shape.
    const earlier = kv.get<unknown>(STORAGE_KEYS.agentsBefore090);
    if (kv.get<unknown>(KEY) === undefined && earlier !== undefined) void kv.update(KEY, earlier);
    // Once, at construction: records from when each agent carried a process
    // policy lose that field — an agent now has one process per window,
    // holding all its sessions, so nothing reads it. Only that key goes;
    // every other part of every record stays exactly as stored.
    const stored = kv.get<unknown>(KEY);
    const hasPolicy = (r: unknown): r is Record<string, unknown> =>
      typeof r === "object" && r !== null && "processPolicy" in r;
    if (Array.isArray(stored) && stored.some(hasPolicy)) {
      void kv.update(
        KEY,
        stored.map((r: unknown) => {
          if (!hasPolicy(r)) return r;
          const { processPolicy: _retired, ...rest } = r;
          return rest;
        }),
      );
    }
    // Once, at construction: defaults saved before every knob was keyed by
    // its id carry a mode as a field of its own, `defaults.mode` — rewritten
    // under the mode knob's id in `options`, where an option set explicitly
    // for that id still wins. Read as it was, the mode would be dropped.
    const current = kv.get<unknown>(KEY);
    const withMode = (r: unknown): r is { defaults: { mode: string; options?: Record<string, unknown> } } =>
      typeof r === "object" &&
      r !== null &&
      "defaults" in r &&
      typeof r.defaults === "object" &&
      r.defaults !== null &&
      "mode" in r.defaults &&
      typeof r.defaults.mode === "string";
    if (Array.isArray(current) && current.some(withMode)) {
      void kv.update(
        KEY,
        current.map((r: unknown) => {
          if (!withMode(r)) return r;
          const { mode, ...defaults } = r.defaults;
          const options = mode === "" ? defaults.options : { [MODE_KNOB_ID]: mode, ...defaults.options };
          return { ...r, defaults: { ...defaults, ...(options === undefined ? {} : { options }) } };
        }),
      );
    }
    // Once, at construction: a binary agent from when only its archive was
    // kept carries it as `registrySource.binary` ({archiveUrl, cmd,
    // sha256}) — moved to `distribution` under the registry's own names.
    // Read as it was, the archive would be dropped.
    const linked = kv.get<unknown>(KEY);
    const withArchive = (
      r: unknown,
    ): r is { registrySource: { binary: { archiveUrl: string; cmd: string; sha256?: string } } } =>
      typeof r === "object" &&
      r !== null &&
      "registrySource" in r &&
      typeof r.registrySource === "object" &&
      r.registrySource !== null &&
      "binary" in r.registrySource;
    if (Array.isArray(linked) && linked.some(withArchive)) {
      void kv.update(
        KEY,
        linked.map((r: unknown) => {
          if (!withArchive(r)) return r;
          const { binary, ...source } = r.registrySource;
          const { archiveUrl, ...rest } = binary;
          return { ...r, registrySource: { ...source, distribution: { archive: archiveUrl, ...rest } } };
        }),
      );
    }
    // Once, at construction: `registrySource` held two facts in one field —
    // where the agent came from and the version it is pinned to — so an
    // edit, dropping the pin, dropped the origin with it. Split into
    // `origin` (its registry id) and `link` (the rest). An agent edited
    // before the split has no source left: it stays custom — never guessed
    // back from its id, which can predate the registry's naming.
    const sourced = kv.get<unknown>(KEY);
    const withSource = (r: unknown): r is { registrySource: unknown } =>
      typeof r === "object" && r !== null && "registrySource" in r;
    if (Array.isArray(sourced) && sourced.some(withSource)) {
      void kv.update(
        KEY,
        sourced.map((r: unknown) => {
          if (!withSource(r)) return r;
          const { registrySource, ...rest } = r;
          if (typeof registrySource !== "object" || registrySource === null || !("registryId" in registrySource)) {
            return { ...rest, origin: null, link: null };
          }
          const { registryId, ...link } = registrySource;
          return { ...rest, origin: registryId, link };
        }),
      );
    }
  }
}
