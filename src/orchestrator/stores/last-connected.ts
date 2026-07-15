// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Reload-continuation stamp: the set of agents still running when the
// extension host went down, written once by deactivate's shutdown and
// consumed (read + cleared — spent either way, like spawn-registry records)
// by the next activate. Freshness-bounded because deactivate fires
// identically for reload and quit (vscode#45474): a window reload reaches
// the next activate in seconds, a quit-and-reopen-later does not — the
// stamp's age is the discriminator the platform doesn't provide. Stale,
// torn, or absent → only auto-connect-flagged agents start; a manually
// connected agent must not resurrect days later. A window *crash* skips
// deactivate entirely, so no fresh stamp exists and the same fallback
// applies — accepted: the flagged agents still return, the manual one is a
// click away. workspaceState: the working set is a workspace fact (sessions
// are cwd-bound), machine-local, non-sensitive — agent ids only.
import type { KV } from "./kv";

export interface LastConnectedStamp {
  agentIds: string[];
  /** ISO write time — freshness is judged against this, nothing else. */
  at: string;
}

const KEY = "acpPatchbay.lastConnected";

/** A reload lands well inside a minute; a human "reopening later" doesn't.
 * Same grace-window idea as a keeper-daemon's reconnect budget would be —
 * custody inverted: here the *next* activate judges, not a survivor. */
export const RELOAD_GRACE_MS = 60_000;

export class LastConnectedStore {
  constructor(private readonly kv: KV) {}

  /** Written at shutdown with whatever was running — an empty set is still
   * written, so a stale stamp can't outlive the shutdown that obsoleted it. */
  async write(agentIds: readonly string[]): Promise<void> {
    const stamp: LastConnectedStamp = { agentIds: [...agentIds], at: new Date().toISOString() };
    await this.kv.update(KEY, stamp);
  }

  /** Read-and-clear. Yields the stamped ids only while fresh; stale, torn,
   * or absent yields [] — and the record is spent in every case, so one
   * stamp can never drive two activations. `now` injectable for tests. */
  async consume(now: Date = new Date()): Promise<string[]> {
    const stamp = this.kv.get<LastConnectedStamp>(KEY);
    await this.kv.update(KEY, undefined);
    if (stamp === undefined || !Array.isArray(stamp.agentIds)) return [];
    const at = Date.parse(stamp.at);
    if (Number.isNaN(at) || now.getTime() - at > RELOAD_GRACE_MS) return [];
    return stamp.agentIds.filter((id): id is string => typeof id === "string");
  }

  /** "Disconnect & erase all data". */
  async wipe(): Promise<void> {
    await this.kv.update(KEY, undefined);
  }
}
