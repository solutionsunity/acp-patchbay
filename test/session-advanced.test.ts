// P8 gate: branch on fake agent with and without fork capability produces
// correctly labeled graph nodes; policy `isolated` isolates `session/new`
// only (a fork still rides its parent's process under any policy).
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
} from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { stubFsTerminalHooks } from "./support/stub-hooks";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "patchbay-sadv-"));
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

function spec(
  script: FakeAgentScript,
  agentId: string,
  processPolicy?: "auto" | "shared" | "isolated",
): LaunchSpec {
  return {
    agentId,
    name: "Fake Agent",
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    cwd,
    processPolicy,
  };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Wires pool + verifier + session manager the way Orchestrator does, minus
 * vscode — including a real `resolveProcessFor` (architecture.md § process
 * model) instead of a stub, since that's exactly what this file tests. */
function harness(): {
  pool: AgentPool;
  sessionManager: SessionManager;
  state(): AgentViewState;
  isolationKeys: () => string[];
} {
  const events: AgentViewEvent[] = [];
  let sessionManager!: SessionManager;
  let capabilityVerifier!: CapabilityVerifier;
  let isolationCounter = 0;
  const state = () => events.reduce(reduceAgentView, initialAgentViewState);

  const pool = new AgentPool({
    onStatusChanged: (agentId, status) => {
      if (status === "crashed" || status === "reconnecting") sessionManager.invalidateAgent(agentId);
    },
    onIsolatedStatusChanged: (poolKey, _agentId, status) => {
      if (status === "crashed" || status === "reconnecting") sessionManager.invalidatePoolKey(poolKey);
    },
    onDeclaredCaptured: (agentId, declared) => capabilityVerifier.onDeclared(agentId, declared),
    onSessionUpdate: (agentId, notification) => sessionManager.handleUpdate(agentId, notification),
    onConcurrentSessionsVerified: (agentId) =>
      capabilityVerifier.markVerified(agentId, "concurrentSessions"),
    ...stubFsTerminalHooks(),
  });
  capabilityVerifier = new CapabilityVerifier(pool, { emit: (...evs) => events.push(...evs) });
  const sessionIndex = new SessionIndexStore(new MemoryKV());

  const isolationKeys: string[] = [];
  async function resolveProcessFor(agentId: string): Promise<string> {
    const primary = pool.get(agentId);
    if (primary === undefined) return agentId;
    const policy = primary.spec.processPolicy ?? "auto";
    const hasExisting = primary.sessions.length > 0;
    const verified = state().capabilities[agentId]?.concurrentSessions?.verified ?? false;
    const isolate = policy === "isolated" || (policy === "auto" && hasExisting && !verified);
    if (!isolate) return agentId;
    const poolKey = `${agentId}::iso::${++isolationCounter}`;
    isolationKeys.push(poolKey);
    await pool.connect(primary.spec, { poolKey, reportAs: agentId, isolated: true });
    return poolKey;
  }

  sessionManager = new SessionManager(
    pool,
    sessionIndex,
    {
      emit: (...evs) => events.push(...evs),
      resolveProcessFor,
      isForkVerified: (agentId) => state().capabilities[agentId]?.["session.fork"]?.verified ?? false,
    },
    () => cwd,
  );
  return { pool, sessionManager, state, isolationKeys: () => isolationKeys };
}

/** The fake agent's session ids are `fake-<pid>-<n>` (or `<parent-id>-fork-<n>`
 * for a fork) — pid-qualified expressly so tests can tell which physical
 * process produced a session without any extra plumbing. */
function pidOf(sessionId: string): string {
  const match = /^fake-(\d+)-/.exec(sessionId);
  if (!match) throw new Error(`unexpected fake session id shape: ${sessionId}`);
  return match[1]!;
}

describe("Session graph — branching (P8)", () => {
  it("native session/fork produces a branch node once the capability is verified", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "forker"));
    await waitFor(() => (h.state().capabilities.forker!["session.fork"].verified ? true : undefined));

    const parentId = await h.sessionManager.createSession("forker", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(parentId, "hello");
    const parentTranscript = h.state().transcripts[parentId]!;

    const branchId = await h.sessionManager.branch(parentId, parentTranscript);

    const summary = h.state().sessions.find((s) => s.id === branchId)!;
    expect(summary.branchOf).toBe(parentId);
    expect(summary.emulated).toBe(false);
    // a real fork — the agent's own new session, not a client-side seed
    expect(pidOf(branchId)).toBe(pidOf(parentId));
    expect(branchId.startsWith(parentId)).toBe(true);

    await h.pool.stop("forker");
  });

  it("without fork capability, branching falls back to an emulated continuation seeded from the parent's transcript", async () => {
    const h = harness();
    await h.pool.connect(spec({}, "noforker")); // declares nothing — session.fork never verifies
    const parentId = await h.sessionManager.createSession("noforker", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(parentId, "hello");
    const parentTranscript = h.state().transcripts[parentId]!;
    expect(parentTranscript.length).toBeGreaterThan(0);

    const branchId = await h.sessionManager.branch(parentId, parentTranscript);

    const summary = h.state().sessions.find((s) => s.id === branchId)!;
    expect(summary.branchOf).toBe(parentId);
    expect(summary.emulated).toBe(true);
    // seeded wholesale from the parent's current transcript, then nothing
    // more (no prompt was sent to the branch itself)
    expect(h.state().transcripts[branchId]).toEqual(parentTranscript);

    await h.pool.stop("noforker");
  });

  it("a lying agent (declares fork, breaks it) never verifies, so branching stays emulated — declared-but-broken must not be trusted", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { sessionCapabilities: { fork: {} } }, lies: { forkBroken: true } }, "liar"),
    );
    await new Promise((r) => setTimeout(r, 300)); // let the automatic round-trip fail
    expect(h.state().capabilities.liar!["session.fork"].verified).toBe(false);

    const parentId = await h.sessionManager.createSession("liar", "Fake Agent", cwd);
    const branchId = await h.sessionManager.branch(parentId, h.state().transcripts[parentId]!);
    expect(h.state().sessions.find((s) => s.id === branchId)!.emulated).toBe(true);

    await h.pool.stop("liar");
  });
});

