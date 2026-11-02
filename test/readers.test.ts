// The readers: what patchbay takes from an agent's message. An absent field
// stays absent (an update says only what changed), the spec's own defaults
// apply only where the spec names them, fields nothing renders yet are
// carried, and what a reader can't take is noted — once.
import { describe, expect, it, vi } from "vitest";
import type { SessionUpdate } from "../src/orchestrator/acp";
import { RequestError } from "../src/orchestrator/acp";
import { agentErrorText } from "../src/orchestrator/readers/agent-error";
import { forModelOnly, readContent } from "../src/orchestrator/readers/content";
import { NoteLog } from "../src/orchestrator/readers/notes";
import { readSessionUpdate, sessionMetaOf } from "../src/orchestrator/readers/session-update";
import { readToolCall, readToolCallAnnounced } from "../src/orchestrator/readers/tool-call";
import { nullLogger } from "../src/orchestrator/logger";

describe("readToolCall", () => {
  it("an update carries only what it sent — nothing absent is defaulted", () => {
    expect(readToolCall({ toolCallId: "t1", rawInput: { path: "a" } })).toEqual({ toolCallId: "t1", rawInput: { path: "a" } });
    expect(readToolCall({ toolCallId: "t1", status: null, title: null, kind: null, content: null, locations: null })).toEqual({
      toolCallId: "t1",
    });
    // an empty title names nothing — the card keeps the one it has
    expect(readToolCall({ toolCallId: "t1", title: "" })).toEqual({ toolCallId: "t1" });
  });

  it("an announcement takes the spec's defaults for what it leaves out: pending, other", () => {
    expect(readToolCallAnnounced({ toolCallId: "t1", title: "Read" })).toMatchObject({ status: "pending", kind: "other", title: "Read" });
    expect(readToolCallAnnounced({ toolCallId: "t1", title: "Run", kind: "execute", status: "in_progress" })).toMatchObject({
      status: "in_progress",
      kind: "execute",
    });
  });

  it("locations keep the path and the line; 0 reads as the first line; no line stays none", () => {
    expect(
      readToolCall({
        toolCallId: "t1",
        locations: [{ path: "/ws/a.ts", line: 42 }, { path: "/ws/b.ts", line: 0 }, { path: "/ws/c.ts", line: null }, { path: "/ws/d.ts" }],
      }).locations,
    ).toEqual([
      { path: "/ws/a.ts", line: 42 },
      { path: "/ws/b.ts", line: 1 },
      { path: "/ws/c.ts", line: null },
      { path: "/ws/d.ts", line: null },
    ]);
  });

  it("carries the tool's name, every content entry and the call's _meta for the extension modules", () => {
    const call = readToolCall({
      toolCallId: "t1",
      name: "bash",
      content: [
        { type: "terminal", terminalId: "x" },
        { type: "diff", path: "/a", newText: "n" },
        { type: "diff", path: "/b", oldText: "o", newText: "n" },
      ],
      _meta: { vendor: 1 },
    });
    expect(call).toMatchObject({ name: "bash", meta: { vendor: 1 } });
    expect(call.content).toEqual([
      { type: "terminal", terminalId: "x" },
      { type: "diff", path: "/a", newText: "n" },
      { type: "diff", path: "/b", oldText: "o", newText: "n" },
    ]);
  });
});

describe("readContent", () => {
  it("a link keeps everything it was sent with; an audience rides along", () => {
    expect(
      readContent({
        type: "resource_link",
        uri: "file:///a",
        name: "a",
        title: "A",
        description: "d",
        mimeType: "text/plain",
        size: 3,
        annotations: { audience: ["assistant"] },
      }),
    ).toEqual({ type: "resource_link", uri: "file:///a", name: "a", title: "A", description: "d", mimeType: "text/plain", size: 3, audience: ["assistant"] });
  });

  it("an image with no bytes carries none — only its uri", () => {
    expect(readContent({ type: "image", data: "", mimeType: "image/png", uri: "https://x/a.png" })).toEqual({
      type: "image",
      mimeType: "image/png",
      uri: "https://x/a.png",
    });
  });

  it("an embedded resource is its text, or its bytes", () => {
    expect(readContent({ type: "resource", resource: { uri: "u", text: "t" } })).toEqual({ type: "resource", uri: "u", text: "t" });
    expect(readContent({ type: "resource", resource: { uri: "u", blob: "b", mimeType: "image/png" } })).toEqual({
      type: "resource",
      uri: "u",
      blob: "b",
      mimeType: "image/png",
    });
  });
});

