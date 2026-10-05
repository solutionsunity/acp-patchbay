// P8 gate: one process per agent, one-click reload, and the session knob
// surfaces — minus vscode, over the real fake agent.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityTracker } from "../src/orchestrator/capability-tracker";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import type { SessionGates } from "../src/orchestrator/session-gates";
import { SessionsStore } from "../src/orchestrator/sessions-store";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { SessionContinuityStore } from "../src/orchestrator/stores/session-continuity";
import { UsedCapabilityStore } from "../src/orchestrator/stores/used-capabilities";
import {
  initialAgentViewState,
  reduceAgentView,
  type AgentViewEvent,
  type AgentViewState,
} from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { stubFsTerminalHooks } from "./support/stub-hooks";
import { gatesFor } from "./support/session-gates";
import type { PatchbayAgentId } from "../src/shared/ids";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "patchbay-sadv-"));
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

function spec(script: FakeAgentScript, patchbayAgentId: PatchbayAgentId): LaunchSpec {
  return {
    patchbayAgentId,
    name: "Fake Agent",
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    cwd,
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

/** Wires pool + verifier + sessions store the way Orchestrator does, minus
 * vscode. */
function harness(extraHooks: {
  seedFor?(patchbayAgentId: PatchbayAgentId): Record<string, string | boolean> | undefined;
  onKnobsConfirmed?(patchbayAgentId: PatchbayAgentId, seed: Record<string, string | boolean>): void;
} = {}): {
  pool: AgentPool;
  sessions: SessionsStore;
  gates: SessionGates;
  capabilityTracker: CapabilityTracker;
  state(): AgentViewState;
} {
  const events: AgentViewEvent[] = [];
  let sessions!: SessionsStore;
  let capabilityTracker!: CapabilityTracker;
  const state = () => events.reduce(reduceAgentView, initialAgentViewState);

  const pool = new AgentPool({
    onStatusChanged: (patchbayAgentId, status) => sessions.agentStatusChanged(patchbayAgentId, status),
    onDeclaredCaptured: (patchbayAgentId) => capabilityTracker.onDeclared(patchbayAgentId),
    onSessionUpdate: (patchbayAgentId, notification) => sessions.handleUpdate(patchbayAgentId, notification),
    onCapabilityEvidence: (patchbayAgentId, row, evidence) => capabilityTracker.noteEvidence(patchbayAgentId, row, evidence),
    ...stubFsTerminalHooks(),
  });
  capabilityTracker = new CapabilityTracker(pool, new UsedCapabilityStore(new MemoryKV()), {
    registryIdOf: () => null,
    changed: () => {},
    probeRoot: async () => cwd, // exists for the test's life — the contract
  });
  sessions = new SessionsStore(
    pool,
    {
      emit: (...evs) => events.push(...evs),
      ...extraHooks,
    },
    new SessionContinuityStore(new MemoryKV()),
    () => cwd,
  );
  return { pool, sessions, gates: gatesFor(sessions, (event) => events.push(event)), capabilityTracker, state };
}

/** The fake agent's own ids for its sessions are `fake-<pid>-<n>` (or
 * `<parent-id>-fork-<n>` for a fork) — pid-qualified expressly so tests can
 * tell which physical process produced a session without any extra
 * plumbing. */
function pidOf(sessionId: string): string {
  const match = /^fake-(\d+)-/.exec(sessionId);
  if (!match) throw new Error(`unexpected fake session id shape: ${sessionId}`);
  return match[1]!;
}

describe("One process per agent", () => {
  // Declaring session/close lets the connect-time probe end its throwaway
  // session agent-side; waiting for that proof means the probe is done and
  // the connection serves nothing yet when the user's sessions open.
  const probeDone = (h: ReturnType<typeof harness>, patchbayAgentId: PatchbayAgentId) =>
    waitFor(() => (h.capabilityTracker.matrix(patchbayAgentId)?.["session.close"]?.used ? true : undefined));

  it("every session rides the agent's one process — the user's own second session proves concurrent sessions", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: { sessionCapabilities: { close: {} } } }, "one" as PatchbayAgentId));
    await probeDone(h, "one" as PatchbayAgentId);
    const a = await h.sessions.createSession("one" as PatchbayAgentId, "Fake Agent", cwd);
    expect(h.capabilityTracker.matrix("one" as PatchbayAgentId)!.concurrentSessions.used).toBe(false);
    const b = await h.sessions.createSession("one" as PatchbayAgentId, "Fake Agent", cwd);

    expect(pidOf(h.sessions.sessionIdOf(a)!)).toBe(pidOf(h.sessions.sessionIdOf(b)!));
    expect(h.capabilityTracker.matrix("one" as PatchbayAgentId)!.concurrentSessions.used).toBe(true);

    await h.pool.stop("one" as PatchbayAgentId);
  });

  it("an agent refusing a second session fails that session and marks concurrent sessions suspect — no second process", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { sessionCapabilities: { close: {} } }, concurrent: "fail" }, "single" as PatchbayAgentId),
    );
    await probeDone(h, "single" as PatchbayAgentId);
    const a = await h.sessions.createSession("single" as PatchbayAgentId, "Fake Agent", cwd);
    await expect(h.sessions.createSession("single" as PatchbayAgentId, "Fake Agent", cwd)).rejects.toThrow();

    expect(h.capabilityTracker.matrix("single" as PatchbayAgentId)!.concurrentSessions).toMatchObject({ used: false, suspect: true });
    expect(h.pool.get("single" as PatchbayAgentId)?.sessions).toEqual([h.sessions.sessionIdOf(a)]);

    await h.pool.stop("single" as PatchbayAgentId);
  });
});

