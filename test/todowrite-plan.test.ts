// Wire-extension gate: a to-do list sent as a tool call is the session's
// plan. A write that completes becomes the plan and never shows a card; a
// write that doesn't — failed, rejected, unreadable, stranded — lands as
// the agent sent it. The frames are OpenCode 1.18.35's, captured live
// (the list's JSON text trimmed from `content`/`output`; nothing reads it).
import { beforeEach, describe, expect, it } from "vitest";
import { fakeAgent } from "./support/fake-agent";
import { tempDir } from "./support/teardown";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ToolCallReading } from "../src/orchestrator/extensions";
import { createTodoWritePlanRewriter } from "../src/orchestrator/extensions/todowrite-plan";
import type { PatchbayAgentId } from "../src/shared/ids";
import { orchestratorHarness } from "./support/orchestrator-harness";
import { readUpdate } from "./support/read-update";

const TODOS = [
  { content: "read README", status: "completed", priority: "high" },
  { content: "list files", status: "completed", priority: "medium" },
  { content: "draft summary", status: "pending", priority: "low" },
  { content: "publish summary", status: "cancelled", priority: "medium" },
];

/** One live write, as the agent sends it. */
function liveWrite(id: string, todos: unknown[], end: "completed" | "failed"): SessionUpdate[] {
  return [
    { sessionUpdate: "tool_call", toolCallId: id, title: "todowrite", kind: "other", status: "pending", locations: [], rawInput: {} },
    { sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", kind: "other", title: "todowrite", locations: [], rawInput: { todos } },
    end === "completed"
      ? {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: "completed",
          title: `${todos.filter((t) => (t as { status: string }).status !== "completed").length} todos`,
          content: [{ type: "content", content: { type: "text", text: "[…]" } }],
          rawOutput: { output: "[…]", metadata: { todos, truncated: false } },
        }
      : {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: "failed",
          kind: "other",
          title: "todowrite",
          locations: [],
          rawInput: { todos },
          content: [{ type: "content", content: { type: "text", text: "The user rejected permission to use this specific tool call." } }],
          rawOutput: { error: "The user rejected permission to use this specific tool call." },
        },
  ];
}

/** Every frame through one rewriter, in order: what each push handed out. */
function run(frames: SessionUpdate[]): ToolCallReading[][] {
  const r = createTodoWritePlanRewriter();
  return frames.map((f) => {
    const fact = readUpdate(f);
    if (fact.kind !== "toolCall") throw new Error("not a tool call");
    return r.push(fact);
  });
}

const kinds = (out: ToolCallReading[][]) => out.map((o) => o.map((r) => r.kind));

describe("todowrite plan rewriter", () => {
  it("a completed write is the plan, its stored list as said — `cancelled` kept, no card", () => {
    const out = run(liveWrite("w-1", TODOS, "completed"));
    expect(kinds(out)).toEqual([[], [], ["plan"]]);
    expect(out[2]![0]).toEqual({ kind: "plan", entries: TODOS });
  });

  it("the proposed list is never the plan: a rejected write lands as sent, frames in order", () => {
    const out = run(liveWrite("w-1", TODOS, "failed"));
    expect(kinds(out)).toEqual([[], [], ["toolCall", "toolCall", "toolCall"]]);
    expect(out[2]!.map((r) => (r.kind === "toolCall" ? [r.announced, r.call.status] : null))).toEqual([
      [true, "pending"],
      [false, "in_progress"],
      [false, "failed"],
    ]);
  });

  it("a replayed write — titled by its count, the list in rawInput — is the plan too", () => {
    const out = run([
      { sessionUpdate: "tool_call", toolCallId: "w-1", title: "2 todos", kind: "other", status: "pending", locations: [], rawInput: { todos: TODOS } },
      { sessionUpdate: "tool_call_update", toolCallId: "w-1", status: "completed", title: "2 todos", rawOutput: { output: "[…]", metadata: { todos: TODOS } } },
    ]);
    expect(out).toEqual([[], [{ kind: "plan", entries: TODOS }]]);
  });

  it("a completed write whose stored list doesn't read lands as sent", () => {
    const out = run([
      { sessionUpdate: "tool_call", toolCallId: "w-1", title: "todowrite", kind: "other", rawInput: {} },
      { sessionUpdate: "tool_call_update", toolCallId: "w-1", status: "completed", rawOutput: { output: "done" } },
    ]);
    expect(kinds(out)).toEqual([[], ["toolCall", "toolCall"]]);
  });

  it("a write still open is released whole, once", () => {
    const r = createTodoWritePlanRewriter();
    for (const f of liveWrite("w-1", TODOS, "completed").slice(0, 2)) {
      const fact = readUpdate(f);
      if (fact.kind === "toolCall") r.push(fact);
    }
    expect(r.release().map((f) => f.call.status)).toEqual(["pending", "in_progress"]);
    expect(r.release()).toEqual([]);
  });

  it("any other call passes untouched — another title, another kind, an unannounced update", () => {
    const frames: SessionUpdate[] = [
      { sessionUpdate: "tool_call", toolCallId: "a", title: "Read a.ts", kind: "other", rawInput: {} },
      { sessionUpdate: "tool_call", toolCallId: "b", title: "todowrite", kind: "edit", rawInput: {} },
      { sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed", rawOutput: { metadata: { todos: TODOS } } },
    ];
    expect(kinds(run(frames))).toEqual([["toolCall"], ["toolCall"], ["toolCall"]]);
  });
});

let cwd: string;
beforeEach(async () => {
  cwd = await tempDir("patchbay-todowrite-");
});

describe("todowrite plan, end to end", () => {
  it("the plan chip holds the stored list, the transcript only the write that failed — live, and replayed by a reload", async () => {
    const h = orchestratorHarness(cwd);
    const { pool, sessionGates: gates } = h.orchestrator;
    const agent = "opencode-like" as PatchbayAgentId;
    const turn = [
      ...liveWrite("w-1", TODOS, "completed"),
      ...liveWrite("w-2", [{ content: "never stored", status: "pending", priority: "low" }], "failed"),
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
    ] satisfies SessionUpdate[];
    await pool.connect(fakeAgent({ declare: { loadSession: true }, turn: turn.map((update) => ({ type: "update", update })) }, agent, cwd));
    const id = await gates.create(agent, "Fake Agent", cwd);
    await gates.prompt(id, { text: "go" });

    const seen = () => ({
      plan: h.agentView.state().activePlan[id],
      calls: (h.agentView.state().transcripts[id] ?? []).flatMap((b) => (b.kind === "toolCall" ? [[b.id, b.status]] : [])),
    });
    const expected = { plan: TODOS, calls: [["w-2", "failed"]] };
    expect(seen()).toEqual(expected);

    await gates.reload(id);
    expect(seen()).toEqual(expected);
    await pool.stop(agent);
  });
});
