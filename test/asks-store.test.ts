// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The asks store's one writer: an ask ends once, as MOVES allows, and the
// end writes its card, its record and its caller's answer together — in
// that order. An answer that doesn't fit its ask moves nothing.
import { describe, expect, it } from "vitest";
import { AsksStore, type AskEnding } from "../src/orchestrator/asks-store";
import type { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
import type { AgentViewEvent, PermissionOptionView, QuestionEvent } from "../src/shared/protocol";
import type { PatchbayAgentId, PatchbayAskId, PatchbaySessionId } from "../src/shared/ids";

const S1 = "s1" as PatchbaySessionId;
const OPTIONS: readonly PermissionOptionView[] = [
  { optionId: "y", label: "Allow", kind: "allow_once" },
  { optionId: "n", label: "Reject", kind: "reject_once" },
];

/** An audit whose writes land when the test says — or fail. */
function heldAudit() {
  const lines: Record<string, unknown>[] = [];
  const pending: { land(): void; fail(err: Error): void }[] = [];
  const audit = {
    append: (entry: Record<string, unknown>) =>
      new Promise<void>((resolve, reject) => {
        pending.push({
          land: () => {
            lines.push(entry);
            resolve();
          },
          fail: reject,
        });
      }),
  } as unknown as DecisionAuditStore;
  return { audit, lines, pending };
}

function harness() {
  const events: AgentViewEvent[] = [];
  const agentEvents: { patchbayAgentId: PatchbayAgentId; event: QuestionEvent }[] = [];
  // the turn running on S1 — whatever a test sets
  let turn: string | null = null;
  const held = heldAudit();
  const ended: PatchbayAskId[] = [];
  const asks = new AsksStore(held.audit, {
    emit: (...evs) => events.push(...evs),
    emitAgent: (patchbayAgentId, event) => agentEvents.push({ patchbayAgentId, event }),
    turnOf: () => turn,
    onAuditWritten: () => {},
    pairOf: () => ({ patchbayAgentId: "a1" as PatchbayAgentId, sessionId: "agent-s1" }),
    ended: (id) => ended.push(id),
  });
  return { asks, events, agentEvents, ended, startTurn: (id: string | null) => (turn = id), ...held };
}

/** Whether a promise has settled by now. */
async function settledYet(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((r) => setTimeout(r, 0));
  return done;
}

describe("AsksStore — an answer that doesn't fit its ask moves nothing", () => {
  it("an option the permission doesn't offer leaves the card open, and the ask still answers", async () => {
    const { asks, events, pending } = harness();
    const { id, ending } = asks.open({ patchbaySessionId: S1 }, "permission", { tool: "Edit", files: [] });
    asks.show(id, { kind: "options", title: "Edit", detail: "Edit", facts: [], options: OPTIONS });

    asks.answerOption(id, "not-an-option");
    asks.answerWrite(id, true); // a write's answer, sent at a permission's card
    asks.answerQuestion(id, { action: "accept", content: {} });
    expect(await settledYet(ending)).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(["permissionRequested"]);

    asks.answerOption(id, "n");
    pending[0]!.land();
    expect(await ending).toEqual({ end: "user", choice: { kind: "option", option: OPTIONS[1] } });
    expect(events.at(-1)).toMatchObject({ kind: "permissionResolved", patchbayAskId: id, label: "Reject", auto: false });
  });

  it("an option answer at a write's card moves nothing either", async () => {
    const { asks, events } = harness();
    const { id, ending } = asks.open({ patchbaySessionId: S1 }, "write", { file: "/w/a.ts" });
    asks.show(id, { kind: "write", file: "/w/a.ts", additions: 1, deletions: 0, preview: [], proposals: [] });
    asks.answerOption(id, "y");
    expect(await settledYet(ending)).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(["diffProposed"]);
  });
});

describe("AsksStore — the record before the answer", () => {
  it("the caller hears the ending only once its record is written — no action runs ahead of it", async () => {
    const { asks, events, lines, pending } = harness();
    const { id, ending } = asks.open({ patchbaySessionId: S1 }, "command", { command: "npm test", cwd: "/w", env: [] });
    asks.show(id, { kind: "options", title: "Terminal", detail: "npm test", facts: [], options: OPTIONS });
    asks.answerOption(id, "y");

    // the card resolves at once; the caller waits for the record
    expect(events.at(-1)).toMatchObject({ kind: "permissionResolved", label: "Allow" });
    expect(await settledYet(ending)).toBe(false);

    pending[0]!.land();
    const ended: AskEnding = await ending;
    expect(ended).toMatchObject({ end: "user" });
    expect(lines).toEqual([{ kind: "user-allow", patchbayAgentId: "a1", sessionId: "agent-s1", command: "npm test", cwd: "/w", env: [] }]);
  });

  it("a record that fails fails the caller — the action never runs unrecorded", async () => {
    const { asks, pending } = harness();
    const { id, ending } = asks.open({ patchbaySessionId: S1 }, "write", { file: "/w/a.ts" });
    asks.show(id, { kind: "write", file: "/w/a.ts", additions: 1, deletions: 0, preview: [], proposals: [] });
    asks.answerWrite(id, true);
    pending[0]!.fail(new Error("disk full"));
    await expect(ending).rejects.toThrow("disk full");
  });

  it("a question is never recorded — its answer reaches the caller at once", async () => {
    const { asks, pending } = harness();
    const { id, ending } = asks.open({ patchbaySessionId: S1 }, "question", null);
    asks.show(id, { kind: "question", message: "Which?", ask: { mode: "form", fields: [] } });
    asks.answerQuestion(id, { action: "decline" });
    expect(await ending).toEqual({ end: "user", choice: { kind: "answer", answer: { action: "decline" } } });
    expect(pending).toHaveLength(0);
  });
});

describe("AsksStore — an ask that ends before its card shows", () => {
  it("leaves no card: the show that follows is a no-op, and the stop is on the record", async () => {
    const { asks, events, lines, pending } = harness();
    const { id, ending } = asks.open({ patchbaySessionId: S1 }, "write", { file: "/w/a.ts" });
    asks.stopSession(S1);
    asks.show(id, { kind: "write", file: "/w/a.ts", additions: 1, deletions: 0, preview: [], proposals: [{ path: "/w/a.ts", oldText: "", newText: "x" }] });
    asks.allow(id); // a rule's verdict that comes too late
    pending[0]!.land();
    expect(await ending).toEqual({ end: "stop" });
    expect(events).toEqual([]);
    expect(lines).toEqual([{ kind: "turn-cancelled", patchbayAgentId: "a1", sessionId: "agent-s1", file: "/w/a.ts" }]);
    expect(asks.proposals(id)).toEqual([]);
  });
});

// An ask ends with its owner (#81): the turn running when it was asked, the
// session for one asked between turns, the agent for one no session owns.
describe("AsksStore — an ask ends with its owner", () => {
  const FORM = { mode: "form", fields: [] } as const;

  it("a turn's end cancels what that turn asked — and nothing asked between turns", async () => {
    const { asks, events, pending, startTurn } = harness();
    startTurn(null);
    const between = asks.open({ patchbaySessionId: S1 }, "question", null);
    asks.show(between.id, { kind: "question", message: "Sign in to the MCP server?", ask: FORM });
    startTurn("t1");
    const during = asks.open({ patchbaySessionId: S1 }, "command", { command: "npm test" });
    asks.show(during.id, { kind: "options", title: "Terminal", detail: "npm test", facts: [], options: OPTIONS });

    asks.endTurn(S1, "t1", false);
    pending[0]!.land();
    expect(await during.ending).toEqual({ end: "stop" });
    expect(await settledYet(between.ending)).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "permissionResolved", patchbayAskId: during.id });

    // another turn's end leaves it too; the session leaving does not
    asks.endTurn(S1, "t2", false);
    expect(await settledYet(between.ending)).toBe(false);
    asks.stopSession(S1);
    expect(await between.ending).toEqual({ end: "stop" });
  });

  it("a stop the user asked for also cancels every permission still pending, whenever it was asked — the spec's MUST", async () => {
    const { asks, pending, startTurn } = harness();
    startTurn(null);
    const permission = asks.open({ patchbaySessionId: S1 }, "permission", { tool: "Edit", files: [] });
    const question = asks.open({ patchbaySessionId: S1 }, "question", null);
    startTurn("t1");

    asks.endTurn(S1, "t1", false);
    expect(await settledYet(permission.ending)).toBe(false);
    asks.endTurn(S1, "t1", true);
    pending[0]!.land();
    expect(await permission.ending).toEqual({ end: "stop" });
    expect(await settledYet(question.ending)).toBe(false);
  });

  it("a question no session owns shows on its agent, and only its agent's connection ending stops it", async () => {
    const { asks, events, agentEvents } = harness();
    const agent = "a1" as PatchbayAgentId;
    const { id, ending } = asks.open({ patchbayAgentId: agent }, "question", null);
    asks.show(id, { kind: "question", message: "Sign in and enter this code: ABCD", ask: FORM });
    expect(events).toEqual([]);
    expect(agentEvents).toEqual([
      { patchbayAgentId: agent, event: { kind: "elicitationRequested", patchbayAskId: id, message: "Sign in and enter this code: ABCD", ...FORM } },
    ]);

    asks.stopSession(S1);
    asks.stopAgent("a2" as PatchbayAgentId);
    expect(await settledYet(ending)).toBe(false);
    asks.stopAgent(agent);
    expect(await ending).toEqual({ end: "stop" });
    expect(agentEvents.at(-1)).toEqual({ patchbayAgentId: agent, event: { kind: "elicitationResolved", patchbayAskId: id, outcome: "cancelled" } });
  });
});

