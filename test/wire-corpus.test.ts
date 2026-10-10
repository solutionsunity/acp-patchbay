// What every kind of agent message renders as — pinned. A turn carrying the
// whole session/update surface (each kind, each content variant, the field
// shapes real agents send) runs through the real wire into the view state,
// live and again as a reload's replay; the reduced state is compared with a
// golden file. A change to how an agent's message renders shows up as a diff
// of that file, reviewed like code — never as a silent difference.
//
// Regenerate after a deliberate change: `npx vitest run test/wire-corpus -u`.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { LaunchSpec } from "../src/orchestrator/pool";
import type { AgentViewState } from "../src/shared/protocol";
import type { PatchbayAgentId, PatchbaySessionId } from "../src/shared/ids";
import type { FakeAgentScript } from "./fake-agent/main";
import { sessionsHarness } from "./support/sessions-harness";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "patchbay-corpus-"));
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

function spec(script: FakeAgentScript, patchbayAgentId: string): LaunchSpec {
  return {
    patchbayAgentId: patchbayAgentId as PatchbayAgentId,
    name: "Fake Agent",
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    cwd,
  };
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** The whole session/update surface, in the order and shapes agents send it. */
const CORPUS: SessionUpdate[] = [
  // prose: two messages told apart by messageId, a thought between
  { sessionUpdate: "agent_thought_chunk", messageId: "t-1", content: { type: "text", text: "Thinking about " } },
  { sessionUpdate: "agent_thought_chunk", messageId: "t-1", content: { type: "text", text: "the request." } },
  { sessionUpdate: "agent_message_chunk", messageId: "m-1", content: { type: "text", text: "First message, " } },
  { sessionUpdate: "agent_message_chunk", messageId: "m-1", content: { type: "text", text: "continued." } },
  { sessionUpdate: "agent_message_chunk", messageId: "m-2", content: { type: "text", text: "Second message." } },
  // every content variant on the message channel
  {
    sessionUpdate: "agent_message_chunk",
    messageId: "m-2",
    content: { type: "resource_link", name: "README.md", uri: "file:///w/README.md", title: "Readme", description: "The readme", mimeType: "text/markdown", size: 120 },
  },
  { sessionUpdate: "agent_message_chunk", content: { type: "image", data: PNG, mimeType: "image/png" } },
  { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "", mimeType: "image/png", uri: "https://example.com/a.png" } },
  { sessionUpdate: "agent_message_chunk", content: { type: "audio", data: "AAAA", mimeType: "audio/wav" } },
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "resource", resource: { uri: "file:///w/notes.txt", text: "embedded notes", mimeType: "text/plain" } },
  },
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "resource", resource: { uri: "file:///w/logo.png", blob: PNG, mimeType: "image/png" } },
  },
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "For the model only.", annotations: { audience: ["assistant"], priority: 0.2 } },
  },
  // a thought carrying a link
  { sessionUpdate: "agent_thought_chunk", content: { type: "resource_link", name: "spec.md", uri: "file:///w/spec.md" } },
  // a user message arriving mid-turn (an agent's echo)
  { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echoed prompt" } },
  // a read: announced, progress without status, then done
  {
    sessionUpdate: "tool_call",
    toolCallId: "read-1",
    title: "Read src/a.ts",
    kind: "read",
    status: "pending",
    locations: [{ path: "/w/src/a.ts", line: 12 }],
    rawInput: { path: "/w/src/a.ts" },
  },
  { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "in_progress" },
  { sessionUpdate: "tool_call_update", toolCallId: "read-1", rawInput: { path: "/w/src/a.ts", limit: 40 } },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "read-1",
    status: "completed",
    rawOutput: { lines: 40 },
    content: [{ type: "content", content: { type: "text", text: "export const a = 1;" } }],
  },
  // an edit carrying its diff
  {
    sessionUpdate: "tool_call",
    toolCallId: "edit-1",
    title: "Edit src/b.ts",
    kind: "edit",
    status: "pending",
    locations: [{ path: "/w/src/b.ts" }],
    content: [{ type: "diff", path: "/w/src/b.ts", oldText: "let b = 1;\n", newText: "let b = 2;\nlet c = 3;\n" }],
  },
  { sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed" },
  // a command the agent runs itself, its terminal its own, output in _meta
  {
    sessionUpdate: "tool_call",
    toolCallId: "exec-1",
    title: "Run npm test",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: ["npm", "test"] },
    content: [{ type: "terminal", terminalId: "agent-term-1" }],
    _meta: { terminal_info: { terminal_id: "agent-term-1", cwd: "/w" } },
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "exec-1",
    _meta: { terminal_output_delta: { terminal_id: "agent-term-1", data: "1 passed\n" } },
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "exec-1",
    status: "completed",
    rawOutput: { exit_code: 0, stdout: "1 passed\n" },
    _meta: { terminal_exit: { terminal_id: "agent-term-1", exit_code: 0 } },
  },
  // a failed fetch
  { sessionUpdate: "tool_call", toolCallId: "fetch-1", title: "Fetch https://example.com", kind: "fetch" },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "fetch-1",
    status: "failed",
    content: [{ type: "content", content: { type: "text", text: "403 Forbidden" } }],
  },
  // an update for a call never announced, with no status
  { sessionUpdate: "tool_call_update", toolCallId: "orphan-1", title: "Orphan", rawOutput: "late output" },
  // a call still open when the turn ends
  { sessionUpdate: "tool_call", toolCallId: "think-1", title: "Thinking", kind: "think", status: "in_progress" },
  // session-level facts
  {
    sessionUpdate: "plan",
    entries: [
      { content: "Read the code", status: "completed", priority: "high" },
      { content: "Make the change", status: "in_progress", priority: "medium" },
      { content: "Run the tests", status: "pending", priority: "low" },
    ],
  },
  {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "review", description: "Review the changes" },
      { name: "test", description: "Run tests", input: { hint: "which suite" } },
    ],
  },
  { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.42, currency: "USD" } },
  { sessionUpdate: "usage_update", used: 1800, size: 200000 },
  { sessionUpdate: "session_info_update", title: "Corpus session" },
  {
    sessionUpdate: "config_option_update",
    configOptions: [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "fast",
        options: [
          { value: "fast", name: "Sonnet", description: "Fast" },
          { value: "deep", name: "Sonnet", description: "Deep" },
        ],
      },
    ],
  },
  // kinds behind client capabilities patchbay doesn't declare
  { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "p-1", content: "# Plan" } },
  { sessionUpdate: "plan_removed", planId: "p-1" } as SessionUpdate,
  { sessionUpdate: "notice", severity: "warning", title: "Rate limit near", description: "80% used" },
  { sessionUpdate: "compaction_update", compactionId: "c-1", status: "completed" },
  { sessionUpdate: "compaction_summary_chunk", compactionId: "c-1", content: { type: "text", text: "summary" } },
  { sessionUpdate: "subagent_update", sessionId: "child-1", title: "Explore", state: { state: "running" } },
  { sessionUpdate: "session_message", messageId: "sm-1", senderSessionId: "child-1", content: [{ type: "text", text: "found it" }] },
  { sessionUpdate: "session_message_chunk", messageId: "sm-1", content: { type: "text", text: "found it" } },
  // the closing words
  { sessionUpdate: "agent_message_chunk", messageId: "m-3", content: { type: "text", text: "Done." } },
];

