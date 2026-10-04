// The queue's three rules per row (queue.ts): a request for an operation
// the row holds joins it, anything else takes its turn in arrival order
// whatever the one before it did, and rows never wait on each other — with
// every move of a row's holdings reported.
import { describe, expect, it } from "vitest";
import { Queue } from "../src/orchestrator/queue";

/** A body the test settles by hand, counting how often it started. */
function gate<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const settled = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const g = {
    starts: 0,
    body: () => {
      g.starts++;
      return settled;
    },
    resolve,
    reject,
  };
  return g;
}

const tick = () => new Promise((r) => setImmediate(r));

describe("Queue", () => {
  it("joins a request for the operation the row holds — one run, one outcome", async () => {
    const q = new Queue<"connect">(() => {});
    const g = gate<string>();
    const first = q.run("a", "connect", g.body);
    const second = q.run("a", "connect", g.body);
    await tick();
    g.resolve("up");
    expect(await first).toBe("up");
    expect(await second).toBe("up");
    expect(g.starts).toBe(1);
  });

  it("joins an operation still waiting its turn, too", async () => {
    const q = new Queue<"connect" | "verify">(() => {});
    const running = gate();
    const waiting = gate();
    void q.run("a", "connect", running.body);
    const first = q.run("a", "verify", waiting.body);
    const second = q.run("a", "verify", waiting.body);
    expect(q.held("a")).toEqual(["connect", "verify"]);
    running.resolve();
    await tick();
    waiting.resolve();
    await Promise.all([first, second]);
    expect(waiting.starts).toBe(1);
  });

  it("runs other operations in arrival order, each once the one before has settled — failed or not", async () => {
    const q = new Queue<"connect" | "upgrade" | "verify">(() => {});
    const order: string[] = [];
    const connect = gate();
    const upgrade = gate();
    const c = q.run("a", "connect", () => (order.push("connect"), connect.body()));
    const u = q.run("a", "upgrade", () => (order.push("upgrade"), upgrade.body()));
    const v = q.run("a", "verify", async () => void order.push("verify"));
    await tick();
    expect(order).toEqual(["connect"]);
    connect.reject(new Error("spawn failed"));
    await expect(c).rejects.toThrow("spawn failed");
    await tick();
    expect(order).toEqual(["connect", "upgrade"]);
    upgrade.resolve();
    await Promise.all([u, v]);
    expect(order).toEqual(["connect", "upgrade", "verify"]);
  });

  it("a joined failure reaches every caller", async () => {
    const q = new Queue<"connect">(() => {});
    const g = gate();
    const first = q.run("a", "connect", g.body);
    const second = q.run("a", "connect", g.body);
    g.reject(new Error("initialize failed"));
    await expect(first).rejects.toThrow("initialize failed");
    await expect(second).rejects.toThrow("initialize failed");
  });

  it("keeps rows apart: one row's running work never holds another's", async () => {
    const q = new Queue<"connect">(() => {});
    const a = gate();
    void q.run("a", "connect", a.body);
    let bDone = false;
    await q.run("b", "connect", async () => void (bDone = true));
    expect(bDone).toBe(true);
    expect(q.held("a")).toEqual(["connect"]);
    a.resolve();
  });

  it("an identity parameter keeps two of one kind apart — each takes its turn", async () => {
    const q = new Queue<"login">(() => {});
    const first = gate();
    const second = gate();
    const one = q.run("a", "login", first.body, "login:browser");
    const two = q.run("a", "login", second.body, "login:terminal");
    expect(q.held("a")).toEqual(["login", "login"]);
    await tick();
    expect([first.starts, second.starts]).toEqual([1, 0]);
    first.resolve();
    await one;
    await tick();
    expect(second.starts).toBe(1);
    second.resolve();
    await two;
  });

  it("reports every move of a row's holdings; an idle row holds nothing", async () => {
    const moves: string[][] = [];
    const q = new Queue<"connect" | "verify">((row) => moves.push(q.held(row)));
    const g = gate();
    const c = q.run("a", "connect", g.body);
    const v = q.run("a", "verify", async () => {});
    g.resolve();
    await Promise.all([c, v]);
    await tick();
    expect(moves).toEqual([["connect"], ["connect", "verify"], ["verify"], []]);
    expect(q.held("a")).toEqual([]);
  });
});
