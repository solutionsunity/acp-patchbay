// P1 gate: reducer determinism and revision-gap recovery are pure and provable.
import { describe, expect, it } from "vitest";
import { assertKind } from "./support/assert-kind";
import {
  applyHostMessage,
  coalesceAgentViewEvent,
  initialAgentViewState,
  initialSettingsState,
  reduceAgentView,
  reduceSettings,
  type AgentSummary,
  type AgentViewEvent,
  type AgentViewState,
  type SettingsEvent,
} from "../src/shared/protocol";

const claude: AgentSummary = { id: "claude", name: "Claude Code", status: "running", needsAuth: false };
const gemini: AgentSummary = { id: "gemini", name: "Gemini CLI", status: "stopped", needsAuth: false };

const events: AgentViewEvent[] = [
  { kind: "agentUpserted", agent: claude },
  { kind: "agentUpserted", agent: gemini },
  { kind: "agentStatusChanged", agentId: "gemini", status: "running" },
  { kind: "agentRemoved", agentId: "claude" },
];

function replay(state: AgentViewState, evs: AgentViewEvent[]): AgentViewState {
  return evs.reduce(reduceAgentView, state);
}

/** State literal helper — tests only care about the agents slice here. */
function stateWith(agents: AgentSummary[]): AgentViewState {
  return { ...initialAgentViewState, agents };
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

  // QC (post-P18): per-agent facts leave with their agent — a snapshot must
  // not carry capability/auth/knob entries for an agent that no longer
  // exists (invisible to renderers, which key off the agents list, but a
  // ghost all the same — and erase-to-factory-state made it matter).
  it("agentRemoved takes the agent's per-agent facts with it", () => {
    const declared = {
      kind: "capabilitiesDeclared",
      agentId: "claude",
      matrix: {} as never,
      authMethods: [],
      at: "2026-01-01T00:00:00Z",
    } as const;

    const view = replay(stateWith([claude]), [declared, { kind: "agentRemoved", agentId: "claude" }]);
    expect(view.agents).toEqual([]);
    expect(view.capabilities).toEqual({});
    expect(view.authMethods).toEqual({});

    const settings = [
      { kind: "agentUpserted", agent: claude } as const,
      declared,
      { kind: "agentVerifyStarted", agentId: "claude" } as const,
      { kind: "agentKnobsObserved", agentId: "claude", knobs: { knobs: [] } } as const,
      { kind: "agentRemoved", agentId: "claude" } as const,
    ].reduce(reduceSettings, initialSettingsState);
    expect(settings.agents).toEqual([]);
    expect(settings.capabilities).toEqual({});
    expect(settings.authMethods).toEqual({});
    expect(settings.agentKnobs).toEqual({});
    expect(settings.verifyingAgents).toEqual({});
  });

  // P17: the in-pane connect lifecycle — started → connecting pane,
  // failed → reason + retry, and the session arriving clears it (reducer-
  // level, so it can't desync from reality); dismiss clears a failure.
  it("chatConnect: connecting → failed → cleared by sessionCreated or dismissal", () => {
    const connecting = replay(initialAgentViewState, [
      { kind: "chatConnectStarted", agentId: "claude" },
    ]);
    expect(connecting.chatConnect).toEqual({ agentId: "claude", status: "connecting" });

    const failed = replay(connecting, [
      { kind: "chatConnectFailed", agentId: "claude", reason: "spawn failed: ENOENT" },
    ]);
    expect(failed.chatConnect?.status).toBe("failed");
    expect(failed.chatConnect?.reason).toBe("spawn failed: ENOENT");

    const dismissed = replay(failed, [{ kind: "chatConnectResolved" }]);
    expect(dismissed.chatConnect).toBeNull();

    const succeeded = replay(connecting, [
      {
        kind: "sessionCreated",
        session: { id: "s1", agentId: "claude", title: "t", live: false, updatedAt: "2026-07-09T00:00:00Z" },
      },
    ]);
    expect(succeeded.chatConnect).toBeNull();
    expect(succeeded.activeSessionId).toBe("s1");
  });

  it("chatConnect carries forSessionId through connecting and failed — the Retry-as-same-click hook", () => {
    const connecting = replay(initialAgentViewState, [
      { kind: "chatConnectStarted", agentId: "claude", forSessionId: "s9" },
    ]);
    expect(connecting.chatConnect?.forSessionId).toBe("s9");
    const failed = replay(connecting, [
      { kind: "chatConnectFailed", agentId: "claude", reason: "spawn failed", forSessionId: "s9" },
    ]);
    expect(failed.chatConnect?.forSessionId).toBe("s9");
  });

  // Startup restore hold: seeded true by the orchestrator when a
  // last-active pointer exists; startupSettled is the only clear — the
  // loading page must never outlive the startup sequence.
  it("startupSettled clears the restore hold", () => {
    const restoring = { ...initialAgentViewState, restoring: true };
    expect(replay(restoring, [{ kind: "startupSettled" }]).restoring).toBe(false);
    // idempotent from the ground state too
    expect(replay(initialAgentViewState, [{ kind: "startupSettled" }]).restoring).toBe(false);
  });

  // P16: crash carries the process's last words; recovery clears them —
  // stale stderr on a running agent would be a lie.
  it("status change carries stderr on crash and clears it on recovery", () => {
    const crashed = replay(stateWith([claude]), [
      { kind: "agentStatusChanged", agentId: "claude", status: "crashed", detail: "exited 1", stderr: ["boom"] },
    ]);
    expect(crashed.agents[0]?.stderr).toEqual(["boom"]);

    const recovered = replay(crashed, [
      { kind: "agentStatusChanged", agentId: "claude", status: "running" },
    ]);
    expect(recovered.agents[0]?.stderr).toBeUndefined();
    expect(recovered.agents[0]?.detail).toBeUndefined();
  });
});

