// P4 gate: session/new → prompt → streamed session/update → transcript;
// stop turn; close; slash-command advertisement; render cache rebuilt
// wholesale from session/load replay after a crash. Sessions are the
// agent's truth: patchbay persists no index and no transcripts.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertKind } from "./support/assert-kind";
import { CapabilityTracker } from "../src/orchestrator/capability-tracker";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import { harnessEnvelopeTag, SessionManager } from "../src/orchestrator/session-manager";
import { sessionsActiveToday } from "../src/orchestrator/session-stats";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { SessionContinuityStore } from "../src/orchestrator/stores/session-continuity";
import { UsedCapabilityStore } from "../src/orchestrator/stores/used-capabilities";
import {
  initialAgentViewState,
  reduceAgentView,
  type AgentViewEvent,
  type AgentViewState,
  type ChatBlock,
  userPartsText,
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
  /** Stand-in for the orchestrator's auth-lock read — the turn-start door
   * consults it before any transcript write or wire call. */
  authLocked?(agentId: string): boolean;
  /** Shared across two harnesses to simulate a window reload: the durable
   * per-session continuity row is the only state that survives. */
  continuityStore?: SessionContinuityStore;
  /** Stand-in for the orchestrator's pinned-panel list: sessions on view
   * in their own window, active-pointer or not. */
  pinned?: ReadonlySet<string>;
  /** Stand-in for the orchestrator's connect-on-demand — records the asks. */
  onConnectForSession?(sessionId: string): void;
  /** Stand-in for the open workspace's folders (reality read, never stored)
   * — the first is the cwd; the rest must reach the agent as additional
   * directories. Mutable through the returned array to simulate a folder
   * change. */
  workspaceRoots?: readonly string[];
  /** Stand-in for the orchestrator's saved-roots read — this workspace's
   * list, then every workspace's, as stored (duplicates and all). */
  savedRoots?: readonly string[];
  /** Folders gone from disk — stand-in for the orchestrator's reality
   * read. Mutable through the returned array. */
  missingRoots?: readonly string[];
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
  workspaceRoots: string[];
  /** Every `rootsChanged` the manager fired — the orchestrator's cue to
   * tell the session's MCP subprocesses. */
  rootsChanged: string[];
  missingRoots: string[];
  /** Every `rootsMissing` report — the orchestrator's cue to republish the
   * saved roots with their missing marks. */
  rootsMissing: string[][];
} {
  const events: AgentViewEvent[] = [];
  const silentEvents: AgentViewEvent[] = [];
  const workspaceRoots = [...(opts?.workspaceRoots ?? [])];
  const rootsChanged: string[] = [];
  const missingRoots = [...(opts?.missingRoots ?? [])];
  const rootsMissing: string[][] = [];
  const continuity = opts?.continuityStore ?? new SessionContinuityStore(new MemoryKV());
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
      workspaceRoots: () => workspaceRoots,
      savedRoots: () => opts?.savedRoots ?? [],
      rootExists: (path) => !missingRoots.includes(path),
      rootsMissing: (paths) => rootsMissing.push([...paths]),
      rootsChanged: (sessionId) => rootsChanged.push(sessionId),
      currentTranscript: (sessionId) =>
        events.reduce(reduceAgentView, initialAgentViewState).transcripts[sessionId] ?? [],
      titleOf: (sessionId) =>
        events.reduce(reduceAgentView, initialAgentViewState).sessions.find((s) => s.id === sessionId)?.title,
      isDeleteUsed: (agentId) =>
        events.reduce(reduceAgentView, initialAgentViewState).capabilities[agentId]?.["session.delete"]
          ?.used ?? false,
      isActiveSession: (sessionId) =>
        events.reduce(reduceAgentView, initialAgentViewState).activeSessionId === sessionId ||
        (opts?.pinned?.has(sessionId) ?? false),
      // Sidebar-pointer semantics (orchestrator mirrors this shape: pinned
      // panels excluded).
      isPointerActive: (sessionId) =>
        events.reduce(reduceAgentView, initialAgentViewState).activeSessionId === sessionId,
      connectForSession: (sessionId) => opts?.onConnectForSession?.(sessionId),
      isUnseen: (sessionId) => opts?.isUnseen?.(sessionId) ?? false,
      authLocked: (agentId) => opts?.authLocked?.(agentId) ?? false,
      continuityFor: (sessionId, agentId) => continuity.read(sessionId, agentId),
      onContinuity: (sessionId, agentId, sessionCwd, patch) => {
        void (patch === null
          ? continuity.forget(sessionId, agentId)
          : continuity.patch(sessionId, agentId, sessionCwd, patch));
      },
      reconcileContinuity: (agentId, sessionCwd, keep) => {
        void continuity.reconcile(agentId, sessionCwd, keep);
      },
      forgetAgentContinuity: (agentId) => {
        void continuity.forgetAgent(agentId);
      },
      draftOf: (sessionId) => events.reduce(reduceAgentView, initialAgentViewState).drafts[sessionId],
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
    workspaceRoots,
    rootsChanged,
    missingRoots,
    rootsMissing,
  };
}

function textOf(block: ChatBlock | undefined): string {
  return block !== undefined && (block.kind === "text" || block.kind === "thought")
    ? block.text
    : "";
}

/** An agent on which roots work end to end: it advertises
 * `additionalDirectories` (the spec forbids sending the field otherwise)
 * and `session/resume` (the one re-apply rung after a turn). */