// What was opened to decide an ask — the diff editor's tabs — goes when the
// ask does, however it ends (#90): the store says so once, as it leaves open.
describe("AsksStore — an ask's end is said once", () => {
  const change = { path: "/w/a.ts", oldText: "a", newText: "b" };
  const card = { kind: "write" as const, file: "/w/a.ts", additions: 1, deletions: 1, preview: [], proposals: [change] };

  it("each way out of open says it — the user, a rule, a stop, a withdrawal — and nothing after", async () => {
    const { asks, ended, pending } = harness();
    const user = asks.open({ patchbaySessionId: S1 }, "write", { file: "/w/a.ts" });
    asks.show(user.id, card);
    expect(asks.proposals(user.id)).toEqual([change]);
    asks.answerWrite(user.id, true);
    asks.answerWrite(user.id, false); // a second click moves nothing
    const rule = asks.open({ patchbaySessionId: S1 }, "write", { file: "/w/a.ts" });
    asks.show(rule.id, { ...card, proposals: [] });
    asks.allow(rule.id);
    const stopped = asks.open({ patchbaySessionId: S1 }, "permission", { tool: "Edit" });
    asks.show(stopped.id, { kind: "options", title: "Edit", detail: "", facts: [], options: [], proposals: [change] });
    asks.stopSession(S1);
    const withdrawn = asks.open({ patchbaySessionId: S1 }, "permission", { tool: "Edit" });
    asks.withdraw(withdrawn.id);
    for (const p of pending) p.land();
    expect(ended).toEqual([user.id, rule.id, stopped.id, withdrawn.id]);
    expect(asks.proposals(user.id)).toEqual([]);
    expect(asks.proposals(stopped.id)).toEqual([]);
  });
});

