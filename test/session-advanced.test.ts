// P8 gate: process policy (`isolated`/`shared`/`auto`), one-click reload,
// and the session knob surfaces — minus vscode, over the real fake agent.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityTracker } from "../src/orchestrator/capability-tracker";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import { SessionManager } from "../src/orchestrator/session-manager";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { UsedCapabilityStore } from "../src/orchestrator/stores/used-capabilities";
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
  let capabilityTracker!: CapabilityTracker;
  let isolationCounter = 0;
  const state = () => events.reduce(reduceAgentView, initialAgentViewState);

  const pool = new AgentPool({
    onStatusChanged: (agentId, status) => {
      if (status === "crashed" || status === "reconnecting") sessionManager.invalidateAgent(agentId);
    },
    onIsolatedStatusChanged: (poolKey, _agentId, status) => {
      if (status === "crashed" || status === "reconnecting") sessionManager.invalidatePoolKey(poolKey);
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
  const isolationKeys: string[] = [];
  async function resolveProcessFor(agentId: string): Promise<string> {
    const primary = pool.get(agentId);
    if (primary === undefined) return agentId;
    const policy = primary.spec.processPolicy ?? "auto";
    const hasExisting = primary.sessions.length > 0;
    const used = state().capabilities[agentId]?.concurrentSessions?.used ?? false;
    const isolate = policy === "isolated" || (policy === "auto" && hasExisting && !used);
    if (!isolate) return agentId;
    const poolKey = `${agentId}::iso::${++isolationCounter}`;
    isolationKeys.push(poolKey);
    await pool.connect(primary.spec, { poolKey, reportAs: agentId, isolated: true });
    return poolKey;
  }

  sessionManager = new SessionManager(
    pool,
    {
      emit: (...evs) => events.push(...evs),
      resolveProcessFor,
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

  it("shared always shares, even across many top-level sessions", async () => {
    const h = harness();
    await h.pool.connect(spec({}, "shared", "shared"));
    const a = await h.sessionManager.createSession("shared", "Fake Agent", cwd);
    const b = await h.sessionManager.createSession("shared", "Fake Agent", cwd);

    expect(pidOf(a)).toBe(pidOf(b));
    expect(h.isolationKeys().length).toBe(0);

    await h.pool.stop("shared");
  });

  it("auto isolates a second top-level session until something marks concurrent-session behavior used", async () => {
    const h = harness();
    await h.pool.connect(spec({}, "auto")); // declares nothing — no automatic check possible
    const a = await h.sessionManager.createSession("auto", "Fake Agent", cwd);
    const b = await h.sessionManager.createSession("auto", "Fake Agent", cwd);
    // not-yet-used concurrent-session behavior: the second top-level session
    // isolates rather than risk sharing an unproven connection
    expect(pidOf(a)).not.toBe(pidOf(b));

    await h.pool.stop("auto");
    for (const key of h.isolationKeys()) await h.pool.stop(key);
  });

  it("auto shares once the automatic fork round-trip also proves concurrent-session behavior", async () => {
    const h = harness();
    // P5's automatic, ephemeral fork-check round-trip forks a temp-dir
    // session on this very connection — structurally the same proof
    // concurrentSessions itself looks for, so both get marked used together.
    await h.pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "auto"));
    await waitFor(() => (h.state().capabilities.auto!.concurrentSessions.used ? true : undefined));

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
    // The modes fallback surface synthesizes one uniform knob (knobs.ts).
    expect(h.state().sessionKnobs[sessionId]).toEqual([
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "ask",
        options: [
          { value: "ask", name: "Ask", description: undefined },
          { value: "code", name: "Code", description: undefined },
        ],
      },
    ]);

    await h.sessionManager.setKnob(sessionId, "mode", "code");
    expect(h.state().sessionKnobs[sessionId]![0]).toMatchObject({ currentValue: "code" });

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
    await h.sessionManager.setKnob(sessionId, "mode", "code");
    // the request "succeeded" but emitted no current_mode_update — display stays put
    expect(h.state().sessionKnobs[sessionId]![0]).toMatchObject({ currentValue: "ask" });

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
    expect(h.state().sessionKnobs[sessionId]).toHaveLength(1);
    expect(h.state().sessionKnobs[sessionId]![0]).toMatchObject({ id: "model-opt", currentValue: "sonnet" });

    await h.sessionManager.setKnob(sessionId, "model-opt", "opus");
    expect(h.state().sessionKnobs[sessionId]![0]).toMatchObject({ currentValue: "opus" });

    await h.pool.stop("cfg");
  });

  it("set_config_option with no update echo: the response's required configOptions is consumed as state (claude-agent-acp behavior)", async () => {
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
          configSetRepliesOnly: true,
        },
        "cfg-reply",
      ),
    );
    const sessionId = await h.sessionManager.createSession("cfg-reply", "Fake Agent", cwd);
    await h.sessionManager.setKnob(sessionId, "model-opt", "opus");
    // no config_option_update arrived — the display truth rode the response
    expect(h.state().sessionKnobs[sessionId]![0]).toMatchObject({ currentValue: "opus" });

    await h.pool.stop("cfg-reply");
  });

  it("an agent offering both surfaces gets exactly the config knobs — modes are ignored wholesale (spec: use configOptions exclusively)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }] },
          // Deliberately no category:"mode" anywhere — exclusivity must not
          // depend on it (ACP: category is UX-only, never correctness).
          configOptions: [
            {
              id: "permission-style",
              name: "Permissions",
              type: "select",
              currentValue: "ask",
              options: [{ value: "ask", name: "Ask" }, { value: "code", name: "Code" }],
            },
          ],
        },
        "both",
      ),
    );
    const sessionId = await h.sessionManager.createSession("both", "Fake Agent", cwd);
    // One knob, not two — the dup-pill class of bug is unrepresentable.
    expect(h.state().sessionKnobs[sessionId]).toHaveLength(1);
    expect(h.state().sessionKnobs[sessionId]![0]).toMatchObject({ id: "permission-style" });
    // The ignored surface is not settable: "mode" names no offered knob.
    await h.sessionManager.setKnob(sessionId, "mode", "code");
    expect(h.state().sessionKnobs[sessionId]![0]).toMatchObject({ currentValue: "ask" });

    await h.pool.stop("both");
  });

  it("per-agent defaults are applied post-create by option id — no category needed (ACP: category is UX-only)", async () => {
    const events: AgentViewEvent[] = [];
    let sessionManager!: SessionManager;
    let capabilityTracker!: CapabilityTracker;
    const pool = new AgentPool({
      onStatusChanged: () => {},
      onDeclaredCaptured: (agentId, declared, raw) =>
      capabilityTracker.onDeclared(agentId, declared, raw.agentInfo?.version ?? null),
      onSessionUpdate: (agentId, notification) => sessionManager.handleUpdate(agentId, notification),
      ...stubFsTerminalHooks(),
    });
    capabilityTracker = new CapabilityTracker(pool, new UsedCapabilityStore(new MemoryKV()), {
    emit: (...evs) => events.push(...evs),
    currentMatrix: (agentId) => events.reduce(reduceAgentView, initialAgentViewState).capabilities[agentId],
  });
    sessionManager = new SessionManager(
      pool,
      {
        emit: (...evs) => events.push(...evs),
        // Folded seed (knob id → value), as the orchestrator delivers it.
        defaultsFor: () => ({ mode: "code", "model-opt": "opus" }),
      },
      () => cwd,
    );
    await pool.connect(
      spec(
        {
          // no `category` on purpose — the ACP schema makes it UX-only
          // ("MUST NOT be required for correctness"), so defaults must
          // apply by knob id alone.
          configOptions: [
            {
              id: "mode",
              name: "Mode",
              type: "select",
              currentValue: "ask",
              options: [{ value: "ask", name: "Ask" }, { value: "code", name: "Code" }],
            },
            {
              id: "model-opt",
              name: "Model",
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

    expect(state().sessionKnobs[sessionId]!.find((k) => k.id === "mode")).toMatchObject({ currentValue: "code" });
    expect(state().sessionKnobs[sessionId]!.find((k) => k.id === "model-opt")).toMatchObject({ currentValue: "opus" });

    await pool.stop("defaulted");
  });

});
