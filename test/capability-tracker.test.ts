// P5 gate: fake agent scripted to lie shows declared-but-not-used; branch
// affordance lights only after the fork is used; reconnect drops used.
import { mkdtemp, rm } from "node:fs/promises";
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
  /** `agentAuthRequired`/`agentAuthResolved` only patch an existing
   * AgentSummary (same shape as the real orchestrator, which always
   * upserts before connecting) — tests touching `needsAuth` seed one first. */
  seedAgent(agentId: string): void;
} {
  const events: AgentViewEvent[] = [];
  let tracker!: CapabilityTracker;
  const state = () => events.reduce(reduceAgentView, initialAgentViewState);
  const usedCache = new UsedCapabilityStore(kv);
  const pool = new AgentPool({
    onStatusChanged: () => {},
    onDeclaredCaptured: (agentId, declared, raw) =>
      tracker.onDeclared(agentId, declared, raw.agentInfo?.version ?? null),
    onSessionUpdate: () => {},
    onCapabilityUsed: (agentId, row) => tracker.markUsed(agentId, row),
    ...stubFsTerminalHooks(),
  });
  tracker = new CapabilityTracker(pool, usedCache, {
    emit: (...evs) => events.push(...evs),
    currentMatrix: (agentId) => state().capabilities[agentId],
  });
  const seedAgent = (agentId: string) =>
    events.push({
      kind: "agentUpserted",
      agent: { id: agentId, name: agentId, status: "reconnecting", needsAuth: false },
    });
  return { pool, tracker, usedCache, state, seedAgent };
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

  it("a lying agent (declares fork, breaks it) shows declared-but-not-used — never used", async () => {
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
    expect(capabilityState(cell)).toBe("declared");
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
