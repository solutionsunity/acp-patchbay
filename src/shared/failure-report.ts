// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A failure as it is shown to the user, in the one form a report of it is
// built from. Every place that shows a failure names itself here and hands
// over what it said; what a report then adds — the versions, the machine —
// and where a report goes are the host's, and no surface knows either.

/** Whose words a failure's text is: Patchbay's own, the agent's as it sent
 * them, an MCP server's (or the network's on the way to it), or Patchbay's
 * around the agent's — "couldn't start" over the reason the agent gave. */
export type FailureWords = "patchbay" | "agent" | "server" | "patchbay-and-agent";

/** Every place a failure is shown with a way to report it: how a report
 * names the place, and whose words its text is. */
export const FAILURE_SURFACES = {
  agentStart: { shown: "the chat, an agent that couldn't start", words: "patchbay-and-agent" },
  agentCrash: { shown: "an agent that stopped unexpectedly", words: "patchbay-and-agent" },
  turn: { shown: "the chat, a turn that failed", words: "agent" },
  compaction: { shown: "the chat, a context compaction that failed", words: "agent" },
  agentNotice: { shown: "the chat, a notice from the agent", words: "agent" },
  subagent: { shown: "the chat, a sub-agent that failed", words: "agent" },
  mcpAdd: { shown: "Settings › MCP Servers, a server that wasn't added", words: "server" },
  mcpSignInLink: { shown: "Settings › MCP Servers, a sign-in link that was refused", words: "patchbay" },
  mcpUnreachable: { shown: "Settings › MCP Servers, a server that is unreachable", words: "server" },
  mcpSession: { shown: "the chat, an MCP server failing for a session", words: "server" },
  registry: { shown: "Settings › Agents, the registry that couldn't be read", words: "patchbay" },
  configImport: { shown: "Settings › Import/Export, an import", words: "patchbay" },
  notification: { shown: "a notification", words: "patchbay" },
  viewError: { shown: "a Patchbay view, an error of its own", words: "patchbay" },
} as const satisfies Record<string, { shown: string; words: FailureWords }>;

export type FailureSurfaceId = keyof typeof FAILURE_SURFACES;

/** How a report says whose words the text is. */
export const WORDS_ARE: Readonly<Record<FailureWords, string>> = {
  patchbay: "Patchbay's own",
  agent: "the agent's, as it sent them",
  server: "the MCP server's, or the network's on the way to it",
  "patchbay-and-agent": "Patchbay's, around the reason the agent gave",
};

/** A failure as its surface shows it. `said` is the text on screen;
 * `output` what stands behind it that a reader of the report needs — a
 * stopped agent's last output. The ids name what it concerns, where it
 * concerns one. */
export interface ShownFailure {
  where: FailureSurfaceId;
  said: string;
  output?: string;
  patchbayAgentId?: string;
  patchbayMcpServerId?: string;
}

/** What the control that reports a failure says of itself, wherever it sits. */
export const REPORT_FAILURE = {
  label: "Report",
  title: "Report this on GitHub — opens an issue filled in with this failure and your versions, for you to review and send",
} as const;