describe("live editor context (ui.md — ghost chip / @ mention sources)", () => {
  it("editorContextChanged replaces selection and open editors wholesale", () => {
    const s = replay(initialAgentViewState, [
      {
        kind: "editorContextChanged",
        selection: { file: "/ws/a.ts", startLine: 3, endLine: 9 },
        openEditors: [{ file: "/ws/a.ts", dirty: true }],
      },
      { kind: "editorContextChanged", selection: null, openEditors: [] },
    ]);
    expect(s.liveSelection).toBeNull();
    expect(s.openEditors).toEqual([]);
  });

  it("coalesces to the latest — cursor moves must not queue up", () => {
    const a: AgentViewEvent = {
      kind: "editorContextChanged",
      selection: { file: "/ws/a.ts", startLine: 1, endLine: 1 },
      openEditors: [],
    };
    const b: AgentViewEvent = { kind: "editorContextChanged", selection: null, openEditors: [] };
    expect(coalesceAgentViewEvent(a, b)).toBe(b);
  });
});

describe("plan strip mirrors only what the agent reports", () => {
  it("transcriptReset clears the live plan — replay rebuilds it or it stays absent", () => {
    const s = replay(initialAgentViewState, [
      {
        kind: "planUpdated",
        sessionId: "s1",
        entries: [{ content: "step", status: "in_progress" }],
      },
      { kind: "transcriptReset", sessionId: "s1" },
    ]);
    expect(s.activePlan.s1).toBeNull();
    expect(s.transcripts.s1).toEqual([]);
  });
});

describe("settings projections (ui.md § Settings Agents)", () => {
  it("sessionStatsChanged and agentKnobsObserved land in settings state", () => {
    const events: SettingsEvent[] = [
      { kind: "sessionStatsChanged", sessionsToday: 3 },
      {
        kind: "agentKnobsObserved",
        agentId: "claude",
        knobs: {
          knobs: [
            { id: "model", name: "Model", category: "model", type: "select", values: [{ value: "s", name: "Sonnet" }] },
          ],
        },
      },
    ];
    const s = events.reduce(reduceSettings, initialSettingsState);
    expect(s.sessionsToday).toBe(3);
    expect(s.agentKnobs.claude!.knobs[0]!.category).toBe("model");
  });

  it("agentVerifyStarted/Finished track exactly the in-flight agents", () => {
    const s1 = [
      { kind: "agentVerifyStarted", agentId: "claude" } as const,
      { kind: "agentVerifyStarted", agentId: "gemini" } as const,
    ].reduce(reduceSettings, initialSettingsState);
    expect(s1.verifyingAgents).toEqual({ claude: true, gemini: true });

    const s2 = reduceSettings(s1, { kind: "agentVerifyFinished", agentId: "claude" });
    expect(s2.verifyingAgents).toEqual({ gemini: true });
    expect(s2.verifyingAgents.claude).toBeUndefined();
  });
});