describe("One-click reload (P8)", () => {
  it("re-loads a session on demand, discarding and rebuilding the transcript, even while still live", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "hi" }] }, "rl" as PatchbayAgentId));
    const patchbaySessionId = await h.sessions.createSession("rl" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "hello" });
    expect(h.state().transcripts[patchbaySessionId]!.length).toBeGreaterThan(0);

    await h.gates.reload(patchbaySessionId);

    // replay always wins — the exact same recorded updates come back, not a
    // merge with whatever was already there
    expect(h.state().transcripts[patchbaySessionId]!.length).toBeGreaterThan(0);
    expect(h.pool.get("rl" as PatchbayAgentId)?.sessions).toContain(h.sessions.sessionIdOf(patchbaySessionId));

    await h.pool.stop("rl" as PatchbayAgentId);
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
        "modes" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("modes" as PatchbayAgentId, "Fake Agent", cwd);
    // The modes fallback surface synthesizes one uniform knob (knobs.ts).
    expect(h.state().sessionKnobs[patchbaySessionId]).toEqual([
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

    await h.gates.setKnob(patchbaySessionId, "mode", "code");
    expect(h.state().sessionKnobs[patchbaySessionId]![0]).toMatchObject({ currentValue: "code" });

    await h.pool.stop("modes" as PatchbayAgentId);
  });

  it("a lying set_mode (reports success, changes nothing) never updates the display — the response is never trusted", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }] },
          lies: { modeChangeNoop: true },
        },
        "liarmode" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("liarmode" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.setKnob(patchbaySessionId, "mode", "code");
    // the request "succeeded" but emitted no current_mode_update — display stays put
    expect(h.state().sessionKnobs[patchbaySessionId]![0]).toMatchObject({ currentValue: "ask" });

    await h.pool.stop("liarmode" as PatchbayAgentId);
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
        "cfg" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("cfg" as PatchbayAgentId, "Fake Agent", cwd);
    expect(h.state().sessionKnobs[patchbaySessionId]).toHaveLength(1);
    expect(h.state().sessionKnobs[patchbaySessionId]![0]).toMatchObject({ id: "model-opt", currentValue: "sonnet" });

    await h.gates.setKnob(patchbaySessionId, "model-opt", "opus");
    expect(h.state().sessionKnobs[patchbaySessionId]![0]).toMatchObject({ currentValue: "opus" });

    await h.pool.stop("cfg" as PatchbayAgentId);
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
        "cfg-reply" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("cfg-reply" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.setKnob(patchbaySessionId, "model-opt", "opus");
    // no config_option_update arrived — the display truth rode the response
    expect(h.state().sessionKnobs[patchbaySessionId]![0]).toMatchObject({ currentValue: "opus" });

    await h.pool.stop("cfg-reply" as PatchbayAgentId);
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
        "both" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("both" as PatchbayAgentId, "Fake Agent", cwd);
    // One knob, not two — the dup-pill class of bug is unrepresentable.
    expect(h.state().sessionKnobs[patchbaySessionId]).toHaveLength(1);
    expect(h.state().sessionKnobs[patchbaySessionId]![0]).toMatchObject({ id: "permission-style" });
    // The ignored surface is not settable: "mode" names no offered knob.
    await h.gates.setKnob(patchbaySessionId, "mode", "code");
    expect(h.state().sessionKnobs[patchbaySessionId]![0]).toMatchObject({ currentValue: "ask" });

    await h.pool.stop("both" as PatchbayAgentId);
  });

  it("per-agent defaults are applied post-create by option id — no category needed (ACP: category is UX-only)", async () => {
    const events: AgentViewEvent[] = [];
    let sessions!: SessionsStore;
    let capabilityTracker!: CapabilityTracker;
    const pool = new AgentPool({
      onStatusChanged: () => {},
      onDeclaredCaptured: (patchbayAgentId) => capabilityTracker.onDeclared(patchbayAgentId),
      onSessionUpdate: (patchbayAgentId, notification) => sessions.handleUpdate(patchbayAgentId, notification),
      ...stubFsTerminalHooks(),
    });
    capabilityTracker = new CapabilityTracker(pool, new UsedCapabilityStore(new MemoryKV()), {
      registryIdOf: () => null,
    changed: () => {},
    probeRoot: async () => cwd, // exists for the test's life — the contract
  });
    sessions = new SessionsStore(
      pool,
      {
        emit: (...evs) => events.push(...evs),
        // Folded seed (knob id → value), as the orchestrator delivers it.
        seedFor: () => ({ mode: "code", "model-opt": "opus" }),
      },
      new SessionContinuityStore(new MemoryKV()),
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
        "defaulted" as PatchbayAgentId,
      ),
    );
    const state = () => events.reduce(reduceAgentView, initialAgentViewState);
    const patchbaySessionId = await sessions.createSession("defaulted" as PatchbayAgentId, "Fake Agent", cwd);

    expect(state().sessionKnobs[patchbaySessionId]!.find((k) => k.id === "mode")).toMatchObject({ currentValue: "code" });
    expect(state().sessionKnobs[patchbaySessionId]!.find((k) => k.id === "model-opt")).toMatchObject({ currentValue: "opus" });

    await pool.stop("defaulted" as PatchbayAgentId);
  });

});

