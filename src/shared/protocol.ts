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
  | { command: string } // custom command line that speaks ACP
  | { configuredId: string }; // a saved workspace agent config (Settings § Agents)

export type Action =
  | { kind: "openSettings" }
  /** `verifyAfterConnect` (Settings § Agents' "Verify after add", default
   * checked) auto-runs the free protocol-level Verify once the connection —
   * and any required login — succeeds. Absent → false (existing callers:
   * Agent View drawer, command palette, default-agent bootstrap). */
  | { kind: "connectAgent"; source: ConnectAgentSource; verifyAfterConnect?: boolean }
  | { kind: "restartAgent"; agentId: string }
  | { kind: "stopAgent"; agentId: string }
  | { kind: "newSession"; agentId: string }
  | { kind: "switchSession"; sessionId: string }
  | { kind: "renameSession"; sessionId: string; title: string }
  | { kind: "closeSession"; sessionId: string }
  | { kind: "sendPrompt"; sessionId: string; text: string }
  | { kind: "stopTurn"; sessionId: string }
  | { kind: "verifyAgent"; agentId: string }
  | { kind: "resolvePermission"; requestId: string; optionId: string }
  | { kind: "resolveDiff"; requestId: string; accept: boolean }
  | { kind: "authenticateAgent"; agentId: string; methodId: string }
  /** A registry `binary` distribution not yet cached locally always gates
   * on this — no checksum exists in the registry spec (binary-installer.ts),
   * so the first download of each (agent, version) needs an explicit,
   * visible confirmation, never a silent fetch-and-run. */
  | { kind: "confirmBinaryInstall"; agentId: string }
  | { kind: "cancelBinaryInstall"; agentId: string }
  | { kind: "upgradeAgent"; agentId: string }
  | { kind: "refreshRoster" }
  /** `layer` picks which rule list (permission-rules.ts): "workspace"
   * (workspaceState, this repo, evaluated first) or "machine" (globalState,
   * every workspace, the fallback floor). */
  | { kind: "addCommandRule"; rule: CommandRuleView; layer: "workspace" | "machine" }
  | { kind: "removeCommandRule"; pattern: string; layer: "workspace" | "machine" }
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
  | { kind: "connectRegistryKey"; registryId: string; token: string; url?: string }
  | { kind: "connectRegistryOAuth"; registryId: string; url?: string }
  /** `id` is generated orchestrator-side from the name (slug, uniquified) —
   * it's the storage/SecretStorage key, an internal concern the user never
   * names. */
  | {
      kind: "addCustomIntegration";
      name: string;
      source: IntegrationSourceView;
      routing: IntegrationRoutingView;
    }
  /** The well-known `{"mcpServers": {...}}` JSON (Claude Desktop / Cursor /
   * VS Code shape) — parsed orchestrator-side; each entry becomes a custom
   * server, failures labeled per entry. */
  | { kind: "importIntegrationsJson"; json: string }
  /** Replaces one custom server's config from its edited mcpServers-fragment
   * JSON. Env values are write-only: an empty value keeps the stored one. */
  | { kind: "updateIntegrationJson"; integrationId: string; json: string }
  /** Abandons an in-flight browser OAuth connect — the pending state clears
   * and nothing is stored (the browser tab, if still open, dies unanswered). */
  | { kind: "cancelIntegrationConnect"; integrationId: string }
  /** Disconnect and remove are the same act — the full clear (config +
   * credential + env). A curated entry then reappears in the catalog, ready
   * for a fresh connect; a custom one is simply gone. The non-destructive
   * option is the active toggle below. */
  | { kind: "removeIntegration"; integrationId: string }
  | { kind: "setIntegrationActive"; integrationId: string; active: boolean }
  | { kind: "setIntegrationRouting"; integrationId: string; routing: IntegrationRoutingView }
  | { kind: "shareIntegrationConfig"; integrationId: string }
  | { kind: "refreshAgentAssets"; agentId: string }
  | { kind: "openAssetFile"; agentId: string; path: string }
  /** Open an agent-reported tool-call diff in VS Code's native diff editor. */
  | { kind: "openToolCallDiff"; sessionId: string; toolCallId: string; path: string }
  /** Open a rendered mermaid SVG as an editor-area panel — full size,
   * outside the agent view's narrow column. */
  | { kind: "openDiagram"; svg: string }
  /** A webview-side runtime error (uncaught, rejection, CSP violation) —
   * logged to the Patchbay Output channel, the durable record the in-view
   * "errors (N)" chip points at. */
  | { kind: "reportWebviewError"; view: "agent-view" | "settings"; message: string }
  /** `env` is the form's submitted set — full desired key list, where an
   * empty value means "keep the stored value for this key". Values ride the
   * action upward only; state snapshots never carry them (envKeys only). */
  | { kind: "addOrUpdateAgentConfig"; config: AgentConfigView; env: Readonly<Record<string, string>> }
  | { kind: "removeAgentConfig"; agentId: string }
  | { kind: "addContextRoot"; sessionId: string }
  | { kind: "removeContextRoot"; sessionId: string; path: string }
  | { kind: "addImageContext"; sessionId: string; dataUrl: string; mimeType: string; label: string }
  | { kind: "addFilePickerContext"; sessionId: string }
  /** From the composer's `@` mention picker — attach an open editor's live
   * content (ui.md § Composer: "@ → context mention picker"). */
  | { kind: "addOpenEditorContext"; sessionId: string; path: string };

