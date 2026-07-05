// The one protocol both sides import (architecture.md § Snapshot + patch protocol).
// Webviews are render-only: they send actions, receive snapshots + patches, and
// apply patches with the pure reducers defined here. The orchestrator applies the
// same reducers to its canonical state, so a snapshot is always replay-consistent.

// ── envelope ─────────────────────────────────────────────────────────────────

export type ChannelId = "agentView" | "settings";

export interface SnapshotMsg<S> {
  kind: "snapshot";
  rev: number;
  state: S;
}

export interface PatchMsg<E> {
  kind: "patch";
  rev: number;
  events: readonly E[];
}

export type HostToView<S, E> = SnapshotMsg<S> | PatchMsg<E>;

export type ViewToHost =
  | { kind: "ready" } // mount → request snapshot
  | { kind: "resnapshot" } // revision gap → request fresh snapshot
  | { kind: "applied"; rev: number } // ack: view state now at rev
  | { kind: "action"; action: Action };

// ── actions (fire-and-forget; results come back as state, never as replies) ──

export type ConnectAgentSource =
  | { rosterId: string }
  | { command: string }; // custom command line that speaks ACP

export type Action =
  | { kind: "openSettings" }
  | { kind: "connectAgent"; source: ConnectAgentSource }
  | { kind: "restartAgent"; agentId: string }
  | { kind: "stopAgent"; agentId: string }
  | { kind: "newSession"; agentId: string }
  | { kind: "switchSession"; sessionId: string }
  | { kind: "renameSession"; sessionId: string; title: string }
  | { kind: "closeSession"; sessionId: string }
  | { kind: "sendPrompt"; sessionId: string; text: string }
  | { kind: "stopTurn"; sessionId: string };

// ── revision application (view side; pure, unit-tested) ─────────────────────

export interface Versioned<S> {
  rev: number;
  state: S;
}

export type ApplyResult<S> =
  | { kind: "ok"; next: Versioned<S> }
  | { kind: "gap" } // missed patches — discard and resnapshot
  | { kind: "stale" }; // duplicate/out-of-date message — ignore

export function applyHostMessage<S, E>(
  reduce: (state: S, event: E) => S,
  current: Versioned<S> | null,
  msg: HostToView<S, E>,
): ApplyResult<S> {
  if (msg.kind === "snapshot") {
    if (current !== null && msg.rev < current.rev) return { kind: "stale" };
    return { kind: "ok", next: { rev: msg.rev, state: msg.state } };
  }
  if (current === null) return { kind: "gap" }; // patch before any snapshot
  if (msg.rev <= current.rev) return { kind: "stale" };
  if (msg.rev > current.rev + 1) return { kind: "gap" };
  let state = current.state;
  for (const event of msg.events) state = reduce(state, event);
  return { kind: "ok", next: { rev: msg.rev, state } };
}

// ── coalescing hook (bus merges consecutive events when the hook says so) ───

export type CoalesceHook<E> = (prev: E, next: E) => E | null;

// ── shared domain vocabulary ─────────────────────────────────────────────────

export type AgentStatus = "running" | "stopped" | "crashed" | "reconnecting";

export interface AgentSummary {
  id: string;
  name: string;
  status: AgentStatus;
  /** Human-readable status context, e.g. "exited 1 · 14:07". */
  detail?: string;
}

/**
 * What the agent *claims* at `initialize` — normalized from the handshake,
 * refreshed on every connect. A claim, not a fact: UI gates on verified.
 */
export interface DeclaredCapabilities {
  loadSession: boolean;
  sessionFork: boolean;
  sessionResume: boolean;
  sessionList: boolean;
  sessionClose: boolean;
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
  authMethods: string[];
}

// ── agent-view channel ───────────────────────────────────────────────────────

export interface RosterEntry {
  id: string;
  name: string;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  title: string;
  /** Turn in flight. */
  live: boolean;
  /** Continuation seeded by patchbay, not replayed natively — always labeled. */
  emulated: boolean;
  /** Parent session id when this is a branch (⑂ badge names its parent). */
  branchOf: string | null;
}

// ── chat / transcript (render cache — rebuilt wholesale, never merged) ──────

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface UserBlock {
  kind: "user";
  id: string;
  text: string;
}

export interface TextBlock {
  kind: "text";
  id: string;
  text: string;
}

export interface ThoughtBlock {
  kind: "thought";
  id: string;
  text: string;
}