/** What a session's messages render as: its transcript and the session-level
 * facts beside it. Ids and clock readings vary per run — each becomes a
 * stable label in order of first sight, so the file pins shape and order. */
function rendered(state: AgentViewState, patchbaySessionId: PatchbaySessionId): string {
  const view = {
    title: state.sessions.find((s) => s.id === patchbaySessionId)?.title,
    transcript: state.transcripts[patchbaySessionId],
    plan: state.activePlan[patchbaySessionId],
    commands: state.commandsBySession[patchbaySessionId],
    usage: state.sessionUsage[patchbaySessionId],
    knobs: state.sessionKnobs[patchbaySessionId],
  };
  const labels = new Map<string, string>();
  const label = (kind: string, value: string) => {
    if (!labels.has(value)) labels.set(value, `<${kind}-${labels.size + 1}>`);
    return labels.get(value)!;
  };
  return JSON.stringify(
    view,
    (key, value: unknown) => {
      if (typeof value !== "string") return value;
      if (value === patchbaySessionId) return "<session>";
      if (key === "file" || ((key === "id" || key === "blockId") && /^[a-z]+-\d+$/.test(value))) return label(key, value);
      if (/^\d{4}-\d\d-\d\dT/.test(value)) return "<time>";
      return value;
    },
    2,
  ) + "\n";
}

describe("wire corpus", () => {
  it("every agent message renders as pinned — live, and replayed by a reload", async () => {
    const h = sessionsHarness(cwd);
    const agent = "corpus" as PatchbayAgentId;
    await h.pool.connect(spec({ declare: { loadSession: true }, turn: CORPUS.map((update) => ({ type: "update", update })) }, agent));
    const patchbaySessionId = await h.sessions.createSession(agent, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "go" });
    await expect(rendered(h.state(), patchbaySessionId)).toMatchFileSnapshot("./goldens/wire-corpus.live.json");

    await h.gates.reload(patchbaySessionId);
    await expect(rendered(h.state(), patchbaySessionId)).toMatchFileSnapshot("./goldens/wire-corpus.replay.json");
    await h.pool.stop(agent);
  });
});
