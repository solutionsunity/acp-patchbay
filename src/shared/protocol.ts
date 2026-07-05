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
  | { kind: "stopTurn"; sessionId: string }
  | { kind: "runDiagnostics"; agentId: string }
  | { kind: "resolvePermission"; requestId: string; optionId: string }
  | { kind: "resolveDiff"; requestId: string; accept: boolean }
  | { kind: "adoptWorkspaceAgent"; agentId: string }
  | { kind: "addCommandRule"; rule: CommandRuleView }
  | { kind: "removeCommandRule"; pattern: string }
  | { kind: "setFileWriteScope"; scope: FileWriteScopeView }
  | { kind: "resolveElicitation"; requestId: string; values: Record<string, unknown> | null }
  | { kind: "addSelectionContext"; sessionId: string }
  | { kind: "addFileContext"; sessionId: string }
  | { kind: "addDiagnosticsContext"; sessionId: string }
  | { kind: "removeContextChip"; sessionId: string; chipId: string }
  | { kind: "branchSession"; sessionId: string }
  | { kind: "reloadSession"; sessionId: string }
  | { kind: "setSessionMode"; sessionId: string; modeId: string }
  | { kind: "setSessionConfigOption"; sessionId: string; configId: string; value: string | boolean }
  | { kind: "connectRegistryIntegration"; registryId: string }
  | {
      kind: "addCustomIntegration";
      id: string;
      name: string;
      source: IntegrationSourceView;
      routing: IntegrationRoutingView;
    }
  | { kind: "disconnectIntegration"; integrationId: string }
  | { kind: "removeIntegration"; integrationId: string }
  | { kind: "setIntegrationRouting"; integrationId: string; routing: IntegrationRoutingView }
  | { kind: "shareIntegrationConfig"; integrationId: string }
  | { kind: "refreshAgentAssets"; agentId: string }
  | { kind: "openAssetFile"; agentId: string; path: string };

// ── integrations (architecture.md § Integrations) ───────────────────────────

export type IntegrationRoutingView = "auto" | readonly string[];

/** Payload for `addCustomIntegration` — the "any MCP server, command or URL,
 * with auth" escape hatch (features.md § Integrations). Registry-backed
 * integrations go through `connectRegistryIntegration` instead, since that
 * path drives an OAuth flow rather than taking a source directly. */
export type IntegrationSourceView =
  | { kind: "custom-stdio"; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
  | { kind: "custom-http"; url: string; authType: "none" | "bearer-token"; token?: string };

export interface IntegrationView {
  id: string;
  name: string;
  sourceKind: "registry" | "custom-stdio" | "custom-http";
  registryId?: string;
  /** A token exists in this workspace's SecretStorage — never assumes one
   * followed from another workspace (features.md's incident-driven rule). */
  connected: boolean;
  routing: IntegrationRoutingView;
}

export interface RegistryEntryView {
  id: string;
  name: string;
  /** False until the owner-supplied clientId/url exist (plan.md P9 touchpoint). */
  connectable: boolean;
}

export interface DeviceFlowView {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  status: "pending" | "failed";
  reason?: string;
}

// ── rules, skills, commands (architecture.md § Rules, skills, commands) ────
// v1 is management, not delivery: files live in each agent's own native
// locations; patchbay lists what's on disk and lets the user jump to it —
// real editing happens in the normal VS Code editor, never a webview dialect.

export interface AssetFileView {
  /** Relative to the workspace root. */
  path: string;
}

export interface AssetCategoryView {
  /** null = this category isn't mapped for this agent (roster data) —
   * shown as unmapped, never guessed. */
  files: readonly AssetFileView[] | null;
}

export interface AgentAssetsView {
  agentId: string;
  rules: AssetCategoryView;
  commands: AssetCategoryView;
  skills: AssetCategoryView;
}

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
  /** rules/skills/commands locations known for this agent (roster data). */
  assetsMapped: boolean;
  /** A bridge observed to act on fs/terminal regardless of client capabilities. */
  knownBypassBridge: boolean;
}

// ── capability matrix (architecture.md § Agent capability matrix) ──────────
// Two states per capability: declared (the handshake's claim, refreshed every
// connect) and verified (set only once the path succeeds on the wire).
// A row with declared=false is "not declared" regardless of verified (which
// cannot be true without declared — enforced by construction: every writer
// below only ever sets verified on a row that was declared).