describe("Process policy (P8)", () => {
  it("isolated isolates session/new: two top-level sessions run on distinct subprocesses", async () => {
    const h = harness();
    await h.pool.connect(spec({}, "iso", "isolated"));
    const a = await h.sessionManager.createSession("iso", "Fake Agent", cwd);
    const b = await h.sessionManager.createSession("iso", "Fake Agent", cwd);

    expect(pidOf(a)).not.toBe(pidOf(b));
    expect(h.isolationKeys().length).toBe(2);
    // the shared/primary entry itself never hosts either session
    expect(h.pool.get("iso")?.sessions.length ?? 0).toBe(0);

    await h.pool.stop("iso");
    for (const key of h.isolationKeys()) await h.pool.stop(key);
  });

  it("isolated pins a fork to its parent's process, not a third one", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "isofork", "isolated"));
    await waitFor(() => (h.state().capabilities.isofork!["session.fork"].verified ? true : undefined));

    const parentId = await h.sessionManager.createSession("isofork", "Fake Agent", cwd);
    const branchId = await h.sessionManager.branch(parentId, []);

    expect(pidOf(branchId)).toBe(pidOf(parentId)); // same process — fork can't hop
    expect(h.isolationKeys().length).toBe(1); // only the parent's own isolated instance was ever created

    await h.pool.stop("isofork");
    for (const key of h.isolationKeys()) await h.pool.stop(key);
  });

  it("shared always shares, even across many top-level sessions", async () => {
    const h = harness();
    await h.pool.connect(spec({}, "shared", "shared"));
    const a = await h.sessionManager.createSession("shared", "Fake Agent", cwd);
    const b = await h.sessionManager.createSession("shared", "Fake Agent", cwd);

    expect(pidOf(a)).toBe(pidOf(b));
    expect(h.isolationKeys().length).toBe(0);

    await h.pool.stop("shared");
  });

  it("auto isolates a second top-level session until something verifies concurrent-session behavior", async () => {
    const h = harness();
    await h.pool.connect(spec({}, "auto")); // declares nothing — no automatic verification possible
    const a = await h.sessionManager.createSession("auto", "Fake Agent", cwd);
    const b = await h.sessionManager.createSession("auto", "Fake Agent", cwd);
    // unverified concurrent-session behavior: the second top-level session
    // isolates rather than risk sharing an unproven connection
    expect(pidOf(a)).not.toBe(pidOf(b));

    await h.pool.stop("auto");
    for (const key of h.isolationKeys()) await h.pool.stop(key);
  });

  it("auto shares once the automatic fork round-trip also proves concurrent-session behavior", async () => {
    const h = harness();
    // P5's automatic, ephemeral fork-verification round-trip forks a
    // temp-dir session on this very connection — structurally the same
    // proof concurrentSessions itself looks for, so both verify together.
    await h.pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "auto"));
    await waitFor(() => (h.state().capabilities.auto!.concurrentSessions.verified ? true : undefined));

    const a = await h.sessionManager.createSession("auto", "Fake Agent", cwd);
    const b = await h.sessionManager.createSession("auto", "Fake Agent", cwd);
    expect(pidOf(a)).toBe(pidOf(b));

    await h.pool.stop("auto");
  });
});

