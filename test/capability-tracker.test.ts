// P5 gate: fake agent scripted to lie shows declared-but-not-used; branch
// affordance lights only after the fork is used; reconnect drops used.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LaunchSpec } from "../src/orchestrator/pool";
import { capabilityState } from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { agentsHarness } from "./support/agents-harness";

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

const harness = () => agentsHarness(cwd);

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
    const { pool, tracker } = harness();
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "honest"));

    const cell = await waitFor(() => {
      const c = tracker.matrix("honest")?.["session.fork"];
      return c?.used ? c : undefined;
    });
    expect(capabilityState(cell)).toBe("used");

    await pool.stop("honest");
  });

  it("the fork probe's throwaway sessions never linger in the connection's session set", async () => {
    const { pool, tracker } = harness();
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "tidy"));
    await waitFor(() => (tracker.matrix("tidy")?.["session.fork"]?.used ? true : undefined));
    // Lingering probe sessions would count toward the concurrent-sessions
    // proof — the user's first real session would read as a second one —
    // so the set must be empty again.
    expect(pool.get("tidy")!.sessions).toEqual([]);
    await pool.stop("tidy");
  });

  it("a failed fork probe also cleans up its throwaway parent session", async () => {
    const { pool, tracker } = harness();
    await pool.connect(
      spec({ declare: { sessionCapabilities: { fork: {} } }, lies: { forkBroken: true } }, "tidy2"),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(tracker.matrix("tidy2")!["session.fork"].used).toBe(false);
    expect(pool.get("tidy2")!.sessions).toEqual([]);
    await pool.stop("tidy2");
  });

  it("an ended probe session's id is retired — the agent may legally re-mint it for a real session", async () => {
    // Session ids are agent-chosen; once the probe close/deletes its
    // throwaway session the id is the agent's to reuse (the acp-matrix
    // fixture mints max-stored+1, so its next real session collides
    // deterministically). A lingering probeSessions entry then swallows the
    // real session's updates and auto-denies its permission requests.
    const { pool, tracker, probes } = harness();
    await pool.connect(
      spec({ declare: { sessionCapabilities: { close: {}, delete: {} } } }, "reuse"),
    );
    const probeId = (await waitFor(() => probes[0])).sessionId;
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
    const { pool, tracker, probes } = harness();
    await pool.connect(spec({}, "lingerer")); // declares neither close nor delete
    const probeId = (await waitFor(() => probes[0])).sessionId;
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
    const { pool, tracker } = harness();
    await pool.connect(spec({}, "rooted"));
    await waitFor(() => (tracker.matrix("rooted") !== undefined ? true : undefined));
    await new Promise((r) => setTimeout(r, 100)); // let the probe's finally run
    expect((await stat(join(cwd, "probe", "rooted"))).isDirectory()).toBe(true);
    await pool.stop("rooted");
  });

  it("a lying agent (declares fork, breaks it) reads suspect — indicted, never used", async () => {
    const { pool, tracker } = harness();
    await pool.connect(
      spec(
        { declare: { sessionCapabilities: { fork: {} } }, lies: { forkBroken: true } },
        "liar",
      ),
    );

    // give the automatic round trip a chance to run and fail
    await new Promise((r) => setTimeout(r, 300));
    const cell = tracker.matrix("liar")!["session.fork"];
    // The probe's failed fork is exactly a fact-that-would-have-proven riding
    // a failed request: declared, not used, flagged — suspicion, not error.
    expect(capabilityState(cell)).toBe("suspect");
    expect(cell.used).toBe(false);

    await pool.stop("liar");
  });

  it("an agent that never declares fork never shows declared, let alone used", async () => {
    const { pool, tracker } = harness();
    await pool.connect(spec({}, "nofork"));
    await new Promise((r) => setTimeout(r, 100));
    expect(capabilityState(tracker.matrix("nofork")!["session.fork"])).toBe("not-declared");
    await pool.stop("nofork");
  });

  it("reconnect at the same version seeds used from the persisted cache immediately", async () => {
    const { pool, tracker } = harness();
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "reconn"));
    await waitFor(() => (tracker.matrix("reconn")!["session.fork"].used ? true : undefined));

    const resetAt1 = pool.get("reconn")?.initializedAt;
    await pool.restart("reconn");

    // same agentInfo.version (the fake agent's fixed "0.0.0") — seeded from
    // the persisted cache the instant the new matrix is declared, not reset.
    expect(tracker.matrix("reconn")!["session.fork"].used).toBe(true);
    expect(pool.get("reconn")?.initializedAt).not.toBe(resetAt1);

    await pool.stop("reconn");
  });

  it("a latched agent's probe waits for the first real session, and the trigger spends once (first-session-mcp-latch)", async () => {
    const { pool, tracker, probes } = harness();
    // "auggie" is the id-keyed curated entry in extensions/first-session-mcp-latch.
    await pool.connect(
      spec({ modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Code" }] } }, "auggie"),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(probes).toHaveLength(0); // connect did NOT spend the process's first session
    expect(tracker.isProbeDeferred("auggie")).toBe(true); // what the defaults editor consults
    tracker.noteRealSessionOpened("auggie", "real-1");
    await waitFor(() => (probes.length > 0 ? true : undefined));
    expect(probes[0]!.agentId).toBe("auggie");
    expect(tracker.isProbeDeferred("auggie")).toBe(false);
    tracker.noteRealSessionOpened("auggie", "real-2"); // already spent — no second probe
    await new Promise((r) => setTimeout(r, 200));
    expect(probes).toHaveLength(1);
    // ...and a non-latched agent id is a no-op trigger.
    tracker.noteRealSessionOpened("someone-else", "real-3");
    await pool.stop("auggie");
  });

  it("a version change resets used — an honestly fresh matrix, not carried over", async () => {
    const { pool, tracker } = harness();
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "verbump"));
    await waitFor(() => (tracker.matrix("verbump")!["session.fork"].used ? true : undefined));
    await pool.stop("verbump");

    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } }, version: "0.0.1" }, "verbump"));
    // immediately after the version-bumped connect, before the round trip re-runs
    expect(tracker.matrix("verbump")!["session.fork"].used).toBe(false);
    expect(capabilityState(tracker.matrix("verbump")!["session.fork"])).toBe("declared");

    // and it earns used on its own, same as any fresh connect
    await waitFor(() => (tracker.matrix("verbump")!["session.fork"].used ? true : undefined));
    await pool.stop("verbump");
  });

  it("verify() re-runs the free fork check on demand", async () => {
    const { pool, tracker } = harness();
    await pool.connect(
      spec({ declare: { sessionCapabilities: { fork: {} } }, lies: { forkBroken: true } }, "diag"),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(tracker.matrix("diag")!["session.fork"].used).toBe(false);

    // still broken — Verify doesn't fake success, it just re-checks honestly
    await tracker.verify("diag");
    expect(tracker.matrix("diag")!["session.fork"].used).toBe(false);

    await pool.stop("diag");
  });

  it("auth_required surfaces as needsAuth on the row, not a check failure", async () => {
    const { pool, tracker, state, seedAgent } = harness();
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
    expect(capabilityState(tracker.matrix("needsauth")!.auth)).toBe("declared");

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
    expect(capabilityState(tracker.matrix("login")!.auth)).toBe("used");

    await pool.stop("login");
  });

  it("concurrent sessions get marked used the moment a second session succeeds on one connection", async () => {
    const { pool, tracker } = harness();
    await pool.connect(spec({}, "multi"));
    expect(capabilityState(tracker.matrix("multi")!.concurrentSessions)).toBe("not-declared");

    await pool.newSession("multi", cwd);
    expect(capabilityState(tracker.matrix("multi")!.concurrentSessions)).toBe("not-declared");

    await pool.newSession("multi", cwd);
    expect(capabilityState(tracker.matrix("multi")!.concurrentSessions)).toBe("used");

    await pool.stop("multi");
  });
});
