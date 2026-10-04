// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// How a view reads what an agent is busy with — the row's `busy`, the
// operations its queue holds. One reading for every surface that shows it:
// the upgrade chip (Agent View header, Settings card) and the chat pane
// while a chat waits on its agent.
import type { AgentSummary, AgentWork, ChatConnectView } from "../../shared/protocol";

/** The upgrade chip: the newer version on offer, or the upgrade the
 * agent's queue holds, named by the version it installs. */
export type UpgradeOffer = { upgrading: false; from: string; to: string } | { upgrading: true; to?: string };

/** The chip's state, or null when there is neither an update nor an
 * upgrade under way. An upgrade under way outranks the offer — once the
 * upgrade has saved the new pin the offer is gone, and the chip still says
 * what is happening. */
export function upgradeOffer(agent: AgentSummary | undefined): UpgradeOffer | null {
  const upgrading = agent?.busy.find((w) => w.kind === "upgrade");
  if (upgrading !== undefined) return { upgrading: true, to: upgrading.to };
  return agent?.update !== undefined ? { upgrading: false, ...agent.update } : null;
}

/** The in-progress pane's line: while the chat waits on its agent, what
 * the agent's queue runs now — with the launch phase while its process
 * starts; once the agent runs, the chat itself being opened (a running
 * agent serves a chat at once, whatever else it is busy with). */
export function chatPaneProgress(connect: ChatConnectView, agent: AgentSummary | undefined): string {
  const name = agent?.name ?? connect.agentId;
  const work = agent?.busy[0];
  if (agent?.status === "running" || work === undefined) {
    return connect.forSessionId !== undefined ? "Opening the session…" : `Starting a chat with ${name}…`;
  }
  // The pool's phase label rides the row's detail while a launch is
  // genuinely in flight ("downloading the agent package…") — the
  // difference between a 20-second silent connect and a said reason.
  const phase = agent?.status === "reconnecting" ? agent.detail : undefined;
  const line = workLine(work, name);
  return phase !== undefined ? `${line} — ${phase}` : line;
}

function workLine(work: AgentWork, name: string): string {
  switch (work.kind) {
    case "connect":
      return `Connecting ${name}…`;
    case "restart":
      return `Restarting ${name}…`;
    case "upgrade":
      return work.to !== undefined ? `Upgrading ${name} to ${work.to}…` : `Upgrading ${name}…`;
    case "login":
      return `Logging in to ${name}…`;
    case "logout":
      return `Logging out of ${name}…`;
    case "verify":
      return `Verifying ${name}…`;
    case "stop":
      return `Stopping ${name}…`;
    case "remove":
      return `Removing ${name}…`;
  }
}
