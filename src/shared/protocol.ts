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
  | { registryId: string } // an agent from the official ACP registry
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
  /** One intent, one click (P17): connect if needed — inside the chat pane
   * — then create and activate the session. The picker, the single-agent
   * "+", and the palette's New Session all land here. (Replaced
   * `newSession`, which assumed an already-running agent.) */
  | { kind: "startChat"; agentId: string }
  | { kind: "dismissChatConnect" }
  /** "Disconnect & erase all data" (P18) — explicit and user-triggered,
   * never a lifecycle side effect: the platform has no uninstall hook, so
   * a clean slate before uninstalling is the user's own deliberate act. */
  | { kind: "eraseAllData" }
  /** Wire log on/off (Audit page + status bar + palette command). Turning
   * it on goes through the orchestrator's disclosure prompt first — the
   * event confirming `active: true` arrives only after consent. */
  | { kind: "setWireLog"; active: boolean }
  /** Data page mount/refresh: recompute the storage inventory from the
   * live stores and answer with dataInventoryChanged. */
  | { kind: "refreshDataInventory" }
  | { kind: "switchSession"; sessionId: string }
  /** Open the session in its own editor panel, floated to a new (auxiliary)
   * window — detached from the sidebar, multi-screen usable. Does not touch
   * the shared active-session pointer. */
  | { kind: "detachSession"; sessionId: string }
  | { kind: "closeSession"; sessionId: string }
  /** `text` is the readable form (transcript + title derivation). `parts`,
   * when present, is the same content with inline file mentions kept
   * positional — the orchestrator turns each `fileRef` into a
   * `resource_link` content block *at its place in the prompt* instead of
   * a chip riding ahead of the prose. Absent for plain text prompts. */
  | { kind: "sendPrompt"; sessionId: string; text: string; parts?: readonly PromptPart[] }
  | { kind: "stopTurn"; sessionId: string }
  /** Remove one still-queued prompt (see QueuedPrompt) before it fires. */
  | { kind: "removeQueuedPrompt"; sessionId: string; promptId: string }
  | { kind: "verifyAgent"; agentId: string }
  | { kind: "resolvePermission"; requestId: string; optionId: string }
  | { kind: "resolveDiff"; requestId: string; accept: boolean }
  | { kind: "authenticateAgent"; agentId: string; methodId: string }
  /** Only ever offered when the agent declared `auth.logout` — the spec's
   * "Clients MUST NOT call it" otherwise holds by construction. */
  | { kind: "logoutAgent"; agentId: string }
  /** A registry `binary` distribution not yet cached locally always gates
   * on this — no checksum exists in the registry spec (binary-installer.ts),
   * so the first download of each (agent, version) needs an explicit,
   * visible confirmation, never a silent fetch-and-run. */
  | { kind: "confirmBinaryInstall"; agentId: string }
  | { kind: "cancelBinaryInstall"; agentId: string }
  | { kind: "upgradeAgent"; agentId: string }
  | { kind: "refreshRegistry" }
  /** `layer` picks which rule list (permission-rules.ts): "workspace"
   * (workspaceState, this repo, evaluated first) or "machine" (globalState,
   * every workspace, the fallback floor). */
  | { kind: "addCommandRule"; rule: CommandRuleView; layer: "workspace" | "machine" }
  | { kind: "removeCommandRule"; pattern: string; layer: "workspace" | "machine" }
  | { kind: "setFileWriteScope"; scope: FileWriteScopeView }
  /** Preferences (Settings § Preferences): partial patch in, the
   * orchestrator answers `preferencesChanged` with the complete stored
   * object — the webview never assumes its own write landed. */
  | { kind: "setPreferences"; patch: Partial<PreferencesView> }
  | { kind: "resolveElicitation"; requestId: string; values: Record<string, unknown> | null }
  | { kind: "addSelectionContext"; sessionId: string }
  | { kind: "addFileContext"; sessionId: string }
  | { kind: "addDiagnosticsContext"; sessionId: string }
  | { kind: "removeContextChip"; sessionId: string; chipId: string }
  | { kind: "reloadSession"; sessionId: string }
  /** One action for every knob — the UI never knows (render-only-webview)
   * whether a knob rides ACP's config-option surface or the legacy modes
   * fallback; the orchestrator's knob processor (knobs.ts) routes it. */
  | { kind: "setSessionKnob"; sessionId: string; knobId: string; value: string | boolean }
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
  /** Open a rendered mermaid SVG as an editor-area panel — the in-chat
   * fullscreen maxes out at the sidebar column; the files area is where a
   * big diagram can breathe. */
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
  /** The `@` mention picker's workspace tier: the webview never touches the
   * filesystem (render-only-webview) — it asks, the orchestrator runs
   * `workspace.findFiles` and answers with workspaceFilesListed. */
  | { kind: "queryWorkspaceFiles"; query: string };

/** A prompt sent while a turn was already in flight — held orchestrator-side
 * (session-manager bookkeeping, ephemeral) and fired when the turn ends. The
 * view carries it only to render removable pending rows; Stop clears the
 * whole queue. */
export interface QueuedPrompt {
  id: string;
  text: string;
  parts?: readonly PromptPart[];
}

