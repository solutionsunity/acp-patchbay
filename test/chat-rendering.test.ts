// Chat rendering gate, reducer/view-model side: the transcript view-model
// (grouping, per-turn rollups, the live-block contract), permission-denied
// distinct from failed, and the coalescer's field-merge rule.
import { describe, expect, it } from "vitest";
import { assertKind } from "./support/assert-kind";
import {
  deriveTranscript,
  formatDuration,
  TOOL_RUN_MIN,
} from "../src/webview/agent-view/chat/view-model";
import {
  coalesceAgentViewEvent,
  initialAgentViewState,
  reduceAgentView,
  type AgentViewEvent,
  type ChatBlock,
  type ToolCallBlock,
} from "../src/shared/protocol";

const S = "sess";

function tool(id: string, over: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return {
    kind: "toolCall",
    id,
    title: id,
    status: "completed",
    toolKind: "other",
    input: null,
    output: null,
    locations: [],
    diffFiles: [],
    denied: false,
    ...over,
  };
}

function text(id: string): ChatBlock {
  return { kind: "text", id, text: "prose" };
}

describe("deriveTranscript: grouping (sequential tool-call runs)", () => {
  it("collapses runs of >= TOOL_RUN_MIN consecutive tool calls, preserving order", () => {
    const blocks = [text("a"), tool("t1"), tool("t2"), tool("t3"), text("b")];
    const { items } = deriveTranscript(blocks, false);
    expect(items.map((i) => i.kind)).toEqual(["single", "toolRun", "single"]);
    const run = assertKind(items[1], "toolRun");
    expect(run.calls.map((c) => c.id)).toEqual(["t1", "t2", "t3"]);
    expect(TOOL_RUN_MIN).toBe(3);
  });

  it("leaves short runs as individual cards", () => {
    const { items } = deriveTranscript([tool("t1"), tool("t2"), text("a")], false);
    expect(items.map((i) => i.kind)).toEqual(["single", "single", "single"]);
  });

  it("any intervening block splits a run — order is never re-bucketed", () => {
    const { items } = deriveTranscript(
      [tool("t1"), tool("t2"), text("a"), tool("t3"), tool("t4"), tool("t5")],
      false,
    );
    expect(items.map((i) => i.kind)).toEqual(["single", "single", "single", "toolRun"]);
  });

  it("a trailing live run still groups (the summary row carries the in-flight call)", () => {
    const { items } = deriveTranscript([tool("t1"), tool("t2"), tool("t3", { status: "in_progress" })], true);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("toolRun");
  });
});

describe("deriveTranscript: the live-block contract (stream/end)", () => {
  it("live turn + trailing prose block → that block is live", () => {
    const { liveBlockId } = deriveTranscript([text("a"), { kind: "thought", id: "th", text: "…" }], true);
    expect(liveBlockId).toBe("th");
  });

  it("a trailing tool call is 'waiting on a tool', never a live prose block", () => {
    const { liveBlockId } = deriveTranscript([text("a"), tool("t1", { status: "in_progress" })], true);
    expect(liveBlockId).toBeNull();
  });

  it("turn ended → nothing is live, whatever the last block is", () => {
    const { liveBlockId } = deriveTranscript([text("a")], false);
    expect(liveBlockId).toBeNull();
  });
});

describe("toolCallDenied (P13b permission-denied ≠ failed)", () => {
  it("marks the block denied in place; a later failed status keeps the denied fact", () => {
    const events: AgentViewEvent[] = [
      { kind: "sessionCreated", session: { id: S, agentId: "a", title: "t", live: true, emulated: false, branchOf: null } },
      { kind: "toolCallUpserted", sessionId: S, blockId: "t1", title: "rm -rf", status: "in_progress", toolKind: "execute" },
      { kind: "toolCallDenied", sessionId: S, blockId: "t1" },
      { kind: "toolCallUpserted", sessionId: S, blockId: "t1", title: "", status: "failed" },
    ];
    const state = events.reduce(reduceAgentView, initialAgentViewState);
    const block = state.transcripts[S]![0];
    expect(block).toMatchObject({
      kind: "toolCall",
      status: "failed",
      denied: true,
      title: "rm -rf",
      toolKind: "execute",
    });
  });

  it("denied for an unknown block is a no-op, never a crash", () => {
    const state = reduceAgentView(initialAgentViewState, {
      kind: "toolCallDenied",
      sessionId: S,
      blockId: "ghost",
    });
    expect(state.transcripts[S]).toBeUndefined();
  });
});

