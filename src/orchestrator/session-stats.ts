// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The Settings "active today" tile: a pure projection of the Agent View's
// canonical session rows, so the number is the drawer's own stamps counted
// — one fact, read where it lives. Kept vscode-free for unit tests, like
// status-bar.ts; the orchestrator republishes it whenever canonical state
// moves.
import type { SessionSummary } from "../shared/protocol";

/** Sessions whose last activity (`updatedAt`) falls on the local calendar
 * day of `now`. Activity, not creation: the wire's `session/list` carries
 * only an activity stamp, so activity is the one definition every row can
 * honor. An unparseable stamp counts as not today. */
export function sessionsActiveToday(sessions: readonly SessionSummary[], now: number = Date.now()): number {
  const today = new Date(now).toDateString();
  let count = 0;
  for (const session of sessions) {
    const at = Date.parse(session.updatedAt);
    if (!Number.isNaN(at) && new Date(at).toDateString() === today) count++;
  }
  return count;
}