/** One positional piece of a composed prompt (sendPrompt `parts`). */
export type PromptPart =
  | { kind: "text"; text: string }
  /** An inline `@file` mention — sent as a `resource_link` content block at
   * this position; the agent reads it through the brokered fs path itself. */
  | { kind: "fileRef"; path: string };

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
  /** Connect this agent when the window opens. Per-agent and opt-in —
   * superseded the native `acpPatchbay.defaultAgent` setting. */
  autoConnect: boolean;
  /** Per-agent session defaults, keyed by knob id (the agent's own
   * config-option id, or knobs.ts's MODE_KNOB_ID on the modes-fallback
   * surface) — never by semantic category, which ACP defines as UX-only.
   * Always the folded shape here; the store's legacy {mode, options} split
   * is folded at the orchestrator boundary (knobs.ts foldSeed). */
  defaults: KnobSeed;
  /** Present only for agents added from the official ACP registry — drives
   * the "update available" comparison against the registry's live version. */
  registrySource: AgentRegistrySourceView | null;
  /** `agentInfo.version` last captured at connect — what the used-
   * capability cache is actually keyed against (reality over the pinned
   * ask); null until connected at least once. */
  lastSeenVersion: string | null;
}

// ── integrations (architecture.md § Integrations) ───────────────────────────

/** Three reaches: "auto" = every fully-brokered agent (the safety gate);
 * an id list = exactly these agents; `{ except }` = the auto set minus the
 * listed agents. Excluding never widens reach — a less-than-brokered agent
 * stays outside the auto set whether or not it's listed. */
export type IntegrationRoutingView = "auto" | readonly string[] | { readonly except: readonly string[] };

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
  /** null = this category isn't mapped for this agent (asset-locations.ts) —
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
  /** The `auth_required` error's own message — the agent's login
   * instruction in its words. The only guidance that exists when an agent
   * declares no actionable auth method (Auggie logged out: "run `auggie
   * login` from your terminal"). Cleared with needsAuth. */
  authReason?: string;
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

/** One of `initialize`'s declared `authMethods` (ACP schema, stable).
 * `kind` discriminates what patchbay can do with it: "agent" (the wire's
 * absent/default `type`, stable — the agent handles auth itself via
 * `authenticate`) and "terminal-recipe" (a parseable `_meta["terminal-auth"]`
 * recipe — adopted extension, meta.ts; patchbay runs the recipe in a
 * VS Code terminal, never calls `authenticate` on it) are actionable.
 * The recipe itself stays orchestrator-side — the UI only needs to know
 * the method is runnable. "env_var" and "terminal" (the wire's UNSTABLE
 * `type` values without a recipe) are shown as declared, never wired to a
 * Log-in button, per "only stable calls are used." */
export interface AuthMethodView {
  id: string;
  name: string;
  /** The wire's optional `description` — stable on all method shapes, meant
   * for display; normalized to null when the agent omits it. */
  description: string | null;
  kind: "agent" | "terminal-recipe" | "env_var" | "terminal";
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
  sessionDelete: boolean;
  sessionClose: boolean;
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
  authMethods: readonly AuthMethodView[];
  /** `agentCapabilities.auth.logout` — the agent supports the stable
   * `logout` method; absent means "Clients MUST NOT call it". */
  authLogout: boolean;
}

// ── agent-view channel ───────────────────────────────────────────────────────

/** One agent of the official ACP registry, as patchbay presents it — the
 * registry record enriched with platform launch resolution and patchbay's
 * own code-table curation (asset locations, bypass-bridge observations).
 * The registry is the one source of agents (the pre-registry roster overlay
 * is gone — terminology followed: roster = registry, so the word "roster"
 * no longer exists in this codebase); custom commands remain the escape
 * hatch for anything it doesn't list. */