/** The two-fold knob rule (reseedAfterAttach): a session's own combination
 * survives involuntary re-attach; entry — fresh or from history with
 * nothing in hand — starts from the entry seed; and the composer's
 * per-agent record (onKnobsConfirmed) is written only by a user set,
 * never by an attach. The fake agent, like claude-agent-acp, resets knob
 * state to its script defaults on session/load — exactly the reset the
 * rule exists to survive. */
describe("Knob two-fold rule (composer vs session)", () => {
  const MODEL_KNOB = {
    id: "model-opt",
    name: "Model",
    type: "select" as const,
    currentValue: "sonnet",
    options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }],
  };

  it("composer recording fires on a user set only — create, reload, and re-attach publishes never record", async () => {
    const records: Record<string, string | boolean>[] = [];
    const h = harness({ onKnobsConfirmed: (_patchbayAgentId, seed) => records.push(seed) });
    await h.pool.connect(
      spec({ declare: { loadSession: true }, configOptions: [MODEL_KNOB], turn: [{ type: "chunk", text: "hi" }] }, "rec" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.sessions.createSession("rec" as PatchbayAgentId, "Fake Agent", cwd);
    expect(records).toEqual([]); // the attach publish carries agent state, not a use

    await h.gates.setKnob(patchbaySessionId, "model-opt", "opus");
    expect(records).toEqual([{ "model-opt": "opus" }]);

    await h.gates.prompt(patchbaySessionId, { text: "hello" });
    await h.gates.reload(patchbaySessionId);
    expect(records).toHaveLength(1); // reload re-published and re-seeded — still not a use

    await h.pool.stop("rec" as PatchbayAgentId);
  });

  it("a modes-surface user set records from the agent's own current_mode_update — a lying no-op set_mode records nothing", async () => {
    const records: Record<string, string | boolean>[] = [];
    const modes = { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }] };
    const h = harness({ onKnobsConfirmed: (_patchbayAgentId, seed) => records.push(seed) });
    await h.pool.connect(spec({ modes }, "modes-rec" as PatchbayAgentId));
    const patchbaySessionId = await h.sessions.createSession("modes-rec" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.setKnob(patchbaySessionId, "mode", "code");
    await waitFor(() => (records.length > 0 ? true : undefined));
    expect(records).toEqual([{ mode: "code" }]);
    await h.pool.stop("modes-rec" as PatchbayAgentId);

    const liar = harness({ onKnobsConfirmed: (_patchbayAgentId, seed) => records.push(seed) });
    await liar.pool.connect(spec({ modes, lies: { modeChangeNoop: true } }, "modes-liar" as PatchbayAgentId));
    const liarSession = await liar.sessions.createSession("modes-liar" as PatchbayAgentId, "Fake Agent", cwd);
    await liar.gates.setKnob(liarSession, "mode", "code");
    await new Promise((r) => setTimeout(r, 100)); // no confirmation will come
    expect(records).toHaveLength(1); // the lying success response recorded nothing
    await liar.pool.stop("modes-liar" as PatchbayAgentId);
  });

  it("involuntary re-attach (reload, connection loss) re-seeds the session's own combination over the agent's load-time reset", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { loadSession: true }, configOptions: [MODEL_KNOB], turn: [{ type: "chunk", text: "hi" }] }, "reseed" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.sessions.createSession("reseed" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.setKnob(patchbaySessionId, "model-opt", "opus");
    await h.gates.prompt(patchbaySessionId, { text: "hello" });

    await h.gates.reload(patchbaySessionId); // agent resets to sonnet on load
    expect(h.state().sessionKnobs[patchbaySessionId]![0]).toMatchObject({ currentValue: "opus" });

    h.sessions.invalidateAgent("reseed" as PatchbayAgentId); // connection death
    await h.gates.prompt(patchbaySessionId, { text: "again" }); // prompt path re-attaches
    expect(h.state().sessionKnobs[patchbaySessionId]![0]).toMatchObject({ currentValue: "opus" });

    await h.pool.stop("reseed" as PatchbayAgentId);
  });

  it("deliberate entry (history session, no combination in hand) seeds from seedFor over the agent's restored state", async () => {
    // Window one: the session exists and was prompted (the fake agent
    // records it durably), knob left at the agent default.
    const w1 = harness();
    await w1.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { list: {} } }, configOptions: [MODEL_KNOB], turn: [{ type: "chunk", text: "hi" }] },
        "entry" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await w1.sessions.createSession("entry" as PatchbayAgentId, "Fake Agent", cwd);
    await w1.gates.prompt(patchbaySessionId, { text: "hello" });
    const sessionId = w1.sessions.sessionIdOf(patchbaySessionId)!;
    await w1.pool.stop("entry" as PatchbayAgentId);

    // Window two: known only via session/list — no combination in hand, so
    // the entry seed (composer/defaults, per knobSource) wins the attach.
    const w2 = harness({ seedFor: () => ({ "model-opt": "opus" }) });
    await w2.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { list: {} } }, configOptions: [MODEL_KNOB], turn: [{ type: "chunk", text: "hi" }] },
        "entry" as PatchbayAgentId,
      ),
    );
    await w2.sessions.syncAgentSessions("entry" as PatchbayAgentId);
    const listed = w2.sessions.rowFor("entry" as PatchbayAgentId, sessionId)!;
    await w2.gates.revive(listed);
    expect(w2.state().sessionKnobs[listed]![0]).toMatchObject({ currentValue: "opus" });

    await w2.pool.stop("entry" as PatchbayAgentId);
  });
});
