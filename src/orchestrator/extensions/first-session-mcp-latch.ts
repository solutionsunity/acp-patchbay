// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Behavioral quirk workaround: some agents honor `session/new`'s
// `mcpServers` only on the process's FIRST session — every later session's
// list is silently dropped (spec: the server list is a parameter of every
// session call). Patchbay's connect-time capability probe was spending that
// first-session privilege on a throwaway session, so every real session got
// zero MCP servers. The workaround: defer the probe until after the first
// real session opens on the connection — the user's session takes the
// privilege, the probe (which needs no MCP servers) runs second.
//
// Id-keyed curated entry: shape-gating is physically impossible here —
// nothing on the wire announces the latch before it bites. Entries are
// earned by wire reproduction, version-stamped.
//
// Adopted 2026-07-13. RETIRE per agent when its vendor honors per-session
// mcpServers — re-test on version change (marker-server repro).
// Retirement = delete the entry (or, when empty, this file + its line in
// extensions/index.ts). Cost while latched: the agent's capability matrix
// and knob offerings stay at declared-only, and a logged-out agent's
// needsAuth surfaces at first real use instead of at connect.
//
// Reported upstream 2026-07-13 (pending send).
const LATCHED_AGENTS: ReadonlySet<string> = new Set([
  // auggie 0.32.0 (commit eb99b871) — verified 2026-07-12, re-verified
  // 2026-07-13 (control spawns within ~10s of session/new; second-session
  // server never spawns).
  "auggie",
]);

/** True when this agent's connect-time capability probe must wait for the
 * first real session (capability-tracker consults this at its probe
 * chokepoint; session-manager's attach fires the trigger). */
export function probeDeferredFor(agentId: string): boolean {
  return LATCHED_AGENTS.has(agentId);
}
