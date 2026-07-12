// P4 gate: session/new → prompt → streamed session/update → transcript;
// stop turn; close; slash-command advertisement; render cache rebuilt
// wholesale from session/load replay after a crash. Sessions are the
// agent's truth: patchbay persists no index and no transcripts.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertKind } from "./support/assert-kind";
import { CapabilityTracker } from "../src/orchestrator/capability-tracker";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import { harnessEnvelopeTag, SessionManager } from "../src/orchestrator/session-manager";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { UsedCapabilityStore } from "../src/orchestrator/stores/used-capabilities";
import {
  initialAgentViewState,
  reduceAgentView,
  type AgentViewEvent,
  type AgentViewState,
  type ChatBlock,
} from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { stubFsTerminalHooks } from "./support/stub-hooks";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

// A fresh cwd per test: the fake agent's session ids restart at "fake-1" on
// every spawn, so a shared cwd would let unrelated tests' persisted replay
// files collide on disk.
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "patchbay-sm-"));
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

function spec(script: FakeAgentScript, agentId = "fake"): LaunchSpec {
  return {
    agentId,
    name: "Fake Agent",
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    cwd,
  };
}

/** Wires a pool + session manager the way Orchestrator does, minus vscode. */
function harness(opts?: {
  /** Idle reaper period — default null (disabled) so tests opt in. */
  idleCloseMs?: number;
  /** Stand-in for the reducer-derived unseen (blue) mark. */
  isUnseen?(sessionId: string): boolean;
}): {
  pool: AgentPool;
  sessionManager: SessionManager;
  capabilityTracker: CapabilityTracker;
  events: AgentViewEvent[];
  /** Events delivered through the silent (replay-window) path — also in
   * `events`, so `state()` stays the full canonical reduction. */
  silentEvents: AgentViewEvent[];
  resyncCount(): number;
  state(): AgentViewState;
} {
  const events: AgentViewEvent[] = [];
  const silentEvents: AgentViewEvent[] = [];
  let resyncs = 0;
  let sessionManager!: SessionManager;
  let capabilityTracker!: CapabilityTracker;
  const pool = new AgentPool({
    onStatusChanged: (agentId, status) => {
      if (status === "crashed" || status === "reconnecting") {
        sessionManager.invalidateAgent(agentId);
      }
    },
    onIsolatedStatusChanged: (poolKey, _agentId, status) => {
      if (status === "crashed" || status === "reconnecting") {
        sessionManager.invalidatePoolKey(poolKey);
      }
    },
    onDeclaredCaptured: (agentId, declared, raw) =>
      capabilityTracker.onDeclared(agentId, declared, raw.agentInfo?.version ?? null, raw.protocolVersion),
    onSessionUpdate: (agentId, notification) => sessionManager.handleUpdate(agentId, notification),
    onCapabilityEvidence: (agentId, row, evidence) =>
      evidence === "used" ? capabilityTracker.markUsed(agentId, row) : capabilityTracker.markSuspect(agentId, row),
    ...stubFsTerminalHooks(),
  });
  capabilityTracker = new CapabilityTracker(pool, new UsedCapabilityStore(new MemoryKV()), {
    emit: (...evs) => events.push(...evs),
    currentMatrix: (agentId) => events.reduce(reduceAgentView, initialAgentViewState).capabilities[agentId],
    probeRoot: async () => cwd, // exists for the test's life — the contract
  });
  sessionManager = new SessionManager(
    pool,
    {
      emit: (...evs) => events.push(...evs),
      emitSilent: (...evs) => {
        events.push(...evs);
        silentEvents.push(...evs);
      },
      resyncView: () => {
        resyncs += 1;
      },
      contextRootsFor: (sessionId) =>
        events.reduce(reduceAgentView, initialAgentViewState).contextRoots[sessionId] ?? [],
      currentTranscript: (sessionId) =>
        events.reduce(reduceAgentView, initialAgentViewState).transcripts[sessionId] ?? [],
      isDeleteUsed: (agentId) =>
        events.reduce(reduceAgentView, initialAgentViewState).capabilities[agentId]?.["session.delete"]
          ?.used ?? false,
      isActiveSession: (sessionId) =>
        events.reduce(reduceAgentView, initialAgentViewState).activeSessionId === sessionId,
      isUnseen: (sessionId) => opts?.isUnseen?.(sessionId) ?? false,
    },
    () => cwd,
    undefined,
    undefined,
    { idleCloseMs: opts?.idleCloseMs ?? null },
  );
  return {
    pool,
    sessionManager,
    capabilityTracker,
    events,
    silentEvents,
    resyncCount: () => resyncs,
    state: () => events.reduce(reduceAgentView, initialAgentViewState),
  };
}

function textOf(block: ChatBlock | undefined): string {
  return block !== undefined && (block.kind === "text" || block.kind === "thought")
    ? block.text
    : "";
}

