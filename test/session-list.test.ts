// The sessions as a list shows them (shared/session-list.ts) — the drawer
// and the Switch Session pick: found by title or by what was said, where
// the conversation is loaded in this window (#98).
import { describe, expect, it } from "vitest";
import { listSessions, loadedHere, withFirst } from "../src/shared/session-list";
import type { PatchbayAgentId, PatchbaySessionId } from "../src/shared/ids";
import type { ChatBlock, SessionSummary } from "../src/shared/protocol";

const session = (id: string, title: string, agent: string, updatedAt: string): SessionSummary => ({
  id: id as PatchbaySessionId,
  patchbayAgentId: agent as PatchbayAgentId,
  title,
  busy: [],
  updatedAt,
  hasTurns: true,
});
const user = (text: string, injected = false): ChatBlock => ({ kind: "user", id: `u${text.length}`, parts: [{ kind: "text", text }], ...(injected ? { injected } : {}) });
const said = (text: string): ChatBlock => ({ kind: "text", id: `t${text.length}`, text });

const state = {
  sessions: [
    session("old", "Fix the login redirect", "claude", "2026-11-01T10:00:00Z"),
    session("new", "Plan the migration", "claude", "2026-11-03T10:00:00Z"),
    session("mid", "Review pricing page", "opencode", "2026-11-02T10:00:00Z"),
  ],
  transcripts: {
    old: [user("why does the callback loop?"), said("The redirect URI lacks the windowId parameter, so the router matches the wrong window.")],
    new: [],
    mid: [user("ignore me <system-reminder>windowId</system-reminder>", true), { kind: "thought", id: "th", text: "thinking about windowId" } as ChatBlock],
  },
};
const ids = (rows: ReturnType<typeof listSessions>) => rows.map((r) => r.session.id);

describe("the sessions list", () => {
  it("a session is loaded when its conversation is in this window", () => {
    expect([loadedHere(state, "old" as PatchbaySessionId), loadedHere(state, "new" as PatchbaySessionId), loadedHere(state, "gone" as PatchbaySessionId)]).toEqual([true, false, false]);
  });

  it("lists latest activity first, each row saying whether it is loaded", () => {
    expect(listSessions(state).map((r) => [r.session.id, r.loaded, r.found])).toEqual([["new", false, null], ["mid", true, null], ["old", true, null]]);
  });

  it("finds by title, whatever its case — loaded or not", () => {
    expect(ids(listSessions(state, { text: " MIGRATION ", agent: "all" }))).toEqual(["new"]);
  });

  it("finds by what was said, where the conversation is loaded — with a few words around it", () => {
    const rows = listSessions(state, { text: "windowid", agent: "all" });
    expect(ids(rows)).toEqual(["old"]);
    // cut at whole words where it runs long, and said so
    expect(rows[0]!.found).toBe("The redirect URI lacks the windowId parameter, so the router matches the wrong…");
    expect(listSessions(state, { text: "wrong window", agent: "all" })[0]!.found).toBe("…so the router matches the wrong window.");
  });

  it("reads the user's words and the agent's answers — not a thought, nor a message the harness put in the user's place", () => {
    expect(ids(listSessions(state, { text: "thinking about", agent: "all" }))).toEqual([]);
    expect(ids(listSessions(state, { text: "system-reminder", agent: "all" }))).toEqual([]);
  });

  it("narrows to one agent's, with or without a search", () => {
    expect(ids(listSessions(state, { text: "", agent: "claude" as PatchbayAgentId }))).toEqual(["new", "old"]);
    expect(ids(listSessions(state, { text: "pricing", agent: "claude" as PatchbayAgentId }))).toEqual([]);
  });

  it("a switcher leads with the session the user was in before, every other row in its place", () => {
    const rows = listSessions(state);
    expect(ids(withFirst(rows, "old" as PatchbaySessionId))).toEqual(["old", "new", "mid"]);
    expect(ids(withFirst(rows, null))).toEqual(["new", "mid", "old"]);
    expect(ids(withFirst(rows, "closed since" as PatchbaySessionId))).toEqual(["new", "mid", "old"]);
  });
});
