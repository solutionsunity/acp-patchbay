// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The asks store's one writer: an ask ends once, as MOVES allows, and the
// end writes its card, its record and its caller's answer together — in
// that order. An answer that doesn't fit its ask moves nothing.
import { describe, expect, it } from "vitest";
import { AsksStore, type AskEnding } from "../src/orchestrator/asks-store";
import type { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
import type { AgentViewEvent, PermissionOptionView } from "../src/shared/protocol";
import type { PatchbayAgentId, PatchbaySessionId } from "../src/shared/ids";

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
  const held = heldAudit();
  const asks = new AsksStore(held.audit, {
    emit: (...evs) => events.push(...evs),
    onAuditWritten: () => {},
    pairOf: () => ({ patchbayAgentId: "a1" as PatchbayAgentId, sessionId: "agent-s1" }),
  });
  return { asks, events, ...held };
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
    const { id, ending } = asks.open(S1, "permission", { tool: "Edit", files: [] });
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
    const { id, ending } = asks.open(S1, "write", { file: "/w/a.ts" });
    asks.show(id, { kind: "write", file: "/w/a.ts", additions: 1, deletions: 0, lines: [], proposal: null });
    asks.answerOption(id, "y");
    expect(await settledYet(ending)).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(["diffProposed"]);
  });
});

describe("AsksStore — the record before the answer", () => {
  it("the caller hears the ending only once its record is written — no action runs ahead of it", async () => {
    const { asks, events, lines, pending } = harness();
    const { id, ending } = asks.open(S1, "command", { command: "npm test", cwd: "/w", env: [] });
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
    const { id, ending } = asks.open(S1, "write", { file: "/w/a.ts" });
    asks.show(id, { kind: "write", file: "/w/a.ts", additions: 1, deletions: 0, lines: [], proposal: null });
    asks.answerWrite(id, true);
    pending[0]!.fail(new Error("disk full"));
    await expect(ending).rejects.toThrow("disk full");
  });

  it("a question is never recorded — its answer reaches the caller at once", async () => {
    const { asks, pending } = harness();
    const { id, ending } = asks.open(S1, "question", null);
    asks.show(id, { kind: "question", message: "Which?", ask: { mode: "form", fields: [] } });
    asks.answerQuestion(id, { action: "decline" });
    expect(await ending).toEqual({ end: "user", choice: { kind: "answer", answer: { action: "decline" } } });
    expect(pending).toHaveLength(0);
  });
});

describe("AsksStore — an ask that ends before its card shows", () => {
  it("leaves no card: the show that follows is a no-op, and the stop is on the record", async () => {
    const { asks, events, lines, pending } = harness();
    const { id, ending } = asks.open(S1, "write", { file: "/w/a.ts" });
    asks.stopSession(S1);
    asks.show(id, { kind: "write", file: "/w/a.ts", additions: 1, deletions: 0, lines: [], proposal: { path: "/w/a.ts", oldText: "", newText: "x" } });
    asks.allow(id); // a rule's verdict that comes too late
    pending[0]!.land();
    expect(await ending).toEqual({ end: "stop" });
    expect(events).toEqual([]);
    expect(lines).toEqual([{ kind: "turn-cancelled", patchbayAgentId: "a1", sessionId: "agent-s1", file: "/w/a.ts" }]);
    expect(asks.proposal(id)).toBeNull();
  });
});