export interface ToolCallBlock {
  kind: "toolCall";
  /** == the ACP toolCallId — one block, updated in place as status changes. */
  id: string;
  title: string;
  status: ToolCallStatus;
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PlanBlock {
  kind: "plan";
  id: string;
  entries: readonly PlanEntry[];
}

export type ChatBlock = UserBlock | TextBlock | ThoughtBlock | ToolCallBlock | PlanBlock;

export interface AvailableCommand {
  name: string;
  description?: string;
}

export interface AgentViewState {
  agents: readonly AgentSummary[];
  sessions: readonly SessionSummary[];
  activeSessionId: string | null;
  /** Known-agents roster (shipped data) for the pickers. */
  roster: readonly RosterEntry[];
  /** Render cache, per session — rebuilt wholesale from session/load replay. */
  transcripts: Readonly<Record<string, readonly ChatBlock[]>>;
  /** The plan strip's source: the most recent plan snapshot, or none. Distinct
   * from the inline plan cards in the transcript (ui.md: "the strip is the
   * live one"). */
  activePlan: Readonly<Record<string, PlanBlock | null>>;
  commandsBySession: Readonly<Record<string, readonly AvailableCommand[]>>;
}

export const initialAgentViewState: AgentViewState = {
  agents: [],
  sessions: [],
  activeSessionId: null,
  roster: [],
  transcripts: {},
  activePlan: {},
  commandsBySession: {},
};

export type AgentViewEvent =
  | { kind: "agentUpserted"; agent: AgentSummary }
  | { kind: "agentRemoved"; agentId: string }
  | {
      kind: "agentStatusChanged";
      agentId: string;
      status: AgentStatus;
      detail?: string;
    }
  | { kind: "sessionCreated"; session: SessionSummary }
  | { kind: "sessionActivated"; sessionId: string }
  | { kind: "sessionRenamed"; sessionId: string; title: string }
  | { kind: "sessionClosed"; sessionId: string }
  | { kind: "sessionLiveChanged"; sessionId: string; live: boolean }
  /** Replay always wins — the transcript is discarded, never merged. */
  | { kind: "transcriptReset"; sessionId: string }
  | { kind: "userMessageAppended"; sessionId: string; blockId: string; text: string }
  | { kind: "agentTextDelta"; sessionId: string; blockId: string; text: string }
  | { kind: "agentThoughtDelta"; sessionId: string; blockId: string; text: string }
  | {
      kind: "toolCallUpserted";
      sessionId: string;
      blockId: string;
      /** Empty string = unspecified; reducer keeps the existing title. */
      title: string;
      status: ToolCallStatus;
    }
  | { kind: "planAppended"; sessionId: string; blockId: string; entries: readonly PlanEntry[] }
  | { kind: "planCleared"; sessionId: string }
  | { kind: "commandsAdvertised"; sessionId: string; commands: readonly AvailableCommand[] };

function reduceAgents(
  agents: readonly AgentSummary[],
  event: AgentViewEvent,
): readonly AgentSummary[] {
  switch (event.kind) {
    case "agentUpserted": {
      const i = agents.findIndex((a) => a.id === event.agent.id);
      if (i === -1) return [...agents, event.agent];
      return agents.map((a, j) => (j === i ? event.agent : a));
    }
    case "agentRemoved":
      return agents.filter((a) => a.id !== event.agentId);
    case "agentStatusChanged":
      return agents.map((a) =>
        a.id === event.agentId
          ? { ...a, status: event.status, detail: event.detail }
          : a,
      );
    default:
      return agents;
  }
}

function withTranscript(
  state: AgentViewState,
  sessionId: string,
  blocks: readonly ChatBlock[],
): AgentViewState {
  return { ...state, transcripts: { ...state.transcripts, [sessionId]: blocks } };
}

function appendBlock(
  state: AgentViewState,
  sessionId: string,
  block: ChatBlock,
): AgentViewState {
  const blocks = state.transcripts[sessionId] ?? [];
  return withTranscript(state, sessionId, [...blocks, block]);
}

function upsertTextBlock(
  state: AgentViewState,
  sessionId: string,
  blockId: string,
  kind: "text" | "thought",
  delta: string,
): AgentViewState {
  const blocks = state.transcripts[sessionId] ?? [];
  const i = blocks.findIndex((b) => b.id === blockId);
  if (i === -1) {
    return appendBlock(state, sessionId, { kind, id: blockId, text: delta });
  }
  const existing = blocks[i] as TextBlock | ThoughtBlock;
  const updated = { ...existing, text: existing.text + delta };
  return withTranscript(
    state,
    sessionId,
    blocks.map((b, j) => (j === i ? updated : b)),
  );
}

function upsertToolCall(
  state: AgentViewState,
  sessionId: string,
  blockId: string,
  title: string,
  status: ToolCallStatus,
): AgentViewState {
  const blocks = state.transcripts[sessionId] ?? [];
  const i = blocks.findIndex((b) => b.id === blockId);
  if (i === -1) {
    return appendBlock(state, sessionId, { kind: "toolCall", id: blockId, title, status });
  }
  const existing = blocks[i] as ToolCallBlock;
  const updated: ToolCallBlock = { ...existing, status, title: title || existing.title };
  return withTranscript(
    state,
    sessionId,
    blocks.map((b, j) => (j === i ? updated : b)),
  );
}

export function reduceAgentView(
  state: AgentViewState,
  event: AgentViewEvent,
): AgentViewState {
  switch (event.kind) {
    case "agentUpserted":
    case "agentRemoved":
    case "agentStatusChanged":
      return { ...state, agents: reduceAgents(state.agents, event) };
    case "sessionCreated":
      return {
        ...state,
        sessions: [...state.sessions, event.session],
        transcripts: { ...state.transcripts, [event.session.id]: [] },
        commandsBySession: { ...state.commandsBySession, [event.session.id]: [] },
        activeSessionId: event.session.id,
      };
    case "sessionActivated":
      return state.sessions.some((s) => s.id === event.sessionId)
        ? { ...state, activeSessionId: event.sessionId }
        : state;
    case "sessionRenamed":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === event.sessionId ? { ...s, title: event.title } : s,
        ),
      };
    case "sessionClosed": {
      const { [event.sessionId]: _t, ...transcripts } = state.transcripts;
      const { [event.sessionId]: _c, ...commandsBySession } = state.commandsBySession;
      const { [event.sessionId]: _p, ...activePlan } = state.activePlan;
      const sessions = state.sessions.filter((s) => s.id !== event.sessionId);
      const activeSessionId =
        state.activeSessionId === event.sessionId
          ? (sessions[sessions.length - 1]?.id ?? null)
          : state.activeSessionId;
      return { ...state, sessions, transcripts, commandsBySession, activePlan, activeSessionId };
    }
    case "sessionLiveChanged":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === event.sessionId ? { ...s, live: event.live } : s,
        ),
      };
    case "transcriptReset":
      return withTranscript(state, event.sessionId, []);
    case "userMessageAppended":
      return appendBlock(state, event.sessionId, {
        kind: "user",
        id: event.blockId,
        text: event.text,
      });
    case "agentTextDelta":
      return upsertTextBlock(state, event.sessionId, event.blockId, "text", event.text);
    case "agentThoughtDelta":
      return upsertTextBlock(state, event.sessionId, event.blockId, "thought", event.text);
    case "toolCallUpserted":
      return upsertToolCall(state, event.sessionId, event.blockId, event.title, event.status);
    case "planAppended": {
      const block: PlanBlock = { kind: "plan", id: event.blockId, entries: event.entries };
      const withBlock = appendBlock(state, event.sessionId, block);
      return { ...withBlock, activePlan: { ...withBlock.activePlan, [event.sessionId]: block } };
    }
    case "planCleared":
      return { ...state, activePlan: { ...state.activePlan, [event.sessionId]: null } };
    case "commandsAdvertised":
      return {
        ...state,
        commandsBySession: { ...state.commandsBySession, [event.sessionId]: event.commands },
      };
  }
}

