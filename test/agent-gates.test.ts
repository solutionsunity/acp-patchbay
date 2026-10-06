// The agents' gates (agent-gates.ts) over a stub store: connection work
// takes its turn in the queue and a repeat joins it; Stop and Remove cut in
// — the process down at once, what runs told to stop and what waits
// dropped, the cut-in's own run once what it cut has unwound; a login is
// one operation per method; and an operation that ends the connection asks
// the one question first. The store's own operations stay plain, so every
// one of these rules is the gates'.
import { describe, expect, it } from "vitest";
import { AgentGates, endQuestion, type AgentOperation, type GateAsks } from "../src/orchestrator/agent-gates";
import type { ConnectionOperations } from "../src/orchestrator/agents-store";
import { Cancelled, Queue } from "../src/orchestrator/queue";
import type { PatchbayAgentId } from "../src/shared/ids";

/** A store whose operations each wait for the test to let them finish,
 * recording what ran and the signal each was handed. */
function stubStore() {
  const ran: string[] = [];
  const signals = new Map<string, AbortSignal>();
  /** The go-ahead each upgrade was handed — the store asks it when it
   * would stop a running agent. */
  const consents: Array<() => Promise<boolean>> = [];
  const pending: Array<{ name: string; finish: () => void }> = [];
  const op = (name: string, signal?: AbortSignal) => {
    ran.push(name);
    if (signal !== undefined) signals.set(name, signal);
    return new Promise<void>((resolve) => pending.push({ name, finish: resolve }));
  };
  const store: ConnectionOperations = {
    connect: (_patchbayAgentId, signal) => op("connect", signal),
    restart: (_patchbayAgentId, signal) => op("restart", signal),
    upgrade: (_patchbayAgentId, signal, consent) => {
      if (consent !== undefined) consents.push(consent);
      return op("upgrade", signal);
    },
    login: (_patchbayAgentId, methodId, signal) => op(`login:${methodId}`, signal),
    logout: () => op("logout"),
    stop: () => op("stop"),
    remove: () => op("remove"),
    stopAll: () => op("stopAll"),
  };
  /** Lets every operation running as `name` finish — one told to stop
   * included: that is it unwinding. */
  const finish = (name: string) => {
    for (const p of pending.filter((q) => q.name === name)) {
      pending.splice(pending.indexOf(p), 1);
      p.finish();
    }
  };
  return { store, ran, signals, consents, finish };
}

const tick = () => new Promise((r) => setImmediate(r));

/** Asks with nothing in hand by default — every question answered yes. */
function gated(asks: Partial<GateAsks> = {}) {
  const { store, ran, signals, consents, finish } = stubStore();
  const queue = new Queue<AgentOperation, PatchbayAgentId>(() => {});
  const gates = new AgentGates(store, queue, {
    name: (patchbayAgentId) => `Agent ${patchbayAgentId}`,
    openWork: () => ({ conversations: 0, turns: 0 }),
    confirm: async () => true,
    ...asks,
  });
  return { gates, queue, ran, signals, consents, finish };
}

/** Work in hand, and a question the test answers. */
function asking(work = { conversations: 2, turns: 1 }) {
  const asked: string[] = [];
  let answer: ((yes: boolean) => void) | undefined;
  return {
    asked,
    answer: (yes: boolean) => answer?.(yes),
    asks: {
      openWork: () => work,
      confirm: (message: string) => {
        asked.push(message);
        return new Promise<boolean>((resolve) => (answer = resolve));
      },
    } satisfies Partial<GateAsks>,
  };
}

