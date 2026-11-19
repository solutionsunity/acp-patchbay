// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A failure as the view shows it, for the surfaces that show the same one
// in more than one place — said once here, so each place reports what the
// other would.
import type { ShownFailure } from "../../shared/failure-report";
import type { AgentSummary } from "../../shared/protocol";

/** An agent that stopped unexpectedly — its row in Settings, the banner
 * over its chat: what the line says, and the last of its output behind it. */
export function crashOf(agent: Pick<AgentSummary, "id" | "name" | "detail" | "stderr">): ShownFailure {
  return {
    where: "agentCrash",
    said: `${agent.name} crashed${agent.detail !== undefined ? ` — ${agent.detail}` : ""}`,
    ...(agent.stderr !== undefined && agent.stderr.length > 0 ? { output: agent.stderr.join("\n") } : {}),
    patchbayAgentId: agent.id,
  };
}
