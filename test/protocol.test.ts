// P1 gate: reducer determinism and revision-gap recovery are pure and provable.
import { describe, expect, it } from "vitest";
import {
  applyHostMessage,
  initialAgentViewState,
  reduceAgentView,
  type AgentSummary,
  type AgentViewEvent,
  type AgentViewState,
} from "../src/shared/protocol";

const claude: AgentSummary = { id: "claude", name: "Claude Code", status: "running" };
const gemini: AgentSummary = { id: "gemini", name: "Gemini CLI", status: "stopped" };

const events: AgentViewEvent[] = [
  { kind: "agentUpserted", agent: claude },
  { kind: "agentUpserted", agent: gemini },
  { kind: "agentStatusChanged", agentId: "gemini", status: "running" },
  { kind: "agentRemoved", agentId: "claude" },
];

function replay(state: AgentViewState, evs: AgentViewEvent[]): AgentViewState {
  return evs.reduce(reduceAgentView, state);
}

describe("reducers", () => {
  it("are deterministic: same events, same result", () => {
    expect(replay(initialAgentViewState, events)).toEqual(
      replay(initialAgentViewState, events),
    );
  });

  it("never mutate their input", () => {
    const before = structuredClone(initialAgentViewState);
    replay(initialAgentViewState, events);
    expect(initialAgentViewState).toEqual(before);
  });

  it("upsert replaces in place, keeping order", () => {
    const s1 = replay(initialAgentViewState, [
      { kind: "agentUpserted", agent: claude },
      { kind: "agentUpserted", agent: gemini },
      { kind: "agentUpserted", agent: { ...claude, status: "crashed" } },
    ]);
    expect(s1.agents.map((a) => a.id)).toEqual(["claude", "gemini"]);
    expect(s1.agents[0]?.status).toBe("crashed");
  });
});

describe("applyHostMessage", () => {
  const reduce = reduceAgentView;

  it("hydrates from a snapshot", () => {
    const r = applyHostMessage(reduce, null, {
      kind: "snapshot",
      rev: 7,
      state: { agents: [claude] },
    });
    expect(r).toEqual({ kind: "ok", next: { rev: 7, state: { agents: [claude] } } });
  });

  it("applies a consecutive patch", () => {
    const r = applyHostMessage(
      reduce,
      { rev: 7, state: { agents: [claude] } },
      { kind: "patch", rev: 8, events: [{ kind: "agentUpserted", agent: gemini }] },
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.next.rev).toBe(8);
      expect(r.next.state.agents).toHaveLength(2);
    }
  });

  it("reports a gap on a revision jump — recovery is resnapshot, never repair", () => {
    const r = applyHostMessage(
      reduce,
      { rev: 7, state: { agents: [] } },
      { kind: "patch", rev: 9, events: [] },
    );
    expect(r.kind).toBe("gap");
  });

  it("reports a gap for a patch before any snapshot", () => {
    const r = applyHostMessage(reduce, null, { kind: "patch", rev: 1, events: [] });
    expect(r.kind).toBe("gap");
  });

  it("ignores stale patches and stale snapshots", () => {
    const current = { rev: 7, state: { agents: [] } };
    expect(
      applyHostMessage(reduce, current, { kind: "patch", rev: 7, events: [] }).kind,
    ).toBe("stale");
    expect(
      applyHostMessage(reduce, current, { kind: "snapshot", rev: 3, state: { agents: [] } }).kind,
    ).toBe("stale");
  });
});
