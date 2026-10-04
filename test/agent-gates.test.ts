// The agents' gates (agent-gates.ts) over a stub store: connection work
// takes its turn in the queue and a repeat joins it, Stop and Remove pass
// at once, and a login is one operation per method — the store's own
// operations stay plain, so every one of these rules is the gates'.
import { describe, expect, it } from "vitest";
import { AgentGates, type AgentTurn } from "../src/orchestrator/agent-gates";
import type { ConnectionOperations } from "../src/orchestrator/agents-store";
import { Queue } from "../src/orchestrator/queue";

/** A store whose operations each wait for the test to let them finish,
 * recording what ran. */
function stubStore() {
  const ran: string[] = [];
  const pending: Array<() => void> = [];
  const op = (name: string) => () => {
    ran.push(name);
    return new Promise<void>((resolve) => pending.push(resolve));
  };
  const store: ConnectionOperations = {
    connect: op("connect"),
    restart: op("restart"),
    upgrade: op("upgrade"),
    login: (_agentId, methodId) => op(`login:${methodId}`)(),
    logout: op("logout"),
    verify: () => op("verify")().then(() => "ok" as const),
    stop: op("stop"),
    remove: op("remove"),
  };
  /** Lets the oldest running operation finish. */
  const finish = () => pending.shift()?.();
  return { store, ran, finish };
}

const tick = () => new Promise((r) => setImmediate(r));

function gated() {
  const { store, ran, finish } = stubStore();
  const queue = new Queue<AgentTurn>(() => {});
  return { gates: new AgentGates(store, queue), queue, ran, finish };
}

describe("AgentGates", () => {
  it("connection work takes its turn on the agent, in arrival order", async () => {
    const { gates, ran, finish } = gated();
    void gates.connect("a");
    void gates.upgrade("a");
    void gates.verify("a");
    await tick();
    expect(ran).toEqual(["connect"]);
    finish();
    await tick();
    expect(ran).toEqual(["connect", "upgrade"]);
    finish();
    await tick();
    expect(ran).toEqual(["connect", "upgrade", "verify"]);
    finish();
  });

  it("a repeat of an operation held joins it", async () => {
    const { gates, ran, finish } = gated();
    const first = gates.upgrade("a");
    const second = gates.upgrade("a");
    await tick();
    finish();
    await Promise.all([first, second]);
    expect(ran).toEqual(["upgrade"]);
  });

  it("Stop and Remove pass at once — never behind held work, never held", async () => {
    const { gates, queue, ran, finish } = gated();
    void gates.connect("a");
    await tick();
    void gates.stop("a");
    void gates.remove("a");
    expect(ran).toEqual(["connect", "stop", "remove"]);
    expect(queue.held("a")).toEqual(["connect"]);
    finish();
    finish();
    finish();
  });

  it("a login is one operation per method: the same method joins, another takes its turn", async () => {
    const { gates, queue, ran, finish } = gated();
    void gates.login("a", "browser");
    void gates.login("a", "browser");
    void gates.login("a", "terminal");
    await tick();
    expect(queue.held("a")).toEqual(["login", "login"]);
    finish();
    await tick();
    expect(ran).toEqual(["login:browser", "login:terminal"]);
    finish();
  });

  it("agents never wait on each other", async () => {
    const { gates, ran, finish } = gated();
    void gates.connect("a");
    void gates.connect("b");
    await tick();
    expect(ran).toEqual(["connect", "connect"]);
    finish();
    finish();
  });
});