// ── Settings § Agents — agent launch config (features.md: "add, edit, and
// remove agents, including launch configuration per agent"). Agents are
// developer-env, not code-env: global to this machine (stores/
// agent-configs.ts), never repo-committed. Deliberately no per-workspace
// scoping — binding to workspaces (not repos) may return later as an
// opt-in; today global-only keeps one honest visibility rule. ──────────────

export interface AgentRegistrySourceView {
  registryId: string;
  distributionKind: "npx" | "uvx" | "binary";
  pinnedVersion: string;
}

export interface AgentConfigView {
  id: string;
  name: string;
  command: string;
  args: readonly string[];
  /** Env var *names* only — the values live in SecretStorage
   * (stores/agent-env.ts, no-secret-exposure.md) and never reach a webview
   * state snapshot; the Settings form edits them write-only. */
  envKeys: readonly string[];
  processPolicy: "auto" | "shared" | "isolated";
  /** Per-agent session defaults. `mode` targets the agent's SessionModeState;
   * `options` is keyed by the agent's own config-option *id* — never by
   * semantic category, which ACP defines as UX-only ("MUST NOT be required
   * for correctness. Clients MUST handle missing or unknown categories
   * gracefully."). */
  defaults: { mode?: string; options?: Readonly<Record<string, string>> };
  /** Present only for agents added from the official ACP registry — drives
   * the "update available" comparison against the roster's live version. */
  registrySource: AgentRegistrySourceView | null;
  /** `agentInfo.version` last captured at connect — what the used-
   * capability cache is actually keyed against (reality over the pinned
   * ask); null until connected at least once. */
  lastSeenVersion: string | null;
}

// ── integrations (architecture.md § Integrations) ───────────────────────────

export type IntegrationRoutingView = "auto" | readonly string[];

/** Payload for `addCustomIntegration` — the "any MCP server, command or URL,
 * with auth" escape hatch (features.md § Integrations). Registry-backed
 * integrations go through `connectRegistryKey`/`connectRegistryOAuth`
 * instead, since those drive a connect flow rather than taking a source
 * directly. Auth shapes per docs/reference-mcp-oauth.md: "header" is a
 * static key in a configurable header (`{headerName}: {valuePrefix}{key}`);
 * "oauth" is the MCP-spec OAuth 2.1 flow, URL-only. */