describe("AgentGates", () => {
  it("connection work takes its turn on the agent, in arrival order", async () => {
    const { gates, ran, finish } = gated();
    const work = [gates.connect("a" as PatchbayAgentId), gates.upgrade("a" as PatchbayAgentId), gates.restart("a" as PatchbayAgentId)];
    await tick();
    expect(ran).toEqual(["connect"]);
    finish("connect");
    await tick();
    expect(ran).toEqual(["connect", "upgrade"]);
    finish("upgrade");
    await tick();
    expect(ran).toEqual(["connect", "upgrade", "restart"]);
    finish("restart");
    await Promise.all(work);
  });

  it("a repeat of an operation held joins it", async () => {
    const { gates, ran, finish } = gated();
    const first = gates.upgrade("a" as PatchbayAgentId);
    const second = gates.upgrade("a" as PatchbayAgentId);
    await tick();
    finish("upgrade");
    await Promise.all([first, second]);
    expect(ran).toEqual(["upgrade"]);
  });

  it("Stop cuts in: the process goes down at once, what runs is told to stop, what waits is dropped", async () => {
    const { gates, queue, ran, signals, finish } = gated();
    const connect = gates.connect("a" as PatchbayAgentId);
    const restart = gates.restart("a" as PatchbayAgentId);
    await tick();
    const stop = gates.stop("a" as PatchbayAgentId);
    // Never behind the work it cuts — that work may be waiting on a hung
    // agent, and ends only with its process.
    expect(ran).toEqual(["connect", "stop"]);
    expect(signals.get("connect")?.aborted).toBe(true);
    // Both settle at once, before anything has unwound.
    await expect(connect).rejects.toBeInstanceOf(Cancelled);
    await expect(restart).rejects.toBeInstanceOf(Cancelled);
    // The connect is still unwinding; the Stop's own run waits for it.
    expect(queue.held("a" as PatchbayAgentId)).toEqual(["connect", "stop"]);
    await tick();
    expect(ran).toEqual(["connect", "stop"]);
    finish("connect");
    await tick();
    // The dropped restart never ran.
    expect(ran).toEqual(["connect", "stop", "stop"]);
    finish("stop");
    await stop;
    expect(queue.held("a" as PatchbayAgentId)).toEqual([]);
  });

  it("Remove cuts in the same way, and is held — the row's busy state — until it is done", async () => {
    const { gates, queue, ran, finish } = gated();
    const login = gates.login("a" as PatchbayAgentId, "terminal");
    await tick();
    const remove = gates.remove("a" as PatchbayAgentId);
    await expect(login).rejects.toBeInstanceOf(Cancelled);
    expect(queue.held("a" as PatchbayAgentId)).toEqual(["login", "remove"]);
    finish("login:terminal");
    finish("stop");
    await tick();
    expect(ran).toEqual(["login:terminal", "stop", "remove"]);
    expect(queue.held("a" as PatchbayAgentId)).toEqual(["remove"]);
    finish("remove");
    await remove;
    expect(queue.held("a" as PatchbayAgentId)).toEqual([]);
  });

  it("a cut-in is never cut: a Remove asked for during a Stop runs once the Stop is done", async () => {
    const { gates, queue, ran, finish } = gated();
    const stop = gates.stop("a" as PatchbayAgentId);
    // Remove always asks first; answered, it takes its place behind the Stop.
    const remove = gates.remove("a" as PatchbayAgentId);
    await tick();
    expect(queue.held("a" as PatchbayAgentId)).toEqual(["stop", "remove"]);
    expect(ran).not.toContain("remove");
    finish("stop");
    await stop;
    await tick();
    expect(ran).toContain("remove");
    finish("remove");
    await remove;
  });

  it("work asked for after a cut waits for what the cut left unwinding, and for the cut-in", async () => {
    const { gates, ran, finish } = gated();
    const cut = gates.connect("a" as PatchbayAgentId);
    await tick();
    const stop = gates.stop("a" as PatchbayAgentId);
    const again = gates.connect("a" as PatchbayAgentId);
    await expect(cut).rejects.toBeInstanceOf(Cancelled);
    finish("stop");
    await tick();
    expect(ran.filter((r) => r === "connect")).toHaveLength(1);
    finish("connect");
    await tick();
    finish("stop");
    await stop;
    await tick();
    // A new operation, not the one cut: it runs.
    expect(ran.filter((r) => r === "connect")).toHaveLength(2);
    finish("connect");
    await again;
  });

  it("stopAll ends every agent's work and takes every process down", async () => {
    const { gates, queue, ran, finish } = gated();
    const a = gates.connect("a" as PatchbayAgentId);
    const b = gates.restart("b" as PatchbayAgentId);
    const bWaiting = gates.upgrade("b" as PatchbayAgentId);
    await tick();
    const all = gates.stopAll();
    expect(ran).toContain("stopAll");
    await expect(a).rejects.toBeInstanceOf(Cancelled);
    await expect(b).rejects.toBeInstanceOf(Cancelled);
    await expect(bWaiting).rejects.toBeInstanceOf(Cancelled);
    finish("stopAll");
    finish("connect");
    finish("restart");
    await all;
    expect(queue.held("a" as PatchbayAgentId)).toEqual([]);
    expect(queue.held("b" as PatchbayAgentId)).toEqual([]);
    expect(ran).not.toContain("upgrade");
  });

  it("a login is one operation per method: the same method joins, another takes its turn", async () => {
    const { gates, queue, ran, finish } = gated();
    const work = [gates.login("a" as PatchbayAgentId, "browser"), gates.login("a" as PatchbayAgentId, "browser"), gates.login("a" as PatchbayAgentId, "terminal")];
    await tick();
    expect(queue.held("a" as PatchbayAgentId)).toEqual(["login", "login"]);
    finish("login:browser");
    await tick();
    expect(ran).toEqual(["login:browser", "login:terminal"]);
    finish("login:terminal");
    await Promise.all(work);
  });

  it("agents never wait on each other", async () => {
    const { gates, ran, finish } = gated();
    const work = [gates.connect("a" as PatchbayAgentId), gates.connect("b" as PatchbayAgentId)];
    await tick();
    expect(ran).toEqual(["connect", "connect"]);
    finish("connect");
    await Promise.all(work);
  });
});

