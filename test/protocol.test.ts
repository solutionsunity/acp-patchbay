// P1 gate: reducer determinism and revision-gap recovery are pure and provable.
import { describe, expect, it } from "vitest";
import { assertKind } from "./support/assert-kind";
import {
  applyHostMessage,
  attaching,
  chatPaneShows,
  coalesceAgentViewEvent,
  initialAgentViewState,
  initialSettingsState,
  reduceAgentView,
  reduceSettings,
  turnUnderway,
  type AgentSummary,
  type AgentViewEvent,
  type AgentViewState,
  type SettingsEvent,
} from "../src/shared/protocol";
import type { PatchbayAgentId, PatchbayAskId, PatchbaySessionId } from "../src/shared/ids";

const claude: AgentSummary = { id: "claude" as PatchbayAgentId, name: "Claude Code", status: "running", needsAuth: false, authMethods: [], busy: [] };
const gemini: AgentSummary = { id: "gemini" as PatchbayAgentId, name: "Gemini CLI", status: "stopped", needsAuth: false, authMethods: [], busy: [] };

const events: AgentViewEvent[] = [
  { kind: "agentUpserted", agent: claude },
  { kind: "agentUpserted", agent: gemini },
  { kind: "agentUpserted", agent: { ...gemini, status: "running" } },
  { kind: "agentRemoved", patchbayAgentId: "claude" as PatchbayAgentId },
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

  // The row is read whole at the host and replaces what the view held — a
  // cleared lock's instruction and a recovered crash's last words can't
  // linger from an earlier row.
  it("an upserted row replaces the agent whole — nothing of the old row lingers", () => {
    const locked = replay(stateWith([claude]), [
      {
        kind: "agentUpserted",
        agent: { ...claude, status: "crashed", stderr: ["boom"], needsAuth: true, authReason: "run `auggie login`" },
      },
    ]);
    expect(locked.agents[0]).toMatchObject({ needsAuth: true, authReason: "run `auggie login`", stderr: ["boom"] });
    const recovered = replay(locked, [{ kind: "agentUpserted", agent: claude }]);
    expect(recovered.agents[0]).toEqual(claude);
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
  // not carry entries for an agent that no longer exists (invisible to
  // renderers, which key off the agents list, but a ghost all the same — and
  // erase-to-factory-state made it matter). The row carries its own facts;
  // Settings' side maps go with it.
  it("agentRemoved takes the agent's per-agent facts with it", () => {
    const view = replay(stateWith([claude]), [{ kind: "agentRemoved", patchbayAgentId: "claude" as PatchbayAgentId }]);
    expect(view.agents).toEqual([]);

    const settings = [
      { kind: "agentUpserted", agent: claude } as const,
      { kind: "agentKnobsObserved", patchbayAgentId: "claude" as PatchbayAgentId, knobs: { knobs: [] } } as const,
      { kind: "agentRemoved", patchbayAgentId: "claude" as PatchbayAgentId } as const,
    ].reduce(reduceSettings, initialSettingsState);
    expect(settings.agents).toEqual([]);
    expect(settings.agentKnobs).toEqual({});
  });

  // Offerings are connection state: the defaults editor's session rode the
  // connection, so its surface leaves with a row that isn't running.
  it("a row that isn't running drops the agent's knob offerings in Settings", () => {
    const observed = [
      { kind: "agentUpserted", agent: claude } as const,
      { kind: "agentKnobsObserved", patchbayAgentId: "claude" as PatchbayAgentId, knobs: { knobs: [] } } as const,
    ].reduce(reduceSettings, initialSettingsState);
    expect(reduceSettings(observed, { kind: "agentUpserted", agent: claude }).agentKnobs.claude).toBeDefined();
    expect(
      reduceSettings(observed, { kind: "agentUpserted", agent: { ...claude, status: "stopped" } }).agentKnobs,
    ).toEqual({});
  });

  // The in-pane connect lifecycle — started → in progress (what the agent
  // is busy with comes from its row), failed → reason + retry, and the
  // session arriving clears it (reducer-level, so it can't desync from
  // reality); dismiss clears a failure.
  it("chatConnect: in progress → failed → cleared by sessionCreated or dismissal", () => {
    const connecting = replay(initialAgentViewState, [
      { kind: "chatConnectStarted", patchbayAgentId: "claude" as PatchbayAgentId },
    ]);
    expect(connecting.chatConnect).toEqual({ patchbayAgentId: "claude" });

    const failed = replay(connecting, [
      { kind: "chatConnectFailed", patchbayAgentId: "claude" as PatchbayAgentId, reason: "spawn failed: ENOENT" },
    ]);
    expect(failed.chatConnect).toEqual({ patchbayAgentId: "claude", reason: "spawn failed: ENOENT" });

    const dismissed = replay(failed, [{ kind: "chatConnectResolved" }]);
    expect(dismissed.chatConnect).toBeNull();

    const succeeded = replay(connecting, [
      {
        kind: "sessionCreated",
        session: { id: "s1" as PatchbaySessionId, patchbayAgentId: "claude" as PatchbayAgentId, title: "t", busy: [], updatedAt: "2026-07-09T00:00:00Z" },
      },
    ]);
    expect(succeeded.chatConnect).toBeNull();
    expect(succeeded.activePatchbaySessionId).toBe("s1");
  });

  // Closing the active session must land on home, never silently activate a
  // sibling: a session click is the one hydrate trigger, so an auto-activated
  // row would show its title over an empty pane.
  it("closing the active session falls back to home, not a sibling", () => {
    const two = replay(initialAgentViewState, [
      {
        kind: "sessionCreated",
        session: { id: "s1" as PatchbaySessionId, patchbayAgentId: "claude" as PatchbayAgentId, title: "one", busy: [], updatedAt: "2026-07-09T00:00:00Z" },
      },
      {
        kind: "sessionCreated",
        session: { id: "s2" as PatchbaySessionId, patchbayAgentId: "claude" as PatchbayAgentId, title: "two", busy: [], updatedAt: "2026-07-09T00:00:01Z" },
      },
    ]);
    expect(two.activePatchbaySessionId).toBe("s2");
    const closed = replay(two, [{ kind: "sessionClosed", patchbaySessionId: "s2" as PatchbaySessionId }]);
    expect(closed.activePatchbaySessionId).toBeNull();
    // Closing a background session leaves the active one alone.
    const other = replay(two, [{ kind: "sessionClosed", patchbaySessionId: "s1" as PatchbaySessionId }]);
    expect(other.activePatchbaySessionId).toBe("s2");
  });

  // The pane is one place: a request still owns it only while it shows that
  // same request in progress — the latest connect on demand took it, or it
  // failed, and the earlier one stands down.
  it("chatPaneShows: only the request the pane shows in progress", () => {
    const newChat = { patchbayAgentId: "claude" as PatchbayAgentId };
    expect(chatPaneShows(newChat, "claude" as PatchbayAgentId, undefined)).toBe(true);
    expect(chatPaneShows(null, "claude" as PatchbayAgentId, undefined)).toBe(false);
    expect(chatPaneShows({ ...newChat, reason: "spawn failed" }, "claude" as PatchbayAgentId, undefined)).toBe(false);
    expect(chatPaneShows(newChat, "gemini" as PatchbayAgentId, undefined)).toBe(false);
    // a new chat and a session open on one agent are two requests
    expect(chatPaneShows(newChat, "claude" as PatchbayAgentId, "s1" as PatchbaySessionId)).toBe(false);
    expect(chatPaneShows({ patchbayAgentId: "claude" as PatchbayAgentId, forPatchbaySessionId: "s1" as PatchbaySessionId }, "claude" as PatchbayAgentId, undefined)).toBe(false);
    expect(chatPaneShows({ patchbayAgentId: "claude" as PatchbayAgentId, forPatchbaySessionId: "s1" as PatchbaySessionId }, "claude" as PatchbayAgentId, "s1" as PatchbaySessionId)).toBe(true);
    expect(chatPaneShows({ patchbayAgentId: "claude" as PatchbayAgentId, forPatchbaySessionId: "s2" as PatchbaySessionId }, "claude" as PatchbayAgentId, "s1" as PatchbaySessionId)).toBe(false);
  });

  it("chatConnect carries forSessionId through progress and failure — the Retry-as-same-click hook", () => {
    const connecting = replay(initialAgentViewState, [
      { kind: "chatConnectStarted", patchbayAgentId: "claude" as PatchbayAgentId, forPatchbaySessionId: "s9" as PatchbaySessionId },
    ]);
    expect(connecting.chatConnect?.forPatchbaySessionId).toBe("s9");
    const failed = replay(connecting, [
      { kind: "chatConnectFailed", patchbayAgentId: "claude" as PatchbayAgentId, reason: "spawn failed", forPatchbaySessionId: "s9" as PatchbaySessionId },
    ]);
    expect(failed.chatConnect?.forPatchbaySessionId).toBe("s9");
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

  // A chat opened for typing asks the composer for the keyboard; the views
  // react to a change, so every request must move the count, twice in a
  // row included.
  it("each request to take the keyboard moves composerFocus", () => {
    expect(initialAgentViewState.composerFocus).toBe(0);
    const once = replay(initialAgentViewState, [{ kind: "composerFocusRequested" }]);
    const twice = replay(once, [{ kind: "composerFocusRequested" }]);
    expect(once.composerFocus).not.toBe(initialAgentViewState.composerFocus);
    expect(twice.composerFocus).not.toBe(once.composerFocus);
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
        patchbaySessionId: "s1" as PatchbaySessionId,
        entries: [{ content: "step", status: "in_progress" }],
      },
      { kind: "transcriptReset", patchbaySessionId: "s1" as PatchbaySessionId },
    ]);
    expect(s.activePlan.s1).toBeNull();
    expect(s.transcripts.s1).toEqual([]);
  });
});