describe("forModelOnly", () => {
  it("content is for the model alone when its audience names no user; no audience is everyone's", () => {
    expect(forModelOnly({ type: "text", text: "x", audience: ["assistant"] })).toBe(true);
    expect(forModelOnly({ type: "text", text: "x", audience: ["user", "assistant"] })).toBe(false);
    expect(forModelOnly({ type: "text", text: "x", audience: ["user"] })).toBe(false);
    expect(forModelOnly({ type: "text", text: "x" })).toBe(false);
  });
});

describe("readSessionUpdate", () => {
  const note = () => {};

  it("a kind with no surface is carried — its name and payload — and noted", () => {
    const said = vi.fn();
    const fact = readSessionUpdate({ sessionUpdate: "plan_removed", planId: "p-1" } as SessionUpdate, said);
    expect(fact).toEqual({ kind: "carried", updateKind: "plan_removed", payload: { planId: "p-1" } });
    expect(said).toHaveBeenCalledWith("plan_removed has no surface yet — shown as the agent sent it");
  });

  it("a sub-agent's association keeps the patch rules: absent is unchanged, null clears, a value replaces", () => {
    // the announcement, as claude-agent-acp 0.100.0 sends it
    expect(
      readSessionUpdate(
        { sessionUpdate: "subagent_update", sessionId: "c1", title: "Count lines", description: "general-purpose", state: { state: "running" }, capabilities: { cancel: {} } },
        note,
      ),
    ).toEqual({
      kind: "subagent",
      childSessionId: "c1",
      patch: { title: "Count lines", description: "general-purpose", state: { state: "running" }, capabilities: { cancel: true } },
    });
    // only the child named: nothing else moves
    expect(readSessionUpdate({ sessionUpdate: "subagent_update", sessionId: "c1" }, note)).toEqual({ kind: "subagent", childSessionId: "c1", patch: {} });
    // every field cleared
    expect(
      readSessionUpdate(
        { sessionUpdate: "subagent_update", sessionId: "c1", title: null, description: null, state: null, capabilities: null, cwd: null, additionalDirectories: null },
        note,
      ),
    ).toEqual({
      kind: "subagent",
      childSessionId: "c1",
      patch: { title: null, description: null, state: null, capabilities: null, cwd: null, additionalDirectories: null },
    });
  });

  it("a sub-agent's capabilities are replaced whole: an absent or null cancel grants nothing", () => {
    for (const capabilities of [{}, { cancel: null }]) {
      expect(readSessionUpdate({ sessionUpdate: "subagent_update", sessionId: "c1", capabilities }, note)).toMatchObject({ patch: { capabilities: { cancel: false } } });
    }
  });

  it("a sub-agent's state is kept as sent — a stop reason and its error only on idle, an open value as it came", () => {
    const state = (s: unknown) => (readSessionUpdate({ sessionUpdate: "subagent_update", sessionId: "c1", state: s } as SessionUpdate, note) as { patch: { state?: unknown } }).patch.state;
    expect(state({ state: "idle", stopReason: "cancelled" })).toEqual({ state: "idle", stopReason: "cancelled" });
    expect(state({ state: "idle", stopReason: null })).toEqual({ state: "idle" });
    expect(state({ state: "idle", stopReason: "error", error: { code: -32000, message: "Authentication required" } })).toEqual({
      state: "idle",
      stopReason: "error",
      error: "Authentication required",
    });
    expect(state({ state: "requires_action" })).toEqual({ state: "requires_action" });
    expect(state({ state: "unknown" })).toEqual({ state: "unknown" });
    expect(state({ state: "_vendor_paused", reason: "x" })).toEqual({ state: "_vendor_paused" });
  });

  it("a sub-agent's directories must be absolute — a relative one is noted and left out", () => {
    const said = vi.fn();
    expect(
      readSessionUpdate({ sessionUpdate: "subagent_update", sessionId: "c1", cwd: "/w/.worktrees/a", additionalDirectories: [] }, said),
    ).toMatchObject({ patch: { cwd: "/w/.worktrees/a", additionalDirectories: [] } });
    expect(readSessionUpdate({ sessionUpdate: "subagent_update", sessionId: "c1", cwd: "rel", additionalDirectories: ["/a", "b"] }, said)).toMatchObject({
      patch: { cwd: null, additionalDirectories: ["/a"] },
    });
    expect(said).toHaveBeenCalledTimes(2);
  });

  it("a session message keeps the patch rules: absent is unchanged, null clears, an empty content clears too", () => {
    expect(
      readSessionUpdate(
        { sessionUpdate: "session_message", messageId: "m1", senderSessionId: "p", recipientSessionId: "c1", recipientMessageId: "m9", content: [{ type: "text", text: "go" }] },
        note,
      ),
    ).toEqual({
      kind: "sessionMessage",
      messageId: "m1",
      patch: { senderSessionId: "p", recipientSessionId: "c1", recipientMessageId: "m9", content: [{ type: "text", text: "go" }] },
    });
    // a metadata-only upsert leaves the content where it was
    expect(readSessionUpdate({ sessionUpdate: "session_message", messageId: "m1", senderMessageId: "m0" }, note)).toEqual({
      kind: "sessionMessage",
      messageId: "m1",
      patch: { senderMessageId: "m0" },
    });
    expect(readSessionUpdate({ sessionUpdate: "session_message", messageId: "m1", senderSessionId: null, content: [] }, note)).toEqual({
      kind: "sessionMessage",
      messageId: "m1",
      patch: { senderSessionId: null, content: null },
    });
    expect(readSessionUpdate({ sessionUpdate: "session_message", messageId: "m1", content: null }, note)).toMatchObject({ patch: { content: null } });
  });

  it("a session message chunk is one content block for its message", () => {
    expect(readSessionUpdate({ sessionUpdate: "session_message_chunk", messageId: "m1", content: { type: "text", text: "more" } }, note)).toEqual({
      kind: "sessionMessageChunk",
      messageId: "m1",
      content: { type: "text", text: "more" },
    });
  });

  it("a notice is its severity hint, title and description — a null description is none", () => {
    expect(readSessionUpdate({ sessionUpdate: "notice", severity: "warning", title: "Model fallback", description: "Using a smaller model" }, note)).toEqual({
      kind: "notice",
      severity: "warning",
      title: "Model fallback",
      description: "Using a smaller model",
    });
    expect(readSessionUpdate({ sessionUpdate: "notice", severity: "info", title: "Heads up", description: null }, note)).toEqual({ kind: "notice", severity: "info", title: "Heads up" });
  });

  it("a usage update without a cost says nothing about the cost", () => {
    expect(readSessionUpdate({ sessionUpdate: "usage_update", used: 1, size: 2 }, note)).toEqual({ kind: "usage", used: 1, size: 2 });
  });

  it("a compaction keeps the spec's patch rules: absent is unchanged, null and an empty summary clear", () => {
    expect(readSessionUpdate({ sessionUpdate: "compaction_update", compactionId: "c", status: "in_progress" }, note)).toEqual({
      kind: "compaction",
      compactionId: "c",
      status: "in_progress",
    });
    expect(
      readSessionUpdate({ sessionUpdate: "compaction_update", compactionId: "c", status: "completed", summary: [{ type: "text", text: "kept" }] }, note),
    ).toEqual({ kind: "compaction", compactionId: "c", status: "completed", summary: [{ type: "text", text: "kept" }] });
    expect(readSessionUpdate({ sessionUpdate: "compaction_update", compactionId: "c", status: "completed", summary: [] }, note)).toMatchObject({ summary: null });
    expect(readSessionUpdate({ sessionUpdate: "compaction_update", compactionId: "c", status: "completed", summary: null, error: null }, note)).toMatchObject({
      summary: null,
      error: null,
    });
    expect(readSessionUpdate({ sessionUpdate: "compaction_update", compactionId: "c", status: "failed", error: "too long" }, note)).toMatchObject({ error: "too long" });
  });

  it("a compaction's summary chunk is one content block for its compaction", () => {
    expect(readSessionUpdate({ sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: { type: "text", text: "x" } }, note)).toEqual({
      kind: "compactionChunk",
      compactionId: "c",
      content: { type: "text", text: "x" },
    });
  });

  it("chunks name their channel and message", () => {
    const update: SessionUpdate = { sessionUpdate: "agent_thought_chunk", messageId: "m", content: { type: "text", text: "x" } };
    expect(readSessionUpdate(update, note)).toEqual({ kind: "chunk", channel: "thought", messageId: "m", content: { type: "text", text: "x" } });
  });
});