describe("the one question before a connection ends", () => {
  it("nothing in hand: Stop, Upgrade and Log out just run — Remove still asks, since it also forgets", () => {
    const none = { conversations: 0, turns: 0 };
    expect(endQuestion("stop", "Claude", none)).toBeNull();
    expect(endQuestion("upgrade", "Claude", none)).toBeNull();
    expect(endQuestion("logout", "Claude", none)).toBeNull();
    expect(endQuestion("remove", "Claude", none)).toEqual({
      message: "Remove Claude? Patchbay forgets the agent: its config, env and capability cache.",
      choice: "Remove",
    });
  });

  it("work in hand: one question with the counts, saying what each one does", () => {
    const work = { conversations: 2, turns: 1 };
    const cut = "2 open conversations — 1 still running and will be cut off";
    expect(endQuestion("stop", "Claude", work)).toEqual({ message: `Stop Claude? It disconnects ${cut}.`, choice: "Stop" });
    expect(endQuestion("upgrade", "Claude", work)?.message).toBe(`Upgrade Claude? It restarts the agent, disconnecting ${cut}.`);
    expect(endQuestion("logout", "Claude", work)).toEqual({
      message: `Log out of Claude? It signs the agent out and stops it, disconnecting ${cut}.`,
      choice: "Log out",
    });
    expect(endQuestion("remove", "Claude", work)?.message).toBe(
      `Remove Claude? It disconnects ${cut}. Patchbay forgets the agent: its config, env and capability cache.`,
    );
    expect(endQuestion("stop", "Claude", { conversations: 1, turns: 0 })?.message).toBe(
      "Stop Claude? It disconnects 1 open conversation.",
    );
  });

  it("Stop asks before it cuts in — declined, nothing is cut and the agent's work runs on", async () => {
    const user = asking();
    const { gates, queue, ran, signals, finish } = gated(user.asks);
    const connect = gates.connect("a" as PatchbayAgentId);
    await tick();
    const stop = gates.stop("a" as PatchbayAgentId);
    await tick();
    expect(user.asked).toEqual(["Stop Agent a? It disconnects 2 open conversations — 1 still running and will be cut off."]);
    expect(ran).toEqual(["connect"]);
    user.answer(false);
    await stop;
    expect(signals.get("connect")?.aborted).toBe(false);
    expect(queue.held("a" as PatchbayAgentId)).toEqual(["connect"]);
    finish("connect");
    await connect;
  });

  it("Stop answered yes cuts in at once", async () => {
    const user = asking();
    const { gates, ran, finish } = gated(user.asks);
    const stop = gates.stop("a" as PatchbayAgentId);
    await tick();
    user.answer(true);
    await tick();
    expect(ran).toEqual(["stop", "stop"]);
    finish("stop");
    await stop;
  });

  it("Remove asks with nothing in hand too — declined, the agent stays", async () => {
    const user = asking({ conversations: 0, turns: 0 });
    const { gates, ran } = gated(user.asks);
    const remove = gates.remove("a" as PatchbayAgentId);
    await tick();
    expect(user.asked).toEqual(["Remove Agent a? Patchbay forgets the agent: its config, env and capability cache."]);
    user.answer(false);
    await remove;
    expect(ran).toEqual([]);
  });

  it("Log out asks when its turn comes — the counts it would cut off, then", async () => {
    const user = asking();
    const { gates, ran, finish } = gated(user.asks);
    const restart = gates.restart("a" as PatchbayAgentId);
    const logout = gates.logout("a" as PatchbayAgentId);
    await tick();
    expect(user.asked).toEqual([]);
    finish("restart");
    await restart;
    await tick();
    expect(user.asked).toHaveLength(1);
    user.answer(true);
    await tick();
    expect(ran).toEqual(["restart", "logout"]);
    finish("logout");
    await logout;
  });

  it("Upgrade hands the store its go-ahead: the question is asked only if the store would stop a running agent", async () => {
    const user = asking();
    const { gates, consents, finish } = gated(user.asks);
    const upgrade = gates.upgrade("a" as PatchbayAgentId);
    await tick();
    expect(user.asked).toEqual([]);
    const agreed = consents[0]!();
    await tick();
    expect(user.asked[0]).toMatch(/^Upgrade Agent a\? It restarts the agent/);
    user.answer(true);
    expect(await agreed).toBe(true);
    finish("upgrade");
    await upgrade;
  });
});