describe("settings projections (ui.md § Settings Agents)", () => {
  it("sessionStatsChanged and agentKnobsObserved land in settings state", () => {
    const events: SettingsEvent[] = [
      { kind: "sessionStatsChanged", sessionsActiveToday: 3 },
      {
        kind: "agentKnobsObserved",
        patchbayAgentId: "claude" as PatchbayAgentId,
        knobs: {
          knobs: [
            { id: "model", name: "Model", category: "model", type: "select", values: [{ value: "s", name: "Sonnet" }] },
          ],
        },
      },
    ];
    const s = events.reduce(reduceSettings, initialSettingsState);
    expect(s.sessionsActiveToday).toBe(3);
    expect(s.agentKnobs.claude!.knobs[0]!.category).toBe("model");
    // the defaults editor ending its session releases the surface — a
    // re-expanded card reads fresh instead of showing the old one
    expect(reduceSettings(s, { kind: "agentKnobsReleased", patchbayAgentId: "claude" as PatchbayAgentId }).agentKnobs.claude).toBeUndefined();
  });

  // Busy is a row fact, not a side map: each upsert carries what the
  // agent's queue holds, idle included, so nothing is left to clear.
  it("busy rides the row — an upsert replaces it whole", () => {
    const restarting = reduceSettings(initialSettingsState, {
      kind: "agentUpserted",
      agent: { ...claude, busy: [{ kind: "restart" }] },
    });
    expect(restarting.agents[0]!.busy).toEqual([{ kind: "restart" }]);
    expect(reduceSettings(restarting, { kind: "agentUpserted", agent: claude }).agents[0]!.busy).toEqual([]);
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
    session: { id: id as PatchbaySessionId, patchbayAgentId: "claude" as PatchbayAgentId, title: id, busy: [], updatedAt: "2026-07-09T00:00:00Z" },
  });

  it("turnStarted/turnEnded bump updatedAt — 'latest' means last activity, not creation", () => {
    const s = replay(initialAgentViewState, [
      mk("a"),
      mk("b"),
      { kind: "sessionActivated", patchbaySessionId: "b" as PatchbaySessionId },
      { kind: "turnStarted", patchbaySessionId: "a" as PatchbaySessionId, at: "2026-07-09T10:00:00Z" },
    ]);
    expect(s.sessions.find((x) => x.id === "a")!.updatedAt).toBe("2026-07-09T10:00:00Z");
    expect(s.sessions.find((x) => x.id === "b")!.updatedAt).toBe("2026-07-09T00:00:00Z");
  });

  const end = (patchbaySessionId: PatchbaySessionId): AgentViewEvent => ({
    kind: "turnEnded",
    patchbaySessionId,
    blockId: `t-${patchbaySessionId}`,
    startedAt: "2026-07-09T10:00:00Z",
    at: "2026-07-09T10:00:05Z",
    stopReason: "end_turn",
    usage: null,
  });
  const viewShown: AgentViewEvent = { kind: "screenChanged", pointer: true, pinned: [] };
  const unseenOf = (s: AgentViewState, id: string) => s.sessions.find((x) => x.id === id)!.unseen;

  it("a turn ending on a non-active session marks it unseen; activation on a visible view clears it", () => {
    const unseen = replay(initialAgentViewState, [mk("a"), mk("b"), viewShown, { kind: "sessionActivated", patchbaySessionId: "b" as PatchbaySessionId }, end("a" as PatchbaySessionId)]);
    expect(unseenOf(unseen, "a")).toBe(true);

    const seen = replay(unseen, [{ kind: "sessionActivated", patchbaySessionId: "a" as PatchbaySessionId }]);
    expect(unseenOf(seen, "a")).toBeUndefined();
  });

  it("the active session finishing while the view is hidden is news too — seen only once the view shows it", () => {
    const hidden = replay(initialAgentViewState, [mk("a"), { kind: "sessionActivated", patchbaySessionId: "a" as PatchbaySessionId }, end("a" as PatchbaySessionId)]);
    expect(unseenOf(hidden, "a")).toBe(true);

    // activating it again while hidden is not seeing it
    const stillHidden = replay(hidden, [{ kind: "sessionActivated", patchbaySessionId: "a" as PatchbaySessionId }]);
    expect(unseenOf(stillHidden, "a")).toBe(true);

    const shown = replay(stillHidden, [viewShown]);
    expect(unseenOf(shown, "a")).toBeUndefined();
  });

  it("a visible pinned panel is seeing its session — no dot, and showing one clears it", () => {
    const pinnedVisible: AgentViewEvent = { kind: "screenChanged", pointer: false, pinned: ["b"] };
    const s = replay(initialAgentViewState, [mk("a"), mk("b"), { kind: "sessionActivated", patchbaySessionId: "a" as PatchbaySessionId }, pinnedVisible, end("b" as PatchbaySessionId)]);
    expect(unseenOf(s, "b")).toBeUndefined();

    const later = replay(s, [{ kind: "screenChanged", pointer: false, pinned: [] }, end("b" as PatchbaySessionId)]);
    expect(unseenOf(later, "b")).toBe(true);
    expect(unseenOf(replay(later, [pinnedVisible]), "b")).toBeUndefined();
  });

  it("a replay-synthesized boundary (at: null) is history, not news — block lands, no updatedAt bump, no unseen dot", () => {
    const s = replay(initialAgentViewState, [
      mk("a"),
      mk("b"),
      { kind: "sessionActivated", patchbaySessionId: "b" as PatchbaySessionId },
      { kind: "turnEnded", patchbaySessionId: "a" as PatchbaySessionId, blockId: "t1", startedAt: null, at: null, stopReason: null, usage: null },
    ]);
    expect(s.transcripts["a"]![0]).toMatchObject({ kind: "turnEnd", startedAt: null, endedAt: null, stopReason: null });
    expect(s.sessions.find((x) => x.id === "a")!.updatedAt).toBe("2026-07-09T00:00:00Z");
    expect(s.sessions.find((x) => x.id === "a")!.unseen).toBeUndefined();
  });

  it("a turn ending on the active session is already seen — watching it complete counts", () => {
    const s = replay(initialAgentViewState, [
      mk("a"),
      viewShown,
      { kind: "sessionActivated", patchbaySessionId: "a" as PatchbaySessionId },
      { kind: "turnEnded", patchbaySessionId: "a" as PatchbaySessionId, blockId: "t1", startedAt: "x", at: "2026-07-09T10:00:05Z", stopReason: "end_turn", usage: null },
    ]);
    expect(s.sessions.find((x) => x.id === "a")!.unseen).toBeUndefined();
  });

  it("sessionRefreshed keeps the newer activity stamp — the wire may trail a local prompt", () => {
    const s = replay(initialAgentViewState, [
      mk("a"),
      { kind: "turnStarted", patchbaySessionId: "a" as PatchbaySessionId, at: "2026-07-09T10:00:00Z" },
      { kind: "sessionRefreshed", patchbaySessionId: "a" as PatchbaySessionId, title: "a", updatedAt: "2026-07-09T09:00:00Z" },
    ]);
    expect(s.sessions.find((x) => x.id === "a")!.updatedAt).toBe("2026-07-09T10:00:00Z");
  });

  it("sessionRefreshed names a fork's original, and a refresh that doesn't mention it keeps it", () => {
    const s = replay(initialAgentViewState, [
      mk("a"),
      mk("b"),
      { kind: "sessionRefreshed", patchbaySessionId: "b" as PatchbaySessionId, forkedFrom: "a" as PatchbaySessionId },
      { kind: "sessionRefreshed", patchbaySessionId: "b" as PatchbaySessionId, title: "renamed" },
    ]);
    expect(s.sessions.find((x) => x.id === "b")).toMatchObject({ title: "renamed", forkedFrom: "a" });
    expect(s.sessions.find((x) => x.id === "a")!.forkedFrom).toBeUndefined();
  });

  it("sessionRefreshed without a stamp is the wire saying nothing — the row keeps its own", () => {
    const s = replay(initialAgentViewState, [
      mk("a"),
      { kind: "turnStarted", patchbaySessionId: "a" as PatchbaySessionId, at: "2026-07-09T10:00:00Z" },
      { kind: "sessionRefreshed", patchbaySessionId: "a" as PatchbaySessionId, title: "renamed" },
    ]);
    expect(s.sessions.find((x) => x.id === "a")).toMatchObject({
      title: "renamed",
      updatedAt: "2026-07-09T10:00:00Z",
    });
  });

  it("sessionRefreshed without a title is silence too — the row keeps what it shows", () => {
    const s = replay(initialAgentViewState, [
      mk("a"),
      { kind: "sessionRefreshed", patchbaySessionId: "a" as PatchbaySessionId, title: "derived from the first prompt" },
      { kind: "sessionRefreshed", patchbaySessionId: "a" as PatchbaySessionId, updatedAt: "2026-07-09T11:00:00Z" },
    ]);
    expect(s.sessions.find((x) => x.id === "a")).toMatchObject({
      title: "derived from the first prompt",
      updatedAt: "2026-07-09T11:00:00Z",
    });
  });
});