describe("applyHostMessage", () => {
  const reduce = reduceAgentView;

  it("hydrates from a snapshot", () => {
    const r = applyHostMessage(reduce, null, {
      kind: "snapshot",
      rev: 7,
      state: stateWith([claude]),
    });
    expect(r).toEqual({ kind: "ok", next: { rev: 7, state: stateWith([claude]) } });
  });

  it("applies a consecutive patch", () => {
    const r = applyHostMessage(
      reduce,
      { rev: 7, state: stateWith([claude]) },
      { kind: "patch", rev: 8, events: [{ kind: "agentUpserted", agent: gemini }] },
    );
    const ok = assertKind(r, "ok");
    expect(ok.next.rev).toBe(8);
    expect(ok.next.state.agents).toHaveLength(2);
  });

  it("reports a gap on a revision jump — recovery is resnapshot, never repair", () => {
    const r = applyHostMessage(
      reduce,
      { rev: 7, state: stateWith([]) },
      { kind: "patch", rev: 9, events: [] },
    );
    expect(r.kind).toBe("gap");
  });

  it("reports a gap for a patch before any snapshot", () => {
    const r = applyHostMessage(reduce, null, { kind: "patch", rev: 1, events: [] });
    expect(r.kind).toBe("gap");
  });

  it("ignores stale patches and stale snapshots", () => {
    const current = { rev: 7, state: stateWith([]) };
    expect(
      applyHostMessage(reduce, current, { kind: "patch", rev: 7, events: [] }).kind,
    ).toBe("stale");
    expect(
      applyHostMessage(reduce, current, { kind: "snapshot", rev: 3, state: stateWith([]) }).kind,
    ).toBe("stale");
  });
});

describe("session activity + unseen (drawer ordering / dots)", () => {
  const mk = (id: string): AgentViewEvent => ({
    kind: "sessionCreated",
    session: { id, agentId: "claude", title: id, live: false, updatedAt: "2026-07-09T00:00:00Z" },
  });

  it("turnStarted/turnEnded bump updatedAt — 'latest' means last activity, not creation", () => {
    const s = replay(initialAgentViewState, [
      mk("a"),
      mk("b"),
      { kind: "sessionActivated", sessionId: "b" },
      { kind: "turnStarted", sessionId: "a", at: "2026-07-09T10:00:00Z" },
    ]);
    expect(s.sessions.find((x) => x.id === "a")!.updatedAt).toBe("2026-07-09T10:00:00Z");
    expect(s.sessions.find((x) => x.id === "b")!.updatedAt).toBe("2026-07-09T00:00:00Z");
  });

  it("a turn ending on a non-active session marks it unseen; activation clears it", () => {
    const end: AgentViewEvent = {
      kind: "turnEnded",
      sessionId: "a",
      blockId: "t1",
      startedAt: "2026-07-09T10:00:00Z",
      at: "2026-07-09T10:00:05Z",
      stopReason: "end_turn",
      usage: null,
    };
    const unseen = replay(initialAgentViewState, [mk("a"), mk("b"), { kind: "sessionActivated", sessionId: "b" }, end]);
    expect(unseen.sessions.find((x) => x.id === "a")!.unseen).toBe(true);

    const seen = replay(unseen, [{ kind: "sessionActivated", sessionId: "a" }]);
    expect(seen.sessions.find((x) => x.id === "a")!.unseen).toBeUndefined();
  });

  it("a turn ending on the active session is already seen — watching it complete counts", () => {
    const s = replay(initialAgentViewState, [
      mk("a"),
      { kind: "sessionActivated", sessionId: "a" },
      { kind: "turnEnded", sessionId: "a", blockId: "t1", startedAt: "x", at: "2026-07-09T10:00:05Z", stopReason: "end_turn", usage: null },
    ]);
    expect(s.sessions.find((x) => x.id === "a")!.unseen).toBeUndefined();
  });

  it("sessionListed keeps the newer activity stamp — the wire may trail a local prompt", () => {
    const s = replay(initialAgentViewState, [
      mk("a"),
      { kind: "turnStarted", sessionId: "a", at: "2026-07-09T10:00:00Z" },
      {
        kind: "sessionListed",
        session: { id: "a", agentId: "claude", title: "a", live: false, updatedAt: "2026-07-09T09:00:00Z" },
      },
    ]);
    expect(s.sessions.find((x) => x.id === "a")!.updatedAt).toBe("2026-07-09T10:00:00Z");
  });
});

