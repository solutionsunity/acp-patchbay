// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The sessions as a list shows them — the drawer, and the Switch Session
// pick — from the one view state: which are loaded here, which a filter
// keeps, and in what order. A session is loaded when its conversation is in
// this window; one that exists only in its agent's history has none here
// until it is opened. That is read off the transcripts, never stored: it
// is also exactly what a search of the conversations can reach.
import type { PatchbayAgentId, PatchbaySessionId } from "./ids";
import { userPartsText, type AgentViewState, type ChatBlock, type SessionSummary } from "./protocol";

type Held = Pick<AgentViewState, "sessions" | "transcripts">;

/** Whether the session's conversation is in this window. */
export function loadedHere(state: Pick<AgentViewState, "transcripts">, patchbaySessionId: PatchbaySessionId): boolean {
  return (state.transcripts[patchbaySessionId] ?? []).length > 0;
}

/** Which sessions a list shows: those whose title — or, loaded here,
 * whose conversation — holds `text`, of one agent or of all. */
export interface SessionFilter {
  text: string;
  agent: "all" | PatchbayAgentId;
}

export const NO_SESSION_FILTER: SessionFilter = { text: "", agent: "all" };

export interface SessionListRow {
  session: SessionSummary;
  loaded: boolean;
  /** Where the conversation holds the text searched for, a few words
   * around it — null where the title matched, or nothing was searched. */
  found: string | null;
}

/** What a conversation says, as a search reads it: the user's words and
 * the agent's answers — not its thoughts, nor a tool's input and output. */
function saidIn(block: ChatBlock): string {
  if (block.kind === "user") return block.injected === true ? "" : userPartsText(block.parts);
  return block.kind === "text" ? block.text : "";
}

/** A few words either side of the first place `text` sits in a
 * conversation, cut at whole words — null when it holds it nowhere. */
function foundIn(blocks: readonly ChatBlock[], text: string): string | null {
  for (const block of blocks) {
    const said = saidIn(block);
    const at = said.toLowerCase().indexOf(text);
    if (at === -1) continue;
    const end = at + text.length;
    let from = Math.max(0, at - 30);
    let to = Math.min(said.length, end + 50);
    // not from the middle of a word, nor to the middle of one
    const afterSpace = from > 0 ? said.indexOf(" ", from) + 1 : 0;
    if (afterSpace > 0 && afterSpace <= at) from = afterSpace;
    const beforeSpace = to < said.length ? said.lastIndexOf(" ", to) : -1;
    if (beforeSpace >= end) to = beforeSpace;
    return `${from > 0 ? "…" : ""}${said.slice(from, to).replace(/\s+/g, " ").trim()}${to < said.length ? "…" : ""}`;
  }
  return null;
}

/** The sessions a list shows, latest activity first. */
export function listSessions(state: Held, filter: SessionFilter = NO_SESSION_FILTER): SessionListRow[] {
  const text = filter.text.trim().toLowerCase();
  return [...state.sessions]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .flatMap((session): SessionListRow[] => {
      if (filter.agent !== "all" && session.patchbayAgentId !== filter.agent) return [];
      const loaded = loadedHere(state, session.id);
      if (text === "" || session.title.toLowerCase().includes(text)) return [{ session, loaded, found: null }];
      const found = foundIn(state.transcripts[session.id] ?? [], text);
      return found === null ? [] : [{ session, loaded, found }];
    });
}

/** The rows with one session first — the one the user was in before the
 * one in front, so a switcher's first answer flips back to it. Every
 * other row keeps its place. */
export function withFirst(rows: readonly SessionListRow[], first: PatchbaySessionId | null): SessionListRow[] {
  const lead = rows.find((r) => r.session.id === first);
  return lead === undefined ? [...rows] : [lead, ...rows.filter((r) => r !== lead)];
}