describe("sessionBusyChanged (what a session's lines hold — its busy state)", () => {
  const created = (id: string): AgentViewEvent => ({
    kind: "sessionCreated",
    session: { id: id as PatchbaySessionId, patchbayAgentId: "a1" as PatchbayAgentId, title: "T", busy: [], updatedAt: "2026-07-21T00:00:00Z" },
  });

  it("a prompt on the turn line is a turn underway; an open or a reload is an attach; other work is neither", () => {
    let s = replay(initialAgentViewState, [created("s1")]);
    const read = () => [turnUnderway(s.sessions[0]!), attaching(s.sessions[0]!)];
    expect(read()).toEqual([false, false]);
    s = reduceAgentView(s, { kind: "sessionBusyChanged", patchbaySessionId: "s1" as PatchbaySessionId, busy: ["open", "prompt"] });
    expect(s.sessions[0]!.busy).toEqual(["open", "prompt"]);
    expect(read()).toEqual([true, true]);
    s = reduceAgentView(s, { kind: "sessionBusyChanged", patchbaySessionId: "s1" as PatchbaySessionId, busy: ["knob"] });
    expect(read()).toEqual([false, false]);
    s = reduceAgentView(s, { kind: "sessionBusyChanged", patchbaySessionId: "s1" as PatchbaySessionId, busy: ["reload"] });
    expect(read()).toEqual([false, true]);
    s = reduceAgentView(s, { kind: "sessionBusyChanged", patchbaySessionId: "s1" as PatchbaySessionId, busy: [] });
    expect(s.sessions[0]!.busy).toEqual([]);
  });

  it("busy for a session the view no longer holds changes no session", () => {
    const s = replay(initialAgentViewState, [created("s1")]);
    const after = reduceAgentView(s, { kind: "sessionBusyChanged", patchbaySessionId: "gone" as PatchbaySessionId, busy: ["reload"] });
    expect(after.sessions).toEqual(s.sessions);
  });
});

