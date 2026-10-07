// The readers: what patchbay takes from an agent's message. An absent field
// stays absent (an update says only what changed), the spec's own defaults
// apply only where the spec names them, fields nothing renders yet are
// carried, and what a reader can't take is noted — once.
import { describe, expect, it, vi } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { agentErrorText } from "../src/orchestrator/readers/agent-error";
import { readContent } from "../src/orchestrator/readers/content";
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

describe("readSessionUpdate", () => {
  const note = () => {};

  it("a kind with no surface is carried — its name and payload — and noted", () => {
    const said = vi.fn();
    const fact = readSessionUpdate({ sessionUpdate: "notice", severity: "info", title: "Heads up" }, said);
    expect(fact).toEqual({ kind: "carried", updateKind: "notice", payload: { severity: "info", title: "Heads up" } });
    expect(said).toHaveBeenCalledWith("notice has no surface yet — shown as the agent sent it");
  });

  it("a usage update without a cost says nothing about the cost", () => {
    expect(readSessionUpdate({ sessionUpdate: "usage_update", used: 1, size: 2 }, note)).toEqual({ kind: "usage", used: 1, size: 2 });
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