export type CapabilityRowId =
  | "fs.readTextFile"
  | "fs.writeTextFile"
  | "terminal"
  | "elicitation"
  | "roots.listChanged"
  | "resources.subscribe"
  | "prompt.image"
  | "prompt.audio"
  | "prompt.embeddedContext"
  | "session.fork"
  | "session.load"
  | "session.resume"
  | "mcp.http"
  | "mcp.sse"
  | "usage"
  | "concurrentSessions";

export interface CapabilityCell {
  declared: boolean;
  verified: boolean;
}

export type CapabilityMatrix = Readonly<Record<CapabilityRowId, CapabilityCell>>;

export type CapabilityState = "not-declared" | "declared" | "verified";

export function capabilityState(cell: CapabilityCell | undefined): CapabilityState {
  if (cell === undefined || !cell.declared) return "not-declared";
  return cell.verified ? "verified" : "declared";
}

export type FidelityLabel = "fully-brokered" | "partially-brokered" | "acts-outside";

/**
 * Pure function of the matrix (architecture.md § Permission broker): fs and
 * terminal declared *and* verified → fully brokered; a proper subset →
 * partially brokered; neither, or a known-bypass bridge → acts outside.
 * Never hand-assigned.
 */
export function computeFidelity(
  matrix: CapabilityMatrix,
  knownBypassBridge: boolean,
): FidelityLabel {
  if (knownBypassBridge) return "acts-outside";
  const brokered = (row: CapabilityRowId) => matrix[row].declared && matrix[row].verified;
  const rows = [brokered("fs.readTextFile"), brokered("fs.writeTextFile"), brokered("terminal")];
  if (rows.every(Boolean)) return "fully-brokered";
  return rows.some(Boolean) ? "partially-brokered" : "acts-outside";
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

// ── session model/mode/effort knobs (architecture.md § Session model, mode,
// effort) — three optional knobs, each existing only if the agent offers it.
// Display comes only from the agent's own state notifications, never from a
// set-request's response (bridges have returned success for rejected
// changes) — reducer cases below only ever apply *Set/*Changed events.

export interface SessionModeOptionView {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModesView {
  currentModeId: string;
  available: readonly SessionModeOptionView[];
}

export interface SessionConfigSelectValueView {
  value: string;
  name: string;
  description?: string;
}

export interface SessionConfigSelectGroupView {
  group: string;
  name: string;
  options: readonly SessionConfigSelectValueView[];
}

interface SessionConfigOptionBase {
  id: string;
  name: string;
  description?: string;
  /** "model" | "mode" | "thought_level" | ... — agent-declared, UX-only. */
  category?: string;
}

export type SessionConfigOptionView = SessionConfigOptionBase &
  (
    | {
        type: "select";
        currentValue: string;
        options: readonly SessionConfigSelectValueView[] | readonly SessionConfigSelectGroupView[];
      }
    | { type: "boolean"; currentValue: boolean }
  );

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

/** One broker path for every gated action (architecture.md § Permission
 * broker) — ACP session/request_permission, and patchbay's own fs.write /
 * terminal handlers, all render the same card shape. */
export interface PermissionOptionView {
  optionId: string;
  label: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PermissionBlock {
  kind: "permission";
  id: string;
  title: string;
  detail: string;
  options: readonly PermissionOptionView[];
  /** Set once resolved — by the user or by a rule. Never re-asked in place. */
  resolution: { label: string; auto: boolean } | null;
}

export type DiffLineKind = "context" | "add" | "del";

export interface DiffBlock {
  kind: "diff";
  id: string;
  file: string;
  additions: number;
  deletions: number;
  lines: readonly { kind: DiffLineKind; text: string }[];
  /** null while awaiting the user; auto-accept still shows the diff. */
  resolution: { accepted: boolean; auto: boolean } | null;
}

export interface TerminalBlock {
  kind: "terminal";
  id: string;
  command: string;
  output: string;
  running: boolean;
  exitCode: number | null;
}

/** The elicitation fallback (architecture.md's adapter table): a local MCP
 * tool renders this as a small form, universal across agents regardless of
 * native ACP elicitation support — which the SDK itself marks unstable/
 * experimental, so v1 uses only this path (plan.md P7 scoping note). */
export interface ElicitationField {
  name: string;
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  required: boolean;
}

export interface ElicitationBlock {
  kind: "elicitation";
  id: string;
  message: string;
  fields: readonly ElicitationField[];
  resolution: { cancelled: boolean } | null;
}

export type ChatBlock =
  | UserBlock
  | TextBlock
  | ThoughtBlock
  | ToolCallBlock
  | PlanBlock
  | PermissionBlock
  | DiffBlock
  | TerminalBlock
  | ElicitationBlock;

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
  /** Declared/verified per agent — replaced wholesale on every (re)connect. */
  capabilities: Readonly<Record<string, CapabilityMatrix>>;
  /** ISO time of the last capabilitiesDeclared — powers the "reset <time>" chip. */
  capabilitiesResetAt: Readonly<Record<string, string>>;
  /** Present only once `usage` verifies — absence over fake (ui.md § gauge). */
  sessionUsage: Readonly<Record<string, UsageInfo>>;
  /** Explicitly attached context, pending inclusion in the next prompt
   * (features.md § Chat: "explicitly add editor state to the prompt"). */
  contextChips: Readonly<Record<string, readonly ContextChip[]>>;
  /** Mode knob — absent (null) when the agent doesn't offer session modes. */
  sessionModes: Readonly<Record<string, SessionModesView | null>>;
  /** Model/effort/etc. knobs — empty when the agent offers none. */
  sessionConfigOptions: Readonly<Record<string, readonly SessionConfigOptionView[]>>;
}

export interface UsageInfo {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}

export interface ContextChip {
  id: string;
  kind: "selection" | "file" | "diagnostics";
  label: string;
  content: string;
}

export const initialAgentViewState: AgentViewState = {
  agents: [],
  sessions: [],
  activeSessionId: null,
  roster: [],
  transcripts: {},
  activePlan: {},
  commandsBySession: {},
  capabilities: {},
  capabilitiesResetAt: {},
  sessionUsage: {},
  contextChips: {},
  sessionModes: {},
  sessionConfigOptions: {},
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
  | { kind: "commandsAdvertised"; sessionId: string; commands: readonly AvailableCommand[] }
  | {
      kind: "permissionRequested";
      sessionId: string;
      blockId: string;
      title: string;
      detail: string;
      options: readonly PermissionOptionView[];
    }
  | { kind: "permissionResolved"; sessionId: string; blockId: string; label: string; auto: boolean }
  | {
      kind: "diffProposed";
      sessionId: string;
      blockId: string;
      file: string;
      additions: number;
      deletions: number;
      lines: readonly { kind: DiffLineKind; text: string }[];
    }
  | { kind: "diffResolved"; sessionId: string; blockId: string; accepted: boolean; auto: boolean }
  | { kind: "terminalStarted"; sessionId: string; blockId: string; command: string }
  | { kind: "terminalOutputAppended"; sessionId: string; blockId: string; chunk: string }
  | { kind: "terminalExited"; sessionId: string; blockId: string; exitCode: number | null }
  | {
      kind: "elicitationRequested";
      sessionId: string;
      blockId: string;
      message: string;
      fields: readonly ElicitationField[];
    }
  | { kind: "elicitationResolved"; sessionId: string; blockId: string; cancelled: boolean }
  | { kind: "contextChipAdded"; sessionId: string; chip: ContextChip }
  | { kind: "contextChipRemoved"; sessionId: string; chipId: string }
  /** Full replace — from a session/new, /load, or /fork response. */
  | { kind: "sessionModesSet"; sessionId: string; modes: SessionModesView | null }
  /** Partial — from a `current_mode_update` notification; a no-op if no modes state exists yet. */
  | { kind: "sessionModeChanged"; sessionId: string; modeId: string }
  /** Full replace — from a create/load/fork response or a `config_option_update` notification. */
  | { kind: "sessionConfigOptionsChanged"; sessionId: string; options: readonly SessionConfigOptionView[] }
  /** A branch (native or emulated) or an emulated dead-end continuation
   * seeding its transcript wholesale — never merged, same "replay always
   * wins" rule as transcriptReset (architecture.md § Last-known view). */
  | { kind: "transcriptSeeded"; sessionId: string; blocks: readonly ChatBlock[] }
  /** Fired on every connect — replaces the agent's whole matrix, verified resets to false. */
  | { kind: "capabilitiesDeclared"; agentId: string; matrix: CapabilityMatrix; at: string }
  | { kind: "capabilityVerified"; agentId: string; row: CapabilityRowId }
  | {
      kind: "usageReported";
      sessionId: string;
      used: number;
      size: number;
      cost?: { amount: number; currency: string };
    }
  /** Settings-only (shared union — AgentView's reducer no-ops on these). */
  | { kind: "workspaceAgentPending"; agent: WorkspaceAgentPending }
  | { kind: "workspaceAgentAdopted"; agentId: string };

/** A repo-defined agent (from `.vscode/acp-patchbay.json`) awaiting the
 * one-time, workspace-trust-gated adoption architecture.md requires before
 * its launch command runs — shown in full, never silently trusted. */
export interface WorkspaceAgentPending {
  agentId: string;
  name: string;
  command: string;
}

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

function reduceCapabilities(
  capabilities: Readonly<Record<string, CapabilityMatrix>>,
  event: AgentViewEvent,
): Readonly<Record<string, CapabilityMatrix>> {
  switch (event.kind) {
    case "capabilitiesDeclared":
      return { ...capabilities, [event.agentId]: event.matrix };
    case "capabilityVerified": {
      // Verified always implies declared — the single write path for both,
      // which is what lets rows with no initialize-time claim (usage,
      // concurrentSessions) go straight from not-declared to verified.
      const matrix = capabilities[event.agentId];
      if (matrix === undefined) return capabilities;
      return {
        ...capabilities,
        [event.agentId]: { ...matrix, [event.row]: { declared: true, verified: true } },
      };
    }
    default:
      return capabilities;
  }
}

function reduceCapabilitiesResetAt(
  resetAt: Readonly<Record<string, string>>,
  event: AgentViewEvent,
): Readonly<Record<string, string>> {
  return event.kind === "capabilitiesDeclared"
    ? { ...resetAt, [event.agentId]: event.at }
    : resetAt;
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

/** Finds a block by id and replaces it with `patch(existing)`'s result — a
 * no-op if the block doesn't exist (e.g. a stale event after a transcript
 * reset). Used by every block that's created once and updated in place. */
function patchBlock<B extends ChatBlock>(
  state: AgentViewState,
  sessionId: string,
  blockId: string,
  patch: (existing: B) => B,
): AgentViewState {
  const blocks = state.transcripts[sessionId] ?? [];
  const i = blocks.findIndex((b) => b.id === blockId);
  if (i === -1) return state;
  const updated = patch(blocks[i] as B);
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
        contextChips: { ...state.contextChips, [event.session.id]: [] },
        sessionModes: { ...state.sessionModes, [event.session.id]: null },
        sessionConfigOptions: { ...state.sessionConfigOptions, [event.session.id]: [] },
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
      const { [event.sessionId]: _x, ...contextChips } = state.contextChips;
      const { [event.sessionId]: _m, ...sessionModes } = state.sessionModes;
      const { [event.sessionId]: _o, ...sessionConfigOptions } = state.sessionConfigOptions;
      const sessions = state.sessions.filter((s) => s.id !== event.sessionId);
      const activeSessionId =
        state.activeSessionId === event.sessionId
          ? (sessions[sessions.length - 1]?.id ?? null)
          : state.activeSessionId;
      return {
        ...state,
        sessions,
        transcripts,
        commandsBySession,
        activePlan,
        contextChips,
        sessionModes,
        sessionConfigOptions,
        activeSessionId,
      };
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
    case "capabilitiesDeclared":
      return {
        ...state,
        capabilities: reduceCapabilities(state.capabilities, event),
        capabilitiesResetAt: reduceCapabilitiesResetAt(state.capabilitiesResetAt, event),
      };
    case "capabilityVerified":
      return { ...state, capabilities: reduceCapabilities(state.capabilities, event) };
    case "usageReported":
      return {
        ...state,
        sessionUsage: {
          ...state.sessionUsage,
          [event.sessionId]: { used: event.used, size: event.size, cost: event.cost },
        },
      };
    case "permissionRequested":
      return appendBlock(state, event.sessionId, {
        kind: "permission",
        id: event.blockId,
        title: event.title,
        detail: event.detail,
        options: event.options,
        resolution: null,
      });
    case "permissionResolved":
      return patchBlock<PermissionBlock>(state, event.sessionId, event.blockId, (b) => ({
        ...b,
        resolution: { label: event.label, auto: event.auto },
      }));
    case "diffProposed":
      return appendBlock(state, event.sessionId, {
        kind: "diff",
        id: event.blockId,
        file: event.file,
        additions: event.additions,
        deletions: event.deletions,
        lines: event.lines,
        resolution: null,
      });
    case "diffResolved":
      return patchBlock<DiffBlock>(state, event.sessionId, event.blockId, (b) => ({
        ...b,
        resolution: { accepted: event.accepted, auto: event.auto },
      }));
    case "terminalStarted":
      return appendBlock(state, event.sessionId, {
        kind: "terminal",
        id: event.blockId,
        command: event.command,
        output: "",
        running: true,
        exitCode: null,
      });
    case "terminalOutputAppended":
      return patchBlock<TerminalBlock>(state, event.sessionId, event.blockId, (b) => ({
        ...b,
        output: b.output + event.chunk,
      }));
    case "terminalExited":
      return patchBlock<TerminalBlock>(state, event.sessionId, event.blockId, (b) => ({
        ...b,
        running: false,
        exitCode: event.exitCode,
      }));
    case "elicitationRequested":
      return appendBlock(state, event.sessionId, {
        kind: "elicitation",
        id: event.blockId,
        message: event.message,
        fields: event.fields,
        resolution: null,
      });
    case "elicitationResolved":
      return patchBlock<ElicitationBlock>(state, event.sessionId, event.blockId, (b) => ({
        ...b,
        resolution: { cancelled: event.cancelled },
      }));
    case "contextChipAdded":
      return {
        ...state,
        contextChips: {
          ...state.contextChips,
          [event.sessionId]: [...(state.contextChips[event.sessionId] ?? []), event.chip],
        },
      };
    case "contextChipRemoved":
      return {
        ...state,
        contextChips: {
          ...state.contextChips,
          [event.sessionId]: (state.contextChips[event.sessionId] ?? []).filter(
            (c) => c.id !== event.chipId,
          ),
        },
      };
    case "sessionModesSet":
      return { ...state, sessionModes: { ...state.sessionModes, [event.sessionId]: event.modes } };
    case "sessionModeChanged": {
      const existing = state.sessionModes[event.sessionId];
      if (!existing) return state; // no modes state to update — stale or unsupported
      return {
        ...state,
        sessionModes: {
          ...state.sessionModes,
          [event.sessionId]: { ...existing, currentModeId: event.modeId },
        },
      };
    }
    case "sessionConfigOptionsChanged":
      return {
        ...state,
        sessionConfigOptions: { ...state.sessionConfigOptions, [event.sessionId]: event.options },
      };
    case "transcriptSeeded":
      return withTranscript(state, event.sessionId, event.blocks);
    default:
      return state; // events belonging only to the settings channel (same shared union)
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
  // Usage can report mid-stream (claude-agent-acp does) — only the latest matters.
  if (
    prev.kind === "usageReported" &&
    next.kind === "usageReported" &&
    prev.sessionId === next.sessionId
  ) {
    return next;
  }
  // Terminal output streams in small chunks — concatenate per block, same as text.
  if (
    prev.kind === "terminalOutputAppended" &&
    next.kind === "terminalOutputAppended" &&
    prev.sessionId === next.sessionId &&
    prev.blockId === next.blockId
  ) {
    return { ...next, chunk: prev.chunk + next.chunk };
  }
  return null;
};

// ── settings channel ─────────────────────────────────────────────────────────

export interface CommandRuleView {
  pattern: string;
  verdict: "allow" | "ask" | "deny";
}

export type FileWriteScopeView = "workspace" | "workspace+temp" | "always-ask";

export interface AuditEntryView {
  ts: string;
  kind: string;
  [key: string]: unknown;
}

export interface SettingsState {
  agents: readonly AgentSummary[];
  roster: readonly RosterEntry[];
  capabilities: Readonly<Record<string, CapabilityMatrix>>;
  capabilitiesResetAt: Readonly<Record<string, string>>;
  commandRules: readonly CommandRuleView[];
  fileWriteScope: FileWriteScopeView;
  auditTail: readonly AuditEntryView[];
  pendingAdoptions: readonly WorkspaceAgentPending[];
  integrationRegistry: readonly RegistryEntryView[];
  integrations: readonly IntegrationView[];
  /** Keyed by registryId while a device-flow connect is in flight or just
   * failed; cleared once `integrationsChanged` reports it connected. */
  deviceFlow: Readonly<Record<string, DeviceFlowView>>;
  /** Keyed by agentId — populated as each connects (and on-demand refresh). */
  assets: Readonly<Record<string, AgentAssetsView>>;
}

export const initialSettingsState: SettingsState = {
  agents: [],
  roster: [],
  capabilities: {},
  capabilitiesResetAt: {},
  commandRules: [],
  fileWriteScope: "workspace",
  auditTail: [],
  pendingAdoptions: [],
  integrationRegistry: [],
  integrations: [],
  deviceFlow: {},
  assets: {},
};

export type SettingsEvent =
  | AgentViewEvent
  | {
      kind: "permissionRulesChanged";
      commandRules: readonly CommandRuleView[];
      fileWriteScope: FileWriteScopeView;
    }
  | { kind: "auditTailChanged"; entries: readonly AuditEntryView[] }
  | { kind: "integrationRegistryLoaded"; entries: readonly RegistryEntryView[] }
  | { kind: "integrationsChanged"; integrations: readonly IntegrationView[] }
  | {
      kind: "integrationDeviceCodeIssued";
      registryId: string;
      userCode: string;
      verificationUri: string;
      expiresIn: number;
    }
  | { kind: "integrationConnectFailed"; registryId: string; reason: string }
  | { kind: "agentAssetsChanged"; assets: AgentAssetsView };

export function reduceSettings(
  state: SettingsState,
  event: SettingsEvent,
): SettingsState {
  switch (event.kind) {
    case "agentUpserted":
    case "agentRemoved":
    case "agentStatusChanged":
      return { ...state, agents: reduceAgents(state.agents, event) };
    case "capabilitiesDeclared":
      return {
        ...state,
        capabilities: reduceCapabilities(state.capabilities, event),
        capabilitiesResetAt: reduceCapabilitiesResetAt(state.capabilitiesResetAt, event),
      };
    case "capabilityVerified":
      return { ...state, capabilities: reduceCapabilities(state.capabilities, event) };
    case "permissionRulesChanged":
      return { ...state, commandRules: event.commandRules, fileWriteScope: event.fileWriteScope };
    case "auditTailChanged":
      return { ...state, auditTail: event.entries };
    case "workspaceAgentPending":
      return state.pendingAdoptions.some((a) => a.agentId === event.agent.agentId)
        ? state
        : { ...state, pendingAdoptions: [...state.pendingAdoptions, event.agent] };
    case "workspaceAgentAdopted":
      return {
        ...state,
        pendingAdoptions: state.pendingAdoptions.filter((a) => a.agentId !== event.agentId),
      };
    case "integrationRegistryLoaded":
      return { ...state, integrationRegistry: event.entries };
    case "integrationsChanged": {
      // A connected registry-backed integration retires its device-flow card.
      const connectedRegistryIds = new Set(
        event.integrations.filter((i) => i.connected && i.registryId).map((i) => i.registryId!),
      );
      const deviceFlow = Object.fromEntries(
        Object.entries(state.deviceFlow).filter(([registryId]) => !connectedRegistryIds.has(registryId)),
      );
      return { ...state, integrations: event.integrations, deviceFlow };
    }
    case "integrationDeviceCodeIssued":
      return {
        ...state,
        deviceFlow: {
          ...state.deviceFlow,
          [event.registryId]: {
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            expiresIn: event.expiresIn,
            status: "pending",
          },
        },
      };
    case "integrationConnectFailed": {
      const existing = state.deviceFlow[event.registryId];
      if (!existing) return state;
      return {
        ...state,
        deviceFlow: {
          ...state.deviceFlow,
          [event.registryId]: { ...existing, status: "failed", reason: event.reason },
        },
      };
    }
    case "agentAssetsChanged":
      return { ...state, assets: { ...state.assets, [event.assets.agentId]: event.assets } };
    default:
      return state;
  }
}

const SETTINGS_ONLY_KINDS = new Set([
  "permissionRulesChanged",
  "auditTailChanged",
  "integrationRegistryLoaded",
  "integrationsChanged",
  "integrationDeviceCodeIssued",
  "integrationConnectFailed",
  "agentAssetsChanged",
]);

export const coalesceSettingsEvent: CoalesceHook<SettingsEvent> = (prev, next) => {
  if (SETTINGS_ONLY_KINDS.has(prev.kind) || SETTINGS_ONLY_KINDS.has(next.kind)) return null;
  return coalesceAgentViewEvent(prev as AgentViewEvent, next as AgentViewEvent);
};
