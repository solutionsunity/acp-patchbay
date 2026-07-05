// P5 gate: fake agent scripted to lie shows declared-but-unverified; branch
// affordance lights only after verified fork; reconnect drops verified.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityVerifier } from "../src/orchestrator/capability-verifier";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
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

function harness(): { pool: AgentPool; verifier: CapabilityVerifier; state(): ReturnType<typeof reduceAgentView> } {
  const events: AgentViewEvent[] = [];
  let verifier!: CapabilityVerifier;
  const pool = new AgentPool({
    onStatusChanged: () => {},
    onDeclaredCaptured: (agentId, declared) => verifier.onDeclared(agentId, declared),
    onSessionUpdate: () => {},
    onConcurrentSessionsVerified: (agentId) => verifier.markVerified(agentId, "concurrentSessions"),
    ...stubFsTerminalHooks(),
  });
  verifier = new CapabilityVerifier(pool, { emit: (...evs) => events.push(...evs) });
  return {
    pool,
    verifier,
    state: () => events.reduce(reduceAgentView, initialAgentViewState),
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

describe("CapabilityVerifier", () => {
  it("an honest agent's declared fork verifies automatically on connect — the branch affordance's gate", async () => {
    const { pool, state } = harness();
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "honest"));

    const cell = await waitFor(() => {
      const c = state().capabilities.honest?.["session.fork"];
      return c?.verified ? c : undefined;
    });
    expect(capabilityState(cell)).toBe("verified");

    await pool.stop("honest");
  });

  it("a lying agent (declares fork, breaks it) shows declared-but-unverified — never verified", async () => {
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
    expect(cell.verified).toBe(false);

    await pool.stop("liar");
  });

  it("an agent that never declares fork never shows declared, let alone verified", async () => {
    const { pool, state } = harness();
    await pool.connect(spec({}, "nofork"));
    await new Promise((r) => setTimeout(r, 100));
    expect(capabilityState(state().capabilities.nofork!["session.fork"])).toBe("not-declared");
    await pool.stop("nofork");
  });

  it("reconnect drops verified — the matrix is replaced wholesale, not patched", async () => {
    const { pool, state } = harness();
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "reconn"));
    await waitFor(() => (state().capabilities.reconn!["session.fork"].verified ? true : undefined));

    const resetAt1 = state().capabilitiesResetAt.reconn;
    await pool.restart("reconn");

    // immediately after reconnect, before the round trip re-runs, verified is false
    expect(state().capabilities.reconn!["session.fork"].verified).toBe(false);
    expect(state().capabilitiesResetAt.reconn).not.toBe(resetAt1);
    expect(capabilityState(state().capabilities.reconn!["session.fork"])).toBe("declared");

    // and it re-verifies on the new connection, same as the first connect
    await waitFor(() => (state().capabilities.reconn!["session.fork"].verified ? true : undefined));
    await pool.stop("reconn");
  });

  it("runDiagnostics re-runs the free fork check on demand", async () => {
    const { pool, verifier, state } = harness();
    await pool.connect(
      spec({ declare: { sessionCapabilities: { fork: {} } }, lies: { forkBroken: true } }, "diag"),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(state().capabilities.diag!["session.fork"].verified).toBe(false);

    // still broken — diagnostics doesn't fake success, it just re-checks honestly
    await verifier.runDiagnostics("diag");
    expect(state().capabilities.diag!["session.fork"].verified).toBe(false);

    await pool.stop("diag");
  });

  it("concurrent sessions verify the moment a second session succeeds on one connection", async () => {
    const { pool, state } = harness();
    await pool.connect(spec({}, "multi"));
    expect(capabilityState(state().capabilities.multi!.concurrentSessions)).toBe("not-declared");

    await pool.newSession("multi", cwd);
    expect(capabilityState(state().capabilities.multi!.concurrentSessions)).toBe("not-declared");

    await pool.newSession("multi", cwd);
    expect(capabilityState(state().capabilities.multi!.concurrentSessions)).toBe("verified");

    await pool.stop("multi");
  });
});