export type IntegrationSourceView =
  /** `env` values ride the add action upward once, straight into
   * SecretStorage (stores/secret-env.ts) — state snapshots never carry
   * them, same write-only rule as agent env. */
  | { kind: "custom-stdio"; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
  | {
      kind: "custom-http";
      url: string;
      authType: "none" | "header" | "oauth";
      headerName?: string;
      valuePrefix?: string;
      token?: string;
    };

export interface IntegrationView {
  id: string;
  name: string;
  sourceKind: "registry" | "custom-stdio" | "custom-http";
  registryId?: string;
  /** The launch line for a custom-stdio server, or the endpoint URL for a
   * custom-http one — shown mono on the card (ui.md § Integrations). */
  command?: string;
  /** A token exists in SecretStorage — never assumed from a pasted/shared
   * config (features.md's incident-driven rule: a shared config carries no
   * credential; connecting is always this user's own explicit act). */
  connected: boolean;
  /** The mute switch: inactive keeps config + credential but the server is
   * excluded from every agent's mcpServers until toggled back. */
  active: boolean;
  routing: IntegrationRoutingView;
  /** Present for custom servers only: the editable mcpServers-fragment JSON.
   * Env values never ride it — keys appear with "" (write-only: blank keeps
   * the stored value, filled overwrites, removed key deletes). */
  editJson?: string;
}

export interface RegistryEntryView {
  id: string;
  name: string;
  /** At least one auth mechanism is open to us and an endpoint can exist
   * (fixed or user-supplied). Figma remote is the honest false today. */
  connectable: boolean;
  /** Per-entry honesty, shown on the card (gated DCR, vendor prerequisites). */
  note: string;
  docsUrl: string;
  /** The user pastes their account's endpoint at connect (Supabase, Augment). */
  userUrl: boolean;
  /** Static-key mode offered — hint says where to get a key; keyUrl is the
   * issuing page, rendered as a clickable link ("" = none known). */
  headerAuth: { hint: string; keyUrl: string } | null;
  /** MCP-spec OAuth with open DCR verified for this vendor. */
  oauth: boolean;
  /** Verified official local server, offered as a prefill into the custom
   * add form (never auto-run). Two shapes: a stdio command (structured so
   * the prefill never re-parses a joined line; `envKeys` names the vars the
   * user must fill) or a local HTTP endpoint served by the vendor's own
   * desktop app (Figma). Null = none verified. */
  local:
    | { kind: "stdio"; command: string; args: readonly string[]; envKeys: readonly string[]; note: string }
    | { kind: "http"; url: string; note: string }
    | null;
}

/** Connect-in-flight state per registryId — "pending" while the browser
 * authorization is out, "failed" with the labeled reason; cleared by
 * `integrationsChanged` once connected. */
export interface ConnectFlowView {
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

/** `untested` = config exists, never initialized successfully at any
 * version (P16) — the arm `stopped` used to lie about. Connection status
 * lives here, NOT in the capability matrix: a `CapabilityCell` has no error
 * arm and its used-state is version-keyed persisted — a "connection" row
 * would light up for a dead process. This is live process state; the matrix
 * is durable proven-ness of the declared surface. */
export type AgentStatus = "untested" | "running" | "stopped" | "crashed" | "reconnecting";

export interface AgentSummary {
  id: string;
  name: string;
  status: AgentStatus;
  /** Human-readable status context, e.g. "exited 1 · 14:07". */
  detail?: string;
  /** The process's own last words (stderr tail), present on crash — the
   * reason readable inline, no Output panel required (P16). */
  stderr?: readonly string[];
  /** Launch command line as spawned (ui.md § Settings Agents — shown mono). */
  command?: string;
  /** True once a real call has hit ACP's `auth_required` for this
   * connection — cleared on a successful authenticate+retry, or on
   * disconnect. Distinct from the `auth` capability row: this is "blocked
   * right now," that row is "has this ever been used successfully." */
  needsAuth: boolean;
}

/** The live-selection indicator's data (ui.md § Composer — the ghost chip):
 * position only, never the text — the text is read host-side at the moment
 * the user solidifies it, not streamed on every cursor move. */
export interface LiveSelectionView {
  file: string;
  startLine: number;
  endLine: number;
}

export interface OpenEditorView {
  file: string;
  dirty: boolean;
}

/** One of `initialize`'s declared `authMethods` (ACP schema, stable). `kind`
 * discriminates by the wire's `type` field: "agent" (absent/default type,
 * stable — the agent handles auth itself via `authenticate`) is the only
 * one patchbay can act on; "env_var" and "terminal" are both UNSTABLE ACP
 * capabilities (may change/be removed) — shown as declared, never wired to
 * a Log-in button, per "only stable calls are used." */
export interface AuthMethodView {
  id: string;
  name: string;
  kind: "agent" | "env_var" | "terminal";
}

/**
 * What the agent *claims* at `initialize` — normalized from the handshake,
 * refreshed on every connect. A claim, not a fact: UI gates on used.
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
  authMethods: readonly AuthMethodView[];
}

// ── agent-view channel ───────────────────────────────────────────────────────

export interface RosterEntry {
  id: string;
  name: string;
  /** Registry description, or a local-only entry's installHint. */
  description: string;
  /** rules/skills/commands locations known for this agent (roster data). */
  assetsMapped: boolean;
  /** A bridge observed to act on fs/terminal regardless of client capabilities. */
  knownBypassBridge: boolean;
  /** Not addable right now — no distribution published for this platform,
   * or a registry id the registry hasn't (yet) returned. Shown on the Add
   * Agent picker, never silently hidden. */
  unavailableReason: string | null;
  /** Present only for registry-backed entries. */
  registryId: string | null;
  /** The registry's current version for this agent — compared against an
   * added config's own pinned version to drive "update available." */
  registryVersion: string | null;
}

// ── capability matrix (architecture.md § Agent capability matrix) ──────────
// Two states per capability: declared (the handshake's claim, refreshed every
// connect) and used (set only once the path actually fires on the wire —
// whether that's a real user action or patchbay's own free connectivity
// check; either way the RPC genuinely happened, hence "used" over "verified":
// a single successful round-trip proves the path fired, not that it's
// certified correct). A row with declared=false is "not declared" regardless
// of used (which cannot be true without declared — enforced by construction:
// every writer below only ever sets used on a row that was declared).

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
  | "concurrentSessions"
  | "auth";

export interface CapabilityCell {
  declared: boolean;
  used: boolean;
}

export type CapabilityMatrix = Readonly<Record<CapabilityRowId, CapabilityCell>>;

export type CapabilityState = "not-declared" | "declared" | "used";

export function capabilityState(cell: CapabilityCell | undefined): CapabilityState {
  if (cell === undefined || !cell.declared) return "not-declared";
  return cell.used ? "used" : "declared";
}

export type FidelityLabel = "fully-brokered" | "partially-brokered" | "acts-outside";

/**
 * Pure function of the matrix (architecture.md § Permission broker): fs and
 * terminal declared *and* used → fully brokered; a proper subset →
 * partially brokered; neither, or a known-bypass bridge → acts outside.
 * Never hand-assigned.
 */
export function computeFidelity(
  matrix: CapabilityMatrix,
  knownBypassBridge: boolean,
): FidelityLabel {
  if (knownBypassBridge) return "acts-outside";
  const brokered = (row: CapabilityRowId) => matrix[row].declared && matrix[row].used;
  const rows = [brokered("fs.readTextFile"), brokered("fs.writeTextFile"), brokered("terminal")];
  if (rows.every(Boolean)) return "fully-brokered";
  return rows.some(Boolean) ? "partially-brokered" : "acts-outside";
}

/**
 * True while the free protocol check (session/new + session/fork probe) still
 * has something it could resolve for this agent — the single predicate both
 * the automatic post-connect/reconnect retry (capability-tracker.ts's
 * `onDeclared`) and the Settings § Agents manual Verify control gate on, so
 * "does this still need a check" can never drift between the two call
 * sites. Only `session.fork` and `auth` are ever probed (capability-
 * verification.md's verification-cost split) — every other row is either
 * opportunistic or has no active check to retry.
 */
export function hasUnusedProbe(
  matrix: CapabilityMatrix,
  authMethods: readonly AuthMethodView[],
): boolean {
  if (matrix["session.fork"].declared && !matrix["session.fork"].used) return true;
  return authMethods.some((m) => m.kind === "agent") && !matrix.auth.used;
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

/** ACP's own tool-call taxonomy (ToolKind) — carried verbatim so the card
 * icon can pattern-match by kind instead of a generic spinner-only look. */
export type ToolCallKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface ToolCallBlock {
  kind: "toolCall";
  /** == the ACP toolCallId — one block, updated in place as status changes. */
  id: string;
  title: string;
  status: ToolCallStatus;
  toolKind: ToolCallKind;
  /** rawInput/rawOutput as bounded pretty-printed text (ui-rendering-strategy:
   * collapsed by default, expandable) — null when the agent never sent one.
   * Bounded at the source with an honest truncation marker, never silently. */
  input: string | null;
  output: string | null;
  /** File paths this call reported touching (ACP locations) — the per-turn
   * rollup's "N files" is the deduped set across edit/delete/move calls. */
  locations: readonly string[];
  /** Paths with agent-reported diff content (ToolCallContent type:"diff").
   * The texts stay orchestrator-side; expanding the card offers "Open
   * diff", routed to VS Code's native diff editor — never an inline diff
   * view (ui-rendering-strategy § tool call card design). */
  diffFiles: readonly string[];
  /** True once the permission broker rejected this call's own
   * session/request_permission — "blocked by permission" and "command
   * failed" are different facts, told apart at a glance. */
  denied: boolean;
}

/** The agent-reported token counts for one turn (PromptResponse.usage —
 * UNSTABLE in ACP and optional per agent). Absent entirely when not
 * reported: absence over fake, never a "—" placeholder. */
export interface TurnUsage {
  total: number;
  input: number;
  output: number;
  /** Cache-read tokens, when the agent breaks them out. */
  cached?: number;
}

/** Appended when a turn resolves — the per-turn metadata line's source.
 * Counts/files are NOT stored here: the rollup derives from the turn's own
 * blocks in the transcript (ui-rendering-strategy § Per-turn summary). */
export interface TurnEndBlock {
  kind: "turnEnd";
  id: string;
  /** ISO — when the prompt was sent (send→stop is the duration basis;
   * deliberate: the ticker must fill the silence *before* a first chunk). */
  startedAt: string;
  /** ISO — when the PromptResponse (or the turn's error) was observed. */
  endedAt: string;
  /** ACP StopReason, or "error" when the turn threw — chip shown only when
   * not a clean end_turn. */
  stopReason: string;
  usage: TurnUsage | null;
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
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
  | TurnEndBlock
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
  /** The pinned plan widget's source — the most recent plan snapshot, or
   * none. A plan is *session-level* state spanning many prompts
   * (ui-rendering-strategy § Plans): it never enters the per-turn
   * transcript, so an update replaces this snapshot instead of repeating a
   * card per turn. */
  activePlan: Readonly<Record<string, readonly PlanEntry[] | null>>;
  /** ISO start time of the in-flight turn, per session — the live elapsed
   * ticker's basis; cleared when the turn's TurnEndBlock lands. */
  activeTurn: Readonly<Record<string, string>>;
  commandsBySession: Readonly<Record<string, readonly AvailableCommand[]>>;
  /** Declared/used per agent — replaced wholesale on every (re)connect. */
  capabilities: Readonly<Record<string, CapabilityMatrix>>;
  /** ISO time of the last capabilitiesDeclared — powers the "reset <time>" chip. */
  capabilitiesResetAt: Readonly<Record<string, string>>;
  /** Declared auth methods per agent — the Log-in button's source (only
   * "agent"-kind methods are actionable; see AuthMethodView). */
  authMethods: Readonly<Record<string, readonly AuthMethodView[]>>;
  /** Present only once `usage` is used — absence over fake (ui.md § gauge). */
  sessionUsage: Readonly<Record<string, UsageInfo>>;
  /** Explicitly attached context, pending inclusion in the next prompt
   * (features.md § Chat: "explicitly add editor state to the prompt"). */
  contextChips: Readonly<Record<string, readonly ContextChip[]>>;
  /** Mode knob — absent (null) when the agent doesn't offer session modes. */
  sessionModes: Readonly<Record<string, SessionModesView | null>>;
  /** Model/effort/etc. knobs — empty when the agent offers none. */
  sessionConfigOptions: Readonly<Record<string, readonly SessionConfigOptionView[]>>;
  /** User-added external context roots, per session (features.md § Chat —
   * workspace folders are always active and need no chip; these are the
   * removable, explicit ones). Passed to the agent as `additionalDirectories`
   * on the next create/reload/fork — ACP has no live-update request, so
   * patchbay never claims one. */
  contextRoots: Readonly<Record<string, readonly string[]>>;
  /** Live IDE selection — the ghost chip's presence signal (ui.md: appears
   * only while the IDE has a selection). Position only; never the text. */
  liveSelection: LiveSelectionView | null;
  /** Currently open editor tabs — the `@` mention picker's source. */
  openEditors: readonly OpenEditorView[];
}

export interface UsageInfo {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}

export interface ContextChip {
  id: string;
  kind: "selection" | "file" | "diagnostics" | "image";
  label: string;
  /** Text content for selection/file/diagnostics; raw base64 payload for image. */
  content: string;
  /** Set only for kind "image" — paste is never disabled (features.md § Chat),
   * so this rides the same chip mechanism as every other explicit context add,
   * sent as a real ImageContent block regardless of what the agent declares. */
  mimeType?: string;
}

export const initialAgentViewState: AgentViewState = {
  agents: [],
  sessions: [],
  activeSessionId: null,
  roster: [],
  transcripts: {},
  activePlan: {},
  activeTurn: {},
  commandsBySession: {},
  capabilities: {},
  capabilitiesResetAt: {},
  authMethods: {},
  sessionUsage: {},
  contextChips: {},
  sessionModes: {},
  sessionConfigOptions: {},
  contextRoots: {},
  liveSelection: null,
  openEditors: [],
};

export type AgentViewEvent =
  | { kind: "agentUpserted"; agent: AgentSummary }
  | { kind: "agentRemoved"; agentId: string }
  | {
      kind: "agentStatusChanged";
      agentId: string;
      status: AgentStatus;
      detail?: string;
      /** stderr tail, riding crash statuses only. */
      stderr?: readonly string[];
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
      /** Absent = unspecified; reducer keeps the existing value (tool_call
       * carries these, tool_call_update only sometimes repeats them).
       * `locations`, when present, *replaces* — ACP defines the update's
       * locations field as a replacement of the collection. */
      toolKind?: ToolCallKind;
      input?: string;
      output?: string;
      locations?: readonly string[];
      diffFiles?: readonly string[];
    }
  /** The broker rejected this tool call's session/request_permission. */
  | { kind: "toolCallDenied"; sessionId: string; blockId: string }
  /** Replaces the session's pinned plan snapshot — never a transcript block. */
  | { kind: "planUpdated"; sessionId: string; entries: readonly PlanEntry[] }
  /** A prompt turn began (send time) / resolved — the turnEnd block carries
   * both timestamps so the reducer never has to reconstruct them. */
  | { kind: "turnStarted"; sessionId: string; at: string }
  | {
      kind: "turnEnded";
      sessionId: string;
      blockId: string;
      startedAt: string;
      at: string;
      stopReason: string;
      usage: TurnUsage | null;
    }
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
  /** Full replace — the current external-root list for a session. */
  | { kind: "contextRootsChanged"; sessionId: string; roots: readonly string[] }
  /** Full replace — live selection + open editors, coalesced to the latest. */
  | {
      kind: "editorContextChanged";
      selection: LiveSelectionView | null;
      openEditors: readonly OpenEditorView[];
    }
  /** Fired on every connect — replaces the agent's whole matrix (used
   * seeded from the persisted cache when the version matches, honestly
   * reset otherwise) and its declared auth methods. */
  | {
      kind: "capabilitiesDeclared";
      agentId: string;
      matrix: CapabilityMatrix;
      authMethods: readonly AuthMethodView[];
      at: string;
    }
  | { kind: "capabilityUsed"; agentId: string; row: CapabilityRowId }
  | {
      kind: "usageReported";
      sessionId: string;
      used: number;
      size: number;
      cost?: { amount: number; currency: string };
    }
  /** A real call (Verify's ephemeral session, or a real one) hit ACP's
   * `auth_required` — the agent needs `authenticate` before sessions work. */
  | { kind: "agentAuthRequired"; agentId: string }
  | { kind: "agentAuthResolved"; agentId: string }
  /** Full replace — the registry × overlay merge changed (refresh, or a new
   * version landed upstream). */
  | { kind: "rosterChanged"; roster: readonly RosterEntry[] };

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
      // stderr is overwritten, never merged — a recovery clears stale last words.
      return agents.map((a) =>
        a.id === event.agentId
          ? { ...a, status: event.status, detail: event.detail, stderr: event.stderr }
          : a,
      );
    case "agentAuthRequired":
      return agents.map((a) => (a.id === event.agentId ? { ...a, needsAuth: true } : a));
    case "agentAuthResolved":
      return agents.map((a) => (a.id === event.agentId ? { ...a, needsAuth: false } : a));
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
    case "capabilityUsed": {
      // Used always implies declared — the single write path for both,
      // which is what lets rows with no initialize-time claim (usage,
      // concurrentSessions) go straight from not-declared to used.
      const matrix = capabilities[event.agentId];
      if (matrix === undefined) return capabilities;
      return {
        ...capabilities,
        [event.agentId]: { ...matrix, [event.row]: { declared: true, used: true } },
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

function reduceAuthMethods(
  authMethods: Readonly<Record<string, readonly AuthMethodView[]>>,
  event: AgentViewEvent,
): Readonly<Record<string, readonly AuthMethodView[]>> {
  return event.kind === "capabilitiesDeclared"
    ? { ...authMethods, [event.agentId]: event.authMethods }
    : authMethods;
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
  event: Extract<AgentViewEvent, { kind: "toolCallUpserted" }>,
): AgentViewState {
  const blocks = state.transcripts[sessionId] ?? [];
  const i = blocks.findIndex((b) => b.id === event.blockId);
  if (i === -1) {
    return appendBlock(state, sessionId, {
      kind: "toolCall",
      id: event.blockId,
      title: event.title,
      status: event.status,
      toolKind: event.toolKind ?? "other",
      input: event.input ?? null,
      output: event.output ?? null,
      locations: event.locations ?? [],
      diffFiles: event.diffFiles ?? [],
      denied: false,
    });
  }
  const existing = blocks[i] as ToolCallBlock;
  // Absent fields keep what a prior event established — a bare status update
  // must never erase the kind or the input already shown.
  const updated: ToolCallBlock = {
    ...existing,
    status: event.status,
    title: event.title || existing.title,
    toolKind: event.toolKind ?? existing.toolKind,
    input: event.input ?? existing.input,
    output: event.output ?? existing.output,
    locations: event.locations ?? existing.locations,
    diffFiles: event.diffFiles ?? existing.diffFiles,
  };
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
    case "agentAuthRequired":
    case "agentAuthResolved":
      return { ...state, agents: reduceAgents(state.agents, event) };
    case "rosterChanged":
      return { ...state, roster: event.roster };
    case "sessionCreated":
      return {
        ...state,
        sessions: [...state.sessions, event.session],
        transcripts: { ...state.transcripts, [event.session.id]: [] },
        commandsBySession: { ...state.commandsBySession, [event.session.id]: [] },
        contextChips: { ...state.contextChips, [event.session.id]: [] },
        sessionModes: { ...state.sessionModes, [event.session.id]: null },
        sessionConfigOptions: { ...state.sessionConfigOptions, [event.session.id]: [] },
        contextRoots: { ...state.contextRoots, [event.session.id]: [] },
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
      const { [event.sessionId]: _a, ...activeTurn } = state.activeTurn;
      const { [event.sessionId]: _x, ...contextChips } = state.contextChips;
      const { [event.sessionId]: _m, ...sessionModes } = state.sessionModes;
      const { [event.sessionId]: _o, ...sessionConfigOptions } = state.sessionConfigOptions;
      const { [event.sessionId]: _r, ...contextRoots } = state.contextRoots;
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
        activeTurn,
        contextChips,
        sessionModes,
        sessionConfigOptions,
        contextRoots,
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
    case "transcriptReset": {
      // The strip mirrors only what the agent reports: a reset means replay
      // is about to rebuild the transcript, and the live plan rebuilds from
      // the same replay — a stale strip must not outlive its source. Same
      // for a stale ticker: no turn survives a transcript rebuild.
      const { [event.sessionId]: _a, ...activeTurn } = state.activeTurn;
      return {
        ...withTranscript(state, event.sessionId, []),
        activePlan: { ...state.activePlan, [event.sessionId]: null },
        activeTurn,
      };
    }
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
      return upsertToolCall(state, event.sessionId, event);
    case "toolCallDenied":
      return patchBlock<ToolCallBlock>(state, event.sessionId, event.blockId, (b) => ({
        ...b,
        denied: true,
      }));
    case "planUpdated":
      return { ...state, activePlan: { ...state.activePlan, [event.sessionId]: event.entries } };
    case "turnStarted":
      return { ...state, activeTurn: { ...state.activeTurn, [event.sessionId]: event.at } };
    case "turnEnded": {
      const { [event.sessionId]: _t, ...activeTurn } = state.activeTurn;
      return {
        ...appendBlock(state, event.sessionId, {
          kind: "turnEnd",
          id: event.blockId,
          startedAt: event.startedAt,
          endedAt: event.at,
          stopReason: event.stopReason,
          usage: event.usage,
        }),
        activeTurn,
      };
    }
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
        authMethods: reduceAuthMethods(state.authMethods, event),
      };
    case "capabilityUsed":
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
      // Seeded blocks come from the persisted last-known view, which may
      // predate fields the live block model has since grown — normalize
      // here, the one door stored data re-enters through, so the view never
      // meets a partial block.
      return withTranscript(
        state,
        event.sessionId,
        event.blocks.map((b) =>
          b.kind === "toolCall"
            ? {
                ...b,
                toolKind: b.toolKind ?? "other",
                input: b.input ?? null,
                output: b.output ?? null,
                locations: b.locations ?? [],
                diffFiles: b.diffFiles ?? [],
                denied: b.denied ?? false,
              }
            : b,
        ),
      );
    case "contextRootsChanged":
      return { ...state, contextRoots: { ...state.contextRoots, [event.sessionId]: event.roots } };
    case "editorContextChanged":
      return { ...state, liveSelection: event.selection, openEditors: event.openEditors };
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
  // Rapid-fire status updates on the same tool call: only the latest matters,
  // but absent fields inherit — same merge rule as the reducer's upsert.
  if (
    prev.kind === "toolCallUpserted" &&
    next.kind === "toolCallUpserted" &&
    prev.sessionId === next.sessionId &&
    prev.blockId === next.blockId
  ) {
    return {
      ...next,
      title: next.title || prev.title,
      toolKind: next.toolKind ?? prev.toolKind,
      input: next.input ?? prev.input,
      output: next.output ?? prev.output,
      locations: next.locations ?? prev.locations,
      diffFiles: next.diffFiles ?? prev.diffFiles,
    };
  }
  // Usage can report mid-stream (claude-agent-acp does) — only the latest matters.
  if (
    prev.kind === "usageReported" &&
    next.kind === "usageReported" &&
    prev.sessionId === next.sessionId
  ) {
    return next;
  }
  // Editor context changes on every cursor move — only the latest matters.
  if (prev.kind === "editorContextChanged" && next.kind === "editorContextChanged") {
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

/** What an agent has been observed to offer, knob-wise, across its sessions
 * (ui.md § Settings Agents: default knobs render "only where offered" —
 * an unoffered knob is a disabled "— not offered", never a free-text guess).
 * Sourced from real session/new|load|fork responses and update
 * notifications; empty until the agent's first session ever offers one. */
export interface AgentKnobsView {
  /** null until modes have ever been offered. */
  modes: readonly SessionModeOptionView[] | null;
  /** Select-type config options only — the shapes defaults can name. */
  options: readonly {
    id: string;
    name: string;
    category?: string;
    values: readonly { value: string; name: string }[];
  }[];
}

/** A registry `binary` distribution awaiting the one-time download
 * confirmation (no checksum exists in the registry spec — see
 * binary-installer.ts) before it's fetched and run. */
export interface PendingBinaryInstallView {
  agentId: string;
  name: string;
  archiveUrl: string;
  cmd: string;
}

export interface SettingsState {
  agents: readonly AgentSummary[];
  roster: readonly RosterEntry[];
  capabilities: Readonly<Record<string, CapabilityMatrix>>;
  capabilitiesResetAt: Readonly<Record<string, string>>;
  authMethods: Readonly<Record<string, readonly AuthMethodView[]>>;
  /** Workspace layer — evaluated first (permission-rules.ts). */
  commandRules: readonly CommandRuleView[];
  /** Machine layer — the fallback floor for every workspace on this machine. */
  machineCommandRules: readonly CommandRuleView[];
  fileWriteScope: FileWriteScopeView;
  auditTail: readonly AuditEntryView[];
  integrationRegistry: readonly RegistryEntryView[];
  integrations: readonly IntegrationView[];
  /** Keyed by registryId (or custom integration id) while a connect is in
   * flight or just failed; cleared once `integrationsChanged` reports it
   * connected. */
  connectFlow: Readonly<Record<string, ConnectFlowView>>;
  /** Keyed by agentId — populated as each connects (and on-demand refresh). */
  assets: Readonly<Record<string, AgentAssetsView>>;
  /** Agents (global, developer-env — never repo-committed): addable,
   * editable, removable from Settings; connecting one goes through the same
   * `connectAgent` action as roster/custom (`{ configuredId }`). */
  agentConfigs: readonly AgentConfigView[];
  /** Stat tile: sessions created today (from the session index). */
  sessionsToday: number;
  /** Keyed by agentId — observed knob offerings (see AgentKnobsView). */
  agentKnobs: Readonly<Record<string, AgentKnobsView>>;
  /** ISO time of the last successful ACP registry fetch; "" = never. */
  registryUpdatedAt: string;
  /** At most one at a time — the Add Agent flow blocks on it. */
  pendingBinaryInstall: PendingBinaryInstallView | null;
  /** Present while a Verify round-trip (manual click or "Verify after add")
   * is in flight for this agent — the card's Verify control dims and reads
   * "Verifying…" until it clears. */
  verifyingAgents: Readonly<Record<string, true>>;
}

export const initialSettingsState: SettingsState = {
  agents: [],
  roster: [],
  capabilities: {},
  capabilitiesResetAt: {},
  authMethods: {},
  commandRules: [],
  machineCommandRules: [],
  fileWriteScope: "workspace",
  auditTail: [],
  integrationRegistry: [],
  integrations: [],
  connectFlow: {},
  assets: {},
  agentConfigs: [],
  sessionsToday: 0,
  agentKnobs: {},
  registryUpdatedAt: "",
  pendingBinaryInstall: null,
  verifyingAgents: {},
};

export type SettingsEvent =
  | AgentViewEvent
  | {
      kind: "permissionRulesChanged";
      commandRules: readonly CommandRuleView[];
      machineCommandRules: readonly CommandRuleView[];
      fileWriteScope: FileWriteScopeView;
    }
  | { kind: "auditTailChanged"; entries: readonly AuditEntryView[] }
  | { kind: "integrationRegistryLoaded"; entries: readonly RegistryEntryView[] }
  | { kind: "integrationsChanged"; integrations: readonly IntegrationView[] }
  /** A browser-authorization connect is out — the card shows waiting state. */
  | { kind: "integrationConnectStarted"; registryId: string }
  | { kind: "integrationConnectFailed"; registryId: string; reason: string }
  /** In-flight/failed connect state cleared without an outcome — the
   * user cancelled a browser flow that will never answer. */
  | { kind: "integrationConnectResolved"; registryId: string }
  | { kind: "agentAssetsChanged"; assets: AgentAssetsView }
  | { kind: "agentConfigsChanged"; configs: readonly AgentConfigView[] }
  | { kind: "sessionStatsChanged"; sessionsToday: number }
  | { kind: "agentKnobsObserved"; agentId: string; knobs: AgentKnobsView }
  | { kind: "registryUpdated"; at: string }
  | { kind: "binaryInstallPending"; install: PendingBinaryInstallView }
  | { kind: "binaryInstallResolved"; agentId: string }
  | { kind: "agentVerifyStarted"; agentId: string }
  | { kind: "agentVerifyFinished"; agentId: string };

export function reduceSettings(
  state: SettingsState,
  event: SettingsEvent,
): SettingsState {
  switch (event.kind) {
    case "agentUpserted":
    case "agentRemoved":
    case "agentStatusChanged":
    case "agentAuthRequired":
    case "agentAuthResolved":
      return { ...state, agents: reduceAgents(state.agents, event) };
    case "rosterChanged":
      return { ...state, roster: event.roster };
    case "capabilitiesDeclared":
      return {
        ...state,
        capabilities: reduceCapabilities(state.capabilities, event),
        capabilitiesResetAt: reduceCapabilitiesResetAt(state.capabilitiesResetAt, event),
        authMethods: reduceAuthMethods(state.authMethods, event),
      };
    case "capabilityUsed":
      return { ...state, capabilities: reduceCapabilities(state.capabilities, event) };
    case "permissionRulesChanged":
      return {
        ...state,
        commandRules: event.commandRules,
        machineCommandRules: event.machineCommandRules,
        fileWriteScope: event.fileWriteScope,
      };
    case "auditTailChanged":
      return { ...state, auditTail: event.entries };
    case "registryUpdated":
      return { ...state, registryUpdatedAt: event.at };
    case "binaryInstallPending":
      return { ...state, pendingBinaryInstall: event.install };
    case "binaryInstallResolved":
      return state.pendingBinaryInstall?.agentId === event.agentId
        ? { ...state, pendingBinaryInstall: null }
        : state;
    case "agentVerifyStarted":
      return {
        ...state,
        verifyingAgents: { ...state.verifyingAgents, [event.agentId]: true },
      };
    case "agentVerifyFinished": {
      const { [event.agentId]: _v, ...rest } = state.verifyingAgents;
      return { ...state, verifyingAgents: rest };
    }
    case "integrationRegistryLoaded":
      return { ...state, integrationRegistry: event.entries };
    case "integrationsChanged": {
      // A connected integration retires its in-flight/failed connect card
      // (keyed by registryId for curated entries, by the integration's own
      // id for custom-http OAuth — currentViews reports both as connected).
      const connectedIds = new Set(
        event.integrations.filter((i) => i.connected).flatMap((i) => [i.id, i.registryId ?? i.id]),
      );
      const connectFlow = Object.fromEntries(
        Object.entries(state.connectFlow).filter(([id]) => !connectedIds.has(id)),
      );
      return { ...state, integrations: event.integrations, connectFlow };
    }
    case "integrationConnectStarted":
      return {
        ...state,
        connectFlow: { ...state.connectFlow, [event.registryId]: { status: "pending" } },
      };
    case "integrationConnectResolved": {
      const { [event.registryId]: _cleared, ...connectFlow } = state.connectFlow;
      return { ...state, connectFlow };
    }
    case "integrationConnectFailed":
      return {
        ...state,
        connectFlow: {
          ...state.connectFlow,
          [event.registryId]: { status: "failed", reason: event.reason },
        },
      };
    case "agentAssetsChanged":
      return { ...state, assets: { ...state.assets, [event.assets.agentId]: event.assets } };
    case "agentConfigsChanged":
      return { ...state, agentConfigs: event.configs };
    case "sessionStatsChanged":
      return { ...state, sessionsToday: event.sessionsToday };
    case "agentKnobsObserved":
      return { ...state, agentKnobs: { ...state.agentKnobs, [event.agentId]: event.knobs } };
    default:
      return state;
  }
}

const SETTINGS_ONLY_KINDS = new Set([
  "permissionRulesChanged",
  "auditTailChanged",
  "integrationRegistryLoaded",
  "integrationsChanged",
  "integrationConnectStarted",
  "integrationConnectFailed",
  "integrationConnectResolved",
  "agentAssetsChanged",
  "agentConfigsChanged",
  "sessionStatsChanged",
  "agentKnobsObserved",
  "registryUpdated",
  "binaryInstallPending",
  "binaryInstallResolved",
  "agentVerifyStarted",
  "agentVerifyFinished",
]);

export const coalesceSettingsEvent: CoalesceHook<SettingsEvent> = (prev, next) => {
  if (SETTINGS_ONLY_KINDS.has(prev.kind) || SETTINGS_ONLY_KINDS.has(next.kind)) return null;
  return coalesceAgentViewEvent(prev as AgentViewEvent, next as AgentViewEvent);
};
