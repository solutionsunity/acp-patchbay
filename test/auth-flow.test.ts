// Live auth flows over a real fake-agent subprocess: the wire facts the
// connect probe / authenticate / prompt actually produce, run through the
// agents store's own auth writer and its authority table (auth-evidence.ts)
// — the extension host's path. The pure transition-table tests prove the table; these prove which
// evidence the wire actually delivers to it — and that a persisted lock is
// never laundered by facts that don't contradict it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOGGED_OUT_REASON, type AuthLock } from "../src/orchestrator/auth-evidence";
import type { LaunchSpec } from "../src/orchestrator/pool";
import { capabilityState } from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { agentsHarness } from "./support/agents-harness";
import type { PatchbayAgentId } from "../src/shared/ids";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "patchbay-authflow-"));
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

/** A strict agent: session/new rejects -32000 until authenticate. */
const STRICT: FakeAgentScript = {
  declare: { sessionCapabilities: { fork: {} } },
  authMethods: [{ id: "default", name: "Default" }],
  lies: { authRequired: true },
};

/** A lazy-auth agent: declares login methods but passes session/new without
 * credentials (the Claude shape). */
const LAZY: FakeAgentScript = {
  declare: { sessionCapabilities: { fork: {} } },
  authMethods: [{ id: "default", name: "Default" }],
};

/** The shared agents harness, plus what these flows read: the persisted
 * lock as the store holds it — tests may pre-seed one, exactly as the store
 * restores a lock across a reload, and the views get the row it reads — and
 * how often the views saw needsAuth go up and come down. */
