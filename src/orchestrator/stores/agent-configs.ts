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

/** Present only when this config was created from the official ACP agent
 * registry — the pinned version drives the update fact (the upgrade chip)
 * and is what gets re-resolved on Upgrade. Absent for custom commands. */
const agentRegistrySourceSchema = z.object({
  registryId: z.string().min(1),
  distributionKind: z.enum(["npx", "uvx", "binary"]),
  pinnedVersion: z.string().min(1),
  /** `binary` kind: the archive the pinned version is downloaded from and
   * the executable's path inside it — what a connect needs to (re)acquire
   * the binary as a launch phase. Absent on records written before this
   * field existed: those spawn their recorded absolute `command` as is.
   * `sha256`: the archive's digest as the registry published it for this
   * version — kept because the registry lists only the latest version, so
   * once it moves on this copy is the only one left to check a
   * re-download against. Replaced whole with the rest at Upgrade. */
  binary: z
    .object({ archiveUrl: z.string().min(1), cmd: z.string().min(1), sha256: z.string().optional() })
    .optional(),
});

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
  registrySource: agentRegistrySourceSchema.nullable().default(null),
  /** `agentInfo.version` last captured at connect — the version-keyed
   * used-capability cache (capability-tracker.ts) is seeded against
   * this, not against `registrySource.pinnedVersion`: reality (the version
   * that actually answered `initialize`) is the source of truth, the pinned
   * version is only what we asked for. */
  lastSeenVersion: z.string().nullable().default(null),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

const KEY = "acpPatchbay.agents";

/** Two agents from one executable or one registry entry are told apart by
 * name: an add takes a name no other agent holds. */
export class AgentConfigStore extends NamedRecordStore<AgentConfig> {
  constructor(kv: KV) {
    super(kv, KEY, agentConfigSchema);
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
  }
}
