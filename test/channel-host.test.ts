// ChannelHost against a fake webview: ready → snapshot, patches carry
// consecutive revs, resnapshot after gap, snapshot discards buffered events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLUSH_INTERVAL_MS } from "../src/orchestrator/bus";
import { ChannelHost, type WebviewLike } from "../src/orchestrator/channel";
import {
  coalesceAgentViewEvent,
  initialAgentViewState,
  reduceAgentView,
  type AgentViewEvent,
  type AgentViewState,
  type HostToView,
} from "../src/shared/protocol";

class FakeWebview implements WebviewLike {
  messages: HostToView<AgentViewState, AgentViewEvent>[] = [];
  postMessage(message: unknown): Thenable<boolean> {
    this.messages.push(message as HostToView<AgentViewState, AgentViewEvent>);
    return Promise.resolve(true);
  }
  last(): HostToView<AgentViewState, AgentViewEvent> | undefined {
    return this.messages[this.messages.length - 1];
  }
}

function makeHost() {
  const actions: unknown[] = [];
  const host = new ChannelHost<AgentViewState, AgentViewEvent>(
    initialAgentViewState,
    reduceAgentView,
    coalesceAgentViewEvent,
    (a) => actions.push(a),
  );
  return { host, actions };
}

const upsert = (id: string): AgentViewEvent => ({
  kind: "agentUpserted",
  agent: { id, name: id, status: "running", needsAuth: false },
});

describe("ChannelHost", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("responds to ready with a snapshot of canonical state", () => {
    const { host } = makeHost();
    host.emit(upsert("claude"));
    host.flushNow();

    const view = new FakeWebview();
    host.attach(view);
    host.handleViewMessage({ kind: "ready" });

    expect(view.last()).toEqual({
      kind: "snapshot",
      rev: 1,
      state: {
        ...initialAgentViewState,
        agents: [{ id: "claude", name: "claude", status: "running", needsAuth: false }],
      },
    });
  });

  it("sends patches with consecutive revisions", () => {
    const { host } = makeHost();
    const view = new FakeWebview();
    host.attach(view);
    host.handleViewMessage({ kind: "ready" });

    host.emit(upsert("a"));
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    host.emit(upsert("b"));
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    const patches = view.messages.filter((m) => m.kind === "patch");
    expect(patches.map((p) => p.rev)).toEqual([1, 2]);
  });

  it("a snapshot request discards buffered events — no double apply", () => {
    const { host } = makeHost();
    const view = new FakeWebview();
    host.attach(view);

    host.emit(upsert("a")); // buffered, not yet flushed
    host.handleViewMessage({ kind: "ready" }); // snapshot folds it in

    const snap = view.last();
    expect(snap?.kind).toBe("snapshot");
    if (snap?.kind === "snapshot") expect(snap.state.agents).toHaveLength(1);

    vi.advanceTimersByTime(FLUSH_INTERVAL_MS * 2);
    expect(view.messages.filter((m) => m.kind === "patch")).toHaveLength(0);

    // next event patches at rev+1 relative to the snapshot
    host.emit(upsert("b"));
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    const patch = view.last();
    expect(patch?.kind).toBe("patch");
    if (patch?.kind === "patch") expect(patch.rev).toBe(snap!.rev + 1);
  });

  it("resnapshot (gap recovery) sends a fresh snapshot", () => {
    const { host } = makeHost();
    const view = new FakeWebview();
    host.attach(view);
    host.handleViewMessage({ kind: "ready" });

    host.emit(upsert("a"));
    host.flushNow();
    host.handleViewMessage({ kind: "resnapshot" });

    const snap = view.last();
    expect(snap?.kind).toBe("snapshot");
    if (snap?.kind === "snapshot") {
      expect(snap.rev).toBe(1);
      expect(snap.state.agents).toHaveLength(1);
    }
  });

  it("canonical revision advances while no webview is attached; remount rehydrates", () => {
    const { host } = makeHost();
    host.emit(upsert("a"));
    host.flushNow();
    host.emit(upsert("b"));
    host.flushNow();
    expect(host.revision).toBe(2);

    const view = new FakeWebview();
    host.attach(view);
    host.handleViewMessage({ kind: "ready" });
    const snap = view.last();
    expect(snap?.kind).toBe("snapshot");
    if (snap?.kind === "snapshot") {
      expect(snap.rev).toBe(2);
      expect(snap.state.agents).toHaveLength(2);
    }
  });

  it("routes actions to the handler and resolves waitForApplied on ack", async () => {
    const { host, actions } = makeHost();
    host.handleViewMessage({ kind: "action", action: { kind: "openSettings" } });
    expect(actions).toEqual([{ kind: "openSettings" }]);

    host.emit(upsert("a"));
    host.flushNow();
    const wait = host.waitForApplied(1);
    host.handleViewMessage({ kind: "applied", rev: 1 });
    await expect(wait).resolves.toBe(1);
  });

  it("onChange fires on every emit, independent of any webview attachment (P11 native surfaces)", () => {
    const { host } = makeHost();
    let calls = 0;
    const unsubscribe = host.onChange(() => calls++);
    host.emit(upsert("a"));
    host.emit(upsert("b"));
    expect(calls).toBe(2);
    unsubscribe();
    host.emit(upsert("c"));
    expect(calls).toBe(2);
  });
});
