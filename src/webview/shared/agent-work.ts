// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// How a view reads what an agent is busy with — the row's `busy`, the
// operations its queue holds. One reading for every surface that shows it:
// the version chip (Agent View header, Settings card) and the chat pane
// while a chat waits on its agent.
import { isVersionMove, type AgentSummary, type AgentWork, type ChatConnectView, type VersionMove } from "../../shared/protocol";

type VersionWork = Extract<AgentWork, { kind: VersionMove }>;

/** The version chip: the agent's version as a read-out, the upgrade itself
 * while the registry has a newer one, or the move its queue holds. `title`
 * says both versions the agent has — the pin and what it reported. */
export type VersionChip =
  | { kind: "version"; shown: string; title: string }
  | { kind: "update"; from: string; to: string; title: string }
  | { kind: "moving"; text: string };

/** The chip's state, or null while nothing of the agent's version is known
 * (a custom command not yet connected). Registry agents show their pin —
 * the scheme an update is measured in — and others what they reported. A
 * move under way outranks the offer — once it has saved the new pin the
 * offer is gone, and the chip still says what is happening. */
export function versionChip(agent: AgentSummary | undefined): VersionChip | null {
  if (agent === undefined) return null;
  const moving = agent.busy.find((w): w is VersionWork => isVersionMove(w.kind));
  if (moving !== undefined) return { kind: "moving", text: movingText(moving) };
  const { pinned, reported } = agent.version;
  const shown = pinned ?? reported;
  if (shown === undefined) return null;
  const versions = [
    ...(pinned === undefined ? [] : [`pinned ${pinned} (ACP registry)`]),
    reported === undefined ? "reports its version once connected" : `reports ${reported}`,
  ].join(" · ");
  if (agent.update !== undefined) {
    return { kind: "update", ...agent.update, title: `Upgrade ${agent.name} to ${agent.update.to} — ${versions}` };
  }
  return { kind: "version", shown, title: `${agent.name}: ${versions}` };
}

function movingText(work: VersionWork): string {
  const to = work.to !== undefined ? ` to ${work.to}` : "";
  switch (work.kind) {
    case "upgrade":
      return `upgrading${to}…`;
    case "reset":
      return `resetting${to}…`;
    case "goBack":
      return `going back${to}…`;
  }
}

/** A crashed agent is offered its Restart — wherever it shows: the Agent
 * View's banner, its Settings card. */
export function restartOffered(agent: AgentSummary | null | undefined): boolean {
  return agent?.status === "crashed";
}

/** The in-progress pane's line: while the chat waits on its agent, what
 * the agent's queue runs now — with the launch phase while its process
 * starts; once the agent runs, the chat itself being opened (a running
 * agent serves a chat at once, whatever else it is busy with). */
export function chatPaneProgress(connect: ChatConnectView, agent: AgentSummary | undefined): string {
  const name = agent?.name ?? connect.patchbayAgentId;
  const work = agent?.busy[0];
  if (agent?.status === "running" || work === undefined) {
    return connect.forPatchbaySessionId !== undefined ? "Opening the session…" : `Starting a chat with ${name}…`;
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
    case "reset":
      return work.to !== undefined ? `Resetting ${name} to the ACP registry's ${work.to}…` : `Resetting ${name} to the ACP registry…`;
    case "goBack":
      return work.to !== undefined ? `Taking ${name} back to ${work.to}…` : `Taking ${name} back…`;
    case "login":
      return `Logging in to ${name}…`;
    case "logout":
      return `Logging out of ${name}…`;
    case "stop":
      return `Stopping ${name}…`;
    case "remove":
      return `Removing ${name}…`;
  }
}
