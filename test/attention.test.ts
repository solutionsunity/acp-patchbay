// Issue #38: "waiting on the user" is one derivation — every open ask, of
// every kind, counts; answered ones never do — and the header reports only
// the sessions that are not already in front of the user.
import { describe, expect, it } from "vitest";
import { elsewhere, openAsks, sessionMark, waitingCount, waitingOn } from "../src/shared/attention";
import {
  initialAgentViewState,
  reduceAgentView,
  type AgentViewEvent,
  type AgentViewState,
} from "../src/shared/protocol";

function replay(evs: AgentViewEvent[], state: AgentViewState = initialAgentViewState): AgentViewState {
  return evs.reduce(reduceAgentView, state);
}

const created = (id: string): AgentViewEvent => ({
  kind: "sessionCreated",
  session: { id, agentId: "fake", title: `title ${id}`, live: false, updatedAt: "2026-09-25T00:00:00Z" },
});

const permission = (sessionId: string, blockId: string): AgentViewEvent => ({
  kind: "permissionRequested",
  sessionId,
  blockId,
  title: "Terminal",
  detail: "npm test",
  options: [{ optionId: "allow_once", label: "Allow once", kind: "allow_once" }],
});

const diff = (sessionId: string, blockId: string): AgentViewEvent => ({
  kind: "diffProposed",
  sessionId,
  blockId,
  file: "/w/a.ts",
  additions: 1,
  deletions: 0,
  lines: [],
});

const question = (sessionId: string, blockId: string): AgentViewEvent => ({
  kind: "elicitationRequested",
  sessionId,
  blockId,
  message: "Which branch?",
  mode: "form",
  fields: [],
});

const link = (sessionId: string, blockId: string): AgentViewEvent => ({
  kind: "elicitationRequested",
  sessionId,
  blockId,
  message: "Sign in",
  mode: "url",
  link: { href: "https://example.com", host: "example.com", warnings: [] },
});

describe("open asks — what a session is blocked on", () => {
  it("every ask kind counts while unanswered, and none once answered", () => {
    const s = replay([
      created("a"),
      permission("a", "p1"),
      diff("a", "d1"),
      question("a", "q1"),
      link("a", "l1"),
    ]);
    expect(openAsks(s.transcripts["a"]!).map((b) => b.id)).toEqual(["p1", "d1", "q1", "l1"]);

    const answered = replay(
      [
        { kind: "permissionResolved", sessionId: "a", blockId: "p1", label: "Allow once", auto: false },
        { kind: "diffResolved", sessionId: "a", blockId: "d1", accepted: true, auto: false },
        { kind: "elicitationResolved", sessionId: "a", blockId: "q1", outcome: "declined" },
        // an accepted link waits on the page, not on patchbay
        { kind: "elicitationResolved", sessionId: "a", blockId: "l1", outcome: "accepted" },
      ],
      s,
    );
    expect(openAsks(answered.transcripts["a"]!)).toEqual([]);
  });

  it("a rule-accepted write never waits", () => {
    const s = replay([
      created("a"),
      diff("a", "d1"),
      { kind: "diffResolved", sessionId: "a", blockId: "d1", accepted: true, auto: true },
    ]);
    expect(waitingCount(s)).toBe(0);
  });

  it("names what the session waits on", () => {
    const s = replay([created("a"), created("b"), created("c"), permission("a", "p1"), diff("b", "d1"), question("c", "q1")]);
    const on = (id: string) => waitingOn(s, s.sessions.find((x) => x.id === id)!);
    expect([on("a"), on("b"), on("c")]).toEqual(["Terminal", "File write", "Question"]);
  });
});

describe("session marks — most urgent first", () => {
  it("waiting outranks running outranks unseen", () => {
    const s = replay([
      created("a"),
      { kind: "sessionLiveChanged", sessionId: "a", live: true },
      question("a", "q1"),
    ]);
    const mark = () => sessionMark(s, s.sessions[0]!);
    expect(mark()).toBe("waiting");
    const running = replay([{ kind: "elicitationResolved", sessionId: "a", blockId: "q1", outcome: "accepted" }], s);
    expect(sessionMark(running, running.sessions[0]!)).toBe("running");
  });
});

describe("elsewhere — what the header reports", () => {
  it("leaves out the active session and any a visible panel shows; the badge counts them all", () => {
    const s = replay([
      created("a"),
      created("b"),
      created("c"),
      created("d"),
      { kind: "screenChanged", pointer: true, pinned: ["c"] },
      { kind: "sessionActivated", sessionId: "a" },
      question("a", "q1"),
      permission("b", "p1"),
      question("c", "q2"),
      { kind: "sessionLiveChanged", sessionId: "d", live: true },
    ]);
    const e = elsewhere(s);
    expect(e.waiting.map((x) => x.id)).toEqual(["b"]);
    expect(e.running.map((x) => x.id)).toEqual(["d"]);
    expect(e.unseen).toEqual([]);
    expect(waitingCount(s)).toBe(3);
  });
});
