// What a session's sub-agents read as: marks in the session vocabulary, a
// last-known look for work no longer confirmed, the words for each state,
// the roster's tree order, and the chip's summary.
import { describe, expect, it } from "vitest";
import { cancelOffered, knobText, rosterRows, rosterSummary, subagentLook, subagentName, subagentStateText } from "../src/webview/agent-view/subagent-controls";
import type { PatchbaySessionId } from "../src/shared/ids";
import type { SubagentView } from "../src/shared/protocol";

const ROOT = "root" as PatchbaySessionId;
const view = (over: Partial<SubagentView> = {}): SubagentView => ({
  id: "root/c" as PatchbaySessionId,
  parentId: ROOT,
  title: "Explore",
  description: null,
  conversationTitle: null,
  state: null,
  lastKnown: null,
  cancel: false,
  cwd: null,
  additionalDirectories: null,
  config: [],
  ...over,
});

describe("subagentLook — the session marks, and one look of its own", () => {
  it("at work is the session's mark: waiting on you, running", () => {
    expect(subagentLook(view({ state: { state: "requires_action" } }))).toEqual({ mark: "waiting" });
    expect(subagentLook(view({ state: { state: "running" } }))).toEqual({ mark: "running" });
  });

  it("work no longer confirmed is never shown live — it keeps what it was last seen doing", () => {
    expect(subagentLook(view({ state: { state: "unknown" }, lastKnown: { state: "running" } }))).toEqual({ mark: "unknown", last: "running" });
    expect(subagentLook(view({ state: null, lastKnown: { state: "requires_action" } }))).toEqual({ mark: "unknown", last: "waiting" });
    expect(subagentLook(view({ state: { state: "unknown" }, lastKnown: null }))).toEqual({ mark: "unknown", last: null });
  });

  it("idle, history, or a state the spec leaves open carries no mark", () => {
    expect(subagentLook(view({ state: { state: "idle", stopReason: "end_turn" } }))).toEqual({ mark: null });
    expect(subagentLook(view({ state: null, lastKnown: { state: "idle" } }))).toEqual({ mark: null });
    expect(subagentLook(view({ state: { state: "_paused" } }))).toEqual({ mark: null });
  });
});

describe("subagentStateText", () => {
  it("says what it does, or why it stopped", () => {
    expect(subagentStateText(view({ state: { state: "running" } }))).toBe("running");
    expect(subagentStateText(view({ state: { state: "requires_action" } }))).toBe("waiting on you");
    expect(subagentStateText(view({ state: { state: "idle", stopReason: "end_turn" } }))).toBe("idle");
    expect(subagentStateText(view({ state: { state: "idle", stopReason: "cancelled" } }))).toBe("cancelled");
    expect(subagentStateText(view({ state: { state: "idle", stopReason: "error", error: "Authentication required" } }))).toBe("failed: Authentication required");
    expect(subagentStateText(view({ state: { state: "idle", stopReason: "max_tokens" } }))).toBe("idle · max_tokens");
    expect(subagentStateText(view({ state: { state: "_paused" } }))).toBe("_paused");
  });

  it("an unconfirmed or unknown state says what was last known", () => {
    expect(subagentStateText(view({ state: null, lastKnown: null }))).toBe("nothing reported");
    expect(subagentStateText(view({ state: null, lastKnown: { state: "running" } }))).toBe("not confirmed — last running");
    expect(subagentStateText(view({ state: { state: "unknown" }, lastKnown: { state: "requires_action" } }))).toBe("unknown — last waiting on you");
  });
});

describe("cancelOffered", () => {
  it("only where the agent granted it, and only while there is work to cancel", () => {
    expect(cancelOffered(view({ cancel: true, state: { state: "running" } }))).toBe(true);
    expect(cancelOffered(view({ cancel: true, state: { state: "unknown" }, lastKnown: { state: "running" } }))).toBe(true);
    expect(cancelOffered(view({ cancel: false, state: { state: "running" } }))).toBe(false);
    expect(cancelOffered(view({ cancel: true, state: { state: "idle", stopReason: "end_turn" } }))).toBe(false);
  });
});

describe("subagentName", () => {
  it("the parent's label, then its own title, then its role — never blank", () => {
    expect(subagentName(view())).toBe("Explore");
    expect(subagentName(view({ title: null, conversationTitle: "Own" }))).toBe("Own");
    expect(subagentName(view({ title: null, description: "general-purpose" }))).toBe("general-purpose");
    expect(subagentName(view({ title: null }))).toBe("Sub-agent");
  });
});

describe("rosterRows", () => {
  it("tree order: each in announced order, its own under it", () => {
    const a = view({ id: "root/a" as PatchbaySessionId, title: "a" });
    const b = view({ id: "root/b" as PatchbaySessionId, title: "b" });
    const a1 = view({ id: "root/a1" as PatchbaySessionId, parentId: a.id, title: "a1" });
    expect(rosterRows([a, b, a1], ROOT).map((r) => [r.subagent.title, r.depth])).toEqual([
      ["a", 0],
      ["a1", 1],
      ["b", 0],
    ]);
  });
});

describe("rosterSummary", () => {
  it("counts, and the most urgent look: waiting, then running, then unconfirmed", () => {
    const running = view({ state: { state: "running" } });
    const waiting = view({ state: { state: "requires_action" } });
    const lost = view({ state: { state: "unknown" }, lastKnown: { state: "running" } });
    const done = view({ state: { state: "idle" } });
    expect(rosterSummary([done])).toEqual({ label: "1 sub-agent", look: { mark: null } });
    expect(rosterSummary([running, done, lost])).toEqual({ label: "3 sub-agents · 1 running", look: { mark: "running" } });
    expect(rosterSummary([running, waiting])).toEqual({ label: "2 sub-agents · 1 running · 1 waiting on you", look: { mark: "waiting" } });
    expect(rosterSummary([done, lost])).toEqual({ label: "2 sub-agents", look: { mark: "unknown", last: "running" } });
  });
});

describe("knobText", () => {
  it("the setting's name and the chosen value's — or the value as sent", () => {
    const options = [
      { value: "haiku", name: "Haiku" },
      { value: "opus", name: "Opus" },
    ];
    expect(knobText({ id: "model", name: "Model", type: "select", currentValue: "haiku", options })).toBe("Model: Haiku");
    expect(knobText({ id: "agent", name: "Agent", type: "select", currentValue: "general-purpose", options: [] })).toBe("Agent: general-purpose");
    expect(knobText({ id: "t", name: "Think", type: "boolean", currentValue: true })).toBe("Think: on");
  });
});
