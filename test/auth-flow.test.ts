// Live auth flows over a real fake-agent subprocess: the wire facts the
// connect probe / authenticate / prompt actually produce, run through the
// real authority table (auth-evidence.ts) exactly as the extension host
// does. The pure transition-table tests prove the table; these prove which
// evidence the wire actually delivers to it — and that a persisted lock is
// never laundered by facts that don't contradict it.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAuthEvidence,
  LOGGED_OUT_REASON,
  type AuthLock,
} from "../src/orchestrator/auth-evidence";
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
  cwd = await mkdtemp(join(tmpdir(), "patchbay-authflow-"));
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

function harness(): {
  pool: AgentPool;
  tracker: CapabilityTracker;
  /** The persisted-lock mirror (AuthLockStore in the real host): tests may
   * pre-seed it, exactly as the store restores a lock across a reload. */
  locks: Map<string, AuthLock>;
  events: AgentViewEvent[];
  state(): ReturnType<typeof reduceAgentView>;
  seedAgent(agentId: string): void;
  authEvents(kind: "agentAuthRequired" | "agentAuthResolved", agentId: string): AgentViewEvent[];
} {
  const events: AgentViewEvent[] = [];
  const locks = new Map<string, AuthLock>();
  let tracker!: CapabilityTracker;
  const state = () => events.reduce(reduceAgentView, initialAgentViewState);
  const pool = new AgentPool({
    onStatusChanged: () => {},
    onDeclaredCaptured: (agentId, declared, raw) =>
      tracker.onDeclared(agentId, declared, raw.agentInfo?.version ?? null, raw.protocolVersion),
    onSessionUpdate: () => {},
    onCapabilityEvidence: (agentId, row, evidence) =>
      evidence === "used" ? tracker.markUsed(agentId, row) : tracker.markSuspect(agentId, row),
    // Mirrors orchestrator.noteAuthEvidence exactly: one writer, the
    // authority table decides, only a transition emits, and only an
    // affirmative auth action's clear marks the auth row used.
    onAuthWireFact: (agentId, method, settled, reason) => {
      const result = applyAuthEvidence(
        locks.get(agentId) ?? null,
        settled === "ok"
          ? { kind: "rpcOk", method }
          : { kind: "authRequired", method, reason: reason ?? null },
        new Date().toISOString(),
      );
      if (!result.changed) return;
      if (result.lock === null) {
        locks.delete(agentId);
        events.push({ kind: "agentAuthResolved", agentId });
        // Restricted marking, as in the host: only an affirmative auth
        // action proves the row — a prompt or same-method heal honestly
        // ends the lock without having exercised patchbay's auth path.
        if (settled === "ok" && method === "authenticate") tracker.markUsed(agentId, "auth");
      } else {
        locks.set(agentId, result.lock);
        events.push({ kind: "agentAuthRequired", agentId, reason: result.lock.reason });
      }
    },
    ...stubFsTerminalHooks(),
  });
  tracker = new CapabilityTracker(pool, new UsedCapabilityStore(new MemoryKV()), {
    emit: (...evs) => events.push(...evs),
    currentMatrix: (agentId) => state().capabilities[agentId],
    onOfferings: () => {},
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
  const authEvents = (kind: "agentAuthRequired" | "agentAuthResolved", agentId: string) =>
    events.filter((e) => e.kind === kind && e.agentId === agentId);
  return { pool, tracker, locks, events, state, seedAgent, authEvents };
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
    h.seedAgent("strict");
    await h.pool.connect(spec(STRICT, "strict"));

    const lock = await waitFor(() => h.locks.get("strict"));
    expect(lock).toMatchObject({ kind: "authRequired", method: methods.agent.session.new });
    expect(h.authEvents("agentAuthRequired", "strict").length).toBeGreaterThanOrEqual(1);
    expect(h.authEvents("agentAuthResolved", "strict")).toHaveLength(0);
    expect(h.state().agents.find((a) => a.id === "strict")?.needsAuth).toBe(true);

    await h.tracker.authenticate("strict", "default");
    expect(h.locks.get("strict")).toBeUndefined();
    expect(h.authEvents("agentAuthResolved", "strict")).toHaveLength(1);
    expect(h.state().agents.find((a) => a.id === "strict")?.needsAuth).toBe(false);
    expect(capabilityState(h.state().capabilities.strict!.auth)).toBe("used");

    await h.pool.stop("strict");
  });

  it("a reconnect onto a still-locked-out agent re-witnesses the same fact silently — no resolve, no duplicate raise", async () => {
    const h = harness();
    h.seedAgent("relock");
    await h.pool.connect(spec(STRICT, "relock"));
    await waitFor(() => h.locks.get("relock"));
    await h.pool.stop("relock");

    // Fresh process, credentials still absent agent-side: the reconnect
    // probe hits the same -32000 with the same method and reason — a
    // non-transition, so no event spam and certainly no resolve.
    await h.pool.connect(spec(STRICT, "relock"));
    await new Promise((r) => setTimeout(r, 300)); // let the reconnect probe settle
    expect(h.authEvents("agentAuthRequired", "relock")).toHaveLength(1);
    expect(h.authEvents("agentAuthResolved", "relock")).toHaveLength(0);
    expect(h.locks.get("relock")).toMatchObject({
      kind: "authRequired",
      method: methods.agent.session.new,
    });

    await h.pool.stop("relock");
  });

  it("a witnessed logout survives a lazy-auth agent's probe successes; only a completed prompt clears it", async () => {
    const h = harness();
    h.seedAgent("lazy");
    // A wire-driven logout can't be produced here — the fixture has no
    // logout handler — so the lock is seeded the way the persisted store
    // restores one across a reload. Every fact below is a real wire fact.
    h.locks.set("lazy", {
      kind: "loggedOut",
      reason: LOGGED_OUT_REASON,
      at: new Date().toISOString(),
    });

    await h.pool.connect(spec(LAZY, "lazy"));
    await waitFor(() => (h.state().capabilities.lazy?.["session.fork"]?.used ? true : undefined));
    // initialize, session/new, session/fork all succeeded — none of them
    // contradicts a logout, so the lock must stand untouched.
    expect(h.authEvents("agentAuthResolved", "lazy")).toHaveLength(0);
    expect(h.locks.get("lazy")).toMatchObject({ kind: "loggedOut" });
    expect(h.state().agents.find((a) => a.id === "lazy")?.needsAuth).toBe(false); // seeded row untouched — the real host seeds needsAuth from the store

    const { sessionId } = await h.pool.newSession("lazy", cwd);
    await h.pool.prompt("lazy", sessionId, [{ type: "text", text: "hi" }]);
    expect(h.locks.get("lazy")).toBeUndefined();
    expect(h.authEvents("agentAuthResolved", "lazy")).toHaveLength(1);
    // The prompt honestly ended the lock — but patchbay's auth path never
    // fired, so the row stays declared: clearing ≠ proving.
    expect(capabilityState(h.state().capabilities.lazy!.auth)).toBe("declared");

    await h.pool.stop("lazy");
  });

  it("an agent healed out-of-band clears a session/new lock on the reconnect probe — same-method contradiction, by design", async () => {
    const h = harness();
    h.seedAgent("healed");
    await h.pool.connect(spec(STRICT, "healed"));
    await waitFor(() => h.locks.get("healed"));
    await h.pool.stop("healed");

    // Credentials now valid agent-side (the lie cleared — the user logged
    // in out-of-band): the reconnect probe's session/new SUCCESS is the
    // very method that raised the lock. That is an honest contradiction —
    // this reconnect DOES resolve, unlike the loggedOut/prompt-raised
    // locks, which session/new can never launder.
    await h.pool.connect(spec({ ...STRICT, lies: {} }, "healed"));
    await waitFor(() => (h.locks.get("healed") === undefined ? true : undefined));
    expect(h.authEvents("agentAuthResolved", "healed")).toHaveLength(1);
    // Same-method contradiction clears the lock but proves no auth path.
    expect(capabilityState(h.state().capabilities.healed!.auth)).toBe("declared");

    await h.pool.stop("healed");
  });
});