function harness() {
  const h = agentsHarness(cwd);
  const locks = {
    get: (patchbayAgentId: PatchbayAgentId): AuthLock | undefined => h.deps.authLocks.lockFor(patchbayAgentId) ?? undefined,
    set: (patchbayAgentId: PatchbayAgentId, lock: AuthLock): void => {
      // MemoryKV writes land before the promise resolves.
      void h.deps.authLocks.upsert({ id: patchbayAgentId, lock });
      h.agents.publish(patchbayAgentId);
    },
  };
  const authFlips = (patchbayAgentId: PatchbayAgentId) => {
    let raised = 0;
    let resolved = 0;
    let locked = false;
    for (const e of h.events) {
      if (e.kind !== "agentUpserted" || e.agent.id !== patchbayAgentId) continue;
      if (e.agent.needsAuth && !locked) raised++;
      if (!e.agent.needsAuth && locked) resolved++;
      locked = e.agent.needsAuth;
    }
    return { raised, resolved };
  };
  return { ...h, locks, authFlips };
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

describe("auth flows on the wire", () => {
  it("strict agent: the probe's -32000 raises a lock carrying session/new; authenticate clears it and marks auth used", async () => {
    const h = harness();
    h.seedAgent("strict" as PatchbayAgentId);
    await h.pool.connect(spec(STRICT, "strict" as PatchbayAgentId));

    const lock = await waitFor(() => h.locks.get("strict" as PatchbayAgentId));
    expect(lock).toMatchObject({ kind: "authRequired", method: methods.agent.session.new });
    expect(h.authFlips("strict" as PatchbayAgentId).raised).toBeGreaterThanOrEqual(1);
    expect(h.authFlips("strict" as PatchbayAgentId).resolved).toBe(0);
    expect(h.state().agents.find((a) => a.id === "strict")?.needsAuth).toBe(true);

    await h.tracker.authenticate("strict" as PatchbayAgentId, "default");
    expect(h.locks.get("strict" as PatchbayAgentId)).toBeUndefined();
    expect(h.authFlips("strict" as PatchbayAgentId).resolved).toBe(1);
    expect(h.state().agents.find((a) => a.id === "strict")?.needsAuth).toBe(false);
    expect(capabilityState(h.row("strict" as PatchbayAgentId)!.capabilities!.auth)).toBe("used");

    await h.pool.stop("strict" as PatchbayAgentId);
  });

  it("a reconnect onto a still-locked-out agent re-witnesses the same fact silently — no resolve, no duplicate raise", async () => {
    const h = harness();
    h.seedAgent("relock" as PatchbayAgentId);
    await h.pool.connect(spec(STRICT, "relock" as PatchbayAgentId));
    await waitFor(() => h.locks.get("relock" as PatchbayAgentId));
    await h.pool.stop("relock" as PatchbayAgentId);

    // Fresh process, credentials still absent agent-side: the reconnect
    // probe hits the same -32000 with the same method and reason — a
    // non-transition, so no event spam and certainly no resolve.
    await h.pool.connect(spec(STRICT, "relock" as PatchbayAgentId));
    await new Promise((r) => setTimeout(r, 300)); // let the reconnect probe settle
    expect(h.authFlips("relock" as PatchbayAgentId).raised).toBe(1);
    expect(h.authFlips("relock" as PatchbayAgentId).resolved).toBe(0);
    expect(h.locks.get("relock" as PatchbayAgentId)).toMatchObject({
      kind: "authRequired",
      method: methods.agent.session.new,
    });

    await h.pool.stop("relock" as PatchbayAgentId);
  });

  it("a witnessed logout survives a lazy-auth agent's probe successes; only a completed prompt clears it", async () => {
    const h = harness();
    h.seedAgent("lazy" as PatchbayAgentId);
    // A wire-driven logout can't be produced here — the fixture has no
    // logout handler — so the lock is seeded the way the persisted store
    // restores one across a reload. Every fact below is a real wire fact.
    h.locks.set("lazy" as PatchbayAgentId, {
      kind: "loggedOut",
      reason: LOGGED_OUT_REASON,
      at: new Date().toISOString(),
    });

    await h.pool.connect(spec(LAZY, "lazy" as PatchbayAgentId));
    await waitFor(() => (h.row("lazy" as PatchbayAgentId)?.capabilities?.["session.fork"]?.used ? true : undefined));
    // initialize, session/new, session/fork all succeeded — none of them
    // contradicts a logout, so the lock must stand untouched.
    expect(h.authFlips("lazy" as PatchbayAgentId).resolved).toBe(0);
    expect(h.locks.get("lazy" as PatchbayAgentId)).toMatchObject({ kind: "loggedOut" });
    expect(h.row("lazy" as PatchbayAgentId)?.needsAuth).toBe(true); // the row reads the standing lock

    const { sessionId } = await h.pool.newSession("lazy" as PatchbayAgentId, cwd);
    await h.pool.prompt("lazy" as PatchbayAgentId, sessionId, [{ type: "text", text: "hi" }]);
    expect(h.locks.get("lazy" as PatchbayAgentId)).toBeUndefined();
    expect(h.authFlips("lazy" as PatchbayAgentId).resolved).toBe(1);
    // The prompt honestly ended the lock — but patchbay's auth path never
    // fired, so the row stays declared: clearing ≠ proving.
    expect(capabilityState(h.row("lazy" as PatchbayAgentId)!.capabilities!.auth)).toBe("declared");

    await h.pool.stop("lazy" as PatchbayAgentId);
  });

  // Issue #35: evidence is earned when the RPC leaves, not when it settles.
  // A prompt that left on valid credentials, with a lock raised while it
  // ran (a sibling session's -32000, a witnessed logout), finishes "ok" and
  // must not clear that lock — its success predates it. The next prompt,
  // started under the lock, is real evidence and clears.
  it("a prompt in flight when the lock is raised does not clear it on completion; one started after it does", async () => {
    const h = harness();
    h.seedAgent("lazy" as PatchbayAgentId);
    await h.pool.connect(spec({ ...LAZY, stepDelayMs: 300, turn: [{ type: "chunk", text: "slow" }] }, "lazy" as PatchbayAgentId));
    const { sessionId } = await h.pool.newSession("lazy" as PatchbayAgentId, cwd);

    const inFlight = h.pool.prompt("lazy" as PatchbayAgentId, sessionId, [{ type: "text", text: "left before the lock" }]);
    await new Promise((r) => setTimeout(r, 50)); // the prompt is on the wire
    h.locks.set("lazy" as PatchbayAgentId, { kind: "loggedOut", reason: LOGGED_OUT_REASON, at: new Date().toISOString() });
    await inFlight;
    expect(h.locks.get("lazy" as PatchbayAgentId)).toMatchObject({ kind: "loggedOut" });
    expect(h.authFlips("lazy" as PatchbayAgentId).resolved).toBe(0);

    await h.pool.prompt("lazy" as PatchbayAgentId, sessionId, [{ type: "text", text: "started under the lock" }]);
    expect(h.locks.get("lazy" as PatchbayAgentId)).toBeUndefined();
    expect(h.authFlips("lazy" as PatchbayAgentId).resolved).toBe(1);

    await h.pool.stop("lazy" as PatchbayAgentId);
  });

  it("an agent healed out-of-band clears a session/new lock on the reconnect probe — same-method contradiction, by design", async () => {
    const h = harness();
    h.seedAgent("healed" as PatchbayAgentId);
    await h.pool.connect(spec(STRICT, "healed" as PatchbayAgentId));
    await waitFor(() => h.locks.get("healed" as PatchbayAgentId));
    await h.pool.stop("healed" as PatchbayAgentId);

    // Credentials now valid agent-side (the lie cleared — the user logged
    // in out-of-band): the reconnect probe's session/new SUCCESS is the
    // very method that raised the lock. That is an honest contradiction —
    // this reconnect DOES resolve, unlike the loggedOut/prompt-raised
    // locks, which session/new can never launder.
    await h.pool.connect(spec({ ...STRICT, lies: {} }, "healed" as PatchbayAgentId));
    await waitFor(() => (h.locks.get("healed" as PatchbayAgentId) === undefined ? true : undefined));
    expect(h.authFlips("healed" as PatchbayAgentId).resolved).toBe(1);
    // Same-method contradiction clears the lock but proves no auth path.
    expect(capabilityState(h.row("healed" as PatchbayAgentId)!.capabilities!.auth)).toBe("declared");

    await h.pool.stop("healed" as PatchbayAgentId);
  });

  it("a mid-turn credential failure rejected as an internal error with an auth-classified errorKind locks like -32000 (turn-auth-failure door)", async () => {
    const h = harness();
    h.seedAgent("expired" as PatchbayAgentId);
    const EXPIRED = "Failed to authenticate: OAuth session expired and could not be refreshed";
    // The claude-agent-acp shape for an expired OAuth session: lazy auth
    // passes connect, probe and session/new; the prompt is what fails —
    // and not with -32000.
    await h.pool.connect(
      spec(
        {
          ...LAZY,
          promptError: {
            code: -32603,
            message: `Internal error: ${EXPIRED}`,
            data: { errorKind: "authentication_failed" },
          },
        },
        "expired" as PatchbayAgentId,
      ),
    );
    await waitFor(() => (h.row("expired" as PatchbayAgentId)?.capabilities?.["session.fork"]?.used ? true : undefined));
    expect(h.locks.get("expired" as PatchbayAgentId)).toBeUndefined();

    const { sessionId } = await h.pool.newSession("expired" as PatchbayAgentId, cwd);
    await expect(h.pool.prompt("expired" as PatchbayAgentId, sessionId, [{ type: "text", text: "hi" }])).rejects.toMatchObject({
      code: -32603,
    });
    // The rejection still reaches the caller (the turn fails honestly),
    // AND the lock now stands, carrying the prompt method and the agent's
    // own reason minus the SDK framing — the card offers Log in.
    expect(h.locks.get("expired" as PatchbayAgentId)).toMatchObject({
      kind: "authRequired",
      method: methods.agent.session.prompt,
      reason: EXPIRED,
    });
    expect(h.authFlips("expired" as PatchbayAgentId).raised).toBe(1);
    expect(h.state().agents.find((a) => a.id === "expired")?.needsAuth).toBe(true);

    await h.pool.stop("expired" as PatchbayAgentId);
  });
});