describe("state-truth regressions — weak evidence never overwrites strong", () => {
  it("usageReported coalesce: a plain tick never erases a standing plan reading", () => {
    const withPlan: AgentViewEvent = {
      kind: "usageReported", patchbaySessionId: "s1" as PatchbaySessionId, used: 10, size: 100, cost: undefined,
      plan: { status: "limited", window: "five_hour", utilization: 0.9, resetsAt: undefined },
    };
    const plainTick: AgentViewEvent = {
      kind: "usageReported", patchbaySessionId: "s1" as PatchbaySessionId, used: 12, size: 100, cost: undefined, plan: undefined,
    };
    const merged = coalesceAgentViewEvent(withPlan, plainTick);
    expect(merged).toMatchObject({ used: 12, plan: { window: "five_hour" } });
    // Different windows are parallel axes — both must reach the reducer.
    const otherWindow: AgentViewEvent = {
      kind: "usageReported", patchbaySessionId: "s1" as PatchbaySessionId, used: 13, size: 100, cost: undefined,
      plan: { status: "ok", window: "weekly", utilization: 0.2, resetsAt: undefined },
    };
    expect(coalesceAgentViewEvent(withPlan, otherWindow)).toBeNull();
  });
});

describe("saved roots (issue #32) — one stored truth, both channels", () => {
  it("savedRootsChanged lands in the agent view and in Settings alike", () => {
    const savedRoots = { workspace: ["/src/lib"], machine: ["/src/odoo"], missing: ["/src/odoo"] };
    const event = { kind: "savedRootsChanged", savedRoots } as const;
    expect(initialAgentViewState.savedRoots).toEqual({ workspace: null, machine: [], missing: [] });
    expect(initialSettingsState.savedRoots).toEqual({ workspace: null, machine: [], missing: [] });
    expect(reduceAgentView(initialAgentViewState, event).savedRoots).toEqual(savedRoots);
    expect(reduceSettings(initialSettingsState, event).savedRoots).toEqual(savedRoots);
  });
});

