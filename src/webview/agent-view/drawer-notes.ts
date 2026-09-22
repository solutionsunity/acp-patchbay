// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The sessions drawer's one honesty line: which agents cannot have their
// history shown. Pure, so the state × surface is a test, not a render
// surprise.
import type { AgentSummary, AgentViewState } from "../../shared/protocol";

/** Agents whose handshake is on record and declared no `session/list`:
 * the drawer can only ever show their sessions open in this window. A
 * never-connected agent has no handshake to judge and is not named. */
export function unlistedAgents(
  agents: readonly AgentSummary[],
  capabilities: AgentViewState["capabilities"],
): AgentSummary[] {
  return agents.filter((a) => {
    const matrix = capabilities[a.id];
    return matrix !== undefined && !matrix["session.list"].declared;
  });
}
