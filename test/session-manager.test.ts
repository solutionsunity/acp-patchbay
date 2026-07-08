// P4 gate: session/new → prompt → streamed session/update → transcript;
// stop turn; session index rename/close; slash-command advertisement;
// render cache rebuilt wholesale from session/load replay after a crash.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertKind } from "./support/assert-kind";
import { CapabilityTracker } from "../src/orchestrator/capability-tracker";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import { SessionManager } from "../src/orchestrator/session-manager";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { SessionIndexStore } from "../src/orchestrator/stores/session-index";
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

/** Wires a pool + session manager the way Orchestrator does, minus vscode.
 * `lastKnownView`, when supplied, stands in for the persisted-to-disk store
 * a real Orchestrator would read from (P8's emulated dead-end fallback). */
function harness(opts?: {
  lastKnownView?(sessionId: string): { at: string; blocks: readonly ChatBlock[] } | null;
}): {
  pool: AgentPool;
  sessionManager: SessionManager;
  events: AgentViewEvent[];
  state(): AgentViewState;
} {
  const events: AgentViewEvent[] = [];
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
      capabilityTracker.onDeclared(agentId, declared, raw.agentInfo?.version ?? null),
    onSessionUpdate: (agentId, notification) => sessionManager.handleUpdate(agentId, notification),
    onCapabilityEvidence: (agentId, row, evidence) =>
      evidence === "used" ? capabilityTracker.markUsed(agentId, row) : capabilityTracker.markSuspect(agentId, row),
    ...stubFsTerminalHooks(),
  });
  capabilityTracker = new CapabilityTracker(pool, new UsedCapabilityStore(new MemoryKV()), {
    emit: (...evs) => events.push(...evs),
    currentMatrix: (agentId) => events.reduce(reduceAgentView, initialAgentViewState).capabilities[agentId],
  });
  const sessionIndex = new SessionIndexStore(new MemoryKV());
  sessionManager = new SessionManager(
    pool,
    sessionIndex,
    {
      emit: (...evs) => events.push(...evs),
      lastKnownView: async (sessionId) => opts?.lastKnownView?.(sessionId) ?? null,
      contextRootsFor: (sessionId) =>
        events.reduce(reduceAgentView, initialAgentViewState).contextRoots[sessionId] ?? [],
    },
    () => cwd,
  );
  return {
    pool,
    sessionManager,
    events,
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

  it("renames and closes sessions", async () => {
    const h = harness();
    await h.pool.connect(spec({}, "sm4"));
    const sessionId = await h.sessionManager.createSession("sm4", "Fake Agent", cwd);

    await h.sessionManager.rename(sessionId, "my custom title");
    expect(h.state().sessions[0]?.title).toBe("my custom title");

    // an explicit rename is never clobbered by first-prompt auto-titling
    await h.sessionManager.sendPrompt(sessionId, "irrelevant text");
    expect(h.state().sessions[0]?.title).toBe("my custom title");

    await h.sessionManager.close(sessionId);
    expect(h.state().sessions).toHaveLength(0);
    expect(h.state().transcripts[sessionId]).toBeUndefined();

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
    // replay rebuilt the original turn's text (as a fresh block), then the
    // new user message, then the new turn's text — never merged, always reset
    expect(textOf(blocks[0])).toBe("before crash");
    expect(blocks[1]).toMatchObject({ kind: "user", text: "second turn" });
    expect(textOf(blocks[2])).toBe("before crash"); // second turn uses the same script

    await h.pool.stop("sm5");
  });

  it("without loadSession declared, a crash falls back to an emulated continuation seeded from the last-known view (P8)", async () => {
    // A sessionId is connection-scoped; without replay there is no
    // protocol-legal way to resume it on the new connection. The only
    // continuation left is emulated: a fresh session/new, its transcript
    // seeded from patchbay's persisted last-known view, clearly labeled —
    // never presented as the agent's own memory (architecture.md § State).
    let persisted: readonly ChatBlock[] | null = null;
    const h = harness({
      lastKnownView: (sessionId) =>
        persisted && sessionId === deadSessionId ? { at: "2026-01-01T00:00:00.000Z", blocks: persisted } : null,
    });
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "only turn" }] }, "sm6"));
    const deadSessionId = await h.sessionManager.createSession("sm6", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(deadSessionId, "hello");
    const before = h.state().transcripts[deadSessionId]!;
    expect(before.length).toBeGreaterThan(0);
    persisted = before; // what a real orchestrator would have written to disk by now

    await h.pool.restart("sm6");
    expect(h.pool.get("sm6")?.declared?.loadSession).toBe(false);

    await h.sessionManager.sendPrompt(deadSessionId, "after restart");

    // the dead session's last-known view is untouched
    expect(h.state().transcripts[deadSessionId]).toEqual(before);
    // a new, labeled continuation exists, branched from the dead session and
    // seeded from its persisted view
    const branch = h.state().sessions.find((s) => s.branchOf === deadSessionId);
    expect(branch?.emulated).toBe(true);
    expect(h.state().activeSessionId).toBe(branch!.id);
    const continued = h.state().transcripts[branch!.id]!;
    expect(continued.slice(0, before.length)).toEqual(before);
    expect(continued.some((b) => b.kind === "user" && b.text === "after restart")).toBe(true);

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
    expect(Date.parse(end.endedAt)).toBeGreaterThanOrEqual(Date.parse(end.startedAt));
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

  it("context roots (P12): added mid-session reach the wire only after a reload — ACP has no live-update request", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { loadSession: true }, turn: [{ type: "echoRoots" }] }, "sm11"),
    );
    const sessionId = await h.sessionManager.createSession("sm11", "Fake Agent", cwd);

    h.sessionManager.addRoot(sessionId, "/repo/backend");
    expect(h.state().contextRoots[sessionId]).toEqual(["/repo/backend"]);

    await h.sessionManager.reload(sessionId);
    await h.sessionManager.sendPrompt(sessionId, "roots?");
    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/backend"]);

    h.sessionManager.removeRoot(sessionId, "/repo/backend");
    expect(h.state().contextRoots[sessionId]).toEqual([]);

    await h.pool.stop("sm11");
  });

  it("a fork inherits its parent's context roots, used on the wire", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { sessionCapabilities: { fork: {} } }, turn: [{ type: "echoRoots" }] }, "sm12"),
    );
    const cell = () => h.state().capabilities.sm12?.["session.fork"];
    const start = Date.now();
    while (!cell()?.used) {
      if (Date.now() - start > 3000) throw new Error("fork never used");
      await new Promise((r) => setTimeout(r, 20));
    }
    const parentId = await h.sessionManager.createSession("sm12", "Fake Agent", cwd);
    h.sessionManager.addRoot(parentId, "/repo/shared");

    const branchId = await h.sessionManager.branch(parentId, []);
    expect(h.state().contextRoots[branchId]).toEqual(["/repo/shared"]);

    await h.sessionManager.sendPrompt(branchId, "roots?");
    const echoed = h.state().transcripts[branchId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/shared"]);

    await h.pool.stop("sm12");
  });
});
