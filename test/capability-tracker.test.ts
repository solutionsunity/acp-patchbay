// P5 gate: fake agent scripted to lie shows declared-but-not-used; branch
// affordance lights only after the fork is used; reconnect drops used.
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityTracker } from "../src/orchestrator/capability-tracker";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { UsedCapabilityStore } from "../src/orchestrator/stores/used-capabilities";
import {
  capabilityState,
  initialAgentViewState,
  reduceAgentView,
  type AgentViewEvent,
} from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { stubFsTerminalHooks } from "./support/stub-hooks";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "patchbay-capver-"));
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

function spec(script: FakeAgentScript, agentId: string): LaunchSpec {
  return {
    agentId,
    name: "Fake Agent",
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    cwd,
  };
}

function harness(kv = new MemoryKV()): {
  pool: AgentPool;
  tracker: CapabilityTracker;
  usedCache: UsedCapabilityStore;
  state(): ReturnType<typeof reduceAgentView>;
  /** Every onOfferings delivery, in order — the connect-time offering read
   * (raw session response per spec-pure-core; tests reach into it). */
  offerings: { agentId: string; sessionId: string; modes: unknown; configOptions: unknown }[];
  /** `agentAuthRequired`/`agentAuthResolved` only patch an existing
   * AgentSummary (same shape as the real orchestrator, which always
   * upserts before connecting) — tests touching `needsAuth` seed one first. */
  seedAgent(agentId: string): void;
} {
  const events: AgentViewEvent[] = [];
  const offerings: { agentId: string; sessionId: string; modes: unknown; configOptions: unknown }[] =
    [];
  let tracker!: CapabilityTracker;
  const state = () => events.reduce(reduceAgentView, initialAgentViewState);
  const usedCache = new UsedCapabilityStore(kv);
  const pool = new AgentPool({
    onStatusChanged: () => {},
    onDeclaredCaptured: (agentId, declared, raw) =>
      tracker.onDeclared(agentId, declared, raw.agentInfo?.version ?? null, raw.protocolVersion),
    onSessionUpdate: () => {},
    onCapabilityEvidence: (agentId, row, evidence) =>
      evidence === "used" ? tracker.markUsed(agentId, row) : tracker.markSuspect(agentId, row),
    // Mirrors the orchestrator: needsAuth is raised at the pool's wire
    // chokepoint, not by the tracker.
    onAuthRequired: (agentId, reason) => events.push({ kind: "agentAuthRequired", agentId, reason }),
    ...stubFsTerminalHooks(),
  });
  tracker = new CapabilityTracker(pool, usedCache, {
    emit: (...evs) => events.push(...evs),
    currentMatrix: (agentId) => state().capabilities[agentId],
    onOfferings: (agentId, response) =>
      offerings.push({
        agentId,
        sessionId: response.sessionId,
        modes: response.modes,
        configOptions: response.configOptions,
      }),
    // Standing probe workspace, orchestrator-style: per agent, created
    // idempotently, never removed mid-connection.
    probeRoot: async (agentId) => {
      const dir = join(cwd, "probe", agentId);
      await mkdir(dir, { recursive: true });
      return dir;
    },
  });
  const seedAgent = (agentId: string) =>
    events.push({
      kind: "agentUpserted",
      agent: { id: agentId, name: agentId, status: "reconnecting", needsAuth: false },
    });
  return { pool, tracker, usedCache, state, offerings, seedAgent };
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

describe("CapabilityTracker", () => {
  it("an honest agent's declared fork gets used automatically on connect — the branch affordance's gate", async () => {
    const { pool, state } = harness();
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "honest"));

    const cell = await waitFor(() => {
      const c = state().capabilities.honest?.["session.fork"];
      return c?.used ? c : undefined;
    });
    expect(capabilityState(cell)).toBe("used");

    await pool.stop("honest");
  });

  it("the fork probe's throwaway sessions never linger in the connection's session set", async () => {
    const { pool, state } = harness();
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "tidy"));
    await waitFor(() => (state().capabilities.tidy?.["session.fork"]?.used ? true : undefined));
    // Lingering probe sessions would read as real concurrent sessions to
    // process-policy "auto" (hasExisting) — the set must be empty again.
    expect(pool.get("tidy")!.sessions).toEqual([]);
    await pool.stop("tidy");
  });

  it("a failed fork probe also cleans up its throwaway parent session", async () => {
    const { pool, state } = harness();
    await pool.connect(
      spec({ declare: { sessionCapabilities: { fork: {} } }, lies: { forkBroken: true } }, "tidy2"),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(state().capabilities.tidy2!["session.fork"].used).toBe(false);
    expect(pool.get("tidy2")!.sessions).toEqual([]);
    await pool.stop("tidy2");
  });

  it("an ended probe session's id is retired — the agent may legally re-mint it for a real session", async () => {
    // Session ids are agent-chosen; once the probe close/deletes its
    // throwaway session the id is the agent's to reuse (the acp-matrix
    // fixture mints max-stored+1, so its next real session collides
    // deterministically). A lingering probeSessions entry then swallows the
    // real session's updates and auto-denies its permission requests.
    const { pool, tracker, offerings } = harness();
    await pool.connect(
      spec({ declare: { sessionCapabilities: { close: {}, delete: {} } } }, "reuse"),
    );
    const probeId = (await waitFor(() => offerings[0])).sessionId;
    await waitFor(() => (tracker.isProbeSession("reuse", probeId) ? undefined : true));
    expect(tracker.isProbeSession("reuse", probeId)).toBe(false);
    await pool.stop("reuse");
  });

  it("probe identity is agent-scoped and real adoption supersedes it — a lingering entry can't capture another agent's session", async () => {
    // A close+delete-incapable agent's probe entry deliberately lingers
    // (the probe session genuinely lives on agent-side). Two boundaries
    // still hold: another agent minting the same id string is never
    // classified by it, and the owning agent re-minting the id for a real
    // session retires it (the probe session necessarily ended agent-side).
    const { pool, tracker, offerings } = harness();
    await pool.connect(spec({}, "lingerer")); // declares neither close nor delete
    const probeId = (await waitFor(() => offerings[0])).sessionId;
    expect(tracker.isProbeSession("lingerer", probeId)).toBe(true);
    expect(tracker.isProbeSession("other-agent", probeId)).toBe(false);
    tracker.noteRealSessionOpened("lingerer", probeId);
    expect(tracker.isProbeSession("lingerer", probeId)).toBe(false);
    await pool.stop("lingerer");
  });

  it("the probe root survives the probe — a workspace-aware agent may hold it past session/new", async () => {
    // Observed with Auggie: workspace validation/indexing runs after the
    // session/new reply; the old mkdtemp/rm-in-finally deleted the root out
    // from under it (CLI-fatal agent-side). Lifetime = agent config, not
    // the probe call.
    const { pool, state } = harness();
    await pool.connect(spec({}, "rooted"));
    await waitFor(() => (state().capabilities.rooted !== undefined ? true : undefined));
    await new Promise((r) => setTimeout(r, 100)); // let the probe's finally run
    expect((await stat(join(cwd, "probe", "rooted"))).isDirectory()).toBe(true);
    await pool.stop("rooted");
  });

  it("a lying agent (declares fork, breaks it) reads suspect — indicted, never used", async () => {
    const { pool, state } = harness();
    await pool.connect(
      spec(
        { declare: { sessionCapabilities: { fork: {} } }, lies: { forkBroken: true } },
        "liar",
      ),
    );

    // give the automatic round trip a chance to run and fail
    await new Promise((r) => setTimeout(r, 300));
    const cell = state().capabilities.liar!["session.fork"];
    // The probe's failed fork is exactly a fact-that-would-have-proven riding
    // a failed request: declared, not used, flagged — suspicion, not error.
    expect(capabilityState(cell)).toBe("suspect");
    expect(cell.used).toBe(false);

    await pool.stop("liar");
  });

  it("an agent that never declares fork never shows declared, let alone used", async () => {
    const { pool, state } = harness();
    await pool.connect(spec({}, "nofork"));
    await new Promise((r) => setTimeout(r, 100));
    expect(capabilityState(state().capabilities.nofork!["session.fork"])).toBe("not-declared");
    await pool.stop("nofork");
  });

  it("reconnect at the same version seeds used from the persisted cache immediately", async () => {
    const { pool, state } = harness();
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "reconn"));
    await waitFor(() => (state().capabilities.reconn!["session.fork"].used ? true : undefined));

    const resetAt1 = state().capabilitiesResetAt.reconn;
    await pool.restart("reconn");

    // same agentInfo.version (the fake agent's fixed "0.0.0") — seeded from
    // the persisted cache the instant the new matrix is declared, not reset.
    expect(state().capabilities.reconn!["session.fork"].used).toBe(true);
    expect(state().capabilitiesResetAt.reconn).not.toBe(resetAt1);

    await pool.stop("reconn");
  });

  it("every connect performs the offering read — even a reconnect with nothing left to verify", async () => {
    const script: FakeAgentScript = {
      declare: { sessionCapabilities: { fork: {} } },
      modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Code" }] },
      configOptions: [
        { id: "model", name: "Model", type: "select", currentValue: "s", options: [{ value: "s", name: "Sonnet" }] },
      ],
    };
    const { pool, state, offerings } = harness();
    await pool.connect(spec(script, "offer"));
    await waitFor(() => (offerings.length > 0 ? true : undefined));
    expect(offerings[0]!.agentId).toBe("offer");
    expect(offerings[0]!.modes).toMatchObject({ currentModeId: "code" });
    expect(offerings[0]!.configOptions).toMatchObject([{ id: "model" }]);

    // reconnect at the same version: fork/auth are seeded used (nothing to
    // verify), but offerings are connection state — read again regardless.
    await waitFor(() => (state().capabilities.offer!["session.fork"].used ? true : undefined));
    await pool.restart("offer");
    await waitFor(() => (offerings.length >= 2 ? true : undefined));
    expect(offerings[1]!.modes).toMatchObject({ currentModeId: "code" });

    await pool.stop("offer");
  });

  it("a latched agent's probe waits for the first real session, and the trigger spends once (first-session-mcp-latch)", async () => {
    const { pool, tracker, offerings } = harness();
    // "auggie" is the id-keyed curated entry in extensions/first-session-mcp-latch.
    await pool.connect(
      spec({ modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Code" }] } }, "auggie"),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(offerings).toHaveLength(0); // connect did NOT spend the process's first session
    tracker.noteRealSessionOpened("auggie", "real-1");
    await waitFor(() => (offerings.length > 0 ? true : undefined));
    expect(offerings[0]!.agentId).toBe("auggie");
    tracker.noteRealSessionOpened("auggie", "real-2"); // already spent — no second probe
    await new Promise((r) => setTimeout(r, 200));
    expect(offerings).toHaveLength(1);
    // ...and a non-latched agent id is a no-op trigger.
    tracker.noteRealSessionOpened("someone-else", "real-3");
    await pool.stop("auggie");
  });

  it("a version change resets used — an honestly fresh matrix, not carried over", async () => {
    const { pool, state } = harness();
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "verbump"));
    await waitFor(() => (state().capabilities.verbump!["session.fork"].used ? true : undefined));
    await pool.stop("verbump");

    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } }, version: "0.0.1" }, "verbump"));
    // immediately after the version-bumped connect, before the round trip re-runs
    expect(state().capabilities.verbump!["session.fork"].used).toBe(false);
    expect(capabilityState(state().capabilities.verbump!["session.fork"])).toBe("declared");

    // and it earns used on its own, same as any fresh connect
    await waitFor(() => (state().capabilities.verbump!["session.fork"].used ? true : undefined));
    await pool.stop("verbump");
  });

  it("verify() re-runs the free fork check on demand", async () => {
    const { pool, tracker, state } = harness();
    await pool.connect(
      spec({ declare: { sessionCapabilities: { fork: {} } }, lies: { forkBroken: true } }, "diag"),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(state().capabilities.diag!["session.fork"].used).toBe(false);

    // still broken — Verify doesn't fake success, it just re-checks honestly
    await tracker.verify("diag");
    expect(state().capabilities.diag!["session.fork"].used).toBe(false);

    await pool.stop("diag");
  });

  it("auth_required surfaces as agentAuthRequired, not a check failure", async () => {
    const { pool, state, seedAgent } = harness();
    seedAgent("needsauth");
    await pool.connect(
      spec(
        {
          declare: { sessionCapabilities: { fork: {} } },
          authMethods: [{ id: "default", name: "Default" }],
          lies: { authRequired: true },
        },
        "needsauth",
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    const agent = state().agents.find((a) => a.id === "needsauth");
    expect(agent?.needsAuth).toBe(true);
    expect(capabilityState(state().capabilities.needsauth!.auth)).toBe("declared");

    await pool.stop("needsauth");
  });

  it("authenticate() clears needsAuth and marks auth used once the retry succeeds", async () => {
    const { pool, tracker, state, seedAgent } = harness();
    seedAgent("login");
    await pool.connect(
      spec(
        {
          declare: { sessionCapabilities: { fork: {} } },
          authMethods: [{ id: "default", name: "Default" }],
          lies: { authRequired: true },
        },
        "login",
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(state().agents.find((a) => a.id === "login")?.needsAuth).toBe(true);

    await tracker.authenticate("login", "default");
    expect(state().agents.find((a) => a.id === "login")?.needsAuth).toBe(false);
    expect(capabilityState(state().capabilities.login!.auth)).toBe("used");

    await pool.stop("login");
  });

  it("concurrent sessions get marked used the moment a second session succeeds on one connection", async () => {
    const { pool, state } = harness();
    await pool.connect(spec({}, "multi"));
    expect(capabilityState(state().capabilities.multi!.concurrentSessions)).toBe("not-declared");

    await pool.newSession("multi", cwd);
    expect(capabilityState(state().capabilities.multi!.concurrentSessions)).toBe("not-declared");

    await pool.newSession("multi", cwd);
    expect(capabilityState(state().capabilities.multi!.concurrentSessions)).toBe("used");

    await pool.stop("multi");
  });
});
