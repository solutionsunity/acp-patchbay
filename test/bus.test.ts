// P1 gate: coalescing — one flush per interval, merge hook honored.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoalescingBus, FLUSH_INTERVAL_MS } from "../src/orchestrator/bus";
import type { CoalesceHook } from "../src/shared/protocol";

type TestEvent =
  | { kind: "delta"; id: string; text: string }
  | { kind: "other" };

const mergeDeltas: CoalesceHook<TestEvent> = (prev, next) =>
  prev.kind === "delta" && next.kind === "delta" && prev.id === next.id
    ? { kind: "delta", id: prev.id, text: prev.text + next.text }
    : null;

describe("CoalescingBus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flushes once per interval, concatenating text chunks per message", () => {
    const flushes: TestEvent[][] = [];
    const bus = new CoalescingBus<TestEvent>((e) => flushes.push(e), mergeDeltas);

    bus.emit({ kind: "delta", id: "m1", text: "Hel" });
    bus.emit({ kind: "delta", id: "m1", text: "lo " });
    bus.emit({ kind: "delta", id: "m1", text: "world" });
    expect(flushes).toHaveLength(0);

    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(flushes).toEqual([[{ kind: "delta", id: "m1", text: "Hello world" }]]);
  });

  it("does not merge across different messages or kinds", () => {
    const flushes: TestEvent[][] = [];
    const bus = new CoalescingBus<TestEvent>((e) => flushes.push(e), mergeDeltas);

    bus.emit({ kind: "delta", id: "m1", text: "a" });
    bus.emit({ kind: "other" });
    bus.emit({ kind: "delta", id: "m2", text: "b" });
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(flushes[0]).toHaveLength(3);
  });

  it("flushNow flushes immediately (turn boundary)", () => {
    const flushes: TestEvent[][] = [];
    const bus = new CoalescingBus<TestEvent>((e) => flushes.push(e), mergeDeltas);

    bus.emit({ kind: "other" });
    bus.flushNow();
    expect(flushes).toHaveLength(1);

    // timer was cleared — no double flush
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS * 2);
    expect(flushes).toHaveLength(1);
  });

  it("discard drops the buffer without flushing", () => {
    const flushes: TestEvent[][] = [];
    const bus = new CoalescingBus<TestEvent>((e) => flushes.push(e), mergeDeltas);

    bus.emit({ kind: "other" });
    bus.discard();
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS * 2);
    expect(flushes).toHaveLength(0);
  });

  it("starts a fresh window after each flush", () => {
    const flushes: TestEvent[][] = [];
    const bus = new CoalescingBus<TestEvent>((e) => flushes.push(e), mergeDeltas);

    bus.emit({ kind: "delta", id: "m1", text: "a" });
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    bus.emit({ kind: "delta", id: "m1", text: "b" });
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(flushes).toEqual([
      [{ kind: "delta", id: "m1", text: "a" }],
      [{ kind: "delta", id: "m1", text: "b" }],
    ]);
  });
});
