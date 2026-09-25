// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What needs the user outside the conversation they are reading — one
// derivation over the canonical Agent View state, read by every surface
// that reports it (the native notification, the view badge, the header
// indicators, the sessions drawer), so no surface keeps its own list of
// what counts as waiting.
import {
  onScreen,
  type AgentViewState,
  type ChatBlock,
  type DiffBlock,
  type ElicitationBlock,
  type PermissionBlock,
  type SessionSummary,
} from "./protocol";

/** An ask the session is blocked on until the user answers: a permission
 * (a tool, a terminal command), a write proposal, a question. An answered
 * ask carries its resolution — an accepted link included: the agent then
 * waits on the page, not on patchbay. */
export type OpenAsk = PermissionBlock | DiffBlock | ElicitationBlock;

export function openAsks(blocks: readonly ChatBlock[]): readonly OpenAsk[] {
  return blocks.filter(
    (b): b is OpenAsk =>
      (b.kind === "permission" || b.kind === "diff" || b.kind === "elicitation") && b.resolution === null,
  );
}

/** What a waiting session is blocked on, in a few words — the first open
 * ask names it. */
export function waitingOn(state: AgentViewState, session: SessionSummary): string {
  const ask = openAsks(state.transcripts[session.id] ?? [])[0];
  if (ask === undefined) return "";
  return ask.kind === "permission" ? ask.title : ask.kind === "diff" ? "File write" : "Question";
}

/** One mark per session, most urgent first: waiting on the user, then a
 * turn running, then a result not yet seen. */
export type SessionMark = "waiting" | "running" | "unseen";

export function sessionMark(state: AgentViewState, session: SessionSummary): SessionMark | null {
  if (openAsks(state.transcripts[session.id] ?? []).length > 0) return "waiting";
  if (session.live) return "running";
  if (session.unseen === true) return "unseen";
  return null;
}

export type Elsewhere = Readonly<Record<SessionMark, readonly SessionSummary[]>>;

/** The sessions the header reports: every marked session except the ones
 * already in front of the user — the active one, and any a visible panel
 * shows. */
export function elsewhere(state: AgentViewState): Elsewhere {
  const shown = onScreen(state);
  const groups: Record<SessionMark, SessionSummary[]> = { waiting: [], running: [], unseen: [] };
  for (const session of state.sessions) {
    if (session.id === state.activeSessionId || shown.has(session.id)) continue;
    const mark = sessionMark(state, session);
    if (mark !== null) groups[mark].push(session);
  }
  return groups;
}

/** Every session waiting on the user, on screen or not — the view badge's
 * count. */
export function waitingCount(state: AgentViewState): number {
  return state.sessions.filter((s) => openAsks(state.transcripts[s.id] ?? []).length > 0).length;
}
