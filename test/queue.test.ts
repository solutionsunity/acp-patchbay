// The queue's rules per row (queue.ts): a request for an operation the row
// holds joins it, anything else takes its turn in arrival order whatever
// the one before it did, one that cuts in ends the row's work first, and
// rows never wait on each other — with every move of a row's holdings
// reported.
import { describe, expect, it } from "vitest";
import { Cancelled, Queue } from "../src/orchestrator/queue";

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
    // The outcome is heard once the row no longer holds the operation.
    expect(q.held("a")).toEqual([]);
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

describe("Queue — cutting in", () => {
  type Work = "connect" | "verify" | "upgrade" | "stop" | "remove";

  it("tells the running operation to stop and drops the waiting ones — each settles as Cancelled at once", async () => {
    const q = new Queue<Work>(() => {});
    const running = gate();
    const waiting = gate();
    let signal: AbortSignal | undefined;
    const connect = q.run("a", "connect", (s) => ((signal = s), running.body()));
    const verify = q.run("a", "verify", waiting.body);
    await tick();
    const stop = gate();
    const cut = q.cut("a", "stop", stop.body);
    expect(signal?.aborted).toBe(true);
    await expect(connect).rejects.toThrow(Cancelled);
    await expect(connect).rejects.toThrow("cancelled by stop");
    await expect(verify).rejects.toThrow(Cancelled);
    // The cut-in runs once what it cut has unwound — not before.
    await tick();
    expect(stop.starts).toBe(0);
    running.reject(new Error("aborted"));
    await tick();
    expect(stop.starts).toBe(1);
    expect(waiting.starts).toBe(0);
    stop.resolve();
    await cut;
  });

  it("a dropped operation leaves the row at once; the cut running one stays until it has unwound", async () => {
    const moves: string[][] = [];
    const q = new Queue<Work>((row) => moves.push(q.held(row)));
    const running = gate();
    void q.run("a", "connect", running.body).catch(() => {});
    void q.run("a", "verify", async () => {}).catch(() => {});
    await tick();
    expect(q.windingDown("a")).toBe(false);
    const stop = q.cut("a", "stop", async () => {});
    await tick();
    expect(q.held("a")).toEqual(["connect", "stop"]);
    expect(q.windingDown("a")).toBe(true);
    running.resolve();
    await stop;
    await tick();
    expect(q.windingDown("a")).toBe(false);
    expect(moves).toEqual([
      ["connect"],
      ["connect", "verify"],
      ["connect", "verify"], // the running one told to stop: it winds down
      ["connect", "verify", "stop"],
      ["connect", "stop"],
      ["stop"],
      [],
    ]);
  });

  it("an operation once cut is not joined: asked for again, it is a new one, in its turn", async () => {
    const q = new Queue<Work>(() => {});
    const first = gate();
    const second = gate();
    const cut = q.run("a", "connect", first.body);
    await tick();
    void q.cut("a", "stop", async () => {});
    const again = q.run("a", "connect", second.body);
    await expect(cut).rejects.toThrow(Cancelled);
    first.reject(new Error("aborted"));
    await tick();
    expect(second.starts).toBe(1);
    second.resolve();
    await again;
  });

  it("what cuts in is never cut: a later cut-in takes its turn behind it, and a repeat joins it", async () => {
    const q = new Queue<Work>(() => {});
    const stop = gate();
    const remove = gate();
    const first = q.cut("a", "stop", stop.body);
    const repeat = q.cut("a", "stop", stop.body);
    const removed = q.cut("a", "remove", remove.body);
    expect(q.held("a")).toEqual(["stop", "remove"]);
    await tick();
    expect([stop.starts, remove.starts]).toEqual([1, 0]);
    stop.resolve();
    await Promise.all([first, repeat]);
    await tick();
    expect(remove.starts).toBe(1);
    remove.resolve();
    await removed;
  });

  it("cutAll ends every row's work and settles once all of it has left", async () => {
    const q = new Queue<Work>(() => {});
    const a = gate();
    const signals: AbortSignal[] = [];
    const ran = q.run("a", "connect", (s) => (signals.push(s), a.body()));
    const waits = q.run("a", "upgrade", async () => {});
    const b = q.run("b", "verify", (s) => (signals.push(s), new Promise<void>((resolve) => s.addEventListener("abort", () => resolve()))));
    await tick();
    let settled = false;
    const all = q.cutAll("stop").then(() => (settled = true));
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    await expect(ran).rejects.toThrow(Cancelled);
    await expect(waits).rejects.toThrow(Cancelled);
    await expect(b).rejects.toThrow(Cancelled);
    await tick();
    expect(settled).toBe(false);
    a.reject(new Error("aborted"));
    await all;
    expect([q.held("a"), q.held("b")]).toEqual([[], []]);
  });

  it("end stops one row's work, says who ended it, runs nothing after, and settles once it has left", async () => {
    const q = new Queue<Work>(() => {});
    const a = gate();
    const signals: AbortSignal[] = [];
    const ran = q.run("a", "connect", (s) => (signals.push(s), a.body()));
    const waits = q.run("a", "upgrade", async () => {});
    const other = gate();
    const elsewhere = q.run("b", "connect", other.body);
    await tick();
    let settled = false;
    const ended = q.end("a", "reload").then(() => (settled = true));
    expect(signals.map((s) => s.aborted)).toEqual([true]);
    await expect(ran).rejects.toMatchObject({ by: "reload" });
    await expect(waits).rejects.toThrow(Cancelled);
    await tick();
    expect(settled).toBe(false); // the running one is still unwinding
    a.reject(new Error("aborted"));
    await ended;
    expect(q.held("a")).toEqual([]);
    expect(q.held("b")).toEqual(["connect"]); // another row is not this end's
    other.resolve();
    await elsewhere;
  });

  it("an operation can wait for work on another row: it takes its turn once that has settled too", async () => {
    const q = new Queue<Work>(() => {});
    const elsewhere = gate();
    void q.run("b", "connect", elsewhere.body);
    const mine = gate();
    const done = q.run("a", "verify", mine.body, "verify", q.settled("b"));
    await tick();
    expect(mine.starts).toBe(0); // its own row is idle, but b is not
    elsewhere.resolve();
    await tick();
    await tick();
    expect(mine.starts).toBe(1);
    mine.resolve();
    await done;
  });

  it("settled is already settled for an idle row, and waits only for what the row holds when asked", async () => {
    const q = new Queue<Work>(() => {});
    await q.settled("idle");
    const first = gate();
    void q.run("a", "connect", first.body);
    const settled = q.settled("a");
    const later = gate();
    void q.run("a", "verify", later.body);
    let heard = false;
    void settled.then(() => (heard = true));
    first.resolve();
    await tick();
    await tick();
    expect(heard).toBe(true); // the later one, still running, is not waited for
    later.resolve();
  });
});