describe("One-click reload (P8)", () => {
  it("re-loads a session on demand, discarding and rebuilding the transcript, even while still live", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "hi" }] }, "rl"));
    const sessionId = await h.sessionManager.createSession("rl", "Fake Agent", cwd);
    await h.sessionManager.sendPrompt(sessionId, "hello");
    expect(h.state().transcripts[sessionId]!.length).toBeGreaterThan(0);

    await h.sessionManager.reload(sessionId);

    // replay always wins — the exact same recorded updates come back, not a
    // merge with whatever was already there
    expect(h.state().transcripts[sessionId]!.length).toBeGreaterThan(0);
    expect(h.pool.get("rl")?.sessions).toContain(sessionId);

    await h.pool.stop("rl");
  });
});

describe("Session model/mode/effort knobs (P8)", () => {
  it("offers modes only from the agent, switches on request, and displays only the agent's own confirmation", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          modes: {
            currentModeId: "ask",
            availableModes: [
              { id: "ask", name: "Ask" },
              { id: "code", name: "Code" },
            ],
          },
        },
        "modes",
      ),
    );
    const sessionId = await h.sessionManager.createSession("modes", "Fake Agent", cwd);
    expect(h.state().sessionModes[sessionId]).toEqual({
      currentModeId: "ask",
      available: [
        { id: "ask", name: "Ask", description: undefined },
        { id: "code", name: "Code", description: undefined },
      ],
    });

    await h.sessionManager.setMode(sessionId, "code");
    expect(h.state().sessionModes[sessionId]!.currentModeId).toBe("code");

    await h.pool.stop("modes");
  });

  it("a lying set_mode (reports success, changes nothing) never updates the display — the response is never trusted", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }] },
          lies: { modeChangeNoop: true },
        },
        "liarmode",
      ),
    );
    const sessionId = await h.sessionManager.createSession("liarmode", "Fake Agent", cwd);
    await h.sessionManager.setMode(sessionId, "code");
    // the request "succeeded" but emitted no current_mode_update — display stays put
    expect(h.state().sessionModes[sessionId]!.currentModeId).toBe("ask");

    await h.pool.stop("liarmode");
  });

  it("model/effort config options: offered by category, set on request, displayed only from the agent's own update", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          configOptions: [
            {
              id: "model-opt",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "sonnet",
              options: [
                { value: "sonnet", name: "Sonnet" },
                { value: "opus", name: "Opus" },
              ],
            },
          ],
        },
        "cfg",
      ),
    );
    const sessionId = await h.sessionManager.createSession("cfg", "Fake Agent", cwd);
    expect(h.state().sessionConfigOptions[sessionId]).toHaveLength(1);
    expect(h.state().sessionConfigOptions[sessionId]![0]).toMatchObject({ id: "model-opt", currentValue: "sonnet" });

    await h.sessionManager.setConfigOption(sessionId, "model-opt", "opus");
    expect(h.state().sessionConfigOptions[sessionId]![0]).toMatchObject({ currentValue: "opus" });

    await h.pool.stop("cfg");
  });

  it("per-agent defaults are applied post-create by issuing the matching set requests", async () => {
    const events: AgentViewEvent[] = [];
    let sessionManager!: SessionManager;
    let capabilityVerifier!: CapabilityVerifier;
    const pool = new AgentPool({
      onStatusChanged: () => {},
      onDeclaredCaptured: (agentId, declared) => capabilityVerifier.onDeclared(agentId, declared),
      onSessionUpdate: (agentId, notification) => sessionManager.handleUpdate(agentId, notification),
      ...stubFsTerminalHooks(),
    });
    capabilityVerifier = new CapabilityVerifier(pool, { emit: (...evs) => events.push(...evs) });
    sessionManager = new SessionManager(
      pool,
      new SessionIndexStore(new MemoryKV()),
      {
        emit: (...evs) => events.push(...evs),
        defaultsFor: () => ({ mode: "code", model: "opus" }),
      },
      () => cwd,
    );
    await pool.connect(
      spec(
        {
          modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }] },
          configOptions: [
            {
              id: "model-opt",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "sonnet",
              options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }],
            },
          ],
        },
        "defaulted",
      ),
    );
    const state = () => events.reduce(reduceAgentView, initialAgentViewState);
    const sessionId = await sessionManager.createSession("defaulted", "Fake Agent", cwd);

    expect(state().sessionModes[sessionId]!.currentModeId).toBe("code");
    expect(state().sessionConfigOptions[sessionId]![0]).toMatchObject({ currentValue: "opus" });

    await pool.stop("defaulted");
  });
});