export interface RegistryAgentView {
  /** The registry's own id — also the config id an Add mints. */
  id: string;
  name: string;
  description: string;
  /** Registry icon as a data URI — fetched host-side and cached with the
   * registry snapshot (acp-registry.ts), so the webview renders it under the
   * already-authored `img-src data:` CSP and never talks to the CDN itself.
   * Null before the first successful fetch. */
  icon: string | null;
  /** rules/skills/commands locations known for this agent (asset-locations.ts
   * code table). */
  assetsMapped: boolean;
  /** A bridge observed to act on fs/terminal regardless of client capabilities. */
  knownBypassBridge: boolean;
  /** Not addable right now — no distribution published for this platform.
   * Shown on the Add Agent picker, never silently hidden. */
  unavailableReason: string | null;
  /** The registry's current version — compared against an added config's
   * own pinned version to drive "update available." */
  version: string;
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
  | "session.list"
  | "session.delete"
  | "session.close"
  | "mcp.http"
  | "mcp.sse"
  | "usage"
  | "concurrentSessions"
  | "auth"
  | "auth.logout";

export interface CapabilityCell {
  declared: boolean;
  used: boolean;
  /** Suspicion, not conviction: a wire fact that would have proven this row
   * rode a request that failed. Absent = never implicated; cleared forever
   * (for this agent version) by the first success — used wins. */
  suspect?: boolean;
}

export type CapabilityMatrix = Readonly<Record<CapabilityRowId, CapabilityCell>>;

export type CapabilityState = "not-declared" | "declared" | "used" | "suspect";

export function capabilityState(cell: CapabilityCell | undefined): CapabilityState {
  if (cell === undefined || !cell.declared) return "not-declared";
  if (cell.used) return "used";
  return cell.suspect === true ? "suspect" : "declared";
}

/** Removes one key from a keyed map, referentially lazily — the reducers'
 * agentRemoved cases use it so per-agent facts leave with their agent
 * instead of lingering as ghost entries (invisible — every renderer keys
 * off the agents list — but a snapshot should not carry state for an agent
 * that no longer exists). */
function dropKey<V>(record: Readonly<Record<string, V>>, key: string): Readonly<Record<string, V>> {
  if (!(key in record)) return record;
  const { [key]: _dropped, ...rest } = record;
  return rest;
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
  return (
    authMethods.some((m) => m.kind === "agent" || m.kind === "terminal-recipe") && !matrix.auth.used
  );
}

export interface SessionSummary {
  id: string;
  agentId: string;
  title: string;
  /** Turn in flight. */
  live: boolean;
  /** ISO time of the last activity — creation, prompt send, turn end, or
   * the agent's own session/list metadata, whichever is newest. The
   * drawer's sort key ("latest" = last activity, not creation). */
  updatedAt: string;
  /** A turn completed while this session wasn't the open one — the blue
   * dot. Reducer-derived (turnEnded on a non-active session), cleared by
   * activation; never persisted — a reload starts with nothing unread. */
  unseen?: boolean;
}

// ── session knobs (architecture.md § Session model, mode, effort) — one
// normalized list per session, produced only by the orchestrator's knob
// processor (knobs.ts). The webview renders it uniformly: it never sees the
// wire's modes/configOptions split, and display updates only from the
// agent's own state (a set-request's success is never trusted — bridges
// have returned success for rejected changes).

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

interface SessionKnobBase {
  id: string;
  name: string;
  description?: string;
  /** "model" | "mode" | "thought_level" | ... — agent-declared, UX-only
   * (glyph/placement); never a routing or correctness key. */
  category?: string;
}

export type SessionKnobView = SessionKnobBase &
  (
    | {
        type: "select";
        currentValue: string;
        options: readonly SessionConfigSelectValueView[] | readonly SessionConfigSelectGroupView[];
      }
    | { type: "boolean"; currentValue: boolean }
  );

/** A stored knob selection set — knob id → value. The persisted stores keep
 * a legacy {mode, options} split for old data; everything in memory and
 * every view uses this folded shape (knobs.ts foldSeed is the one door). */
export type KnobSeed = Readonly<Record<string, string | boolean>>;

// ── chat / transcript (render cache — rebuilt wholesale, never merged) ──────

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** A status that claims work is still happening — the spinner-truth
 * predicate. The one spelling of "not yet terminal": the orchestrator's
 * open-call worklist, the run summary, and the seeded-snapshot normalizer
 * all mean exactly this. */
export function isToolCallOpen(status: ToolCallStatus): boolean {
  return status === "pending" || status === "in_progress";
}

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
  /** True once the orchestrator has observed the owning turn end (any
   * stopReason but end_turn, or an error) while this call was still
   * pending/in_progress — set once, at that real event, never re-derived
   * from "is some turn active right now" (a later turn in the same session
   * must not resurrect an old turn's stalled call). A trailing
   * tool_call_update always wins: any fresh upsert clears it, since the
   * wire is still talking about this call after all. */
  interrupted: boolean;
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
 * blocks in the transcript (ui-rendering-strategy § Per-turn summary).
 *
 * Nullable trio = a boundary synthesized during session/load replay: the
 * turn's *structure* is recoverable from the wire (a turn ends where the
 * next user message begins), but its timing, stop reason, and usage were
 * observations made at the original PromptResponse and are not on the
 * replay wire — absent over fake, never re-attached from a patchbay-side
 * store (turns have no wire identity; an externally-continued session
 * would misalign every line). */
