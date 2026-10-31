// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// How an agent is summed up in a line — wherever it is listed: the Agents
// drawer, the Settings card, the New session pick. One reading, so it
// reads the same everywhere.
import { capabilityState, type AgentSummary, type CapabilityCell, type CapabilityMatrix, type CapabilityState } from "./protocol";

/** How the line says each state — the same reading the matrix shows. */
const SAID: Record<CapabilityState, string> = {
  used: "✓",
  suspect: "suspect",
  declared: "declared, not used",
  "not-declared": "—",
};

function rowText(label: string, cell: CapabilityCell, usedSuffix = ""): string {
  const state = capabilityState(cell);
  return `${label} ${SAID[state]}${state === "used" ? usedSuffix : ""}`;
}

/** The Agents drawer / Settings card's short summary line. File system is
 * one entry: used once both its rows are, otherwise as its read row reads. */
export function capabilityOneLiner(matrix: CapabilityMatrix): string {
  const read = matrix["fs.readTextFile"];
  const both = capabilityState(read) === "used" && capabilityState(matrix["fs.writeTextFile"]) === "used";
  const fs = both ? "fs ✓" : rowText("fs", { ...read, used: false });
  return [fs, rowText("terminal", matrix.terminal), rowText("fork", matrix["session.fork"], " used")].join(" · ");
}

/** An agent's subtitle in a list: what its status says now, else what it
 * proved, else its status. A list without a status dot beside the line
 * (the command palette's pick) says the status instead of what it proved —
 * there, the line is the only place a stopped or crashed agent shows. */
export function agentSubtitle(
  agent: Pick<AgentSummary, "status" | "detail" | "capabilities">,
  besideStatusDot: boolean,
): string {
  if (agent.detail !== undefined) return agent.detail;
  if (agent.status === "running") return "ready";
  if (agent.status === "untested") return "never connected";
  return besideStatusDot && agent.capabilities !== undefined ? capabilityOneLiner(agent.capabilities) : agent.status;
}
