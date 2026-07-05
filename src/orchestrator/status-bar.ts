// Status bar content (features.md § 3 — "active session, connection health,
// usage when available"): a pure function of canonical AgentViewState, kept
// vscode-free so the formatting is unit-testable without a real extension
// host. Orchestrator just assigns the result to a real StatusBarItem.
import type { AgentViewState } from "../shared/protocol";

export interface StatusBarContent {
  text: string;
  tooltip: string;
}

export function statusBarContent(state: AgentViewState): StatusBarContent {
  const session = state.sessions.find((s) => s.id === state.activeSessionId);
  if (session === undefined) {
    return { text: "$(plug) Patchbay", tooltip: "No active session — click to open the Agent View" };
  }
  const agent = state.agents.find((a) => a.id === session.agentId);
  const icon =
    agent?.status === "running"
      ? "$(circle-filled)"
      : agent?.status === "crashed"
        ? "$(error)"
        : agent?.status === "reconnecting"
          ? "$(sync~spin)"
          : "$(circle-outline)";
  const usage = state.sessionUsage[session.id];
  const usageText = usage !== undefined ? ` · ${Math.round((usage.used / usage.size) * 100)}%` : "";
  return {
    text: `${icon} ${session.title}${usageText}`,
    tooltip: `${agent?.name ?? session.agentId} — ${agent?.status ?? "unknown"}`,
  };
}