describe("SessionManager", () => {
  it("streams a full turn into the transcript and clears live on completion", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "hi " }, { type: "chunk", text: "there" }] }, "sm1"));
    const sessionId = await h.sessionManager.createSession("sm1", "Fake Agent", cwd);

    const state1 = h.state();
    expect(state1.sessions).toHaveLength(1);
    expect(state1.activeSessionId).toBe(sessionId);
    expect(state1.transcripts[sessionId]).toEqual([]);

    await h.sessionManager.sendPrompt(sessionId, "go go go");

    const state2 = h.state();
    const blocks = state2.transcripts[sessionId]!;
    expect(blocks[0]).toMatchObject({ kind: "user", text: "go go go" });
    expect(textOf(blocks[1])).toBe("hi there");
    expect(state2.sessions[0]?.live).toBe(false);
    // first prompt on an untitled session derives its title
    expect(state2.sessions[0]?.title).toBe("go go go");

    await h.pool.stop("sm1");
  });

  it("renders tool calls, plans, and advertised commands", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "t1", title: "Reading file" },
            { type: "toolDone", id: "t1" },
            { type: "plan", entries: [{ content: "step one", status: "completed" }, { content: "step two", status: "in_progress" }] },
            { type: "commands", names: ["review", "deploy"] },
          ],
        },
        "sm2",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm2", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "do the thing");

    const state = h.state();
    const blocks = state.transcripts[sessionId]!;
    const toolBlock = blocks.find((b) => b.kind === "toolCall");
    expect(toolBlock).toMatchObject({ title: "Reading file", status: "completed" });

    // A plan is session-level state (ui-rendering-strategy § Plans): it
    // updates the pinned widget's snapshot and never enters the transcript.
    expect(state.activePlan[sessionId]).toEqual([
      { content: "step one", status: "completed" },
      { content: "step two", status: "in_progress" },
    ]);
    expect(state.commandsBySession[sessionId]).toEqual([
      { name: "review", description: "fake review" },
      { name: "deploy", description: "fake deploy" },
    ]);

    await h.pool.stop("sm2");
  });

  it("stop turn cancels and reports live=false with no crash", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }, { type: "chunk", text: "c" }], stepDelayMs: 150 },
        "sm3",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm3", "Fake Agent", cwd);

    const promptDone = h.sessionManager.sendPrompt(sessionId, "long turn");
    await new Promise((r) => setTimeout(r, 80));
    await h.sessionManager.stopTurn(sessionId);
    await promptDone;

    expect(h.state().sessions[0]?.live).toBe(false);
    await h.pool.stop("sm3");
  });

  // ACP is one prompt per turn: a send landing mid-turn queues (removable
  // row), drains one per turn end, and Stop clears the whole queue.
  it("a prompt sent mid-turn queues and fires when the turn ends", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }], stepDelayMs: 150 },
        "smq1",
      ),
    );
    const sessionId = await h.sessionManager.createSession("smq1", "Fake Agent", cwd);

    const promptDone = h.sessionManager.sendPrompt(sessionId, "first");
    await new Promise((r) => setTimeout(r, 80));
    await h.sessionManager.sendPrompt(sessionId, "second"); // resolves immediately: queued
    expect(h.state().promptQueue[sessionId]).toMatchObject([{ text: "second" }]);
    await promptDone;

    // the drain fired the queued prompt as a real turn
    await new Promise((r) => setTimeout(r, 500));
    expect(h.state().promptQueue[sessionId] ?? []).toEqual([]);
    const users = h.state().transcripts[sessionId]!.filter((b) => b.kind === "user");
    expect(users.map((b) => (b as { text: string }).text)).toEqual(["first", "second"]);
    await h.pool.stop("smq1");
  });

  it("stop clears the queue — a deliberate stop never restarts from it", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }], stepDelayMs: 150 },
        "smq2",
      ),
    );
    const sessionId = await h.sessionManager.createSession("smq2", "Fake Agent", cwd);

    const promptDone = h.sessionManager.sendPrompt(sessionId, "first");
    await new Promise((r) => setTimeout(r, 80));
    await h.sessionManager.sendPrompt(sessionId, "second");
    await h.sessionManager.stopTurn(sessionId);
    await promptDone;

    await new Promise((r) => setTimeout(r, 200));
    expect(h.state().promptQueue[sessionId] ?? []).toEqual([]);
    const users = h.state().transcripts[sessionId]!.filter((b) => b.kind === "user");
    expect(users).toHaveLength(1); // "second" never fired
    await h.pool.stop("smq2");
  });

  // Honest close: closing mid-stream stops the turn (spec cancel) and lets
  // it settle — turnEnded lands before sessionClosed, never a delete fired
  // under a live turn.
  it("closing mid-turn cancels first — turnEnded lands before sessionClosed", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }, { type: "chunk", text: "c" }], stepDelayMs: 150 },
        "sm3c",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm3c", "Fake Agent", cwd);

    const promptDone = h.sessionManager.sendPrompt(sessionId, "long turn");
    await new Promise((r) => setTimeout(r, 80));
    await h.sessionManager.close(sessionId);
    await promptDone;

    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain("turnEnded");
    expect(kinds.indexOf("turnEnded")).toBeLessThan(kinds.indexOf("sessionClosed"));
    await h.pool.stop("sm3c");
  });

  it("reloading mid-turn cancels first — the replay never interleaves a live stream", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true },
          turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }, { type: "chunk", text: "c" }],
          stepDelayMs: 150,
        },
        "sm3d",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm3d", "Fake Agent", cwd);

    const promptDone = h.sessionManager.sendPrompt(sessionId, "long turn");
    await new Promise((r) => setTimeout(r, 80));
    await h.sessionManager.reload(sessionId);
    await promptDone;

    // The cancelled turn ended before the replay's transcriptReset — nothing
    // streamed into the rebuilt cache.
    const kinds = h.events.map((e) => e.kind);
    expect(kinds.indexOf("turnEnded")).toBeLessThan(kinds.indexOf("transcriptReset"));
    expect(h.state().sessions[0]?.live).toBe(false);
    await h.pool.stop("sm3d");
  });

  it("marks a tool call left open by a cancelled turn interrupted, once, at turn end", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          // No toolDone: the call is still pending/in_progress when the
          // cancel lands mid-turn.
          turn: [{ type: "toolCall", id: "t1", title: "Write" }, { type: "chunk", text: "a" }, { type: "chunk", text: "b" }],
          stepDelayMs: 150,
        },
        "sm3b",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm3b", "Fake Agent", cwd);

    // Each step sleeps stepDelayMs *before* acting, so the wait here must
    // clear the first step's own delay (the toolCall landing) but not the
    // second's — otherwise there's nothing yet to strand.
    const promptDone = h.sessionManager.sendPrompt(sessionId, "long turn");
    await new Promise((r) => setTimeout(r, 220));
    await h.sessionManager.stopTurn(sessionId);
    await promptDone;

    const toolBlock = assertKind(
      h.state().transcripts[sessionId]!.find((b) => b.id === "t1")!,
      "toolCall",
    );
    expect(toolBlock.interrupted).toBe(true);
    expect(toolBlock.status).toBe("in_progress");

    await h.pool.stop("sm3b");
  });

  it("closes sessions — row and transcript leave the view", async () => {
    const h = harness();
    await h.pool.connect(spec({}, "sm4"));
    const sessionId = await h.sessionManager.createSession("sm4", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "some words");

    await h.sessionManager.close(sessionId);
    expect(h.state().sessions).toHaveLength(0);
    expect(h.state().transcripts[sessionId]).toBeUndefined();
    expect(h.sessionManager.knows(sessionId)).toBe(false);

    await h.pool.stop("sm4");
  });

  it("rebuilds the render cache wholesale from session/load replay after a crash", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true },
          turn: [{ type: "chunk", text: "before " }, { type: "chunk", text: "crash" }],
        },
        "sm5",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm5", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "first turn");
    expect(textOf(h.state().transcripts[sessionId]?.[1])).toBe("before crash");

    // simulate the agent process dying and being restarted
    await h.pool.restart("sm5");
    expect(h.pool.get("sm5")?.declared?.loadSession).toBe(true);

    // sending a prompt on the old sessionId must reopen via session/load first
    await h.sessionManager.sendPrompt(sessionId, "second turn");

    const blocks = h.state().transcripts[sessionId]!;
    // replay rebuilt the whole first turn — user message included (the spec
    // replays the *entire* conversation) — then the new user message, then
    // the new turn's text — never merged, always reset
    expect(blocks[0]).toMatchObject({ kind: "user", text: "first turn" });
    expect(textOf(blocks[1])).toBe("before crash");
    // the replayed turn keeps its boundary — synthesized, since the replay
    // wire carries no turn resolution: structure recovered, timing/stop/usage
    // honestly absent (never re-attached from a patchbay-side store)
    expect(blocks[2]).toMatchObject({
      kind: "turnEnd",
      startedAt: null,
      endedAt: null,
      stopReason: null,
      usage: null,
    });
    expect(blocks[3]).toMatchObject({ kind: "user", text: "second turn" });
    expect(textOf(blocks[4])).toBe("before crash"); // second turn uses the same script

    await h.pool.stop("sm5");
  });

  it("session/load replay is delivered silently and closed by one resync — never a patch flood", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "hello" }] }, "sm5s"),
    );
    const sessionId = await h.sessionManager.createSession("sm5s", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "first turn");
    expect(h.silentEvents).toHaveLength(0); // live streaming patches normally
    expect(h.resyncCount()).toBe(0);

    await h.pool.restart("sm5s");
    await h.sessionManager.sendPrompt(sessionId, "second turn");

    // The replay window went silent — reset + the whole replayed first turn,
    // closed by its synthesized boundary — and one wholesale resync; the
    // live second turn streamed as patches again.
    expect(h.silentEvents.map((e) => e.kind)).toEqual([
      "transcriptReset",
      "userTextDelta",
      "agentTextDelta",
      "turnEnded",
    ]);
    expect(h.resyncCount()).toBe(1);
    // canonical state is complete regardless of delivery path
    const blocks = h.state().transcripts[sessionId]!;
    expect(blocks[0]).toMatchObject({ kind: "user", text: "first turn" });
    expect(textOf(blocks[1])).toBe("hello");
    expect(blocks[2]).toMatchObject({ kind: "turnEnd", startedAt: null });
    expect(blocks[3]).toMatchObject({ kind: "user", text: "second turn" });
    await h.pool.stop("sm5s");
  });

  it("a multi-turn replay gets a synthesized boundary per turn — the next user message flushes one, the end of the replay flushes the last", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "reply" }] }, "sm5m"),
    );
    const sessionId = await h.sessionManager.createSession("sm5m", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "one");
    await h.sessionManager.sendPrompt(sessionId, "two");

    await h.pool.restart("sm5m");
    await h.sessionManager.sendPrompt(sessionId, "three");

    // two replayed turns, each closed by a synthesized boundary (nullable
    // timing), then the live third turn closed by its real one
    const shape = h.state().transcripts[sessionId]!.map((b) =>
      b.kind === "turnEnd" ? `turnEnd:${b.startedAt === null ? "synthesized" : "real"}` : b.kind,
    );
    expect(shape).toEqual([
      "user", "text", "turnEnd:synthesized",
      "user", "text", "turnEnd:synthesized",
      "user", "text", "turnEnd:real",
    ]);

    await h.pool.stop("sm5m");
  });

  it("session/load replay ending on a still-open tool call marks it interrupted — live cancel and its replay render identically", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true },
          turn: [{ type: "toolCall", id: "t1", title: "Write" }, { type: "chunk", text: "a" }, { type: "chunk", text: "b" }],
          stepDelayMs: 150,
        },
        "sm5i",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm5i", "Fake Agent", cwd);
    const promptDone = h.sessionManager.sendPrompt(sessionId, "long turn");
    await new Promise((r) => setTimeout(r, 220));
    await h.sessionManager.stopTurn(sessionId);
    await promptDone;

    // Reload: the recorded history replays and ends on the never-completed
    // call — no turn end follows, so only the replay-end sweep can mark it.
    await h.pool.restart("sm5i");
    await h.sessionManager.hydrate(sessionId);

    const t1 = assertKind(
      h.state().transcripts[sessionId]!.find((b) => b.id === "t1")!,
      "toolCall",
    );
    expect(t1.interrupted).toBe(true);
    expect(t1.status).toBe("in_progress");
    await h.pool.stop("sm5i");
  });

  it("a live user_message_chunk echo never duplicates the sent prompt", async () => {
    // Some agents echo the in-flight prompt back (slash-command expansion);
    // sendPrompt already appended the user block, so the echo must drop.
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "userEcho", text: "/cmd expanded" }, { type: "chunk", text: "ok" }] },
        "sm5e",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm5e", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "/cmd");
    const blocks = h.state().transcripts[sessionId]!;
    expect(blocks.filter((b) => b.kind === "user")).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "user", text: "/cmd" });
    expect(textOf(blocks[1])).toBe("ok");
    await h.pool.stop("sm5e");
  });

  it("without load or resume declared, a prompt on a dead session fails honestly — never a minted continuation", async () => {
    // A sessionId is connection-scoped; without replay there is no
    // protocol-legal way to continue it on the new connection. Patchbay
    // never mints a session and calls it a continuation: the prompt
    // rejects, the transcript stands untouched, no sibling appears.
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "only turn" }] }, "sm6"));
    const deadSessionId = await h.sessionManager.createSession("sm6", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(deadSessionId, "hello");
    const before = h.state().transcripts[deadSessionId]!;
    expect(before.length).toBeGreaterThan(0);

    await h.pool.restart("sm6");
    expect(h.pool.get("sm6")?.declared?.loadSession).toBe(false);

    await expect(h.sessionManager.sendPrompt(deadSessionId, "after restart")).rejects.toThrow(
      /neither session\/load nor session\/resume/,
    );

    expect(h.state().transcripts[deadSessionId]).toEqual(before);
    expect(h.state().sessions.map((s) => s.id)).toEqual([deadSessionId]);

    await h.pool.stop("sm6");
  });

  it("interleaved text/thought/tool updates render ordered, merged, and updated in place (P13b gate)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "chunk", text: "let me " },
            { type: "chunk", text: "look. " },
            { type: "thought", text: "hmm, " },
            { type: "thought", text: "grep first" },
            { type: "chunk", text: "searching now" },
            { type: "toolCall", id: "t1", title: "Grep pattern", kind: "search", rawInput: { pattern: "foo" } },
            { type: "toolDone", id: "t1", rawOutput: "3 matches" },
            { type: "chunk", text: "found it" },
          ],
        },
        "sm13b",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm13b", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "find foo");

    const blocks = h.state().transcripts[sessionId]!;
    // Literal arrival order, chunks merged per run, interruptions split runs:
    // user · text · thought · text · one tool block · text — never re-bucketed
    // — then the turn's own metadata block (P13c) closing it.
    expect(blocks.map((b) => b.kind)).toEqual(["user", "text", "thought", "text", "toolCall", "text", "turnEnd"]);
    expect(textOf(blocks[1])).toBe("let me look. ");
    expect(textOf(blocks[2])).toBe("hmm, grep first");
    expect(textOf(blocks[3])).toBe("searching now");
    expect(textOf(blocks[5])).toBe("found it");
    // tool_call + tool_call_update landed on ONE block, updated in place,
    // with kind and raw input/output carried through.
    const search = assertKind(blocks[4], "toolCall");
    expect(search).toMatchObject({
      id: "t1",
      status: "completed",
      toolKind: "search",
      denied: false,
    });
    expect(search.input).toContain('"pattern": "foo"');
    expect(search.output).toBe("3 matches");

    await h.pool.stop("sm13b");
  });

  it("oversized tool rawOutput is bounded with an honest truncation marker (P13b)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "big", title: "Read file", kind: "read" },
            { type: "toolDone", id: "big", rawOutput: "x".repeat(10_000) },
          ],
        },
        "sm13c",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm13c", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "read it");

    const tool = assertKind(
      h.state().transcripts[sessionId]!.find((b) => b.kind === "toolCall"),
      "toolCall",
    );
    expect(tool.output).not.toBeNull();
    expect(tool.output!.length).toBeLessThan(4_200);
    expect(tool.output).toContain("… truncated (10,000 chars total)");

    await h.pool.stop("sm13c");
  });

  it("a resolved turn appends a turnEnd block: send→stop duration, stop reason, usage when reported (P13c gate)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "chunk", text: "done" },
            { type: "toolCall", id: "e1", title: "Edit a.ts", kind: "edit", locations: ["/ws/a.ts"] },
            { type: "toolDone", id: "e1" },
          ],
          usage: { totalTokens: 1200, inputTokens: 1000, outputTokens: 200, cachedReadTokens: 800 },
        },
        "sm13d",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm13d", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "edit it");

    const state = h.state();
    const blocks = state.transcripts[sessionId]!;
    const end = assertKind(blocks[blocks.length - 1], "turnEnd");
    expect(end.stopReason).toBe("end_turn");
    expect(Date.parse(end.endedAt!)).toBeGreaterThanOrEqual(Date.parse(end.startedAt!));
    expect(end.usage).toEqual({ total: 1200, input: 1000, output: 200, cached: 800 });
    // the ticker's basis is cleared the moment the turn resolves
    expect(state.activeTurn[sessionId]).toBeUndefined();
    // locations rode in for the rollup's distinct-files count
    const tool = assertKind(blocks.find((b) => b.kind === "toolCall"), "toolCall");
    expect(tool.locations).toEqual(["/ws/a.ts"]);

    await h.pool.stop("sm13d");
  });

  it("agent-reported diff content: paths ride the block, texts stay orchestrator-side for the native diff editor", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "d1", title: "Edit a.ts", kind: "edit" },
            { type: "toolDone", id: "d1", diff: { path: "/ws/a.ts", oldText: "old\n", newText: "new\n" } },
          ],
        },
        "sm13f",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm13f", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "edit");

    const tool = assertKind(
      h.state().transcripts[sessionId]!.find((b) => b.kind === "toolCall"),
      "toolCall",
    );
    expect(tool.diffFiles).toEqual(["/ws/a.ts"]);
    // texts never enter webview state — they come back through the stash
    expect(h.sessionManager.toolCallDiff(sessionId, "d1", "/ws/a.ts")).toEqual({
      oldText: "old\n",
      newText: "new\n",
    });
    expect(h.sessionManager.toolCallDiff(sessionId, "d1", "/nope")).toBeNull();

    await h.pool.stop("sm13f");
  });

  it("a turn without reported usage gets usage: null — absence over fake (P13c)", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "hi" }] }, "sm13e"));
    const sessionId = await h.sessionManager.createSession("sm13e", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "go");

    const blocks = h.state().transcripts[sessionId]!;
    const end = assertKind(blocks[blocks.length - 1], "turnEnd");
    expect(end.usage).toBeNull();

    await h.pool.stop("sm13e");
  });

  it("usage reporting is marked used opportunistically the moment it's first observed (P5)", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ turn: [{ type: "usage", used: 42, size: 200 }, { type: "chunk", text: "hi" }] }, "sm7"),
    );
    expect(h.state().capabilities.sm7!.usage).toEqual({ declared: false, used: false });

    const sessionId = await h.sessionManager.createSession("sm7", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "go");

    expect(h.state().sessionUsage[sessionId]).toEqual({ used: 42, size: 200, cost: undefined });
    expect(h.state().capabilities.sm7!.usage).toEqual({ declared: true, used: true });

    await h.pool.stop("sm7");
  });

  it("session.load reopening marks the session.load row used (P5)", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "hi" }] }, "sm8"),
    );
    const sessionId = await h.sessionManager.createSession("sm8", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "first");
    expect(h.state().capabilities.sm8!["session.load"]).toEqual({ declared: true, used: false });

    await h.pool.restart("sm8");
    await h.sessionManager.sendPrompt(sessionId, "second");

    expect(h.state().capabilities.sm8!["session.load"]).toEqual({ declared: true, used: true });
    await h.pool.stop("sm8");
  });

  it("attached context rides in as its own labeled blocks, ahead of the user's words, then clears (P7)", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "echoBlocks" }] }, "sm9"));
    const sessionId = await h.sessionManager.createSession("sm9", "Fake Agent", cwd);

    h.sessionManager.addContext(sessionId, {
      id: "chip-1",
      kind: "selection",
      label: "Selection: a.ts:1-2",
      content: "const x = 1;",
    });
    expect(h.state().contextChips[sessionId]).toEqual([
      { id: "chip-1", kind: "selection", label: "Selection: a.ts:1-2", content: "const x = 1;" },
    ]);

    await h.sessionManager.sendPrompt(sessionId, "what does this do?");

    // chip cleared from state after being consumed by the prompt
    expect(h.state().contextChips[sessionId]).toEqual([]);

    const echoed = h
      .state()
      .transcripts[sessionId]!.find((b) => b.kind === "text");
    expect(echoed?.kind === "text" && echoed.text.split("\n---BLOCK---\n")).toEqual([
      "[Selection: a.ts:1-2]\nconst x = 1;",
      "what does this do?",
    ]);

    await h.pool.stop("sm9");
  });

  it("image chips ride as ImageContent when promptCapabilities.image is declared", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { promptCapabilities: { image: true } }, turn: [{ type: "echoBlockKinds" }] },
        "img1",
      ),
    );
    const sessionId = await h.sessionManager.createSession("img1", "Fake Agent", cwd);
    h.sessionManager.addContext(sessionId, {
      id: "chip-img",
      kind: "image",
      label: "Image (image/png)",
      content: Buffer.from("fake-png-bytes").toString("base64"),
      mimeType: "image/png",
    });
    await h.sessionManager.sendPrompt(sessionId, "what is this?");

    const echoed = h.state().transcripts[sessionId]!.find((b) => b.kind === "text");
    const kinds = JSON.parse(echoed?.kind === "text" ? echoed.text : "[]") as Array<Record<string, string>>;
    expect(kinds).toEqual([{ type: "image", mimeType: "image/png" }, { type: "text" }]);
    await h.pool.stop("img1");
  });

  it("text chips ride as embedded resources when promptCapabilities.embeddedContext is declared", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { promptCapabilities: { embeddedContext: true } }, turn: [{ type: "echoBlockKinds" }] },
        "emb1",
      ),
    );
    const sessionId = await h.sessionManager.createSession("emb1", "Fake Agent", cwd);
    h.sessionManager.addContext(sessionId, {
      id: "chip-sel",
      kind: "selection",
      label: "Selection: a.ts:1-2",
      content: "const x = 1;",
      sourceUri: "file:///ws/a.ts#L1-2",
    });
    h.sessionManager.addContext(sessionId, {
      id: "chip-diag",
      kind: "diagnostics",
      label: "Problems (1)",
      content: "a.ts:3 [error] boom",
      // no single source — the chip itself is named (uri is wire-required)
    });
    await h.sessionManager.sendPrompt(sessionId, "context please");

    const echoed = h.state().transcripts[sessionId]!.find((b) => b.kind === "text");
    const kinds = JSON.parse(echoed?.kind === "text" ? echoed.text : "[]") as Array<Record<string, string>>;
    expect(kinds).toEqual([
      { type: "resource", uri: "file:///ws/a.ts#L1-2" },
      { type: "resource", uri: "patchbay://context/diagnostics/chip-diag" },
      { type: "text" },
    ]);
    await h.pool.stop("emb1");
  });

  it("image chips fall back to a temp-file ResourceLink when image support is undeclared — paste is never disabled", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "echoBlockKinds" }] }, "img2"));
    const sessionId = await h.sessionManager.createSession("img2", "Fake Agent", cwd);
    const bytes = Buffer.from("fake-jpeg-bytes");
    h.sessionManager.addContext(sessionId, {
      id: "chip-img-fb",
      kind: "image",
      label: "Image (image/jpeg)",
      content: bytes.toString("base64"),
      mimeType: "image/jpeg",
    });
    await h.sessionManager.sendPrompt(sessionId, "and this?");

    const echoed = h.state().transcripts[sessionId]!.find((b) => b.kind === "text");
    const kinds = JSON.parse(echoed?.kind === "text" ? echoed.text : "[]") as Array<Record<string, string>>;
    expect(kinds).toHaveLength(2);
    expect(kinds[0]).toMatchObject({ type: "resource_link", mimeType: "image/jpeg" });
    expect(kinds[0]!.uri).toMatch(/^file:\/\/.*chip-img-fb\.jpg$/);
    // the link points at real bytes on disk, not a dangling uri
    const { fileURLToPath } = await import("node:url");
    const written = await readFile(fileURLToPath(kinds[0]!.uri!), null);
    expect(Buffer.from(written).equals(bytes)).toBe(true);
    await h.pool.stop("img2");
  });

  it("removeContext drops a chip before it's ever sent", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "echoBlocks" }] }, "sm10"));
    const sessionId = await h.sessionManager.createSession("sm10", "Fake Agent", cwd);

    h.sessionManager.addContext(sessionId, {
      id: "chip-1",
      kind: "file",
      label: "File: a.ts",
      content: "export const a = 1;",
    });
    h.sessionManager.removeContext(sessionId, "chip-1");
    expect(h.state().contextChips[sessionId]).toEqual([]);

    await h.sessionManager.sendPrompt(sessionId, "hello");
    const echoed = h.state().transcripts[sessionId]!.find((b) => b.kind === "text");
    expect(echoed?.kind === "text" && echoed.text).toBe("hello"); // the removed chip never appears
    await h.pool.stop("sm10");
  });

  it("context roots on a zero-turn session: recreated with the new list — works for every agent, path normalized", async () => {
    const h = harness();
    // Deliberately no load/resume declared: the zero-turn rung is session/new.
    await h.pool.connect(spec({ turn: [{ type: "echoRoots" }] }, "sm11"));
    const oldId = await h.sessionManager.createSession("sm11", "Fake Agent", cwd);

    await h.sessionManager.addRoot(oldId, "/repo/backend/"); // trailing slash normalized away
    const newId = h.state().activeSessionId!;
    expect(newId).not.toBe(oldId);
    expect(h.state().sessions.some((s) => s.id === oldId)).toBe(false);
    expect(h.state().contextRoots[newId]).toEqual(["/repo/backend"]);

    await h.sessionManager.sendPrompt(newId, "roots?");
    const echoed = h.state().transcripts[newId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/backend"]);

    await h.pool.stop("sm11");
  });

  it("context roots after a turn: re-applied in place via session/load — no manual reload, same sessionId", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { loadSession: true }, turn: [{ type: "echoRoots" }] }, "sm11l"),
    );
    const sessionId = await h.sessionManager.createSession("sm11l", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "first turn");

    await h.sessionManager.addRoot(sessionId, "/repo/backend");
    expect(h.state().activeSessionId).toBe(sessionId); // in place, never recreated
    await h.sessionManager.sendPrompt(sessionId, "roots?");
    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/backend"]);

    await h.sessionManager.removeRoot(sessionId, "/repo/backend");
    await h.sessionManager.sendPrompt(sessionId, "roots?");
    const after = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(after?.kind === "text" && JSON.parse(after.text)).toEqual([]);

    await h.pool.stop("sm11l");
  });

  it("root re-apply retains user-steered knobs — the re-attach resets agent defaults, patchbay re-seeds", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true },
          turn: [{ type: "echoRoots" }],
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "default",
              options: [
                { value: "default", name: "Default" },
                { value: "sonnet", name: "Sonnet" },
              ],
            },
          ],
        },
        "sm11k",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm11k", "Fake Agent", cwd);
    await h.sessionManager.setKnob(sessionId, "model", "sonnet");
    await h.sessionManager.sendPrompt(sessionId, "first turn");

    await h.sessionManager.addRoot(sessionId, "/repo/backend");

    // session/load handed back the script defaults ("default") — the
    // re-seed must have restored the user's confirmed value.
    const model = h.state().sessionKnobs[sessionId]!.find((k) => k.id === "model");
    expect(model?.currentValue).toBe("sonnet");

    await h.pool.stop("sm11k");
  });

  it("a failed root re-apply detaches the session — the next prompt re-enters the ladder, never a corpse", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { loadSession: true }, failLoad: true, turn: [{ type: "echoRoots" }] }, "sm11f"),
    );
    const sessionId = await h.sessionManager.createSession("sm11f", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "first turn");
    expect(h.sessionManager.isLive(sessionId)).toBe(true);

    await h.sessionManager.addRoot(sessionId, "/repo/backend");
    expect(h.state().contextRoots[sessionId]).toEqual(["/repo/backend"]); // canonical list stands
    expect(h.sessionManager.isLive(sessionId)).toBe(false); // detached, not a zombie

    await h.pool.stop("sm11f");
  });

  it("context roots re-apply via session/resume on a resume-only agent — transcript untouched", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { sessionCapabilities: { resume: {} } }, turn: [{ type: "echoRoots" }] },
        "sm11r",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm11r", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "first turn");
    const before = h.state().transcripts[sessionId]!.length;

    await h.sessionManager.addRoot(sessionId, "/repo/backend");

    // Resume rung: no replay, so the render cache must not have been reset.
    expect(h.state().transcripts[sessionId]!.length).toBeGreaterThanOrEqual(before);
    await h.sessionManager.sendPrompt(sessionId, "roots?");
    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/backend"]);

    await h.pool.stop("sm11r");
  });

  it("prompt parts: inline file mentions ride as resource_link blocks at their position", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "echoBlockKinds" }] }, "sm11p"));
    const sessionId = await h.sessionManager.createSession("sm11p", "Fake Agent", cwd);

    await h.sessionManager.sendPrompt(sessionId, "look at @app.ts please", [
      { kind: "text", text: "look at " },
      { kind: "fileRef", path: "/repo/src/app.ts" },
      { kind: "text", text: " please" },
    ]);

    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual([
      { type: "text" },
      { type: "resource_link", uri: "file:///repo/src/app.ts", name: "app.ts" },
      { type: "text" },
    ]);
    // the transcript shows the readable form, tokens included
    const user = h.state().transcripts[sessionId]!.find((b) => b.kind === "user");
    expect(user?.kind === "user" && user.text).toBe("look at @app.ts please");

    await h.pool.stop("sm11p");
  });

  it("a still-new session is findable for add-session focus; the first prompt ends that", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "ok" }] }, "sm14"));
    const sessionId = await h.sessionManager.createSession("sm14", "Fake Agent", cwd);
    expect(h.sessionManager.findNeverPrompted("sm14")).toBe(sessionId);
    expect(h.sessionManager.findNeverPrompted("other-agent")).toBeUndefined();

    await h.sessionManager.sendPrompt(sessionId, "first words");
    expect(h.sessionManager.findNeverPrompted("sm14")).toBeUndefined();

    await h.pool.stop("sm14");
  });
});