const ROOTS_CAPS = { sessionCapabilities: { additionalDirectories: {}, resume: {} } } as const;

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
    expect(blocks[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "go go go" }] });
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
    expect(users.map((b) => b.kind === "user" && userPartsText(b.parts))).toEqual(["first", "second"]);
    await h.pool.stop("smq1");
  });

  it("a held prompt carries the composer's draft; take-back is tail-only, draft-only, and leaves the rest in order", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }], stepDelayMs: 150 },
        "smq4",
      ),
    );
    const sessionId = await h.sessionManager.createSession("smq4", "Fake Agent", cwd);

    const promptDone = h.sessionManager.sendPrompt(sessionId, "first");
    await new Promise((r) => setTimeout(r, 80));
    await h.sessionManager.sendPrompt(sessionId, "second", undefined, '{"editor":"second"}');
    await h.sessionManager.sendPrompt(sessionId, "third"); // held before the composer sent drafts
    await h.sessionManager.sendPrompt(sessionId, "fourth", undefined, '{"editor":"fourth"}');
    const [a, b, c] = h.state().promptQueue[sessionId]!;
    expect([a, b, c]).toMatchObject([
      { text: "second", draft: '{"editor":"second"}' },
      { text: "third" },
      { text: "fourth", draft: '{"editor":"fourth"}' },
    ]);

    // not the tail — refused, nothing moves
    expect(h.sessionManager.reclaimQueuedPrompt(sessionId, a!.id)).toBeUndefined();
    expect(h.state().promptQueue[sessionId]).toHaveLength(3);
    // the tail — comes back with its editor state, the rest keep their order
    expect(h.sessionManager.reclaimQueuedPrompt(sessionId, c!.id)).toMatchObject({ draft: '{"editor":"fourth"}' });
    expect(h.state().promptQueue[sessionId]!.map((q) => q.text)).toEqual(["second", "third"]);
    // the new tail has nothing to come back as — refused, it copies and fires
    expect(h.sessionManager.reclaimQueuedPrompt(sessionId, b!.id)).toBeUndefined();
    expect(h.state().promptQueue[sessionId]).toHaveLength(2);

    await promptDone;
    await new Promise((r) => setTimeout(r, 900));
    const users = h.state().transcripts[sessionId]!.filter((x) => x.kind === "user");
    expect(users.map((x) => x.kind === "user" && userPartsText(x.parts))).toEqual(["first", "second", "third"]);
    await h.pool.stop("smq4");
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

  // The turn-start door: a standing auth lock is inFlight's peer — words
  // sent into a locked agent hold as visible queue rows (no fabricated
  // user message, nothing on the wire) and fire when the lock's clearing
  // releases them. The live-caught shape: prompting a reconnected-but-
  // logged-out agent fabricated a phantom "Hi" plus an error turn.
  it("a prompt into a locked agent holds at the door and fires on release", async () => {
    let locked = true;
    const h = harness({ authLocked: () => locked });
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "served" }] }, "smq3"));
    const sessionId = await h.sessionManager.createSession("smq3", "Fake Agent", cwd);

    await h.sessionManager.sendPrompt(sessionId, "held words"); // resolves immediately: held
    expect(h.state().promptQueue[sessionId]).toMatchObject([{ text: "held words" }]);
    // nothing fabricated: no user message, no turn
    expect(h.state().transcripts[sessionId]).toEqual([]);

    locked = false;
    h.sessionManager.drainHeldQueues("smq3");
    await new Promise((r) => setTimeout(r, 500));
    expect(h.state().promptQueue[sessionId] ?? []).toEqual([]);
    const users = h.state().transcripts[sessionId]!.filter((b) => b.kind === "user");
    expect(users.map((b) => b.kind === "user" && userPartsText(b.parts))).toEqual(["held words"]);
    await h.pool.stop("smq3");
  });

  it("the turn-end drain holds queued words under a lock that landed mid-turn", async () => {
    let locked = false;
    const h = harness({ authLocked: () => locked });
    await h.pool.connect(
      spec(
        { turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }], stepDelayMs: 150 },
        "smq4",
      ),
    );
    const sessionId = await h.sessionManager.createSession("smq4", "Fake Agent", cwd);

    const promptDone = h.sessionManager.sendPrompt(sessionId, "first");
    await new Promise((r) => setTimeout(r, 80));
    await h.sessionManager.sendPrompt(sessionId, "second"); // queued mid-turn
    locked = true; // logout witnessed while the turn streamed
    await promptDone;
    await new Promise((r) => setTimeout(r, 300));

    // held, not fired — and not dropped
    expect(h.state().promptQueue[sessionId]).toMatchObject([{ text: "second" }]);
    expect(h.state().transcripts[sessionId]!.filter((b) => b.kind === "user")).toHaveLength(1);

    // login clears the lock: the release valve fires the held words
    locked = false;
    h.sessionManager.drainHeldQueues("smq4");
    await new Promise((r) => setTimeout(r, 600));
    expect(h.state().promptQueue[sessionId] ?? []).toEqual([]);
    expect(h.state().transcripts[sessionId]!.filter((b) => b.kind === "user")).toHaveLength(2);
    await h.pool.stop("smq4");
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

  // Issue #48: agents send whole files (Gemini, Codex) or just the changed
  // regions (Claude, OpenCode's edit input). Each diff is counted against
  // its own counterpart — a region measured against the file on disk, or
  // against another edit's region, counted lines nobody touched (+41 −1 for
  // two one-line edits to a 40-line file).
  it("an edit counts its own diff — regions against their counterparts, never the file (#48)", async () => {
    const h = harness();
    const target = "/ws/forty.txt";
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "e1", title: "Edit", kind: "edit" },
            { type: "toolDone", id: "e1", diff: { path: target, oldText: "line 10", newText: "LINE 10" } },
            { type: "toolCall", id: "e2", title: "Edit", kind: "edit" },
            // the post-edit shape: one hunk with its unchanged context
            { type: "toolDone", id: "e2", diff: { path: target, oldText: "line 29\nline 30\nline 31", newText: "line 29\nLINE 30\nline 31" } },
          ],
        },
        "sm48a",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm48a", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "edit");
    const tools = h.state().transcripts[sessionId]!.filter((b) => b.kind === "toolCall");
    expect(tools.map((t) => assertKind(t, "toolCall").diffs)).toEqual([
      { [target]: { additions: 1, deletions: 1 } },
      { [target]: { additions: 1, deletions: 1 } },
    ]);
    await h.pool.stop("sm48a");
  });

  it("several regions of one file sum, and open as one diff joined by a shared marker (#48)", async () => {
    const h = harness();
    const target = "/ws/multi.ts";
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "m1", title: "Edit", kind: "edit" },
            {
              type: "toolDone",
              id: "m1",
              content: [
                { type: "diff", path: target, oldText: "a\nb", newText: "a\nB" },
                { type: "diff", path: target, oldText: "x\ny\nz", newText: "x\nz" },
                { type: "diff", path: "/ws/other.ts", oldText: "k", newText: "k\nl" },
              ],
            },
          ],
        },
        "sm48b",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm48b", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "edit");
    const tool = assertKind(h.state().transcripts[sessionId]!.find((b) => b.kind === "toolCall"), "toolCall");
    expect(tool.diffs).toEqual({
      [target]: { additions: 1, deletions: 2 },
      "/ws/other.ts": { additions: 1, deletions: 0 },
    });
    // no region is keyed away — both open, side by side, marker on each side
    expect(h.sessionManager.toolCallDiff(sessionId, "m1", target)).toEqual({
      oldText: "a\nb\n⋯\nx\ny\nz",
      newText: "a\nB\n⋯\nx\nz",
    });
    await h.pool.stop("sm48b");
  });

  // The overwrite shape: announced as a creation (no oldText, the whole
  // new file), then corrected by the post-edit update to the real hunk.
  // The update's content is the whole collection — its diffs replace the
  // announcement's, counts and openable texts alike.
  it("an update's diffs replace the announced ones — counts and texts (#48)", async () => {
    const h = harness();
    const target = "/ws/over.txt";
    await h.pool.connect(
      spec(
        {
          turn: [
            {
              type: "toolCall",
              id: "o1",
              title: "Write",
              kind: "edit",
              content: [{ type: "diff", path: target, oldText: null, newText: "hello\nworld\n" }],
            },
            { type: "toolDone", id: "o1", diff: { path: target, oldText: "a\nb\nc", newText: "hello\nworld" } },
          ],
          stepDelayMs: 150,
        },
        "sm48d",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm48d", "Fake Agent", cwd);
    const turn = h.sessionManager.sendPrompt(sessionId, "overwrite");
    const card = () => h.state().transcripts[sessionId]?.find((b) => b.kind === "toolCall");
    const start = Date.now();
    while (card() === undefined) {
      if (Date.now() - start > 2000) throw new Error("tool call never announced");
      await new Promise((r) => setTimeout(r, 10));
    }
    // announced: what the agent said — a creation
    expect(assertKind(card(), "toolCall").diffs).toEqual({ [target]: { additions: 2, deletions: 0 } });
    await turn;
    // corrected: the update's hunk, and the texts the ± opens follow it
    expect(assertKind(card(), "toolCall").diffs).toEqual({ [target]: { additions: 2, deletions: 3 } });
    expect(h.sessionManager.toolCallDiff(sessionId, "o1", target)).toEqual({ oldText: "a\nb\nc", newText: "hello\nworld" });
    await h.pool.stop("sm48d");
  });

  // A failed edit: announced with its diff, then an update whose content is
  // only the error. The update's content is the whole collection, so the
  // count goes — a card claiming +1 −1 for an edit that never happened is
  // the lie this replaces.
  it("an update carrying only text clears the call's diffs — a failed edit counts nothing (#48)", async () => {
    const h = harness();
    const target = "/ws/failed.md";
    await h.pool.connect(
      spec(
        {
          turn: [
            {
              type: "toolCall",
              id: "f1",
              title: "Edit",
              kind: "edit",
              content: [{ type: "diff", path: target, oldText: "not there", newText: "never written" }],
            },
            {
              type: "toolDone",
              id: "f1",
              content: [{ type: "content", content: { type: "text", text: "String to replace not found in file." } }],
            },
          ],
          stepDelayMs: 150,
        },
        "sm48e",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm48e", "Fake Agent", cwd);
    const turn = h.sessionManager.sendPrompt(sessionId, "edit");
    const card = () => h.state().transcripts[sessionId]?.find((b) => b.kind === "toolCall");
    const start = Date.now();
    while (card() === undefined) {
      if (Date.now() - start > 2000) throw new Error("tool call never announced");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(assertKind(card(), "toolCall").diffs).toEqual({ [target]: { additions: 1, deletions: 1 } });
    await turn;
    expect(assertKind(card(), "toolCall").diffs).toEqual({});
    expect(h.sessionManager.toolCallDiff(sessionId, "f1", target)).toBeNull();
    await h.pool.stop("sm48e");
  });

  it("a diff with no oldText counts every new line as added — what the agent said (#48)", async () => {
    const h = harness();
    const target = "/ws/written.txt";
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "w1", title: "Write", kind: "edit" },
            { type: "toolDone", id: "w1", diff: { path: target, newText: "one\ntwo\nthree" } },
          ],
        },
        "sm48c",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm48c", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "write");
    const tool = assertKind(h.state().transcripts[sessionId]!.find((b) => b.kind === "toolCall"), "toolCall");
    expect(tool.diffs).toEqual({ [target]: { additions: 3, deletions: 0 } });
    expect(h.sessionManager.toolCallDiff(sessionId, "w1", target)).toEqual({ oldText: "", newText: "one\ntwo\nthree" });
    await h.pool.stop("sm48c");
  });

  it("held words survive an agent crash and fire after reconnect — only the user discards", async () => {
    const h = harness();
    // The dying script serves one chunk then exits mid-turn; the reconnect
    // uses a healthy one — a crash is an event, not a personality trait.
    const dying: FakeAgentScript = {
      declare: { loadSession: true },
      turn: [{ type: "chunk", text: "a" }, { type: "crash" }],
      stepDelayMs: 200,
    };
    const healthy: FakeAgentScript = {
      declare: { loadSession: true },
      turn: [{ type: "chunk", text: "ok" }],
    };
    await h.pool.connect(spec(dying, "smc1"));
    const sessionId = await h.sessionManager.createSession("smc1", "Fake Agent", cwd);
    const promptDone = h.sessionManager.sendPrompt(sessionId, "first").catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    await h.sessionManager.sendPrompt(sessionId, "held words"); // queued mid-turn
    await promptDone; // the crash step kills the process under the live turn
    await new Promise((r) => setTimeout(r, 250)); // exit handler + deferred drain settle

    // the crash dropped the live session — but the words held, visibly
    expect(h.sessionManager.isLive(sessionId)).toBe(false);
    expect(h.state().promptQueue[sessionId]).toMatchObject([{ text: "held words" }]);

    // reconnect: the next prompt joins BEHIND the held words, which fire first
    await h.pool.connect(spec(healthy, "smc1"));
    await h.sessionManager.sendPrompt(sessionId, "after reconnect");
    const start = Date.now();
    let users: string[] = [];
    for (;;) {
      users = (h.state().transcripts[sessionId] ?? [])
        .filter((b) => b.kind === "user")
        .map((b) => (b.kind === "user" ? userPartsText(b.parts) : ""));
      if ((h.state().promptQueue[sessionId]?.length ?? 0) === 0 && users.length >= 2) break;
      if (Date.now() - start > 3500) {
        throw new Error(
          `held words never fired — users: ${JSON.stringify(users)} queue: ${JSON.stringify(h.state().promptQueue[sessionId])} live: ${h.sessionManager.isLive(sessionId)} status: ${h.pool.get("smc1")?.status}`,
        );
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(users.slice(-2)).toEqual(["held words", "after reconnect"]);
    await h.pool.stop("smc1");
  }, 15000);

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
    expect(blocks[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "first turn" }] });
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
    expect(blocks[3]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "second turn" }] });
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
      "userPartAppended",
      "agentTextDelta",
      "turnEnded",
    ]);
    expect(h.resyncCount()).toBe(1);
    // canonical state is complete regardless of delivery path
    const blocks = h.state().transcripts[sessionId]!;
    expect(blocks[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "first turn" }] });
    expect(textOf(blocks[1])).toBe("hello");
    expect(blocks[2]).toMatchObject({ kind: "turnEnd", startedAt: null });
    expect(blocks[3]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "second turn" }] });
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
    expect(blocks[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "/cmd" }] });
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
            { type: "toolCall", id: "e1", title: "Edit a.ts", kind: "edit", locations: [{ path: "/ws/a.ts" }] },
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
    expect(tool.locations).toEqual([{ path: "/ws/a.ts", line: null }]);

    await h.pool.stop("sm13d");
  });

  it("an agent's non-text chunks become parts between its prose, never a placeholder (issue #45)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "chunk", text: "Here is the screenshot:" },
            { type: "agentContent", content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } },
            { type: "chunk", text: "and the notes:" },
            { type: "agentContent", content: { type: "resource", resource: { uri: "file:///ws/n.md", text: "note" } } },
            { type: "agentContent", content: { type: "audio", data: "AAAA", mimeType: "audio/wav" }, thought: true },
          ],
        },
        "sm45",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm45", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "show me");

    const blocks = h.state().transcripts[sessionId]!.filter((b) => b.kind !== "user" && b.kind !== "turnEnd");
    const shape = blocks.map((b) =>
      b.kind === "text" ? `text:${b.text}` : b.kind === "agentPart" ? `part:${b.part.kind}:${b.thought}` : b.kind,
    );
    expect(shape).toEqual([
      "text:Here is the screenshot:",
      "part:image:false",
      "text:and the notes:",
      "part:context:false",
      "part:unrendered:true",
    ]);
    const image = assertKind(blocks[1], "agentPart").part;
    // the bytes went to the attachments stash for the preview
    expect(image.kind === "image" && image.file !== undefined).toBe(true);
    await h.pool.stop("sm45");
  });

  it("a tool call's content rides the block in the agent's order — text bounded, diffs left to the file rows (issue #44)", async () => {
    const h = harness();
    const long = "x".repeat(5_000);
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "b1", title: "Run build", kind: "execute" },
            {
              type: "toolDone",
              id: "b1",
              rawOutput: { stdout: "ok" },
              content: [
                { type: "content", content: { type: "text", text: "```console\nok\n```" } },
                { type: "terminal", terminalId: "term-7" },
                { type: "diff", path: "/ws/a.ts", oldText: "a", newText: "b" },
                { type: "content", content: { type: "resource_link", name: "a.ts", uri: "file:///ws/a.ts" } },
                { type: "content", content: { type: "resource", resource: { uri: "file:///ws/n.md", text: "note" } } },
                { type: "content", content: { type: "audio", data: "AAAA", mimeType: "audio/wav" } },
                { type: "content", content: { type: "text", text: long } },
              ],
            },
          ],
        },
        "sm44",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm44", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "build");

    const tool = assertKind(h.state().transcripts[sessionId]!.find((b) => b.kind === "toolCall"), "toolCall");
    expect(tool.content.slice(0, 5)).toEqual([
      { kind: "text", text: "```console\nok\n```" },
      { kind: "terminal", terminalId: "term-7" },
      { kind: "mention", name: "a.ts", uri: "file:///ws/a.ts" },
      { kind: "context", label: "file:///ws/n.md", text: "note" },
      { kind: "unrendered", type: "audio" },
    ]);
    const last = tool.content[5]!;
    expect(last.kind === "text" && last.text.endsWith("… truncated (5,000 chars total)")).toBe(true);
    expect(tool.diffs).toEqual({ "/ws/a.ts": { additions: 1, deletions: 1 } });
    // the raw payload stays on the block for the Raw section
    expect(tool.output).toContain('"stdout": "ok"');
    await h.pool.stop("sm44");
  });

  it("a location's line rides the block, read 1-based: 0 is the first line, no line stays none (issue #41)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            {
              type: "toolCall",
              id: "r1",
              title: "Read a.ts",
              kind: "read",
              locations: [{ path: "/ws/a.ts", line: 42 }, { path: "/ws/b.ts", line: 0 }, { path: "/ws/c.ts" }],
            },
            { type: "toolDone", id: "r1" },
          ],
        },
        "sm41",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm41", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "read it");

    const tool = assertKind(h.state().transcripts[sessionId]!.find((b) => b.kind === "toolCall"), "toolCall");
    expect(tool.locations).toEqual([
      { path: "/ws/a.ts", line: 42 },
      { path: "/ws/b.ts", line: 1 },
      { path: "/ws/c.ts", line: null },
    ]);
    await h.pool.stop("sm41");
  });

  it("agent-reported diff content: counts ride the block, texts stay orchestrator-side for the native diff editor", async () => {
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
    expect(tool.diffs).toEqual({ "/ws/a.ts": { additions: 1, deletions: 1 } });
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

  it("attachment chips ride as resource_link to their real path — baseline, no capability consulted", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "echoBlockKinds" }] }, "att1"));
    const sessionId = await h.sessionManager.createSession("att1", "Fake Agent", cwd);
    h.sessionManager.addContext(sessionId, {
      id: "chip-att",
      kind: "attachment",
      label: "File: report.pdf",
      path: "/ws/docs/report.pdf",
      mimeType: "application/pdf",
    });
    h.sessionManager.addContext(sessionId, {
      id: "chip-att-2",
      kind: "attachment",
      label: "File: blob.bin",
      path: "/ws/blob.bin",
      // no mimeType: the producer didn't know one — absent stays absent
    });
    await h.sessionManager.sendPrompt(sessionId, "what are these?");

    const echoed = h.state().transcripts[sessionId]!.find((b) => b.kind === "text");
    const kinds = JSON.parse(echoed?.kind === "text" ? echoed.text : "[]") as Array<Record<string, string>>;
    expect(kinds).toEqual([
      { type: "resource_link", uri: "file:///ws/docs/report.pdf", name: "report.pdf", mimeType: "application/pdf" },
      { type: "resource_link", uri: "file:///ws/blob.bin", name: "blob.bin" },
      { type: "text" },
    ]);
    await h.pool.stop("att1");
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

  it("context roots on a zero-turn session: recreated with the new list — path normalized", async () => {
    const h = harness();
    // Deliberately no load/resume declared: the zero-turn rung is session/new.
    await h.pool.connect(spec({ declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] }, "sm11"));
    const oldId = await h.sessionManager.createSession("sm11", "Fake Agent", cwd);

    await h.sessionManager.addRoot(oldId, "/repo/backend/"); // trailing slash normalized away
    const newId = h.state().activeSessionId!;
    expect(newId).not.toBe(oldId);
    expect(h.state().sessions.some((s) => s.id === oldId)).toBe(false);
    expect(h.state().contextRoots[newId]).toEqual(["/repo/backend"]);
    // each birth tells its own servers once the session exists: the old
    // shell's at creation and on the add, the fresh one's at its re-mint
    expect(h.rootsChanged).toEqual([oldId, oldId, newId]);

    await h.sessionManager.sendPrompt(newId, "roots?");
    const echoed = h.state().transcripts[newId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/backend"]);

    await h.pool.stop("sm11");
  });

  // A root has two readers (issue #34): the session's MCP servers, told at
  // once through the orchestrator, and the agent, told only on a lifecycle
  // request. So an add is always recorded; what the agent's rung decides
  // is when — or whether — the agent's own list moves.
  it("after a turn, an agent that advertises the field but not session/resume: the root is recorded and the servers told; the agent takes it at the next open (issue #34)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { additionalDirectories: {} } }, turn: [{ type: "echoRoots" }] },
        "sm11l",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm11l", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "first turn");

    // load would replay the whole session for one root — never used for a
    // re-apply; without resume the agent's copy waits, but the list is the
    // session's and the servers read it now
    await h.sessionManager.addRoot(sessionId, "/repo/backend");
    expect(h.state().contextRoots[sessionId]).toEqual(["/repo/backend"]);
    expect(h.rootsChanged).toEqual([sessionId, sessionId]); // birth, then the add
    expect(h.sessionManager.rootsOf(sessionId)).toEqual([cwd, "/repo/backend"]);
    expect(h.state().activeSessionId).toBe(sessionId);
    await h.sessionManager.sendPrompt(sessionId, "roots?");
    const before = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(before?.kind === "text" && JSON.parse(before.text)).toEqual([]);

    // the next open — the reload the chip's note offers — carries the whole list
    await h.sessionManager.reload(sessionId);
    await h.sessionManager.sendPrompt(sessionId, "roots?");
    const after = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(after?.kind === "text" && JSON.parse(after.text)).toEqual(["/repo/backend"]);

    await h.pool.stop("sm11l");
  });

  it("multi-root workspace: every folder beyond the cwd rides as an additional directory — at session/new, on a root change, and on a folder change (issue #28)", async () => {
    const h = harness({ workspaceRoots: [cwd, "/repo/second", "/repo/third"] });
    await h.pool.connect(
      spec({ declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] }, "sm28"),
    );
    const sessionId = await h.sessionManager.createSession("sm28", "Fake Agent", cwd);
    const wireRoots = async () => {
      await h.sessionManager.sendPrompt(sessionId, "roots?");
      const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
      return echoed?.kind === "text" ? (JSON.parse(echoed.text) as string[]) : null;
    };
    // session/new: the folders the chip already counts — minus the cwd,
    // which travels as cwd — reached the agent
    expect(await wireRoots()).toEqual(["/repo/second", "/repo/third"]);
    // a user-added external root joins the same list, never replaces it
    await h.sessionManager.addRoot(sessionId, "/repo/backend");
    expect(await wireRoots()).toEqual(["/repo/second", "/repo/third", "/repo/backend"]);
    // a workspace folder removed at runtime: the chip would update — the
    // wire must too, or the two lists diverge again by a rarer path
    h.workspaceRoots.splice(2, 1); // drop /repo/third
    await h.sessionManager.reapplyWorkspaceRoots();
    expect(await wireRoots()).toEqual(["/repo/second", "/repo/backend"]);
    // the durable row carries only the user-added root — folders are read
    // from reality, never stored
    expect(h.state().contextRoots[sessionId]).toEqual(["/repo/backend"]);
    await h.pool.stop("sm28");
  });

  it("an agent that does not advertise additionalDirectories never receives the field (spec MUST) — folders and adds alike", async () => {
    const h = harness({ workspaceRoots: [cwd, "/repo/second"] });
    await h.pool.connect(
      spec({ declare: { sessionCapabilities: { resume: {} } }, turn: [{ type: "echoRoots" }] }, "sm28n"),
    );
    const sessionId = await h.sessionManager.createSession("sm28n", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "roots?");
    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual([]);
    // an add is recorded for the servers (issue #34) and never re-applied
    // on the agent: no field to send, so no re-attach is made for it
    await h.sessionManager.addRoot(sessionId, "/repo/backend");
    expect(h.state().contextRoots[sessionId]).toEqual(["/repo/backend"]);
    expect(h.rootsChanged).toEqual([sessionId, sessionId]); // birth, then the add
    expect(h.sessionManager.rootsOf(sessionId)).toEqual([cwd, "/repo/second", "/repo/backend"]);
    await h.sessionManager.sendPrompt(sessionId, "roots?");
    const again = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(again?.kind === "text" && JSON.parse(again.text)).toEqual([]);
    // one session/new, one prompt, one prompt: nothing re-attached
    expect(h.state().sessions.map((s) => s.id)).toEqual([sessionId]);
    await h.pool.stop("sm28n");
  });

  // Saved roots (issue #32): a preference that shapes a session's birth and
  // nothing after — the session owns its list from then on.
  it("saved roots seed a new session: sent at session/new, then the session's own list — each once, never what it already has (issue #32)", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    const h = harness({
      continuityStore: store,
      workspaceRoots: [cwd, "/repo/second"],
      savedRoots: ["/src/odoo", cwd, "/repo/second", "/src/lib", "/src/odoo"],
    });
    // Resume deliberately not declared: nothing after birth re-applies in
    // place, so an echo that carries them proves session/new did. List +
    // load make the session's row durable.
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true, sessionCapabilities: { list: {}, additionalDirectories: {} } },
          turn: [{ type: "echoRoots" }],
        },
        "sm32",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm32", "Fake Agent", cwd);

    expect(h.state().contextRoots[sessionId]).toEqual(["/src/odoo", "/src/lib"]);
    expect(store.read(sessionId, "sm32")?.roots).toEqual(["/src/odoo", "/src/lib"]);
    // servers spawned during session/new could only ask before the id was
    // known — they are told once the session and its list exist
    expect(h.rootsChanged).toEqual([sessionId]);
    expect(h.sessionManager.rootsOf(sessionId)).toEqual([cwd, "/repo/second", "/src/odoo", "/src/lib"]);
    await h.sessionManager.sendPrompt(sessionId, "roots?");
    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/second", "/src/odoo", "/src/lib"]);
    expect(h.state().sessions.map((s) => s.id)).toEqual([sessionId]); // no re-attach

    // the session's own act from here: removing one leaves the others
    await h.sessionManager.removeRoot(sessionId, "/src/odoo");
    expect(h.state().contextRoots[sessionId]).toEqual(["/src/lib"]);
    await h.pool.stop("sm32");
  });

  it("saved roots reach the servers of an agent that does not advertise the field — the field itself is never sent (issue #32)", async () => {
    const h = harness({ savedRoots: ["/src/odoo"] });
    await h.pool.connect(
      spec({ declare: { sessionCapabilities: { resume: {} } }, turn: [{ type: "echoRoots" }] }, "sm32n"),
    );
    const sessionId = await h.sessionManager.createSession("sm32n", "Fake Agent", cwd);
    expect(h.state().contextRoots[sessionId]).toEqual(["/src/odoo"]);
    expect(h.sessionManager.rootsOf(sessionId)).toEqual([cwd, "/src/odoo"]);
    await h.sessionManager.sendPrompt(sessionId, "roots?");
    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual([]);
    await h.pool.stop("sm32n");
  });

  // A root is a folder on disk: every lifecycle request checks, skips a
  // folder that is gone, and says so in the session (issue #32).
  it("a saved root gone from disk: not seeded, not sent, not served — the session says which, and the saved list is told (issue #32)", async () => {
    const h = harness({ savedRoots: ["/src/odoo", "/src/gone"], missingRoots: ["/src/gone"] });
    await h.pool.connect(spec({ declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] }, "sm32m"));
    const sessionId = await h.sessionManager.createSession("sm32m", "Fake Agent", cwd);

    expect(h.state().contextRoots[sessionId]).toEqual(["/src/odoo"]);
    expect(h.sessionManager.rootsOf(sessionId)).toEqual([cwd, "/src/odoo"]);
    expect(h.rootsMissing).toEqual([["/src/gone"]]);
    const notice = h.state().transcripts[sessionId]!.find((b) => b.kind === "notice");
    expect(notice?.kind === "notice" && notice.text).toContain("/src/gone");
    await h.sessionManager.sendPrompt(sessionId, "roots?");
    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/src/odoo"]);
    await h.pool.stop("sm32m");
  });

  it("a session's own root gone from disk: kept on its list, skipped at the next open and by its servers, with a notice (issue #32)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true, sessionCapabilities: { list: {}, additionalDirectories: {}, resume: {} } },
          turn: [{ type: "echoRoots" }],
        },
        "sm32g",
      ),
    );
    const firstId = await h.sessionManager.createSession("sm32g", "Fake Agent", cwd);
    await h.sessionManager.addRoot(firstId, "/repo/backend"); // zero-turn: re-minted
    const sessionId = h.state().activeSessionId!;
    await h.sessionManager.sendPrompt(sessionId, "first turn");

    h.missingRoots.push("/repo/backend");
    expect(h.sessionManager.rootsOf(sessionId)).toEqual([cwd]);
    await h.sessionManager.reload(sessionId);
    expect(h.state().contextRoots[sessionId]).toEqual(["/repo/backend"]); // the user's list, untouched
    expect(h.rootsMissing).toEqual([["/repo/backend"]]);
    const notice = h.state().transcripts[sessionId]!.filter((b) => b.kind === "notice").at(-1);
    expect(notice?.kind === "notice" && notice.text).toContain("/repo/backend");
    await h.sessionManager.sendPrompt(sessionId, "roots?");
    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual([]);
    await h.pool.stop("sm32g");
  });

  // The agent's own roots report (issue #33): a session/list row may carry
  // the complete list the last lifecycle request set — whichever client
  // sent it. A present list replaces patchbay's intended list for a session
  // not open here (replaced, never merged), minus the workspace folders
  // patchbay composes itself, so the row keeps only what the user added.
  // An omitted field says nothing: the report is optional, and the agents
  // that declare the field omit it on every row today — the reload case
  // below ("held words, roots, chips, and draft survive") pins that the
  // row stands then.
  describe("a session/list row reporting the session's roots (issue #33)", () => {
    const REPORT_CAPS = {
      loadSession: true,
      sessionCapabilities: { list: {}, additionalDirectories: {}, resume: {} },
    } as const;
    const reportFile = () => join(cwd, "reported-roots.json");
    const report = (roots: string[]) => writeFile(reportFile(), JSON.stringify(roots));

    it("a listed session enters with the reported list, the row following it; a later report replaces again, and an empty one clears", async () => {
      const store = new SessionContinuityStore(new MemoryKV());
      const script: FakeAgentScript = {
        declare: REPORT_CAPS,
        listRootsFrom: reportFile(),
        turn: [{ type: "chunk", text: "x" }],
      };
      const h1 = harness({ continuityStore: store });
      await h1.pool.connect(spec(script, "c33"));
      const sessionId = await h1.sessionManager.createSession("c33", "Fake Agent", cwd);
      await h1.sessionManager.sendPrompt(sessionId, "first turn");
      await h1.sessionManager.addRoot(sessionId, "/repo/extra");
      expect(store.read(sessionId, "c33")?.roots).toEqual(["/repo/extra"]);
      await h1.pool.stop("c33");

      // another client set the roots while no window was open: first sight
      await report(["/other/root"]);
      const h2 = harness({ continuityStore: store });
      await h2.pool.connect(spec(script, "c33"));
      await h2.sessionManager.syncAgentSessions("c33");
      expect(h2.state().contextRoots[sessionId]).toEqual(["/other/root"]);
      expect(store.read(sessionId, "c33")?.roots).toEqual(["/other/root"]);

      // a known session, still not open here: the next walk's report wins again
      await report(["/other/root", "/third"]);
      await h2.sessionManager.syncAgentSessions("c33");
      expect(h2.state().contextRoots[sessionId]).toEqual(["/other/root", "/third"]);

      // an empty report is a report
      await report([]);
      await h2.sessionManager.syncAgentSessions("c33");
      expect(h2.state().contextRoots[sessionId]).toEqual([]);
      expect(store.read(sessionId, "c33")?.roots).toBeUndefined(); // the row carries no empty list
      await h2.pool.stop("c33");
    });

    it("a session open here is not adopted — patchbay is its last writer", async () => {
      const script: FakeAgentScript = {
        declare: REPORT_CAPS,
        listRootsFrom: reportFile(),
        turn: [{ type: "chunk", text: "x" }],
      };
      const h = harness();
      await h.pool.connect(spec(script, "c33o"));
      const sessionId = await h.sessionManager.createSession("c33o", "Fake Agent", cwd);
      await h.sessionManager.sendPrompt(sessionId, "first turn");
      await h.sessionManager.addRoot(sessionId, "/repo/extra");
      await report(["/stale/root"]);
      await h.sessionManager.syncAgentSessions("c33o");
      expect(h.state().contextRoots[sessionId]).toEqual(["/repo/extra"]);
      await h.pool.stop("c33o");
    });

    it("the agent reports the composed list — workspace folders are subtracted, the row keeps only the user's roots, and the wire gets the same composition back", async () => {
      const store = new SessionContinuityStore(new MemoryKV());
      const script: FakeAgentScript = {
        declare: REPORT_CAPS,
        listRootsFrom: reportFile(),
        turn: [{ type: "echoRoots" }],
      };
      const h1 = harness({ continuityStore: store, workspaceRoots: [cwd, "/repo/second"] });
      await h1.pool.connect(spec(script, "c33w"));
      const sessionId = await h1.sessionManager.createSession("c33w", "Fake Agent", cwd);
      await h1.sessionManager.sendPrompt(sessionId, "first turn");
      await h1.pool.stop("c33w");

      await report(["/repo/second", "/repo/extra"]);
      const h2 = harness({ continuityStore: store, workspaceRoots: [cwd, "/repo/second"] });
      await h2.pool.connect(spec(script, "c33w"));
      await h2.sessionManager.syncAgentSessions("c33w");
      expect(h2.state().contextRoots[sessionId]).toEqual(["/repo/extra"]);
      expect(store.read(sessionId, "c33w")?.roots).toEqual(["/repo/extra"]);
      await h2.sessionManager.sendPrompt(sessionId, "roots?");
      const echoed = h2.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
      expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/second", "/repo/extra"]);
      await h2.pool.stop("c33w");
    });
  });

  it("a root added during a live turn is applied before the held prompt fires — the next prompt runs on the new list", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: ROOTS_CAPS, stepDelayMs: 150, turn: [{ type: "echoRoots" }] }, "sm28t"),
    );
    const sessionId = await h.sessionManager.createSession("sm28t", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "warm-up"); // everPrompted: the resume rung, not recreate
    const slow = h.sessionManager.sendPrompt(sessionId, "slow turn");
    await new Promise((r) => setTimeout(r, 30)); // the turn is in flight
    await h.sessionManager.addRoot(sessionId, "/repo/backend"); // deferred to turn end
    const held = h.sessionManager.sendPrompt(sessionId, "roots?"); // held until the turn ends
    await Promise.all([slow, held]);
    for (let i = 0; i < 100; i++) {
      const texts = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text");
      if (texts.length >= 3) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/backend"]);
    await h.pool.stop("sm28t");
  });

  it("root re-apply retains user-steered knobs — the re-attach resets agent defaults, patchbay re-seeds", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: ROOTS_CAPS,
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

    // session/resume handed back the script defaults ("default") — the
    // re-seed must have restored the user's confirmed value.
    const model = h.state().sessionKnobs[sessionId]!.find((k) => k.id === "model");
    expect(model?.currentValue).toBe("sonnet");

    await h.pool.stop("sm11k");
  });

  // The durable copy behind the reattach rule: a window reload wipes the
  // in-memory snapshot, but a restored session is not a deliberate fresh
  // entry — its own combination must come back, not the entry seed. The
  // persisted copy was lost when the session index was removed; this pins
  // its return.
  it("a session's knob combination survives a window reload — restored, not reseeded", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    const script: FakeAgentScript = {
      declare: { loadSession: true, sessionCapabilities: { list: {} } },
      turn: [{ type: "chunk", text: "x" }],
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
    };
    // window 1: the user steers the knob, then the window goes away
    const h1 = harness({ continuityStore: store });
    await h1.pool.connect(spec(script, "smk1"));
    const sessionId = await h1.sessionManager.createSession("smk1", "Fake Agent", cwd);
    await h1.sessionManager.setKnob(sessionId, "model", "sonnet");
    await h1.sessionManager.sendPrompt(sessionId, "first turn");
    expect(store.read(sessionId, "smk1")?.knobs).toMatchObject({ model: "sonnet" });
    await h1.pool.stop("smk1");

    // window 2: fresh processes, fresh memory — only the durable copy survives
    const h2 = harness({ continuityStore: store });
    await h2.pool.connect(spec(script, "smk1"));
    await h2.sessionManager.syncAgentSessions("smk1");
    expect(h2.sessionManager.knows(sessionId)).toBe(true);
    h2.sessionManager.activate(sessionId);
    // session/load hands back the script default; the involuntary-arm
    // reseed must restore the session's own confirmed value
    const start = Date.now();
    for (;;) {
      const model = h2.state().sessionKnobs[sessionId]?.find((k) => k.id === "model");
      if (model?.currentValue === "sonnet") break;
      if (Date.now() - start > 4000) {
        throw new Error(`knob never restored — surface: ${JSON.stringify(h2.state().sessionKnobs[sessionId])}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    await h2.pool.stop("smk1");
  });

  // The rest of the continuity row: held words, user-added roots, prepared
  // chips, and the composer draft all re-enter with the listed session —
  // and the held words release when the lock clears, exactly as they would
  // have in the window that queued them.
  it("held words, roots, chips, and draft survive a window reload", async () => {
    let locked = false;
    const store = new SessionContinuityStore(new MemoryKV());
    const script: FakeAgentScript = {
      declare: { loadSession: true, sessionCapabilities: { list: {}, additionalDirectories: {}, resume: {} } },
      turn: [{ type: "chunk", text: "x" }],
    };
    const h1 = harness({ continuityStore: store, authLocked: () => locked });
    await h1.pool.connect(spec(script, "smq6"));
    const sessionId = await h1.sessionManager.createSession("smq6", "Fake Agent", cwd);
    await h1.sessionManager.sendPrompt(sessionId, "real turn"); // persists agent-side
    await h1.sessionManager.addRoot(sessionId, "/repo/extra");
    h1.sessionManager.addContext(sessionId, {
      kind: "selection",
      id: "chip-1",
      label: "main.ts:1-3",
      content: "const x = 1;",
    });
    locked = true; // logout witnessed
    await h1.sessionManager.sendPrompt(sessionId, "held words"); // → held row
    h1.sessionManager.persistDraft(sessionId, "half-typed thought"); // the orchestrator's debounced save
    await h1.pool.stop("smq6");

    // window 2: fresh memory, lock still standing — the row restores everything
    const h2 = harness({ continuityStore: store, authLocked: () => locked });
    await h2.pool.connect(spec(script, "smq6"));
    await h2.sessionManager.syncAgentSessions("smq6");
    expect(h2.state().promptQueue[sessionId]).toMatchObject([{ text: "held words" }]);
    expect(h2.state().contextRoots[sessionId]).toEqual(["/repo/extra"]);
    expect(h2.state().drafts[sessionId]).toBe("half-typed thought");
    {
      // chips decode async (stash read) — give the tick a moment
      const start = Date.now();
      while ((h2.state().contextChips[sessionId]?.length ?? 0) === 0) {
        if (Date.now() - start > 2000) throw new Error("chip never rehydrated");
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    expect(h2.state().contextChips[sessionId]).toMatchObject([{ id: "chip-1", label: "main.ts:1-3" }]);

    // login clears the lock: the held words fire, chips riding along
    locked = false;
    h2.sessionManager.drainHeldQueues("smq6");
    const start = Date.now();
    for (;;) {
      const users = h2.state().transcripts[sessionId]?.filter((b) => b.kind === "user") ?? [];
      if (users.length >= 2) break;
      if (Date.now() - start > 4000) throw new Error("held words never fired after unlock");
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(h2.state().promptQueue[sessionId] ?? []).toEqual([]);
    await h2.pool.stop("smq6");
  });

  // The row's lifetime, issue #29: a row is written only where the agent's
  // own list can name the session again and the ladder can open it — the
  // same predicate the reclaim depends on. Anything else is stored for a
  // reader that never comes.
  describe("continuity rows live only where they can be read back (issue #29)", () => {
    const CONTINUITY_KEY = "acpPatchbay.sessionContinuity";
    const MODEL_KNOB = [
      {
        id: "model",
        name: "Model",
        category: "model" as const,
        type: "select" as const,
        currentValue: "default",
        options: [
          { value: "default", name: "Default" },
          { value: "sonnet", name: "Sonnet" },
        ],
      },
    ];

    it("an agent without session/list writes no row — knobs, roots, chips, held words, draft alike; a list+resume agent writes them all", async () => {
      let locked = false;
      const kv = new MemoryKV();
      const store = new SessionContinuityStore(kv);
      const h = harness({ continuityStore: store, authLocked: () => locked });
      const script = (list: boolean): FakeAgentScript => ({
        declare: {
          sessionCapabilities: { additionalDirectories: {}, resume: {}, ...(list ? { list: {} } : {}) },
        },
        configOptions: MODEL_KNOB,
        turn: [{ type: "chunk", text: "x" }],
      });
      const stage = async (agentId: string) => {
        const sessionId = await h.sessionManager.createSession(agentId, "Fake Agent", cwd);
        await h.sessionManager.sendPrompt(sessionId, "first turn");
        await h.sessionManager.setKnob(sessionId, "model", "sonnet");
        await h.sessionManager.addRoot(sessionId, "/repo/extra");
        h.sessionManager.addContext(sessionId, { kind: "selection", id: `${agentId}-chip`, label: "a.ts:1", content: "x" });
        locked = true;
        await h.sessionManager.sendPrompt(sessionId, "held words");
        locked = false;
        h.sessionManager.persistDraft(sessionId, "half a thought");
        return sessionId;
      };

      await h.pool.connect(spec(script(false), "c29-nolist"));
      const unlisted = await stage("c29-nolist");
      // the view holds everything the user staged — only the durable copy is refused
      expect(h.state().contextRoots[unlisted]).toEqual(["/repo/extra"]);
      expect(h.state().promptQueue[unlisted]).toMatchObject([{ text: "held words" }]);
      expect(store.list()).toEqual([]);

      await h.pool.connect(spec(script(true), "c29-list"));
      const listed = await stage("c29-list");
      expect(store.list().map((r) => r.agentId)).toEqual(["c29-list"]);
      expect(store.read(listed, "c29-list")).toMatchObject({
        knobs: { model: "sonnet" },
        roots: ["/repo/extra"],
        chips: [{ id: "c29-list-chip" }],
        queue: [{ text: "held words" }],
        draft: "half a thought",
      });
      expect(store.list()[0]?.cwd).toBe(cwd);

      await h.pool.stop("c29-nolist");
      await h.pool.stop("c29-list");
    });

    it("connecting an agent that cannot bring sessions back drops every row it has — older builds' rows included, every workspace", async () => {
      const kv = new MemoryKV();
      const store = new SessionContinuityStore(kv);
      await store.patch("stale", "c29-load", cwd, { draft: "old words" });
      await store.patch("stale-elsewhere", "c29-load", "/elsewhere", { draft: "old words" });
      await store.patch("other", "c29-other", cwd, { draft: "stays" });
      await kv.update(CONTINUITY_KEY, [
        ...(kv.get<unknown[]>(CONTINUITY_KEY) ?? []),
        { id: "c29-load\u0000legacy", agentId: "c29-load", draft: "no cwd" },
      ]);
      const h = harness({ continuityStore: store });
      // load without list: a rung, but nothing ever names the id again
      await h.pool.connect(spec({ declare: { loadSession: true } }, "c29-load"));
      await h.sessionManager.syncAgentSessions("c29-load");
      expect(store.list().map((r) => r.id)).toEqual(["c29-other\u0000other"]);
      await h.pool.stop("c29-load");
    });

    it("a complete list walk reconciles this workspace's rows: unreported rows leave, an older row the walk names is stamped and rehydrated, other workspaces untouched", async () => {
      const kv = new MemoryKV();
      const store = new SessionContinuityStore(kv);
      const script: FakeAgentScript = {
        declare: { loadSession: true, sessionCapabilities: { list: {} } },
        turn: [{ type: "chunk", text: "x" }],
      };
      const h1 = harness({ continuityStore: store });
      await h1.pool.connect(spec(script, "c29-walk"));
      const sessionId = await h1.sessionManager.createSession("c29-walk", "Fake Agent", cwd);
      await h1.sessionManager.sendPrompt(sessionId, "persisted agent-side");
      await h1.pool.stop("c29-walk");

      // while patchbay was closed: one session deleted in the agent's own
      // store, one row from a build that recorded no cwd
      await store.patch("deleted-while-closed", "c29-walk", cwd, { draft: "gone" });
      await store.patch("other-ws", "c29-walk", "/elsewhere", { draft: "stays" });
      await kv.update(CONTINUITY_KEY, [
        ...(kv.get<unknown[]>(CONTINUITY_KEY) ?? []),
        { id: `c29-walk\u0000${sessionId}`, agentId: "c29-walk", draft: "legacy draft" },
      ]);

      const h2 = harness({ continuityStore: store });
      await h2.pool.connect(spec(script, "c29-walk"));
      await h2.sessionManager.syncAgentSessions("c29-walk");
      expect(store.read("deleted-while-closed", "c29-walk")).toBeUndefined();
      expect(store.read("other-ws", "c29-walk")).toEqual({ draft: "stays" });
      expect(store.read(sessionId, "c29-walk")).toEqual({ draft: "legacy draft" });
      expect(store.list().find((r) => r.id === `c29-walk\u0000${sessionId}`)?.cwd).toBe(cwd);
      expect(h2.state().drafts[sessionId]).toBe("legacy draft");
      await h2.pool.stop("c29-walk");
    });

    it("a live zero-turn session's row survives a walk that does not report it yet", async () => {
      const store = new SessionContinuityStore(new MemoryKV());
      const h = harness({ continuityStore: store });
      await h.pool.connect(
        spec({ declare: { loadSession: true, sessionCapabilities: { list: {} } }, configOptions: MODEL_KNOB }, "c29-live"),
      );
      const sessionId = await h.sessionManager.createSession("c29-live", "Fake Agent", cwd);
      await h.sessionManager.setKnob(sessionId, "model", "sonnet");
      expect(store.read(sessionId, "c29-live")?.knobs).toEqual({ model: "sonnet" });
      await h.sessionManager.syncRunningAgents(); // the agent persists nothing until the first turn
      expect(store.read(sessionId, "c29-live")?.knobs).toEqual({ model: "sonnet" });
      await h.pool.stop("c29-live");
    });

    it("agent removal drops rows the index never saw, in every workspace", async () => {
      const store = new SessionContinuityStore(new MemoryKV());
      await store.patch("never-indexed", "c29-rm", "/elsewhere", { draft: "x" });
      await store.patch("keep", "c29-keep", cwd, { draft: "y" });
      const h = harness({ continuityStore: store });
      h.sessionManager.forgetAgentSessions("c29-rm");
      expect(store.list().map((r) => r.agentId)).toEqual(["c29-keep"]);
    });

    it("a zero-turn recreate carries the composer draft from the view — an agent that writes no row still keeps the words", async () => {
      const h = harness();
      await h.pool.connect(spec({ declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] }, "c29-draft"));
      const oldId = await h.sessionManager.createSession("c29-draft", "Fake Agent", cwd);
      // the orchestrator's draft path: durable write (refused here) + view mirror
      h.sessionManager.persistDraft(oldId, "typed before any turn");
      h.events.push({ kind: "sessionDraftChanged", sessionId: oldId, draft: "typed before any turn" });
      await h.sessionManager.addRoot(oldId, "/repo/backend");
      const newId = h.state().activeSessionId!;
      expect(newId).not.toBe(oldId);
      expect(h.state().drafts[newId]).toBe("typed before any turn");
      await h.pool.stop("c29-draft");
    });
  });

  it("a failed root re-apply detaches the session — the next prompt re-enters the ladder, never a corpse", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: ROOTS_CAPS, failResume: true, turn: [{ type: "echoRoots" }] }, "sm11f"),
    );
    const sessionId = await h.sessionManager.createSession("sm11f", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "first turn");
    expect(h.sessionManager.isLive(sessionId)).toBe(true);

    await h.sessionManager.addRoot(sessionId, "/repo/backend");
    expect(h.state().contextRoots[sessionId]).toEqual(["/repo/backend"]); // canonical list stands
    expect(h.sessionManager.isLive(sessionId)).toBe(false); // detached, not a zombie

    await h.pool.stop("sm11f");
  });

  it("context roots after a turn re-apply in place via session/resume — same sessionId, transcript untouched", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] },
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
    // the transcript records the prompt in the part vocabulary — the
    // mention is a structured part, rendered as an inline @app.ts token
    const user = h.state().transcripts[sessionId]!.find((b) => b.kind === "user");
    expect(user?.kind === "user" && user.parts).toEqual([
      { kind: "text", text: "look at " },
      { kind: "mention", name: "app.ts", uri: "file:///repo/src/app.ts" },
      { kind: "text", text: " please" },
    ]);

    await h.pool.stop("sm11p");
  });

  // Issue #30: a never-prompted session whose connection died is still the
  // agent's new session. The agent persisted nothing for it, so no rung can
  // bring the id back — but the row, and everything the user staged on it,
  // is patchbay's. The next use mints the session again from the row.
  describe("a never-prompted session whose connection died (issue #30)", () => {
    async function untilStatus(h: ReturnType<typeof harness>, agentId: string, status: string): Promise<void> {
      const start = Date.now();
      while (h.pool.get(agentId)?.status !== status) {
        if (Date.now() - start > 3000) throw new Error(`${agentId} never reached ${status}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    it("new-session focus still finds the row, and the first prompt re-mints it carrying the draft — no sibling", async () => {
      const h = harness();
      await h.pool.connect(spec({ exitAfterMs: 150 }, "c30a"));
      const oldId = await h.sessionManager.createSession("c30a", "Fake Agent", cwd);
      h.events.push({ kind: "sessionDraftChanged", sessionId: oldId, draft: "typed before the crash" });
      await untilStatus(h, "c30a", "crashed");
      expect(h.sessionManager.isLive(oldId)).toBe(false);
      expect(h.sessionManager.findNeverPrompted("c30a")).toBe(oldId);

      await h.pool.connect(spec({ turn: [{ type: "chunk", text: "ok" }] }, "c30a"));
      await h.sessionManager.sendPrompt(oldId, "first words");
      const rows = h.state().sessions.filter((s) => s.agentId === "c30a");
      expect(rows).toHaveLength(1);
      const newId = rows[0]!.id;
      expect(newId).not.toBe(oldId);
      expect(h.state().transcripts[newId]?.some((b) => b.kind === "user")).toBe(true);
      expect(textOf(h.state().transcripts[newId]?.at(-2))).toBe("ok");
      expect(h.state().drafts[newId]).toBe("typed before the crash");
      // the first prompt ended newness on the fresh id, and named it
      expect(h.sessionManager.findNeverPrompted("c30a")).toBeUndefined();
      expect(rows[0]!.title).toBe("first words");
      await h.pool.stop("c30a");
    });

    it("opening the dead row re-mints it — one live session, focused, chips carried", async () => {
      const h = harness();
      await h.pool.connect(spec({ exitAfterMs: 150 }, "c30b"));
      const oldId = await h.sessionManager.createSession("c30b", "Fake Agent", cwd);
      h.sessionManager.addContext(oldId, { kind: "selection", id: "c30-chip", label: "a.ts:1", content: "x" });
      await untilStatus(h, "c30b", "crashed");

      await h.pool.connect(spec({}, "c30b"));
      h.sessionManager.activate(oldId);
      const start = Date.now();
      let newId: string | undefined;
      for (;;) {
        const rows = h.state().sessions.filter((s) => s.agentId === "c30b");
        newId = rows.find((s) => s.id !== oldId && h.sessionManager.isLive(s.id))?.id;
        if (newId !== undefined) break;
        if (Date.now() - start > 3000) throw new Error("the dead row was never re-minted");
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(h.state().sessions.filter((s) => s.agentId === "c30b")).toHaveLength(1);
      expect(h.state().activeSessionId).toBe(newId);
      expect(h.state().contextChips[newId]).toMatchObject([{ id: "c30-chip" }]);
      await h.pool.stop("c30b");
    });
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

  it("open work counts conversations a stop would disconnect — never-prompted ones cost nothing (issue #47)", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "ok" }], stepDelayMs: 300 }, "w47"));
    const fresh = await h.sessionManager.createSession("w47", "Fake Agent", cwd);
    expect(h.sessionManager.openWork("w47")).toEqual({ conversations: 0, turns: 0 });

    const turn = h.sessionManager.sendPrompt(fresh, "go");
    await vi.waitFor(() => expect(h.sessionManager.openWork("w47")).toEqual({ conversations: 1, turns: 1 }));
    await turn;
    expect(h.sessionManager.openWork("w47")).toEqual({ conversations: 1, turns: 0 });

    await h.sessionManager.createSession("w47", "Fake Agent", cwd);
    expect(h.sessionManager.openWork("w47")).toEqual({ conversations: 1, turns: 0 });
    expect(h.sessionManager.openWork("other-agent")).toEqual({ conversations: 0, turns: 0 });

    await h.pool.stop("w47");
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

  it("malformed list rows degrade at the boundary: metadata to absent, identity-less rows dropped", async () => {
    // acp-matrix fixture finding: rows with epoch-seconds updatedAt used to
    // reach the drawer typed as ISO strings and blank the webview on sort.
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "ext-bad.jsonl"), "", "utf8");

    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS, lies: { malformedListRows: true } }, "shm"));
    await h.sessionManager.syncAgentSessions("shm");

    const state = h.state();
    const row = state.sessions.find((s) => s.id === "ext-bad");
    // The row survives with its bad sort key degraded to a real ISO string…
    expect(row).toBeDefined();
    expect(typeof row!.updatedAt).toBe("string");
    expect(() => row!.updatedAt.localeCompare("2026-01-01T00:00:00Z")).not.toThrow();
    // …and the identity-less row never entered the snapshot.
    expect(state.sessions.some((s) => s.title === "no identity")).toBe(false);

    await h.pool.stop("shm");
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
    expect(blocks.filter((b) => b.kind === "user").map((b) => b.kind === "user" && userPartsText(b.parts))).toEqual([
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

  it("the reaper spares a session holding words — held prompts are unfinished user work", async () => {
    let locked = false;
    const h = harness({ idleCloseMs: 150, authLocked: () => locked });
    await h.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { close: {} } }, turn: [{ type: "chunk", text: "x" }] },
        "smq5",
      ),
    );
    const victim = await h.sessionManager.createSession("smq5", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(victim, "reapable");
    const holding = await h.sessionManager.createSession("smq5", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(holding, "prompted once");
    locked = true;
    await h.sessionManager.sendPrompt(holding, "held words"); // auth-held row
    const active = await h.sessionManager.createSession("smq5", "Fake Agent", cwd); // takes the view

    // the reaper proves it ran by releasing the queue-less idle session…
    const start = Date.now();
    while (h.sessionManager.isLive(victim)) {
      if (Date.now() - start > 3000) throw new Error("reaper never fired");
      await new Promise((r) => setTimeout(r, 25));
    }
    // …while the one holding words stays attached, words intact
    expect(h.sessionManager.isLive(holding)).toBe(true);
    expect(h.state().promptQueue[holding]).toMatchObject([{ text: "held words" }]);
    expect(h.state().sessions.map((s) => s.id)).toEqual([victim, holding, active]);

    h.sessionManager.dispose();
    await h.pool.stop("smq5");
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

// ── the activity stamp has one home: the view's canonical row. The
// session-manager reports evidence (prompt send, turn end, a wire stamp);
// the reducer judges (newest wins); the Settings tile projects it.
describe("session activity stamp — one home", () => {
  const LIST_CAPS = { sessionCapabilities: { list: {}, delete: {} } };
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  it("a wire row stamped yesterday, prompted today: active today — and a re-read cannot move it back", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "old-1.jsonl"), "", "utf8");

    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { ...LIST_CAPS, loadSession: true }, listUpdatedAt: yesterday, turn: [{ type: "chunk", text: "hi" }] },
        "st1",
      ),
    );
    await h.sessionManager.syncAgentSessions("st1");
    const before = h.state().sessions.find((s) => s.id === "old-1");
    expect(before?.updatedAt).toBe(yesterday);
    expect(sessionsActiveToday(h.state().sessions)).toBe(0);

    await h.sessionManager.sendPrompt("old-1", "wake up"); // attaches on demand, then prompts
    const prompted = h.state().sessions.find((s) => s.id === "old-1")!;
    expect(prompted.updatedAt > yesterday).toBe(true);
    // creation-day counting would still say 0 here — the row was born yesterday
    expect(sessionsActiveToday(h.state().sessions)).toBe(1);

    // the wire still says yesterday; newest wins, in the one place it is judged
    await h.sessionManager.syncAgentSessions("st1");
    expect(h.state().sessions.find((s) => s.id === "old-1")!.updatedAt).toBe(prompted.updatedAt);

    await h.pool.stop("st1");
  });

  it("a wire row without a stamp: the re-read says nothing, the row keeps its own", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS, turn: [{ type: "chunk", text: "hi" }] }, "st2"));
    const sessionId = await h.sessionManager.createSession("st2", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "go");
    const after = h.state().sessions.find((s) => s.id === sessionId)!.updatedAt;

    const before = h.events.length;
    await h.sessionManager.syncAgentSessions("st2");
    expect(h.state().sessions.find((s) => s.id === sessionId)!.updatedAt).toBe(after);
    // silence is no event at all — neither a second listing nor an empty refresh
    const during = h.events.slice(before);
    expect(during.some((e) => e.kind === "sessionListed" && e.session.id === sessionId)).toBe(false);
    expect(during.some((e) => e.kind === "sessionRefreshed" && e.sessionId === sessionId)).toBe(false);

    await h.pool.stop("st2");
  });

  it("session_info_update with a null title and no stamp is a clear, not a rename — nothing moves", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "hi" }] }, "st2n"));
    const sessionId = await h.sessionManager.createSession("st2n", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "derive me");
    const before = h.events.length;
    await h.sessionManager.handleUpdate("st2n", {
      sessionId,
      update: { sessionUpdate: "session_info_update", title: null },
    });
    expect(h.events.slice(before).some((e) => e.kind === "sessionRefreshed")).toBe(false);
    expect(h.state().sessions.find((s) => s.id === sessionId)?.title).toBe("derive me");

    await h.pool.stop("st2n");
  });

  it("walks coalesce per agent: a re-read asked mid-walk joins it — one session/list on the wire", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "st6"));
    const listSessions = vi.spyOn(h.pool, "listSessions");
    await Promise.all([h.sessionManager.syncAgentSessions("st6"), h.sessionManager.syncRunningAgents()]);
    expect(listSessions).toHaveBeenCalledTimes(1);
    // …and a later read walks again
    await h.sessionManager.syncRunningAgents();
    expect(listSessions).toHaveBeenCalledTimes(2);

    await h.pool.stop("st6");
  });

  it("a wire list without titles leaves the derived title alone — the refresh carries no title", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS, turn: [{ type: "chunk", text: "hi" }] }, "st4"));
    const sessionId = await h.sessionManager.createSession("st4", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "derive me");
    expect(h.state().sessions.find((s) => s.id === sessionId)?.title).toBe("derive me");

    const before = h.events.length;
    await h.sessionManager.syncAgentSessions("st4");
    expect(h.state().sessions.find((s) => s.id === sessionId)?.title).toBe("derive me");
    // the wire said nothing about this row — no refresh rode at all
    expect(h.events.slice(before).some((e) => e.kind === "sessionRefreshed" && e.sessionId === sessionId)).toBe(false);

    await h.pool.stop("st4");
  });

  it("a zero-turn recreate inherits the title from the view's row — the manager keeps no copy", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] }, "st5"));
    const oldId = await h.sessionManager.createSession("st5", "Fake Agent", cwd);
    // an agent-pushed title lands on the row only (session_info_update path)
    await h.sessionManager.handleUpdate("st5", {
      sessionId: oldId,
      update: { sessionUpdate: "session_info_update", title: "agent named me" },
    });
    expect(h.state().sessions.find((s) => s.id === oldId)?.title).toBe("agent named me");

    await h.sessionManager.addRoot(oldId, "/repo/backend");
    const newId = h.state().activeSessionId!;
    expect(newId).not.toBe(oldId);
    expect(h.state().sessions.find((s) => s.id === newId)?.title).toBe("agent named me");

    await h.pool.stop("st5");
  });

  it("syncRunningAgents re-reads every running list-capable agent — another window's session appears", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "st3"));
    await h.pool.connect(spec({}, "st3-nolist")); // no session/list: skipped, not an error
    await h.sessionManager.syncAgentSessions("st3");
    expect(h.sessionManager.knows("other-window-1")).toBe(false);

    // "another window" writes into the agent's own store after our connect
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "other-window-1.jsonl"), "", "utf8");
    await h.sessionManager.syncRunningAgents();
    expect(h.sessionManager.knows("other-window-1")).toBe(true);
    expect(h.state().sessions.some((s) => s.id === "other-window-1")).toBe(true);

    await h.pool.stop("st3");
    await h.pool.stop("st3-nolist");
  });
});