describe("sessionMetaOf", () => {
  it("a null title is silence; a stamp that isn't a date is ignored, and noted", () => {
    const said = vi.fn();
    expect(sessionMetaOf({ title: null, updatedAt: "yesterday" }, said)).toEqual({});
    expect(said).toHaveBeenCalledTimes(1);
    expect(sessionMetaOf({ title: "T", updatedAt: "2026-10-07T10:00:00Z" }, said)).toEqual({ title: "T", updatedAt: "2026-10-07T10:00:00Z" });
  });
});

describe("NoteLog", () => {
  it("says each note once per agent and place — a stream repeating itself is one line", () => {
    const info = vi.fn();
    const notes = new NoteLog({ ...nullLogger, info });
    const a = notes.at("claude", "session/update");
    a("x");
    a("x");
    notes.at("claude", "session/update")("x");
    notes.at("codex", "session/update")("x");
    a("y");
    expect(info.mock.calls).toEqual([["claude: session/update: x"], ["codex: session/update: x"], ["claude: session/update: y"]]);
  });
});

describe("agentErrorText", () => {
  it("an agent's error says what its data adds — a string, a reason field, else the data itself, bounded (#80)", () => {
    expect(agentErrorText(new RequestError(-32603, "Internal error", "process exited with code 1"))).toBe(
      "Internal error — process exited with code 1",
    );
    expect(agentErrorText(new RequestError(-32603, "Internal error", { details: "model overloaded" }))).toBe("Internal error — model overloaded");
    expect(agentErrorText(new RequestError(-32603, "Internal error", { status: 529 }))).toBe('Internal error — {"status":529}');
    expect(agentErrorText(new RequestError(-32603, "Internal error", { blob: "x".repeat(400) })).length).toBeLessThan(330);
  });

  it("data the message already says, no data, or not an agent's error: the message alone", () => {
    expect(agentErrorText(new RequestError(-32603, "quota exceeded", "quota exceeded"))).toBe("quota exceeded");
    expect(agentErrorText(new RequestError(-32602, "Invalid params"))).toBe("Invalid params");
    expect(agentErrorText(new Error("agent x is not running"))).toBe("agent x is not running");
    expect(agentErrorText("plain")).toBe("plain");
  });
});

describe("optionText", () => {
  it("folds the description in only where names are shared — an agent's same-named model variants (#80)", async () => {
    const { optionText } = await import("../src/webview/shared/option-label");
    const options = [
      { name: "Sonnet", description: "Fast" },
      { name: "Sonnet", description: "Deep" },
      { name: "Opus", description: "Most capable" },
      { name: "Haiku" },
    ];
    expect(options.map((o) => optionText(o, options))).toEqual([
      { label: "Sonnet · Fast" },
      { label: "Sonnet · Deep" },
      { label: "Opus", description: "Most capable" },
      { label: "Haiku" },
    ]);
  });
});