export const coalesceAgentViewEvent: CoalesceHook<AgentViewEvent> = (prev, next) => {
  // Concatenate text chunks per message (architecture.md § coalescing).
  if (
    (prev.kind === "agentTextDelta" && next.kind === "agentTextDelta") ||
    (prev.kind === "agentThoughtDelta" && next.kind === "agentThoughtDelta")
  ) {
    if (prev.sessionId === next.sessionId && prev.blockId === next.blockId) {
      return { ...next, text: prev.text + next.text } as AgentViewEvent;
    }
  }
  // Rapid-fire status updates on the same tool call: only the latest matters.
  if (
    prev.kind === "toolCallUpserted" &&
    next.kind === "toolCallUpserted" &&
    prev.sessionId === next.sessionId &&
    prev.blockId === next.blockId
  ) {
    return { ...next, title: next.title || prev.title };
  }
  return null;
};

// ── settings channel ─────────────────────────────────────────────────────────

export interface SettingsState {
  agents: readonly AgentSummary[];
}

export const initialSettingsState: SettingsState = { agents: [] };

export type SettingsEvent = AgentViewEvent;

export function reduceSettings(
  state: SettingsState,
  event: SettingsEvent,
): SettingsState {
  switch (event.kind) {
    case "agentUpserted":
    case "agentRemoved":
    case "agentStatusChanged":
      return { ...state, agents: reduceAgents(state.agents, event) };
    default:
      return state;
  }
}

export const coalesceSettingsEvent: CoalesceHook<SettingsEvent> = coalesceAgentViewEvent;