describe("open — one ceremony for every entrance", () => {
  const LOAD: FakeAgentScript = { declare: { loadSession: true }, turn: [{ type: "chunk", text: "remembered" }] };

  async function untilLive(h: ReturnType<typeof harness>, sessionId: string): Promise<void> {
    const start = Date.now();
    while (!h.sessionManager.isLive(sessionId)) {
      if (Date.now() - start > 3000) throw new Error(`${sessionId} never attached`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("pinned open hydrates the session without moving the pointer, and asks for its agent", async () => {
    const asked: string[] = [];
    const pinned = new Set<string>();
    const h = harness({ pinned, onConnectForSession: (id) => asked.push(id) });
    await h.pool.connect(spec(LOAD, "op1"));
    const older = await h.sessionManager.createSession("op1", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(older, "first");
    const current = await h.sessionManager.createSession("op1", "Fake Agent", cwd);
    expect(h.state().activeSessionId).toBe(current);
    h.sessionManager.invalidateAgent("op1");

    pinned.add(older);
    h.sessionManager.open(older, { pin: true }); // "Open in new window"
    await untilLive(h, older);
    expect(h.state().activeSessionId).toBe(current); // the sidebar didn't move
    expect(asked).toEqual([older]);

    await h.pool.stop("op1");
  });

  it("plain open is a click: pointer, ladder, and the connect ask", async () => {
    const asked: string[] = [];
    const h = harness({ onConnectForSession: (id) => asked.push(id) });
    await h.pool.connect(spec(LOAD, "op2"));
    const sessionId = await h.sessionManager.createSession("op2", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "first");
    h.sessionManager.invalidateAgent("op2");

    h.sessionManager.open(sessionId); // the palette pick, the drawer click
    await untilLive(h, sessionId);
    expect(h.state().activeSessionId).toBe(sessionId);
    expect(asked).toEqual([sessionId]);

    await h.pool.stop("op2");
  });

  it("an agent coming up hydrates every session on view — pinned included, not only the pointer", async () => {
    const pinned = new Set<string>();
    const h = harness({ pinned });
    await h.pool.connect(spec(LOAD, "op3"));
    const shown = await h.sessionManager.createSession("op3", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(shown, "first");
    const other = await h.sessionManager.createSession("op3", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(other, "second");
    expect(h.state().activeSessionId).toBe(other);
    // The agent goes down; the pinned window opens while it's off — nothing
    // to attach to yet, so open can only ask for the connect.
    await h.pool.stop("op3");
    h.sessionManager.invalidateAgent("op3");
    pinned.add(shown);
    h.sessionManager.open(shown, { pin: true });
    expect(h.sessionManager.isLive(shown)).toBe(false);

    await h.pool.connect(spec(LOAD, "op3"));
    await h.sessionManager.hydrateViewed("op3"); // what the status-running hook runs after its list sync
    expect(h.sessionManager.isLive(shown)).toBe(true); // pinned
    expect(h.sessionManager.isLive(other)).toBe(true); // the pointer
    expect(h.state().activeSessionId).toBe(other);

    await h.pool.stop("op3");
  });
});

describe("chunk rendering honesty (G4/G10/G11)", () => {
  async function chunkHarness(agentId: string) {
    const h = harness();
    await h.pool.connect(spec({ declare: {}, turn: [] }, agentId));
    const sessionId = await h.sessionManager.createSession(agentId, "Fake Agent", cwd);
    const push = (update: Record<string, unknown>) =>
      h.sessionManager.handleUpdate(agentId, {
        sessionId,
        update,
      } as Parameters<typeof h.sessionManager.handleUpdate>[1]);
    return { h, sessionId, push, blocks: () => h.state().transcripts[sessionId] ?? [] };
  }

  it("an update from a different agent under the same session id is dropped — ids are only unique per connection", async () => {
    const { h, sessionId, push, blocks } = await chunkHarness("ch-owner");
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "mine" } });
    expect(blocks()).toHaveLength(1);
    // Same sessionId string, different agent: spec-legal collision — must
    // never write into this transcript.
    h.sessionManager.handleUpdate("intruder", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "not mine" } },
    } as Parameters<typeof h.sessionManager.handleUpdate>[1]);
    expect(blocks()).toHaveLength(1);
    await h.pool.stop("ch-owner");
  });

  it("replayed image and embedded-resource chunks land as structured parts in the SAME bubble", async () => {
    const { h, push, blocks } = await chunkHarness("ch-parts");
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "see " }, messageId: "m1" });
    push({ sessionUpdate: "user_message_chunk", content: { type: "image", data: png, mimeType: "image/png" }, messageId: "m1" });
    push({
      sessionUpdate: "user_message_chunk",
      content: { type: "resource", resource: { uri: "file:///ws/ctx.ts", text: "const c = 1;" } },
      messageId: "m1",
    });
    push({ sessionUpdate: "user_message_chunk", content: { type: "audio", data: "x", mimeType: "audio/wav" }, messageId: "m1" });
    expect(blocks()).toHaveLength(1);
    const user = blocks()[0]!;
    expect(user.kind).toBe("user");
    const parts = user.kind === "user" ? user.parts : [];
    expect(parts[0]).toEqual({ kind: "text", text: "see " });
    expect(parts[1]).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect((parts[1] as { file?: string }).file).toMatch(/\.png$/);
    expect(parts[2]).toEqual({ kind: "context", label: "file:///ws/ctx.ts", text: "const c = 1;" });
    expect(parts[3]).toEqual({ kind: "unrendered", type: "audio" });
    await h.pool.stop("ch-parts");
  });

  it("live chips ride the sent bubble as parts — image, attachment, context, then prose", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "ok" }] }, "sm-parts"));
    const sessionId = await h.sessionManager.createSession("sm-parts", "Fake Agent", cwd);
    h.sessionManager.addContext(sessionId, {
      id: "img-1",
      kind: "image",
      label: "pasted image",
      content: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
      mimeType: "image/png",
    });
    h.sessionManager.addContext(sessionId, {
      id: "att-1",
      kind: "attachment",
      label: "notes.md",
      path: "/ws/notes.md",
    });
    h.sessionManager.addContext(sessionId, {
      id: "sel-1",
      kind: "selection",
      label: "Selection: a.ts:1-2",
      content: "const x = 1;",
    });
    await h.sessionManager.sendPrompt(sessionId, "what is this?");
    const user = h.state().transcripts[sessionId]!.find((b) => b.kind === "user");
    expect(user?.kind === "user" && user.parts).toEqual([
      { kind: "image", mimeType: "image/png", file: "img-1.png" },
      { kind: "attachment", name: "notes.md", path: "/ws/notes.md" },
      { kind: "context", label: "Selection: a.ts:1-2", text: "const x = 1;" },
      { kind: "text", text: "what is this?" },
    ]);
    await h.pool.stop("sm-parts");
  });

  it("whitespace-only chunks never open a run — no blank Thought accordion (G11)", async () => {
    const { h, push, blocks } = await chunkHarness("ch1");
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" } });
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "\n\n  " } });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } });
    expect(blocks()).toEqual([]);
    // …but an open run still takes mid-stream whitespace: real spacing
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "part one" } });
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "\n\n" } });
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "part two" } });
    expect(blocks()).toHaveLength(1);
    expect(textOf(blocks()[0])).toBe("part one\n\npart two");
    // and a no-op chunk must not sever a neighboring prose run
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer " } });
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" } });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continues" } });
    expect(blocks()).toHaveLength(2);
    expect(textOf(blocks()[1])).toBe("answer continues");
    await h.pool.stop("ch1");
  });

  it("non-text thought content is never a silent drop: it renders as a part that stays a thought (G11, #45)", async () => {
    const { h, push, blocks } = await chunkHarness("ch2");
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "image", data: "x", mimeType: "image/png" } });
    expect(blocks()).toHaveLength(1);
    expect(blocks()[0]).toMatchObject({ kind: "agentPart", thought: true, part: { kind: "image", mimeType: "image/png" } });
    await h.pool.stop("ch2");
  });

  it("agent prose rides the wire-extension rewriter: a chunk-split vendor wrapper lands as fence attributes", async () => {
    // The rewrite itself is gated in augment-code-snippet.test.ts; this
    // locks the DOOR — deltas route through the run's rewriter (split
    // anywhere), and sealRun flushes a withheld tail when a tool call
    // interrupts the run instead of letting it vanish.
    const { h, push, blocks } = await chunkHarness("ch7");
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Look:\n\n<augment_code_sni" } });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: 'ppet path="a.ts" mode="EXCERPT">\n```ts\n1\n' } });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "```\n</augment_code_snippet>" } });
    expect(textOf(blocks()[0])).toBe('Look:\n\n```ts path="a.ts" excerpt\n1\n```\n');
    // a tail the rewriter is still withholding when prose is interrupted:
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\ntail <augment_code" } });
    expect(textOf(blocks()[0])).toBe('Look:\n\n```ts path="a.ts" excerpt\n1\n```\n\n\ntail ');
    push({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read", status: "pending" });
    expect(textOf(blocks()[0])).toBe('Look:\n\n```ts path="a.ts" excerpt\n1\n```\n\n\ntail <augment_code');
    await h.pool.stop("ch7");
  });

  it("a replayed user resource_link mention merges INTO the prompt bubble as @name (G10b)", async () => {
    // Parts of one message share a messageId on the wire (verified:
    // claude-agent-acp replays composer positional parts under one id).
    const { h, push, blocks } = await chunkHarness("ch3");
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "please read " }, messageId: "m1" });
    push({
      sessionUpdate: "user_message_chunk",
      content: { type: "resource_link", uri: "file:///ws/a.ts", name: "a.ts" },
      messageId: "m1",
    });
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: " and fix it" }, messageId: "m1" });
    expect(blocks()).toHaveLength(1);
    // One wire message, one bubble: the mention is its own structured part
    // between the merged prose spans.
    expect(blocks()[0]).toMatchObject({
      kind: "user",
      parts: [
        { kind: "text", text: "please read " },
        { kind: "mention", name: "a.ts", uri: "file:///ws/a.ts" },
        { kind: "text", text: " and fix it" },
      ],
    });
    await h.pool.stop("ch3");
  });

  it("a messageId change splits adjacent user messages — cancelled turns never fuse", async () => {
    // The cancelled-turn shape: two prompts with nothing between them (the
    // turn produced no output). Claude additionally interleaves its own
    // interruption marker as a separate message — the marker is a turn
    // fact, never a bubble (outside a replay window it adds nothing: the
    // live turn's own turnEnded already said cancelled).
    const { h, push, blocks } = await chunkHarness("ch5");
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "in this starting" }, messageId: "m1" });
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "[Request interrupted by user]" }, messageId: "m2" });
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "again?" }, messageId: "m3" });
    expect(blocks()).toHaveLength(2);
    expect(blocks()[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "in this starting" }] });
    expect(blocks()[1]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "again?" }] });
    await h.pool.stop("ch5");
  });

  it("a replayed interruption marker closes its turn as cancelled — the chip, not the raw text", async () => {
    // Live cancel shows the real turnEnded's "cancelled" line; the marker
    // the agent stores instead must replay to the same rendering (live
    // cancel and its later replay render identically).
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true },
          // the agent echoes the marker as its own user-role message during
          // the turn — dropped live (inFlight), durably recorded for replay
          turn: [{ type: "userEcho", text: "[Request interrupted by user]" }],
        },
        "sm-int",
      ),
    );
    const sessionId = await h.sessionManager.createSession("sm-int", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "do the thing");

    await h.pool.restart("sm-int");
    await h.sessionManager.reload(sessionId);

    const blocks = h.state().transcripts[sessionId]!;
    // prompt bubble, then the cancelled boundary — the marker text nowhere
    expect(blocks[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "do the thing" }] });
    expect(blocks[1]).toMatchObject({ kind: "turnEnd", stopReason: "cancelled", startedAt: null });
    expect(
      blocks.some(
        (b) => b.kind === "user" && b.parts.some((p) => p.kind === "text" && p.text.includes("interrupted")),
      ),
    ).toBe(false);
    await h.pool.stop("sm-int");
  });

  it("id-less user chunks never merge — one bubble per message (auggie shape)", async () => {
    // Agents that omit messageId replay whole messages per chunk; merging
    // them fused adjacent cancelled prompts into one bubble.
    const { h, push, blocks } = await chunkHarness("ch6");
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "still same?" } });
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "?" } });
    expect(blocks()).toHaveLength(2);
    expect(blocks()[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "still same?" }] });
    expect(blocks()[1]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "?" }] });
    await h.pool.stop("ch6");
  });

  it("a messageId change splits adjacent agent messages — a closing fence never glues to the next heading", async () => {
    // The mermaid-corruption shape: message N ends with ``` (no trailing
    // newline — models end fenced blocks at the fence), message N+1 opens
    // with a heading. Fused into one block, the glued ```## line un-closes
    // the fence and the code block swallows the following prose.
    const { h, push, blocks } = await chunkHarness("ch7");
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "```mermaid\nflowchart TD\n" }, messageId: "a1" });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A --> B\n```" }, messageId: "a1" });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "## 4. Next section" }, messageId: "a2" });
    expect(blocks()).toHaveLength(2);
    expect(textOf(blocks()[0])).toBe("```mermaid\nflowchart TD\nA --> B\n```");
    expect(textOf(blocks()[1])).toBe("## 4. Next section");
    await h.pool.stop("ch7");
  });

  it("a messageId change splits adjacent thought messages the same way", async () => {
    const { h, push, blocks } = await chunkHarness("ch8");
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "first thought" }, messageId: "t1" });
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "second thought" }, messageId: "t2" });
    expect(blocks()).toHaveLength(2);
    expect(textOf(blocks()[0])).toBe("first thought");
    expect(textOf(blocks()[1])).toBe("second thought");
    await h.pool.stop("ch8");
  });

  it("id-less agent chunks keep merging — no boundary on the wire means no guessed split", async () => {
    // Live they're stream deltas; replayed they may lawfully be the recorded
    // chunk log played back. Splitting on a guess shreds prose mid-fence —
    // only a proven messageId change splits (runBlockFor).
    const { h, push, blocks } = await chunkHarness("ch9");
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one " } });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "message" } });
    expect(blocks()).toHaveLength(1);
    expect(textOf(blocks()[0])).toBe("one message");
    // …and an id arriving mid-run pins the run: the next id change splits
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " with id" }, messageId: "a1" });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new message" }, messageId: "a2" });
    expect(blocks()).toHaveLength(2);
    expect(textOf(blocks()[0])).toBe("one message with id");
    expect(textOf(blocks()[1])).toBe("new message");
    await h.pool.stop("ch9");
  });

  it("an agent resource_link renders as a markdown link in the prose run (G10b)", async () => {
    const { h, push, blocks } = await chunkHarness("ch4");
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "see " } });
    push({
      sessionUpdate: "agent_message_chunk",
      content: { type: "resource_link", uri: "file:///ws/b.ts", name: "b.ts" },
    });
    expect(blocks()).toHaveLength(1);
    expect(textOf(blocks()[0])).toBe("see [b.ts](file:///ws/b.ts)");
    await h.pool.stop("ch4");
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
