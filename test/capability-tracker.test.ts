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
import type { PatchbayAgentId } from "../src/shared/ids";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "patchbay-capver-"));
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
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "honest" as PatchbayAgentId));

    const cell = await waitFor(() => {
      const c = tracker.matrix("honest" as PatchbayAgentId)?.["session.fork"];
      return c?.used ? c : undefined;
    });
    expect(capabilityState(cell)).toBe("used");

    await pool.stop("honest" as PatchbayAgentId);
  });

  it("the fork probe's throwaway sessions never linger in the connection's session set", async () => {
    const { pool, tracker } = harness();
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "tidy" as PatchbayAgentId));
    await waitFor(() => (tracker.matrix("tidy" as PatchbayAgentId)?.["session.fork"]?.used ? true : undefined));
    // Lingering probe sessions would count toward the concurrent-sessions
    // proof — the user's first real session would read as a second one —
    // so the set must be empty again.
    expect(pool.get("tidy" as PatchbayAgentId)!.sessions).toEqual([]);
    await pool.stop("tidy" as PatchbayAgentId);
  });

  it("a failed fork probe also cleans up its throwaway parent session", async () => {
    const { pool, tracker } = harness();
    await pool.connect(
      spec({ declare: { sessionCapabilities: { fork: {} } }, lies: { forkBroken: true } }, "tidy2" as PatchbayAgentId),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(tracker.matrix("tidy2" as PatchbayAgentId)!["session.fork"].used).toBe(false);
    expect(pool.get("tidy2" as PatchbayAgentId)!.sessions).toEqual([]);
    await pool.stop("tidy2" as PatchbayAgentId);
  });

  it("an ended probe session's id is retired — the agent may legally re-mint it for a real session", async () => {
    // Session ids are agent-chosen; once the probe close/deletes its
    // throwaway session the id is the agent's to reuse (the acp-matrix
    // fixture mints max-stored+1, so its next real session collides
    // deterministically). A lingering probeSessions entry then swallows the
    // real session's updates and auto-denies its permission requests.
    const { pool, tracker, probes } = harness();
    await pool.connect(
      spec({ declare: { sessionCapabilities: { close: {}, delete: {} } } }, "reuse" as PatchbayAgentId),
    );
    const probeId = (await waitFor(() => probes[0])).sessionId;
    await waitFor(() => (tracker.isProbeSession("reuse" as PatchbayAgentId, probeId) ? undefined : true));
    expect(tracker.isProbeSession("reuse" as PatchbayAgentId, probeId)).toBe(false);
    await pool.stop("reuse" as PatchbayAgentId);
  });

  it("probe identity is agent-scoped and real adoption supersedes it — a lingering entry can't capture another agent's session", async () => {
    // A close+delete-incapable agent's probe entry deliberately lingers
    // (the probe session genuinely lives on agent-side). Two boundaries
    // still hold: another agent minting the same id string is never
    // classified by it, and the owning agent re-minting the id for a real
    // session retires it (the probe session necessarily ended agent-side).
    const { pool, tracker, probes } = harness();
    await pool.connect(spec({}, "lingerer" as PatchbayAgentId)); // declares neither close nor delete
    const probeId = (await waitFor(() => probes[0])).sessionId;
    expect(tracker.isProbeSession("lingerer" as PatchbayAgentId, probeId)).toBe(true);
    expect(tracker.isProbeSession("other-agent" as PatchbayAgentId, probeId)).toBe(false);
    tracker.noteRealSessionOpened("lingerer" as PatchbayAgentId, probeId);
    expect(tracker.isProbeSession("lingerer" as PatchbayAgentId, probeId)).toBe(false);
    await pool.stop("lingerer" as PatchbayAgentId);
  });

  it("the probe root survives the probe — a workspace-aware agent may hold it past session/new", async () => {
    // Observed with Auggie: workspace validation/indexing runs after the
    // session/new reply; the old mkdtemp/rm-in-finally deleted the root out
    // from under it (CLI-fatal agent-side). Lifetime = agent config, not
    // the probe call.
    const { pool, tracker } = harness();
    await pool.connect(spec({}, "rooted" as PatchbayAgentId));
    await waitFor(() => (tracker.matrix("rooted" as PatchbayAgentId) !== undefined ? true : undefined));
    await new Promise((r) => setTimeout(r, 100)); // let the probe's finally run
    expect((await stat(join(cwd, "probe", "rooted"))).isDirectory()).toBe(true);
    await pool.stop("rooted" as PatchbayAgentId);
  });

  it("a lying agent (declares fork, breaks it) reads suspect — indicted, never used", async () => {
    const { pool, tracker } = harness();
    await pool.connect(
      spec(
        { declare: { sessionCapabilities: { fork: {} } }, lies: { forkBroken: true } },
        "liar" as PatchbayAgentId,
      ),
    );

    // give the automatic round trip a chance to run and fail
    await new Promise((r) => setTimeout(r, 300));
    const cell = tracker.matrix("liar" as PatchbayAgentId)!["session.fork"];
    // The probe's failed fork is exactly a fact-that-would-have-proven riding
    // a failed request: declared, not used, flagged — suspicion, not error.
    expect(capabilityState(cell)).toBe("suspect");
    expect(cell.used).toBe(false);

    await pool.stop("liar" as PatchbayAgentId);
  });

  it("an agent that never declares fork never shows declared, let alone used", async () => {
    const { pool, tracker } = harness();
    await pool.connect(spec({}, "nofork" as PatchbayAgentId));
    await new Promise((r) => setTimeout(r, 100));
    expect(capabilityState(tracker.matrix("nofork" as PatchbayAgentId)!["session.fork"])).toBe("not-declared");
    await pool.stop("nofork" as PatchbayAgentId);
  });

  it("reconnect at the same version seeds used from the persisted cache immediately", async () => {
    const { pool, tracker } = harness();
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "reconn" as PatchbayAgentId));
    await waitFor(() => (tracker.matrix("reconn" as PatchbayAgentId)!["session.fork"].used ? true : undefined));

    const resetAt1 = pool.get("reconn" as PatchbayAgentId)?.initializedAt;
    await pool.restart("reconn" as PatchbayAgentId);

    // same agentInfo.version (the fake agent's fixed "0.0.0") — seeded from
    // the persisted cache the instant the new matrix is declared, not reset.
    expect(tracker.matrix("reconn" as PatchbayAgentId)!["session.fork"].used).toBe(true);
    expect(pool.get("reconn" as PatchbayAgentId)?.initializedAt).not.toBe(resetAt1);

    await pool.stop("reconn" as PatchbayAgentId);
  });

  it("a latched agent's probe waits for the first real session, and the trigger spends once (first-session-mcp-latch)", async () => {
    const { pool, tracker, probes, seedAgent } = harness();
    // The latch's curated entry names the registry entry "auggie"; the agent
    // added from it has an id of its own.
    seedAgent("latched" as PatchbayAgentId, "auggie");
    await pool.connect(
      spec({ modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Code" }] } }, "latched" as PatchbayAgentId),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(probes).toHaveLength(0); // connect did NOT spend the process's first session
    expect(tracker.isProbeDeferred("latched" as PatchbayAgentId)).toBe(true); // what the defaults editor consults
    tracker.noteRealSessionOpened("latched" as PatchbayAgentId, "real-1");
    await waitFor(() => (probes.length > 0 ? true : undefined));
    expect(probes[0]!.patchbayAgentId).toBe("latched");
    expect(tracker.isProbeDeferred("latched" as PatchbayAgentId)).toBe(false);
    tracker.noteRealSessionOpened("latched" as PatchbayAgentId, "real-2"); // already spent — no second probe
    await new Promise((r) => setTimeout(r, 200));
    expect(probes).toHaveLength(1);
    // ...and a non-latched agent id is a no-op trigger.
    tracker.noteRealSessionOpened("someone-else" as PatchbayAgentId, "real-3");
    await pool.stop("latched" as PatchbayAgentId);
  });

  it("a version change resets used — an honestly fresh matrix, not carried over", async () => {
    const { pool, tracker } = harness();
    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } } }, "verbump" as PatchbayAgentId));
    await waitFor(() => (tracker.matrix("verbump" as PatchbayAgentId)!["session.fork"].used ? true : undefined));
    await pool.stop("verbump" as PatchbayAgentId);

    await pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } }, version: "0.0.1" }, "verbump" as PatchbayAgentId));
    // immediately after the version-bumped connect, before the round trip re-runs
    expect(tracker.matrix("verbump" as PatchbayAgentId)!["session.fork"].used).toBe(false);
    expect(capabilityState(tracker.matrix("verbump" as PatchbayAgentId)!["session.fork"])).toBe("declared");

    // and it earns used on its own, same as any fresh connect
    await waitFor(() => (tracker.matrix("verbump" as PatchbayAgentId)!["session.fork"].used ? true : undefined));
    await pool.stop("verbump" as PatchbayAgentId);
  });

  it("verify() re-runs the free fork check on demand", async () => {
    const { pool, tracker } = harness();
    await pool.connect(
      spec({ declare: { sessionCapabilities: { fork: {} } }, lies: { forkBroken: true } }, "diag" as PatchbayAgentId),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(tracker.matrix("diag" as PatchbayAgentId)!["session.fork"].used).toBe(false);

    // still broken — Verify doesn't fake success, it just re-checks honestly
    await tracker.verify("diag" as PatchbayAgentId);
    expect(tracker.matrix("diag" as PatchbayAgentId)!["session.fork"].used).toBe(false);

    await pool.stop("diag" as PatchbayAgentId);
  });

  it("auth_required surfaces as needsAuth on the row, not a check failure", async () => {
    const { pool, tracker, state, seedAgent } = harness();
    seedAgent("needsauth" as PatchbayAgentId);
    await pool.connect(
      spec(
        {
          declare: { sessionCapabilities: { fork: {} } },
          authMethods: [{ id: "default", name: "Default" }],
          lies: { authRequired: true },
        },
        "needsauth" as PatchbayAgentId,
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    const agent = state().agents.find((a) => a.id === "needsauth");
    expect(agent?.needsAuth).toBe(true);
    expect(capabilityState(tracker.matrix("needsauth" as PatchbayAgentId)!.auth)).toBe("declared");

    await pool.stop("needsauth" as PatchbayAgentId);
  });

  it("authenticate() clears needsAuth and marks auth used once the retry succeeds", async () => {
    const { pool, tracker, state, seedAgent } = harness();
    seedAgent("login" as PatchbayAgentId);
    await pool.connect(
      spec(
        {
          declare: { sessionCapabilities: { fork: {} } },
          authMethods: [{ id: "default", name: "Default" }],
          lies: { authRequired: true },
        },
        "login" as PatchbayAgentId,
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(state().agents.find((a) => a.id === "login")?.needsAuth).toBe(true);

    await tracker.authenticate("login" as PatchbayAgentId, "default");
    expect(state().agents.find((a) => a.id === "login")?.needsAuth).toBe(false);
    expect(capabilityState(tracker.matrix("login" as PatchbayAgentId)!.auth)).toBe("used");

    await pool.stop("login" as PatchbayAgentId);
  });

  it("concurrent sessions get marked used the moment a second session succeeds on one connection", async () => {
    const { pool, tracker } = harness();
    await pool.connect(spec({}, "multi" as PatchbayAgentId));
    expect(capabilityState(tracker.matrix("multi" as PatchbayAgentId)!.concurrentSessions)).toBe("not-declared");

    await pool.newSession("multi" as PatchbayAgentId, cwd);
    expect(capabilityState(tracker.matrix("multi" as PatchbayAgentId)!.concurrentSessions)).toBe("not-declared");

    await pool.newSession("multi" as PatchbayAgentId, cwd);
    expect(capabilityState(tracker.matrix("multi" as PatchbayAgentId)!.concurrentSessions)).toBe("used");

    await pool.stop("multi" as PatchbayAgentId);
  });
});