describe("toolCallUpserted merge semantics (P13b)", () => {
  it("reducer: absent fields keep what a prior event established", () => {
    const events: AgentViewEvent[] = [
      { kind: "sessionCreated", session: { id: S, agentId: "a", title: "t", live: true, emulated: false, branchOf: null } },
      { kind: "toolCallUpserted", sessionId: S, blockId: "t1", title: "Read", status: "in_progress", toolKind: "read", input: "{ path }" },
      { kind: "toolCallUpserted", sessionId: S, blockId: "t1", title: "", status: "completed", output: "contents" },
    ];
    const state = events.reduce(reduceAgentView, initialAgentViewState);
    expect(state.transcripts[S]![0]).toMatchObject({
      title: "Read",
      status: "completed",
      toolKind: "read",
      input: "{ path }",
      output: "contents",
    });
  });

  it("coalescer: same merge rule when events collapse in the bus", () => {
    const prev: AgentViewEvent = {
      kind: "toolCallUpserted", sessionId: S, blockId: "t1",
      title: "Read", status: "in_progress", toolKind: "read", input: "{ path }",
    };
    const next: AgentViewEvent = {
      kind: "toolCallUpserted", sessionId: S, blockId: "t1",
      title: "", status: "completed", output: "contents",
    };
    expect(coalesceAgentViewEvent(prev, next)).toMatchObject({
      title: "Read",
      status: "completed",
      toolKind: "read",
      input: "{ path }",
      output: "contents",
    });
  });
});

describe("deriveTranscript: per-turn rollups", () => {
  const turnEnd = (id: string): ChatBlock => ({
    kind: "turnEnd", id, startedAt: "2026-07-07T10:00:00Z", endedAt: "2026-07-07T10:01:29Z",
    stopReason: "end_turn", usage: null,
  });
  const user = (id: string): ChatBlock => ({ kind: "user", id, text: "go" });

  it("counts tool calls and DEDUPES files — 3 edits to one file is 1 file, not 3", () => {
    const blocks: ChatBlock[] = [
      user("u1"),
      tool("t1", { toolKind: "edit", locations: ["/ws/a.ts"] }),
      tool("t2", { toolKind: "edit", locations: ["/ws/a.ts"] }),
      tool("t3", { toolKind: "edit", locations: ["/ws/a.ts", "/ws/b.ts"] }),
      tool("t4", { toolKind: "read", locations: ["/ws/c.ts"] }), // reads never count as touched
      turnEnd("e1"),
    ];
    const r = deriveTranscript(blocks, false).rollups.get("e1")!;
    expect(r.toolCalls).toBe(4);
    expect(r.filesTouched).toBe(2);
    expect(r.byKind).toEqual({ edit: 3, read: 1 });
  });

  it("the rollup spans only its own turn — earlier turns are behind a boundary", () => {
    const blocks: ChatBlock[] = [
      user("u1"),
      tool("t1", { toolKind: "execute" }),
      turnEnd("e1"),
      user("u2"),
      tool("t2", { toolKind: "search" }),
      tool("t3", { toolKind: "search" }),
      turnEnd("e2"),
    ];
    const { rollups } = deriveTranscript(blocks, false);
    expect(rollups.get("e2")).toEqual({ toolCalls: 2, filesTouched: 0, byKind: { search: 2 } });
    expect(rollups.get("e1")).toEqual({ toolCalls: 1, filesTouched: 0, byKind: { execute: 1 } });
  });

  it("formatDuration: seconds, minutes, hours", () => {
    expect(formatDuration("2026-07-07T10:00:00Z", "2026-07-07T10:00:12Z")).toBe("12s");
    expect(formatDuration("2026-07-07T10:00:00Z", "2026-07-07T10:01:29Z")).toBe("1m 29s");
    expect(formatDuration("2026-07-07T10:00:00Z", "2026-07-07T11:02:00Z")).toBe("1h 02m");
  });
});

describe("turn lifecycle reducer (P13c)", () => {
  it("turnStarted sets the ticker basis; turnEnded clears it and appends the block", () => {
    const events: AgentViewEvent[] = [
      { kind: "sessionCreated", session: { id: S, agentId: "a", title: "t", live: true, emulated: false, branchOf: null } },
      { kind: "turnStarted", sessionId: S, at: "2026-07-07T10:00:00Z" },
    ];
    const mid = events.reduce(reduceAgentView, initialAgentViewState);
    expect(mid.activeTurn[S]).toBe("2026-07-07T10:00:00Z");

    const done = reduceAgentView(mid, {
      kind: "turnEnded", sessionId: S, blockId: "e1",
      startedAt: "2026-07-07T10:00:00Z", at: "2026-07-07T10:00:05Z",
      stopReason: "cancelled", usage: null,
    });
    expect(done.activeTurn[S]).toBeUndefined();
    expect(done.transcripts[S]![done.transcripts[S]!.length - 1]).toMatchObject({
      kind: "turnEnd",
      stopReason: "cancelled",
    });
  });
});

describe("transcriptSeeded normalization", () => {
  it("legacy persisted toolCall blocks (pre-P13b/c schema) gain the fields the live model grew", () => {
    const legacy = { kind: "toolCall", id: "t1", title: "Read", status: "completed" } as unknown as ChatBlock;
    const state = reduceAgentView(initialAgentViewState, {
      kind: "transcriptSeeded",
      sessionId: S,
      blocks: [legacy],
    });
    expect(state.transcripts[S]![0]).toEqual({
      kind: "toolCall", id: "t1", title: "Read", status: "completed",
      toolKind: "other", input: null, output: null, locations: [], diffFiles: [], denied: false,
    });
  });
});