// ── session history: the agent's own session/list is the only list there
// is — patchbay persists no session records (no index, no transcripts).
describe("session history (list / resume / delete)", () => {
  const LIST_CAPS = { sessionCapabilities: { list: {}, delete: {} } };

  it("surfaces externally-created sessions from session/list, without stealing focus", async () => {
    // A session that exists only in the agent's own durable store — made by
    // "another client" (here: a previous fake-agent process would have).
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "ext-1.jsonl"), "", "utf8");

    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "sh1"));
    const mine = await h.sessionManager.createSession("sh1", "Fake Agent", cwd);
    await h.sessionManager.syncAgentSessions("sh1");

    const state = h.state();
    expect(state.sessions.map((s) => s.id)).toContain("ext-1");
    expect(state.sessions.map((s) => s.id)).toContain(mine);
    expect(state.sessions.find((s) => s.id === "ext-1")).toMatchObject({ live: false });
    // the sync never activates anything — the user's focus is theirs
    expect(state.activeSessionId).toBe(mine);
    expect(h.sessionManager.knows("ext-1")).toBe(true);
    // the wire round-trip proved the row
    expect(state.capabilities.sh1?.["session.list"]).toMatchObject({ declared: true, used: true });

    await h.pool.stop("sh1");
  });

  it("prunes rows the agent no longer reports — wire truth wins", async () => {
    const { mkdir, writeFile, rm: rmFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "gone-1.jsonl"), "", "utf8");

    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "sh2"));
    await h.sessionManager.syncAgentSessions("sh2");
    expect(h.sessionManager.knows("gone-1")).toBe(true);

    // deleted externally (CLI, another editor) — the next sync drops it
    await rmFile(join(cwd, ".fake-agent-sessions", "gone-1.jsonl"));
    await h.sessionManager.syncAgentSessions("sh2");

    expect(h.sessionManager.knows("gone-1")).toBe(false);
    expect(h.events.some((e) => e.kind === "sessionClosed" && e.sessionId === "gone-1")).toBe(true);

    await h.pool.stop("sh2");
  });

  it("a load-declared agent that lost the session: the prompt fails honestly, nothing is minted", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "lost-1.jsonl"), "", "utf8");

    // failLoad: load 404s and drops the session — the corpse-leaving agent
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { ...LIST_CAPS, loadSession: true }, failLoad: true, turn: [{ type: "chunk", text: "ok" }] },
        "sh2c",
      ),
    );
    await h.sessionManager.syncAgentSessions("sh2c");
    const before = h.state().sessions.map((s) => s.id);

    await expect(h.sessionManager.sendPrompt("lost-1", "continue please")).rejects.toThrow();

    // no sibling appeared, nothing activated itself
    expect(h.state().sessions.map((s) => s.id)).toEqual(before);
    expect(h.events.some((e) => e.kind === "sessionActivated")).toBe(false);

    await h.pool.stop("sh2c");
  });

  it("the agent's title always wins — patchbay-side rename is gone", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS, listWithTitles: true }, "sh3"));
    const sessionId = await h.sessionManager.createSession("sh3", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "derive me a title");
    expect(h.state().sessions[0]?.title).toBe("derive me a title");

    await h.sessionManager.syncAgentSessions("sh3");
    expect(h.state().sessions.find((s) => s.id === sessionId)?.title).toBe(`fake:${sessionId}`);

    await h.pool.stop("sh3");
  });

  it("session_info_update retitles live", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: LIST_CAPS, turn: [{ type: "infoUpdate", title: "agent named me" }] }, "sh4"),
    );
    const sessionId = await h.sessionManager.createSession("sh4", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "hello");
    // noteInfoUpdate is fire-and-forget off the notification — settle it
    await new Promise((r) => setTimeout(r, 50));
    expect(h.state().sessions[0]?.title).toBe("agent named me");

    await h.pool.stop("sh4");
  });

  it("resume rung: same session continues without replay, behind a seam notice", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { sessionCapabilities: { resume: {} } }, turn: [{ type: "chunk", text: "turn done" }] },
        "sh5",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sh5", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "first");
    const before = h.state().transcripts[sessionId]!.length;
    expect(before).toBeGreaterThan(0);

    // the connection died from patchbay's perspective; the agent still has it
    h.sessionManager.invalidateAgent("sh5");
    await h.sessionManager.sendPrompt(sessionId, "second");

    const state = h.state();
    // same id — a real continuation, not an emulated sibling
    expect(state.sessions.map((s) => s.id)).toEqual([sessionId]);
    const blocks = state.transcripts[sessionId]!;
    // cached view kept, seam notice marks where the unreplayed memory begins
    const noticeAt = blocks.findIndex((b) => b.kind === "notice");
    expect(noticeAt).toBeGreaterThanOrEqual(before);
    expect(blocks.filter((b) => b.kind === "user").map((b) => b.kind === "user" && b.text)).toEqual([
      "first",
      "second",
    ]);
    expect(state.capabilities.sh5?.["session.resume"]).toMatchObject({ declared: true, used: true });

    await h.pool.stop("sh5");
  });

  it("opening a dead session hydrates via load replay — no prompt, no reload needed", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "remembered" }] }, "sh7"),
    );
    const sessionId = await h.sessionManager.createSession("sh7", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "first");
    h.sessionManager.invalidateAgent("sh7");
    const resetsBefore = h.events.filter((e) => e.kind === "transcriptReset").length;

    h.sessionManager.activate(sessionId); // a click, nothing more
    const start = Date.now();
    while (h.events.filter((e) => e.kind === "transcriptReset").length === resetsBefore) {
      if (Date.now() - start > 3000) throw new Error("hydrate never replayed");
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 100)); // let the replay stream settle

    // The fake agent's durable record replays its own updates (its store
    // holds no user_message_chunk) — the agent prose coming back is the proof.
    const blocks = h.state().transcripts[sessionId]!;
    expect(blocks.some((b) => b.kind === "text" && b.text.includes("remembered"))).toBe(true);
    expect(h.sessionManager.isLive(sessionId)).toBe(true);

    await h.pool.stop("sh7");
  });

  it("opening a session neither load nor resume can reach says so — a notice, never faked content", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "dead-1.jsonl"), "", "utf8");

    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "sh8")); // list only — no load, no resume
    await h.sessionManager.syncAgentSessions("sh8");

    h.sessionManager.activate("dead-1");
    const start = Date.now();
    while (!h.events.some((e) => e.kind === "transcriptSeeded" && e.sessionId === "dead-1")) {
      if (Date.now() - start > 3000) throw new Error("notice never seeded");
      await new Promise((r) => setTimeout(r, 20));
    }
    const blocks = h.state().transcripts["dead-1"]!;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind === "notice" && blocks[0].text).toContain("can't be reopened");
    expect(h.sessionManager.isLive("dead-1")).toBe(false);

    await h.pool.stop("sh8");
  });

  it("opening a resume-only session attaches it, saying load isn't supported", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { sessionCapabilities: { resume: {} } }, turn: [{ type: "chunk", text: "ok" }] }, "sh9"),
    );
    const sessionId = await h.sessionManager.createSession("sh9", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "before");
    h.sessionManager.invalidateAgent("sh9");

    h.sessionManager.activate(sessionId); // a click
    const start = Date.now();
    while (!h.sessionManager.isLive(sessionId)) {
      if (Date.now() - start > 3000) throw new Error("open never resumed");
      await new Promise((r) => setTimeout(r, 20));
    }
    const blocks = h.state().transcripts[sessionId]!;
    const notice = blocks.find((b) => b.kind === "notice");
    expect(notice?.kind === "notice" && notice.text).toContain("doesn't support replaying history");
    // ready to prompt straight away — same session, context attached
    await h.sessionManager.sendPrompt(sessionId, "after");
    expect(h.state().sessions.map((s) => s.id)).toEqual([sessionId]);

    await h.pool.stop("sh9");
  });

  it("release frees an attached session on the wire; the next open re-attaches", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { close: {} } }, turn: [{ type: "chunk", text: "x" }] },
        "sh10",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sh10", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "work");

    await h.sessionManager.release(sessionId, "idle");
    expect(h.sessionManager.isLive(sessionId)).toBe(false);
    expect(h.state().capabilities.sh10?.["session.close"]).toMatchObject({ declared: true, used: true });
    // the row survives — release frees resources, it never closes the chat
    expect(h.state().sessions.map((s) => s.id)).toEqual([sessionId]);

    h.sessionManager.activate(sessionId);
    const start = Date.now();
    while (!h.sessionManager.isLive(sessionId)) {
      if (Date.now() - start > 3000) throw new Error("re-open never re-attached");
      await new Promise((r) => setTimeout(r, 20));
    }

    await h.pool.stop("sh10");
  });

  it("release requires declared session/load — resume alone is not enough (no saved history to fall back on)", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { sessionCapabilities: { close: {}, resume: {} } } }, "sh11"),
    );
    const sessionId = await h.sessionManager.createSession("sh11", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "irreplaceable transcript");

    // resume would bring back the context but not the visible history —
    // and patchbay persists none, so closing would destroy the only copy.
    await h.sessionManager.release(sessionId, "idle");
    expect(h.sessionManager.isLive(sessionId)).toBe(true);

    await h.pool.stop("sh11");
  });

  it("the idle reaper releases idle sessions — but never the one open in the view", async () => {
    const h = harness({ idleCloseMs: 150 });
    await h.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { close: {} } }, turn: [{ type: "chunk", text: "x" }] },
        "sh12",
      ),
    );
    const idle = await h.sessionManager.createSession("sh12", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(idle, "then silence");
    const active = await h.sessionManager.createSession("sh12", "Fake Agent", cwd); // activates itself
    await h.sessionManager.sendPrompt(active, "also silent, but visible");
    expect(h.state().activeSessionId).toBe(active);

    const start = Date.now();
    while (h.sessionManager.isLive(idle)) {
      if (Date.now() - start > 3000) throw new Error("reaper never fired");
      await new Promise((r) => setTimeout(r, 25));
    }
    // long past its own idle threshold, the visible session is still attached
    expect(h.sessionManager.isLive(active)).toBe(true);
    // the reaped row survives in the list — released, not closed
    expect(h.state().sessions.map((s) => s.id)).toEqual([idle, active]);

    h.sessionManager.dispose();
    await h.pool.stop("sh12");
  });

  it("the reaper never touches a still-new session — new sessions never close, period", async () => {
    const h = harness({ idleCloseMs: 100 });
    await h.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { close: {} } }, turn: [{ type: "chunk", text: "x" }] },
        "sh13",
      ),
    );
    const fresh = await h.sessionManager.createSession("sh13", "Fake Agent", cwd);
    const active = await h.sessionManager.createSession("sh13", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(active, "make this one the visible, prompted one");
    expect(h.state().activeSessionId).toBe(active);

    // well past the idle threshold: the never-prompted session is untouched
    await new Promise((r) => setTimeout(r, 400));
    expect(h.sessionManager.isLive(fresh)).toBe(true);

    h.sessionManager.dispose();
    await h.pool.stop("sh13");
  });

  it("the reaper never closes under an unseen result — the blue mark blocks it", async () => {
    let unseenId: string | null = null;
    const h = harness({ idleCloseMs: 100, isUnseen: (id) => id === unseenId });
    await h.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { close: {} } }, turn: [{ type: "chunk", text: "x" }] },
        "sh14",
      ),
    );
    const idle = await h.sessionManager.createSession("sh14", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(idle, "finished while looking away");
    unseenId = idle;
    const active = await h.sessionManager.createSession("sh14", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(active, "the visible one");

    await new Promise((r) => setTimeout(r, 400));
    expect(h.sessionManager.isLive(idle)).toBe(true); // blue mark holds it open

    unseenId = null; // the user looked — first reap after that may release it
    const start = Date.now();
    while (h.sessionManager.isLive(idle)) {
      if (Date.now() - start > 3000) throw new Error("reaper never fired after unseen cleared");
      await new Promise((r) => setTimeout(r, 25));
    }

    h.sessionManager.dispose();
    await h.pool.stop("sh14");
  });

  it("close deletes on the agent once session.delete is used — no resurrection on resync", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "sh6"));
    // the probe's own delete round-trip proves the row (connect-time hygiene)
    await h.capabilityTracker.verify("sh6");
    expect(h.state().capabilities.sh6?.["session.delete"]).toMatchObject({ declared: true, used: true });

    const sessionId = await h.sessionManager.createSession("sh6", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "leave a durable record");
    await h.sessionManager.close(sessionId);

    // the agent's own list must no longer report it — else the next sync
    // would resurrect a session the user asked to remove
    const listed = await h.pool.listSessions("sh6", { cwd });
    expect(listed.sessions.map((s) => s.sessionId)).not.toContain(sessionId);
    await h.sessionManager.syncAgentSessions("sh6");
    expect(h.state().sessions.map((s) => s.id)).not.toContain(sessionId);

    await h.pool.stop("sh6");
  });
});