export interface TurnEndBlock {
  kind: "turnEnd";
  id: string;
  /** ISO — when the prompt was sent (send→stop is the duration basis;
   * deliberate: the ticker must fill the silence *before* a first chunk).
   * null = replay-synthesized boundary, timing never observed. */
  startedAt: string | null;
  /** ISO — when the PromptResponse (or the turn's error) was observed. */
  endedAt: string | null;
  /** ACP StopReason, or "error" when the turn threw — chip shown only when
   * not a clean end_turn. null = unknown (replay-synthesized). */
  stopReason: string | null;
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

/** A patchbay-authored transcript marker — system voice, never agent prose.
 * Exists for the honesty seams: e.g. the session/resume rung shows where
 * patchbay's cached view ends and the agent's unreplayed memory continues. */
export interface NoticeBlock {
  kind: "notice";
  id: string;
  text: string;
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
  | ElicitationBlock
  | NoticeBlock;

export interface AvailableCommand {
  name: string;
  description?: string;
  /** The agent's hint for the command's free-text input (ACP
   * UnstructuredCommandInput.hint) — shown in the slash menu. */
  inputHint?: string;
}

/** The in-pane connect state for a chat being started (P17): "+" on a
 * not-yet-running agent connects inside the chat pane itself — a
 * lightweight "Connecting…" resolving into the session, or a failure with
 * the specific reason and a Retry, never a bounce back to the empty state. */
export interface ChatConnectView {
  agentId: string;
  status: "connecting" | "failed";
  reason?: string;
  /** Present when the connect was triggered by opening an existing session
   * (a session click is a connect trigger — the running agent is the
   * session's prerequisite). Retry then re-opens that session instead of
   * minting a new one via startChat. */
  forSessionId?: string;
}

/** Machine-scoped behavior defaults (stores/preferences.ts — globalState,
 * non-sensitive). Read fresh orchestrator-side at each point of use
 * (store-truth); this view exists so the Preferences page can render and
 * edit them, and so the agent view can gate its own furniture (composer
 * stats). Declared above AgentViewState because initialAgentViewState
 * seeds from DEFAULT_PREFERENCES. */
export interface PreferencesView {
  /** System chime when a prompt turn finishes (host-side player — a
   * cancelled turn never chimes: the user was present to cancel it). */
  soundOnDone: boolean;
  /** What a fresh session's knobs are seeded from: the agent config's
   * defaults, or the last agent-confirmed combination on that agent
   * (stores/composer-knobs.ts, falling back to the defaults when none). */
  knobSource: "agent-default" | "last-session";
  /** Idle-release timer (session-manager reapIdle, condition 5) in
   * minutes; 0 disables the reaper entirely. */
  idleCloseMinutes: number;
  /** The composer's session-stats strip (prompts, tool calls, files,
   * context gauge) — pure render furniture, so hiding it loses nothing. */
  composerStats: boolean;
}

export const DEFAULT_PREFERENCES: PreferencesView = {
  soundOnDone: false,
  knobSource: "agent-default",
  idleCloseMinutes: 60,
  composerStats: true,
};

export interface AgentViewState {
  agents: readonly AgentSummary[];
  sessions: readonly SessionSummary[];
  activeSessionId: string | null;
  /** Non-null while a "+"-initiated chat is connecting or has failed —
   * cleared by success (the session activates), retry, or dismissal. */
  chatConnect: ChatConnectView | null;
  /** True while the startup restore is still settling (startup connects +
   * last-active-session reactivation, orchestrator.ts) — the rendering area
   * shows a loading page instead of flashing the empty state while the last
   * open session is on its way back. Seeded true only when a last-active
   * pointer exists; cleared by `startupSettled`. */
  restoring: boolean;
  /** The ACP registry's agents (acp-registry.ts) for the pickers. */
  registryAgents: readonly RegistryAgentView[];
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
  /** Prompts accepted mid-turn, waiting for the turn to end (QueuedPrompt).
   * Orchestrator-owned like everything else here — rendered as removable
   * pending rows above the composer. */
  promptQueue: Readonly<Record<string, readonly QueuedPrompt[]>>;
  /** Normalized knobs per session (knobs.ts is the only producer) — empty
   * when the agent offers none. */
  sessionKnobs: Readonly<Record<string, readonly SessionKnobView[]>>;
  /** User-added external context roots, per session (features.md § Chat —
   * workspace folders are always active and need no chip; these are the
   * removable, explicit ones). Passed to the agent as `additionalDirectories`.
   * ACP has no live-update request, but `session/load`/`session/resume` "set
   * the complete list" — so a change re-applies to a live session through an
   * in-place re-attach; only an agent declaring neither waits for the next
   * reload/branch. */
  contextRoots: Readonly<Record<string, readonly string[]>>;
  /** Workspace folders — the always-active roots every session gets as its
   * cwd baseline. Fixed and non-removable in the UI; shown so the roots chip
   * reflects reality instead of counting only the user-added extras. */
  workspaceRoots: readonly string[];
  /** Live IDE selection — the ghost chip's presence signal (ui.md: appears
   * only while the IDE has a selection). Position only; never the text. */
  liveSelection: LiveSelectionView | null;
  /** Currently open editor tabs — the `@` mention picker's source. */
  openEditors: readonly OpenEditorView[];
  /** The `@` mention picker's workspace tier — the latest
   * queryWorkspaceFiles answer (files and directories, ranked host-side).
   * `query` rides along so the picker can tell a stale answer from the one
   * matching what's typed now. */
  workspaceFiles: { query: string; files: readonly string[]; dirs: readonly string[] };
  /** The stored preferences truth as of the last preferencesChanged —
   * same event feeds the Settings channel; the agent view reads only what
   * gates its own rendering (composerStats). */
  preferences: PreferencesView;
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
  /** The source's uri where one exists (file/selection — selection carries
   * its line range as a `#L` fragment); absent for aggregates like
   * diagnostics. Rides the embedded-resource prompt form when the agent
   * declares `promptCapabilities.embeddedContext`. */
  sourceUri?: string;
  /** Set only for kind "image" — paste is never disabled (features.md § Chat),
   * so this rides the same chip mechanism as every other explicit context add,
   * sent as a real ImageContent block regardless of what the agent declares. */
  mimeType?: string;
}

export const initialAgentViewState: AgentViewState = {
  agents: [],
  sessions: [],
  activeSessionId: null,
  chatConnect: null,
  restoring: false,
  registryAgents: [],
  transcripts: {},
  activePlan: {},
  activeTurn: {},
  commandsBySession: {},
  capabilities: {},
  capabilitiesResetAt: {},
  authMethods: {},
  sessionUsage: {},
  contextChips: {},
  promptQueue: {},
  sessionKnobs: {},
  contextRoots: {},
  workspaceRoots: [],
  liveSelection: null,
  openEditors: [],
  workspaceFiles: { query: "", files: [], dirs: [] },
  preferences: DEFAULT_PREFERENCES,
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
  | { kind: "chatConnectStarted"; agentId: string; forSessionId?: string }
  | { kind: "chatConnectFailed"; agentId: string; reason: string; forSessionId?: string }
  | { kind: "chatConnectResolved" }
  /** The startup restore settled — restored, or found nothing to restore
   * (stale pointer, failed connects); either way `restoring` clears and the
   * rendering area stops holding the loading page. */
  | { kind: "startupSettled" }
  | { kind: "sessionCreated"; session: SessionSummary }
  /** A session surfaced by the agent's own `session/list` (or refreshed by a
   * later sync) — upserts the row *without* activating it or touching the
   * connect pane, unlike sessionCreated: a connect-time sync of N history
   * rows must not steal focus. `live` is advisory on update (existing rows
   * keep their own). */
  | { kind: "sessionListed"; session: SessionSummary }
  | { kind: "sessionActivated"; sessionId: string }
  | { kind: "sessionRenamed"; sessionId: string; title: string }
  | { kind: "sessionClosed"; sessionId: string }
  | { kind: "sessionLiveChanged"; sessionId: string; live: boolean }
  /** Replay always wins — the transcript is discarded, never merged. */
  | { kind: "transcriptReset"; sessionId: string }
  | { kind: "userMessageAppended"; sessionId: string; blockId: string; text: string }
  /** Replayed user prose (session/load `user_message_chunk`) — delta
   * semantics like the agent chunks, unlike `userMessageAppended` (the
   * live send, which is whole by construction). */
  | { kind: "userTextDelta"; sessionId: string; blockId: string; text: string }
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
  /** The owning turn ended (non-end_turn stop reason, or error) while this
   * call was still open — session-manager's turn-end sweep, the tool-call
   * analogue of broker.cancelPending for permission requests. */
  | { kind: "toolCallInterrupted"; sessionId: string; blockId: string }
  /** Replaces the session's pinned plan snapshot — never a transcript block. */
  | { kind: "planUpdated"; sessionId: string; entries: readonly PlanEntry[] }
  /** A prompt turn began (send time) / resolved — the turnEnd block carries
   * both timestamps so the reducer never has to reconstruct them. The
   * nullable trio is the replay-synthesized boundary (see TurnEndBlock):
   * `at: null` also tells the reducer this is history landing, not news —
   * no updatedAt bump, no unseen dot. */
  | { kind: "turnStarted"; sessionId: string; at: string }
  | {
      kind: "turnEnded";
      sessionId: string;
      blockId: string;
      startedAt: string | null;
      at: string | null;
      stopReason: string | null;
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
  /** A prompt landed while a turn was in flight — queued, not refused. */
  | { kind: "promptQueued"; sessionId: string; prompt: QueuedPrompt }
  /** One queued prompt left the queue — fired (drain) or removed by hand. */
  | { kind: "promptUnqueued"; sessionId: string; promptId: string }
  /** Stop means stop: the whole queue goes with the cancelled turn. */
  | { kind: "promptQueueCleared"; sessionId: string }
  /** Full replace, always — every knob-bearing wire fact (a create/load/fork
   * response, a config_option_update or current_mode_update notification, a
   * set_config_option response) lands here already normalized by knobs.ts. */
  | { kind: "sessionKnobsSet"; sessionId: string; knobs: readonly SessionKnobView[] }
  /** The resume rung's seed (cached view + seam notice) or a cannot-reopen
   * notice — the transcript is replaced wholesale, never merged: same
   * "replay always wins" rule as transcriptReset. */
  | { kind: "transcriptSeeded"; sessionId: string; blocks: readonly ChatBlock[] }
  /** Full replace — the current external-root list for a session. */
  | { kind: "contextRootsChanged"; sessionId: string; roots: readonly string[] }
  | { kind: "workspaceRootsChanged"; roots: readonly string[] }
  /** Full replace — live selection + open editors, coalesced to the latest. */
  | {
      kind: "editorContextChanged";
      selection: LiveSelectionView | null;
      openEditors: readonly OpenEditorView[];
    }
  /** Full replace — the answer to one queryWorkspaceFiles, echoing its query. */
  | { kind: "workspaceFilesListed"; query: string; files: readonly string[]; dirs: readonly string[] }
  /** Fired on every connect — replaces the agent's whole matrix (used
   * seeded from the persisted cache when the version matches, honestly
   * reset otherwise) and its declared auth methods. */
  | {
      kind: "capabilitiesDeclared";
      agentId: string;
      matrix: CapabilityMatrix;
      authMethods: readonly AuthMethodView[];
      /** The initialize response's negotiated protocol version. */
      protocolVersion: number;
      at: string;
    }
  | { kind: "capabilityUsed"; agentId: string; row: CapabilityRowId }
  | { kind: "capabilitySuspect"; agentId: string; row: CapabilityRowId }
  | {
      kind: "usageReported";
      sessionId: string;
      used: number;
      size: number;
      cost?: { amount: number; currency: string };
    }
  /** A real call (Verify's ephemeral session, or a real one) hit ACP's
   * `auth_required` — the agent needs `authenticate` before sessions work.
   * `reason` is the error's own message (agent-authored instruction),
   * null when the wire carried none. */
  | { kind: "agentAuthRequired"; agentId: string; reason: string | null }
  | { kind: "agentAuthResolved"; agentId: string }
  /** Full replace — the registry × overlay merge changed (refresh, or a new
   * version landed upstream). */
  | { kind: "registryChanged"; agents: readonly RegistryAgentView[]; fetchedAt: string }
  /** The complete stored preferences (never a patch) — one event, both
   * channels: the Preferences page renders it, the agent view gates its
   * composer stats on it. */
  | { kind: "preferencesChanged"; preferences: PreferencesView };

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
      return agents.map((a) =>
        a.id === event.agentId
          ? { ...a, needsAuth: true, authReason: event.reason ?? undefined }
          : a,
      );
    case "agentAuthResolved":
      return agents.map((a) =>
        a.id === event.agentId ? { ...a, needsAuth: false, authReason: undefined } : a,
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
    case "capabilityUsed": {
      // Used always implies declared — the single write path for both,
      // which is what lets rows with no initialize-time claim (usage,
      // concurrentSessions) go straight from not-declared to used. Writing
      // the whole cell also drops any suspect flag: success acquits.
      const matrix = capabilities[event.agentId];
      if (matrix === undefined) return capabilities;
      return {
        ...capabilities,
        [event.agentId]: { ...matrix, [event.row]: { declared: true, used: true } },
      };
    }
    case "capabilitySuspect": {
      // Suspicion implies declared too — the attempt is itself the claim
      // (a failed second session/new indicts concurrentSessions even though
      // no initialize-time claim exists). Never touches a used row: proof
      // already won, and pool.ts doesn't emit suspect over used anyway.
      const matrix = capabilities[event.agentId];
      if (matrix === undefined || matrix[event.row].used) return capabilities;
      return {
        ...capabilities,
        [event.agentId]: { ...matrix, [event.row]: { declared: true, used: false, suspect: true } },
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
  kind: "text" | "thought" | "user",
  delta: string,
): AgentViewState {
  const blocks = state.transcripts[sessionId] ?? [];
  const i = blocks.findIndex((b) => b.id === blockId);
  if (i === -1) {
    return appendBlock(state, sessionId, { kind, id: blockId, text: delta });
  }
  const existing = blocks[i] as TextBlock | ThoughtBlock | UserBlock;
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
      interrupted: false,
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
    // A trailing tool_call_update still wins (acp-compliance.md §7): the
    // wire is still talking about this call, so the "abandoned" guess is
    // no longer the freshest fact.
    interrupted: false,
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
    case "agentStatusChanged":
    case "agentAuthRequired":
    case "agentAuthResolved":
      return { ...state, agents: reduceAgents(state.agents, event) };
    case "agentRemoved":
      // Per-agent facts leave with their agent — no ghost entries.
      return {
        ...state,
        agents: reduceAgents(state.agents, event),
        capabilities: dropKey(state.capabilities, event.agentId),
        capabilitiesResetAt: dropKey(state.capabilitiesResetAt, event.agentId),
        authMethods: dropKey(state.authMethods, event.agentId),
      };
    case "registryChanged":
      // The agent view needs only the list; the settings channel also keeps
      // the snapshot's fetchedAt for the Add Agent card's freshness line.
      return { ...state, registryAgents: event.agents };
    case "chatConnectStarted":
      return { ...state, chatConnect: { agentId: event.agentId, status: "connecting", forSessionId: event.forSessionId } };
    case "chatConnectFailed":
      return { ...state, chatConnect: { agentId: event.agentId, status: "failed", reason: event.reason, forSessionId: event.forSessionId } };
    case "chatConnectResolved":
      return { ...state, chatConnect: null };
    case "startupSettled":
      return { ...state, restoring: false };
    case "sessionCreated":
      return {
        ...state,
        sessions: [...state.sessions, event.session],
        transcripts: { ...state.transcripts, [event.session.id]: [] },
        commandsBySession: { ...state.commandsBySession, [event.session.id]: [] },
        contextChips: { ...state.contextChips, [event.session.id]: [] },
        sessionKnobs: { ...state.sessionKnobs, [event.session.id]: [] },
        contextRoots: { ...state.contextRoots, [event.session.id]: [] },
        activeSessionId: event.session.id,
        // A session arriving ends any in-pane connect, success or stale
        // failure alike — cleared here so it can't desync from reality.
        chatConnect: null,
      };
    case "sessionListed": {
      const existing = state.sessions.find((s) => s.id === event.session.id);
      if (existing !== undefined) {
        // Refresh the summary facts; `live` stays whatever the row already
        // knows — a list sync is metadata, not a liveness signal. Activity
        // time: newest wins — the wire's stamp may trail a local prompt.
        return {
          ...state,
          sessions: state.sessions.map((s) =>
            s.id === event.session.id
              ? {
                  ...s,
                  title: event.session.title,
                  updatedAt:
                    event.session.updatedAt > s.updatedAt ? event.session.updatedAt : s.updatedAt,
                }
              : s,
          ),
        };
      }
      return {
        ...state,
        sessions: [...state.sessions, event.session],
        transcripts: { ...state.transcripts, [event.session.id]: [] },
        commandsBySession: { ...state.commandsBySession, [event.session.id]: [] },
        contextChips: { ...state.contextChips, [event.session.id]: [] },
        sessionKnobs: { ...state.sessionKnobs, [event.session.id]: [] },
        contextRoots: { ...state.contextRoots, [event.session.id]: [] },
      };
    }
    case "sessionActivated":
      return state.sessions.some((s) => s.id === event.sessionId)
        ? {
            ...state,
            activeSessionId: event.sessionId,
            // opening it is what "seen" means
            sessions: state.sessions.map((s) =>
              s.id === event.sessionId && s.unseen === true ? { ...s, unseen: undefined } : s,
            ),
          }
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
      const { [event.sessionId]: _k, ...sessionKnobs } = state.sessionKnobs;
      const { [event.sessionId]: _r, ...contextRoots } = state.contextRoots;
      const { [event.sessionId]: _u, ...sessionUsage } = state.sessionUsage;
      const { [event.sessionId]: _q, ...promptQueue } = state.promptQueue;
      const sessions = state.sessions.filter((s) => s.id !== event.sessionId);
      // Closing the active session lands on home ("+ New chat"), never on a
      // sibling: a session click is the one hydrate/connect trigger, so a
      // silently auto-activated row would render its title over an empty pane.
      const activeSessionId =
        state.activeSessionId === event.sessionId ? null : state.activeSessionId;
      return {
        ...state,
        sessions,
        transcripts,
        commandsBySession,
        activePlan,
        activeTurn,
        contextChips,
        sessionKnobs,
        contextRoots,
        sessionUsage,
        promptQueue,
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
    case "userTextDelta":
      return upsertTextBlock(state, event.sessionId, event.blockId, "user", event.text);
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
    case "toolCallInterrupted":
      return patchBlock<ToolCallBlock>(state, event.sessionId, event.blockId, (b) => ({
        ...b,
        interrupted: true,
      }));
    case "planUpdated":
      return { ...state, activePlan: { ...state.activePlan, [event.sessionId]: event.entries } };
    case "turnStarted":
      return {
        ...state,
        activeTurn: { ...state.activeTurn, [event.sessionId]: event.at },
        // "latest" = last activity: a prompt send is the freshest fact there is
        sessions: state.sessions.map((s) =>
          s.id === event.sessionId ? { ...s, updatedAt: event.at } : s,
        ),
      };
    case "turnEnded": {
      const { [event.sessionId]: _t, ...activeTurn } = state.activeTurn;
      const appended = appendBlock(state, event.sessionId, {
        kind: "turnEnd",
        id: event.blockId,
        startedAt: event.startedAt,
        endedAt: event.at,
        stopReason: event.stopReason,
        usage: event.usage,
      });
      // Replay-synthesized boundary (at: null): history landing, not news —
      // the block appends, but "latest activity" and the unseen dot are
      // live-turn facts and must not fire off a load replay.
      if (event.at === null) return { ...appended, activeTurn };
      const at = event.at;
      return {
        ...appended,
        activeTurn,
        // A turn finished while the user was looking elsewhere → the blue
        // dot (unseen) until the session is next activated. Watching it
        // complete counts as seen.
        sessions: state.sessions.map((s) =>
          s.id === event.sessionId
            ? { ...s, updatedAt: at, unseen: state.activeSessionId !== event.sessionId || undefined }
            : s,
        ),
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
    case "capabilitySuspect":
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
    case "promptQueued":
      return {
        ...state,
        promptQueue: {
          ...state.promptQueue,
          [event.sessionId]: [...(state.promptQueue[event.sessionId] ?? []), event.prompt],
        },
      };
    case "promptUnqueued":
      return {
        ...state,
        promptQueue: {
          ...state.promptQueue,
          [event.sessionId]: (state.promptQueue[event.sessionId] ?? []).filter(
            (q) => q.id !== event.promptId,
          ),
        },
      };
    case "promptQueueCleared": {
      const { [event.sessionId]: _q, ...promptQueue } = state.promptQueue;
      return { ...state, promptQueue };
    }
    case "sessionKnobsSet":
      return { ...state, sessionKnobs: { ...state.sessionKnobs, [event.sessionId]: event.knobs } };
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
                // A persisted still-open snapshot survives a reload with no
                // live turn behind it — the render-only webview holds no
                // turn state across reloads, so stale opens from a prior
                // session are interrupted on sight, same as the
                // orchestrator's own turn-end sweep.
                interrupted: b.interrupted ?? isToolCallOpen(b.status),
              }
            : b,
        ),
      );
    case "contextRootsChanged":
      return { ...state, contextRoots: { ...state.contextRoots, [event.sessionId]: event.roots } };
    case "workspaceRootsChanged":
      return { ...state, workspaceRoots: event.roots };
    case "editorContextChanged":
      return { ...state, liveSelection: event.selection, openEditors: event.openEditors };
    case "workspaceFilesListed":
      return { ...state, workspaceFiles: { query: event.query, files: event.files, dirs: event.dirs } };
    case "preferencesChanged":
      return { ...state, preferences: event.preferences };
    default:
      return state; // events belonging only to the settings channel (same shared union)
  }
}

export const coalesceAgentViewEvent: CoalesceHook<AgentViewEvent> = (prev, next) => {
  // Concatenate text chunks per message (architecture.md § coalescing).
  if (
    (prev.kind === "agentTextDelta" && next.kind === "agentTextDelta") ||
    (prev.kind === "agentThoughtDelta" && next.kind === "agentThoughtDelta") ||
    (prev.kind === "userTextDelta" && next.kind === "userTextDelta")
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
  // Mention queries arrive per keystroke — only the latest answer matters.
  if (prev.kind === "workspaceFilesListed" && next.kind === "workspaceFilesListed") {
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

/** What this agent's *current connection* offers, knob-wise — connection
 * state, never persisted (architecture.md § Session model: offerings are
 * read, never stored — provider inventory can't be version-keyed honestly).
 * Sourced from the connect-time offering read (the free probe's session/new)
 * plus every live session's responses and update notifications; the entry
 * leaves settings state when the connection does. */
export interface AgentKnobsView {
  /** The normalized knob offering (knobs.ts): ids, names, and offered
   * values only — no current value, since offerings describe what the
   * connection can do, not any one session's state. */
  knobs: readonly {
    id: string;
    name: string;
    category?: string;
    type: "select" | "boolean";
    /** Offered values — empty for boolean options. */
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
  registryAgents: readonly RegistryAgentView[];
  capabilities: Readonly<Record<string, CapabilityMatrix>>;
  capabilitiesResetAt: Readonly<Record<string, string>>;
  /** Negotiated ACP protocol version per agent (initialize response) —
   * connection-level truth, refreshed per connect like the matrix. */
  agentProtocol: Readonly<Record<string, number>>;
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
   * `connectAgent` action as registry/custom (`{ configuredId }`). */
  agentConfigs: readonly AgentConfigView[];
  /** Stat tile: sessions created today (from the session index). */
  sessionsToday: number;
  /** Keyed by agentId — observed knob offerings (see AgentKnobsView). */
  agentKnobs: Readonly<Record<string, AgentKnobsView>>;
  /** ISO time of the last successful ACP registry fetch; "" = never. */
  registryFetchedAt: string;
  /** At most one at a time — the Add Agent flow blocks on it. */
  pendingBinaryInstall: PendingBinaryInstallView | null;
  /** Present while a Verify round-trip (manual click or "Verify after add")
   * is in flight for this agent — the card's Verify control dims and reads
   * "Verifying…" until it clears. */
  verifyingAgents: Readonly<Record<string, true>>;
  /** Wire log (Audit page): live state of the raw-frame tap. Never
   * persisted — debugging is a session act, a reload always starts clean. */
  wireLog: { active: boolean; until: string | null };
  /** Live storage inventory (Data page) — null until the first read; always
   * recomputed from the stores on request, never cached (reality is the
   * source of truth). */
  dataInventory: readonly DataInventoryRow[] | null;
  /** Preferences page snapshot — the stored truth as of the last
   * preferencesChanged; edits round-trip through setPreferences. */
  preferences: PreferencesView;
}

/** One row of the Data page's storage inventory — a store, where it lives
 * (the placement contract from architecture.md § State, stated as live
 * reality), and what's in it right now. */
export interface DataInventoryRow {
  id: string;
  label: string;
  placement: "globalState" | "workspaceState" | "SecretStorage" | "workspace storage";
  detail: string;
}

export const initialSettingsState: SettingsState = {
  agents: [],
  registryAgents: [],
  capabilities: {},
  capabilitiesResetAt: {},
  agentProtocol: {},
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
  registryFetchedAt: "",
  pendingBinaryInstall: null,
  verifyingAgents: {},
  wireLog: { active: false, until: null },
  dataInventory: null,
  preferences: DEFAULT_PREFERENCES,
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
  | { kind: "wireLogChanged"; active: boolean; until: string | null }
  | { kind: "dataInventoryChanged"; rows: readonly DataInventoryRow[] }
  | { kind: "binaryInstallPending"; install: PendingBinaryInstallView }
  | { kind: "binaryInstallResolved"; agentId: string }
  | { kind: "agentVerifyStarted"; agentId: string }
  | { kind: "agentVerifyFinished"; agentId: string };

export function reduceSettings(
  state: SettingsState,
  event: SettingsEvent,
): SettingsState {
  switch (event.kind) {
    case "agentStatusChanged":
      return {
        ...state,
        agents: reduceAgents(state.agents, event),
        // Offerings are connection state — they leave with the connection;
        // the next connect's offering read repopulates them fresh.
        ...(event.status !== "running"
          ? { agentKnobs: dropKey(state.agentKnobs, event.agentId) }
          : {}),
      };
    case "agentUpserted":
    case "agentAuthRequired":
    case "agentAuthResolved":
      return { ...state, agents: reduceAgents(state.agents, event) };
    case "agentRemoved":
      // Per-agent facts leave with their agent — no ghost entries.
      return {
        ...state,
        agents: reduceAgents(state.agents, event),
        capabilities: dropKey(state.capabilities, event.agentId),
        capabilitiesResetAt: dropKey(state.capabilitiesResetAt, event.agentId),
        agentProtocol: dropKey(state.agentProtocol, event.agentId),
        authMethods: dropKey(state.authMethods, event.agentId),
        assets: dropKey(state.assets, event.agentId),
        agentKnobs: dropKey(state.agentKnobs, event.agentId),
        verifyingAgents: dropKey(state.verifyingAgents, event.agentId),
      };
    case "registryChanged":
      return { ...state, registryAgents: event.agents, registryFetchedAt: event.fetchedAt };
    case "capabilitiesDeclared":
      return {
        ...state,
        capabilities: reduceCapabilities(state.capabilities, event),
        capabilitiesResetAt: reduceCapabilitiesResetAt(state.capabilitiesResetAt, event),
        agentProtocol: { ...state.agentProtocol, [event.agentId]: event.protocolVersion },
        authMethods: reduceAuthMethods(state.authMethods, event),
      };
    case "capabilityUsed":
    case "capabilitySuspect":
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
    case "wireLogChanged":
      return { ...state, wireLog: { active: event.active, until: event.until } };
    case "dataInventoryChanged":
      return { ...state, dataInventory: event.rows };
    case "preferencesChanged":
      return { ...state, preferences: event.preferences };
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
  "wireLogChanged",
  "dataInventoryChanged",
  "binaryInstallPending",
  "binaryInstallResolved",
  "agentVerifyStarted",
  "agentVerifyFinished",
]);

export const coalesceSettingsEvent: CoalesceHook<SettingsEvent> = (prev, next) => {
  if (SETTINGS_ONLY_KINDS.has(prev.kind) || SETTINGS_ONLY_KINDS.has(next.kind)) return null;
  return coalesceAgentViewEvent(prev as AgentViewEvent, next as AgentViewEvent);
};
