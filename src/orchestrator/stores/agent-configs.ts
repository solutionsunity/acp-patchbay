// Agents are developer-env, not code-env: stored in context.globalState,
// never a repo-committed file, visible everywhere on this machine.
// Deliberately global-only — per-workspace binding may return later as an
// opt-in (workspaces, not repos), but until then one visibility rule, no
// scope machinery.
import { z } from "zod";
import { GlobalRecordStore } from "./global-record-store";
import type { KV } from "./kv";

/** `options` is keyed by knob id (the agent's own config-option id, or
 * knobs.ts's MODE_KNOB_ID on the modes-fallback surface), never by semantic
 * category — ACP defines category as UX-only, forbidden as a correctness
 * dependency. `mode` is legacy-read-only: folded into the seed on read
 * (knobs.ts foldSeed), never written again — new saves carry `options`
 * alone. (Supersedes the earlier {model, mode, effort} triple, which
 * required categories to map back to options.) */
export const agentDefaultsSchema = z.object({
  mode: z.string().optional(),
  // boolean covers boolean-typed options (a thinking toggle); the wire call
  // (session/set_config_option) carries both shapes natively.
  options: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
});

/** Present only when this config was created from the official ACP agent
 * registry — the pinned version drives the "update available" badge and is
 * what gets re-resolved on Upgrade. Absent for custom commands and for the
 * local-only roster entries the registry doesn't list (kiro/hermes/openclaw). */
export const agentRegistrySourceSchema = z.object({
  registryId: z.string().min(1),
  distributionKind: z.enum(["npx", "uvx", "binary"]),
  pinnedVersion: z.string().min(1),
});
export type AgentRegistrySource = z.infer<typeof agentRegistrySourceSchema>;

export const agentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  // No env here on purpose: env values are how agents commonly take API
  // keys, so they live in SecretStorage (stores/agent-env.ts), joined onto
  // the LaunchSpec at spawn time — never in globalState.
  processPolicy: z.enum(["auto", "shared", "isolated"]).default("auto"),
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

export class AgentConfigStore extends GlobalRecordStore<AgentConfig> {
  constructor(kv: KV) {
    super(kv, KEY, agentConfigSchema);
  }
}
