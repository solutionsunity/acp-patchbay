// P4 gate: session/new → prompt → streamed session/update → transcript;
// stop turn; session index rename/close; slash-command advertisement;
// render cache rebuilt wholesale from session/load replay after a crash.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityVerifier } from "../src/orchestrator/capability-verifier";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import { SessionManager } from "../src/orchestrator/session-manager";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { SessionIndexStore } from "../src/orchestrator/stores/session-index";
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
function harness(): {
  pool: AgentPool;
  sessionManager: SessionManager;
  events: AgentViewEvent[];
  state(): AgentViewState;
} {
  const events: AgentViewEvent[] = [];
  let sessionManager!: SessionManager;
  let capabilityVerifier!: CapabilityVerifier;
  const pool = new AgentPool({
    onStatusChanged: (agentId, status) => {
      if (status === "crashed" || status === "reconnecting") {
        sessionManager.invalidateAgent(agentId);
      }
    },
    onDeclaredCaptured: (agentId, declared) => capabilityVerifier.onDeclared(agentId, declared),
    onSessionUpdate: (agentId, notification) => sessionManager.handleUpdate(agentId, notification),
    onConcurrentSessionsVerified: (agentId) =>
      capabilityVerifier.markVerified(agentId, "concurrentSessions"),
    ...stubFsTerminalHooks(),
  });
  capabilityVerifier = new CapabilityVerifier(pool, { emit: (...evs) => events.push(...evs) });
  const sessionIndex = new SessionIndexStore(new MemoryKV());
  sessionManager = new SessionManager(
    pool,
    sessionIndex,
    { emit: (...evs) => events.push(...evs) },
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

    const planBlock = blocks.find((b) => b.kind === "plan");
    expect(planBlock?.kind).toBe("plan");
    if (planBlock?.kind === "plan") {
      expect(planBlock.entries).toEqual([
        { content: "step one", status: "completed" },
        { content: "step two", status: "in_progress" },
      ]);
    }
    expect(state.activePlan[sessionId]).toEqual(planBlock);
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

  it("without loadSession declared, a crash leaves the last-known view standing but refuses to reuse the dead sessionId", async () => {
    // A sessionId is connection-scoped; without replay there is no
    // protocol-legal way to resume it on the new connection. Seeding a
    // fresh, labeled continuation from the last-known view is P8 (session
    // graph, emulated branching) — out of scope for the P4 vertical slice.
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "only turn" }] }, "sm6"));
    const sessionId = await h.sessionManager.createSession("sm6", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "hello");
    const before = h.state().transcripts[sessionId]!;
    expect(before.length).toBeGreaterThan(0);

    await h.pool.restart("sm6");
    expect(h.pool.get("sm6")?.declared?.loadSession).toBe(false);

    await expect(h.sessionManager.sendPrompt(sessionId, "after restart")).rejects.toThrow(
      /does not support session\/load/,
    );
    // the last-known view is untouched by the failed reopen attempt
    expect(h.state().transcripts[sessionId]).toEqual(before);

    await h.pool.stop("sm6");
  });

  it("usage reporting verifies opportunistically the moment it's first observed (P5)", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ turn: [{ type: "usage", used: 42, size: 200 }, { type: "chunk", text: "hi" }] }, "sm7"),
    );
    expect(h.state().capabilities.sm7!.usage).toEqual({ declared: false, verified: false });

    const sessionId = await h.sessionManager.createSession("sm7", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "go");

    expect(h.state().sessionUsage[sessionId]).toEqual({ used: 42, size: 200, cost: undefined });
    expect(h.state().capabilities.sm7!.usage).toEqual({ declared: true, verified: true });

    await h.pool.stop("sm7");
  });

  it("session.load reopening verifies the session.load row (P5)", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "hi" }] }, "sm8"),
    );
    const sessionId = await h.sessionManager.createSession("sm8", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "first");
    expect(h.state().capabilities.sm8!["session.load"]).toEqual({ declared: true, verified: false });

    await h.pool.restart("sm8");
    await h.sessionManager.sendPrompt(sessionId, "second");

    expect(h.state().capabilities.sm8!["session.load"]).toEqual({ declared: true, verified: true });
    await h.pool.stop("sm8");
  });
});