describe("harnessEnvelopeTag — injected user-role envelope classification", () => {
  it("matches a single harness envelope (nested foreign tags included)", () => {
    const text =
      "<task-notification>\n<task-id>abc</task-id>\n<output-file>/tmp/x.output</output-file>\n<result>done</result>\n</task-notification>";
    expect(harnessEnvelopeTag(text)).toBe("task-notification");
  });

  it("matches a sequence of sibling envelopes (slash-command echo shape)", () => {
    const text =
      '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>\n<local-command-stdout>Set model</local-command-stdout>';
    expect(harnessEnvelopeTag(text)).toBe("command-name");
  });

  it("matches system-reminder with surrounding whitespace and self-closing elements", () => {
    expect(harnessEnvelopeTag("  <system-reminder>context</system-reminder>\n")).toBe("system-reminder");
    expect(harnessEnvelopeTag("<command-args/>")).toBe("command-args");
  });

  it("rejects anything a human plausibly typed — conservative by design", () => {
    expect(harnessEnvelopeTag("fix the login bug")).toBeNull();
    expect(harnessEnvelopeTag("what does <b>bold</b> mean here, in this html?")).toBeNull();
    expect(harnessEnvelopeTag("<div>some pasted html</div> plus my question")).toBeNull();
    expect(harnessEnvelopeTag("<unclosed>never ends")).toBeNull();
    expect(harnessEnvelopeTag("")).toBeNull();
  });
});