describe("elicitation blocks (#36) — the answer's own vocabulary", () => {
  it("a resolved card says which of the three answers the user gave", () => {
    const asked: AgentViewEvent = {
      kind: "elicitationRequested",
      patchbaySessionId: "s1" as PatchbaySessionId,
      patchbayAskId: "e1" as PatchbayAskId,
      message: "Which database?",
      mode: "form",
      fields: [{ name: "db", type: "string", required: true }],
    };
    for (const outcome of ["accepted", "declined", "cancelled", "withdrawn", "completed"] as const) {
      const state = replay(initialAgentViewState, [
        asked,
        { kind: "elicitationResolved", patchbaySessionId: "s1" as PatchbaySessionId, patchbayAskId: "e1" as PatchbayAskId, outcome },
      ]);
      const block = state.transcripts.s1!.find((b) => b.kind === "elicitation");
      expect(block?.kind === "elicitation" && block.resolution).toEqual({ outcome });
    }
  });

  it("a link card waits once opened, and its follow-up lands whether or not it was answered", () => {
    const asked: AgentViewEvent = {
      kind: "elicitationRequested",
      patchbaySessionId: "s1" as PatchbaySessionId,
      patchbayAskId: "e1" as PatchbayAskId,
      message: "Sign in",
      mode: "url",
      link: { href: "https://auth.example.com/", host: "auth.example.com", warnings: [] },
    };
    const card = (events: AgentViewEvent[]) =>
      replay(initialAgentViewState, [asked, ...events]).transcripts.s1!.find((b) => b.kind === "elicitation");
    const resolved = (outcome: "accepted" | "declined" | "completed"): AgentViewEvent => ({
      kind: "elicitationResolved",
      patchbaySessionId: "s1" as PatchbaySessionId,
      patchbayAskId: "e1" as PatchbayAskId,
      outcome,
    });
    const settled = (state: "completed" | "ended"): AgentViewEvent => ({
      kind: "elicitationLinkSettled",
      patchbaySessionId: "s1" as PatchbaySessionId,
      patchbayAskId: "e1" as PatchbayAskId,
      state,
    });
    expect(card([])?.kind === "elicitation" && card([])?.linkState).toBeFalsy();
    expect(card([resolved("accepted")])).toMatchObject({ linkState: "waiting" });
    expect(card([resolved("declined")])?.kind === "elicitation" && card([resolved("declined")])?.linkState).toBeFalsy();
    expect(card([resolved("accepted"), settled("completed")])).toMatchObject({ linkState: "completed" });
    expect(card([resolved("accepted"), settled("ended")])).toMatchObject({ linkState: "ended" });
    // finished by the agent before the user answered: one fact, done
    expect(card([resolved("completed")])).toMatchObject({ linkState: "completed", resolution: { outcome: "completed" } });
  });
});
