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
import type { PatchbayAgentId, PatchbayAskId, PatchbaySessionId } from "../src/shared/ids";

function replay(evs: AgentViewEvent[], state: AgentViewState = initialAgentViewState): AgentViewState {
  return evs.reduce(reduceAgentView, state);
}

const created = (id: string): AgentViewEvent => ({
  kind: "sessionCreated",
  session: { id: id as PatchbaySessionId, patchbayAgentId: "fake" as PatchbayAgentId, title: `title ${id}`, busy: [], updatedAt: "2026-09-25T00:00:00Z" },
});

const permission = (patchbaySessionId: PatchbaySessionId, id: string): AgentViewEvent => ({
  kind: "permissionRequested",
  patchbaySessionId,
  patchbayAskId: id as PatchbayAskId,
  title: "Terminal",
  detail: "npm test",
  facts: [],
  options: [{ optionId: "allow_once", label: "Allow once", kind: "allow_once" }],
});

const diff = (patchbaySessionId: PatchbaySessionId, id: string): AgentViewEvent => ({
  kind: "diffProposed",
  patchbaySessionId,
  patchbayAskId: id as PatchbayAskId,
  file: "/w/a.ts",
  additions: 1,
  deletions: 0,
  preview: [],
});

const question = (patchbaySessionId: PatchbaySessionId, id: string): AgentViewEvent => ({
  kind: "elicitationRequested",
  patchbaySessionId,
  patchbayAskId: id as PatchbayAskId,
  message: "Which branch?",
  mode: "form",
  fields: [],
});

const link = (patchbaySessionId: PatchbaySessionId, id: string): AgentViewEvent => ({
  kind: "elicitationRequested",
  patchbaySessionId,
  patchbayAskId: id as PatchbayAskId,
  message: "Sign in",
  mode: "url",
  link: { href: "https://example.com", host: "example.com", warnings: [] },
});

describe("open asks — what a session is blocked on", () => {
  it("every ask kind counts while unanswered, and none once answered", () => {
    const s = replay([
      created("a"),
      permission("a" as PatchbaySessionId, "p1"),
      diff("a" as PatchbaySessionId, "d1"),
      question("a" as PatchbaySessionId, "q1"),
      link("a" as PatchbaySessionId, "l1"),
    ]);
    expect(openAsks(s.transcripts["a"]!).map((b) => b.id)).toEqual(["p1", "d1", "q1", "l1"]);

    const answered = replay(
      [
        { kind: "permissionResolved", patchbaySessionId: "a" as PatchbaySessionId, patchbayAskId: "p1" as PatchbayAskId, label: "Allow once", auto: false },
        { kind: "diffResolved", patchbaySessionId: "a" as PatchbaySessionId, patchbayAskId: "d1" as PatchbayAskId, accepted: true, auto: false },
        { kind: "elicitationResolved", patchbaySessionId: "a" as PatchbaySessionId, patchbayAskId: "q1" as PatchbayAskId, outcome: "declined" },
        // an accepted link waits on the page, not on patchbay
        { kind: "elicitationResolved", patchbaySessionId: "a" as PatchbaySessionId, patchbayAskId: "l1" as PatchbayAskId, outcome: "accepted" },
      ],
      s,
    );
    expect(openAsks(answered.transcripts["a"]!)).toEqual([]);
  });

  it("a rule-accepted write never waits", () => {
    const s = replay([
      created("a"),
      diff("a" as PatchbaySessionId, "d1"),
      { kind: "diffResolved", patchbaySessionId: "a" as PatchbaySessionId, patchbayAskId: "d1" as PatchbayAskId, accepted: true, auto: true },
    ]);
    expect(waitingCount(s)).toBe(0);
  });

  it("names what the session waits on", () => {
    const s = replay([created("a"), created("b"), created("c"), permission("a" as PatchbaySessionId, "p1"), diff("b" as PatchbaySessionId, "d1"), question("c" as PatchbaySessionId, "q1")]);
    const on = (id: string) => waitingOn(s, s.sessions.find((x) => x.id === id)!);
    expect([on("a"), on("b"), on("c")]).toEqual(["Terminal", "File write", "Question"]);
  });
});

describe("session marks — most urgent first", () => {
  it("waiting outranks running outranks unseen", () => {
    const s = replay([
      created("a"),
      { kind: "sessionBusyChanged", patchbaySessionId: "a" as PatchbaySessionId, busy: ["prompt"] },
      question("a" as PatchbaySessionId, "q1"),
    ]);
    const mark = () => sessionMark(s, s.sessions[0]!);
    expect(mark()).toBe("waiting");
    const running = replay([{ kind: "elicitationResolved", patchbaySessionId: "a" as PatchbaySessionId, patchbayAskId: "q1" as PatchbayAskId, outcome: "accepted" }], s);
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
      { kind: "sessionActivated", patchbaySessionId: "a" as PatchbaySessionId },
      question("a" as PatchbaySessionId, "q1"),
      permission("b" as PatchbaySessionId, "p1"),
      question("c" as PatchbaySessionId, "q2"),
      { kind: "sessionBusyChanged", patchbaySessionId: "d" as PatchbaySessionId, busy: ["prompt"] },
    ]);
    const e = elsewhere(s);
    expect(e.waiting.map((x) => x.id)).toEqual(["b"]);
    expect(e.running.map((x) => x.id)).toEqual(["d"]);
    expect(e.unseen).toEqual([]);
    expect(waitingCount(s)).toBe(3);
  });
});
