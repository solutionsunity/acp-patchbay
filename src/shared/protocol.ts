// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The one protocol both sides import.
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
  | { configuredId: string }; // a saved workspace agent config (Settings Agents)

/** The Settings shell's section ids — protocol-level because the open
 * section is host-owned state (webviews rehydrate
 * from the orchestrator), and because openSettings deep-links by it. */
export type SettingsSectionId =
  | "agents"
  | "matrix"
  | "integrations"
  | "preferences"
  | "roots"
  | "permissions"
  | "audit"
  | "data";

/** Where a saved root lives: "workspace" — this workspace only
 * (workspaceState, never the repo), the default; "machine" — every
 * workspace on this machine. */
export type SavedRootScope = "workspace" | "machine";

/** The folders every new session starts with, beyond the workspace's own.
 * `workspace` is null in a window with no folder open: there is no
 * workspace to save to. `missing` names the saved folders gone from disk
 * as of the last read — each needs the user's action (restore or remove);
 * sessions skip them meanwhile. */
export interface SavedRootsView {
  workspace: readonly string[] | null;
  machine: readonly string[];
  missing: readonly string[];
}

export const NO_SAVED_ROOTS: SavedRootsView = { workspace: null, machine: [], missing: [] };

/** What both saving surfaces say where `workspace` is null. */
export const NO_WORKSPACE_TO_SAVE = "No folder open — there is no workspace to save to.";

export type Action =
  /** Opens (or reveals) the Settings panel; `section` additionally navigates
   * it — without it an already-open panel stays on whatever it showed, which
   * reads as a dead click from anywhere that promises a destination. */
  | { kind: "openSettings"; section?: SettingsSectionId }
  /** The Settings nav itself — section state lives host-side so a disposed
   * webview (hidden tab) comes back where the user left it. */
  | { kind: "setSettingsSection"; section: SettingsSectionId }
  /** `verifyAfterConnect` (Settings Agents' "Verify after add", default
   * checked) auto-runs the free protocol-level Verify once the connection —
   * and any required login — succeeds. Absent → false (existing callers:
   * Agent View drawer, command palette, default-agent bootstrap). */
  | { kind: "connectAgent"; source: ConnectAgentSource; verifyAfterConnect?: boolean }
  | { kind: "restartAgent"; agentId: string }
  | { kind: "stopAgent"; agentId: string }
  /** One intent, one click: connect if needed — inside the chat pane
   * — then create and activate the session. The picker, the single-agent
   * "+", and the palette's New Session all land here. (Replaced
   * `newSession`, which assumed an already-running agent.) */
  | { kind: "startChat"; agentId: string }
  | { kind: "dismissChatConnect" }
  /** "Disconnect & erase all data" — explicit and user-triggered,
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
  /** The user is about to read the session list (drawer opening): re-read
   * every running agent's own `session/list` so activity from another
   * window is on the rows — reality at the moment of need, never polled. */
  | { kind: "syncSessions" }
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
  /** `draft` is the composer's serialized editor state for these words —
   * kept only if the prompt is held (QueuedPrompt.draft), dropped on a
   * direct send. */
  | { kind: "sendPrompt"; sessionId: string; text: string; parts?: readonly PromptPart[]; draft?: string }
  | { kind: "stopTurn"; sessionId: string }
  /** Remove one still-queued prompt (see QueuedPrompt) before it fires. */
  | { kind: "removeQueuedPrompt"; sessionId: string; promptId: string }
  /** Take the tail of the queue back into the composer: the row leaves the
   * queue and its editor state becomes the session draft. Tail only — the
   * one row whose place a resend keeps — and only into an empty composer;
   * anything else is a no-op (Copy is the way to merge by hand). */
  | { kind: "reclaimQueuedPrompt"; sessionId: string; promptId: string }
  /** Debounced durable save of the composer's per-session draft. */
  | { kind: "setSessionDraft"; sessionId: string; draft: string }
  | { kind: "verifyAgent"; agentId: string }
  /** A Settings card's knob editor expanded (open) or collapsed — the
   * orchestrator's defaults editor opens/ends the throwaway session that
   * reads the agent's surface for the defaults being edited. */
  | { kind: "editAgentDefaults"; agentId: string; open: boolean }
  | { kind: "resolvePermission"; requestId: string; optionId: string }
  | { kind: "resolveDiff"; requestId: string; accept: boolean }
  | { kind: "authenticateAgent"; agentId: string; methodId: string }
  /** Only ever offered when the agent declared `auth.logout` — the spec's
   * "Clients MUST NOT call it" otherwise holds by construction. */
  | { kind: "logoutAgent"; agentId: string }
  | { kind: "upgradeAgent"; agentId: string }
  | { kind: "refreshRegistry" }
  /** `layer` picks which rule list (permission-rules.ts): "workspace"
   * (workspaceState, this repo, evaluated first) or "machine" (machine store,
   * every workspace, the fallback floor). */
  | { kind: "addCommandRule"; rule: CommandRuleView; layer: "workspace" | "machine" }
  | { kind: "removeCommandRule"; pattern: string; layer: "workspace" | "machine" }
  | { kind: "setFileWriteScope"; scope: FileWriteScopeView }
  /** Preferences: partial patch in, the
   * orchestrator answers `preferencesChanged` with the complete stored
   * object — the webview never assumes its own write landed. */
  | { kind: "setPreferences"; patch: Partial<PreferencesView> }
  /** Preferences Turn-end play button — plays the given sound ("" = the
   * platform default chime) host-side, exactly as a finishing turn would.
   * Preview only: nothing is stored. */
  | { kind: "previewDoneSound"; sound: string }
  /** The user's answer to an elicitation card, in the wire's own
   * vocabulary: accept carries what they typed (reviewed and editable
   * until they press it), decline is a refusal, cancel is a dismissal.
   * Decline and cancel are different answers and the agent is told which. */
  | { kind: "resolveElicitation"; requestId: string; answer: ElicitationAnswer }
  /** Open an accepted link's page again (the tab was closed mid-flow).
   * Names the card, never the address: the host opens the link it holds. */
  | { kind: "reopenElicitationLink"; requestId: string }
  | { kind: "addSelectionContext"; sessionId: string }
  | { kind: "addFileContext"; sessionId: string }
  | { kind: "addDiagnosticsContext"; sessionId: string }
  | { kind: "removeContextChip"; sessionId: string; chipId: string }
  | { kind: "reloadSession"; sessionId: string }
  /** One action for every knob — the UI never knows
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
  /** Replaces one custom server's config from its edited mcpServers entry
   * JSON — env (and a header key) stored exactly as written. */
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
  /** Pins an http-backed integration to patchbay's stdio bridge ("bridge")
   * or lets declaring agents connect directly ("auto") — the escape hatch
   * for an agent whose declared mcp.http support is broken in practice. */
  | { kind: "setIntegrationTransport"; integrationId: string; transport: "auto" | "bridge" }
  /** Re-runs the connect-time tool probe (patchbay's own MCP client
   * handshake with the server) — a free read, no agent involved. */
  | { kind: "probeIntegration"; integrationId: string }
  /** Copies the server as a `{"mcpServers": {name: entry}}` document — the
   * shape `importIntegrationsJson` reads back and other clients take. */
  | { kind: "copyIntegrationJson"; integrationId: string }
  /** Open an agent-reported tool-call diff in VS Code's native diff editor. */
  | { kind: "openToolCallDiff"; sessionId: string; toolCallId: string; path: string }
  /** Open a pending write proposal — the diff card's full change — in VS
   * Code's native diff editor; a no-op once the proposal has resolved. */
  | { kind: "openProposedDiff"; blockId: string }
  /** Open a file in the editor by absolute path — the read-out strip's
   * files-panel rows (the view never touches fs). */
  /** `line` is the location's 1-based line — absent opens at the top. */
  | { kind: "openFile"; path: string; line?: number }
  /** The files panel's ± — native diff of the session's first-touch
   * pre-image against the live file. Texts stay orchestrator-side
   * (fileBaselines); the view only ever names the path. */
  | { kind: "openSessionFileDiff"; sessionId: string; path: string }
  /** Files panel opening: re-read reality for each diff-bearing path so
   * the ± shown matches the diff a click would open. */
  | { kind: "refreshFileDiffStats"; sessionId: string }
  /** Open a rendered mermaid SVG as an editor-area panel — the in-chat
   * fullscreen maxes out at the sidebar column; the files area is where a
   * big diagram can breathe. */
  | { kind: "openDiagram"; svg: string }
  /** A webview-side runtime error (uncaught, rejection, CSP violation) —
   * logged to the Patchbay Output channel, the durable record the in-view
   * "errors (N)" chip points at. */
  | { kind: "reportWebviewError"; view: "agent-view" | "settings"; message: string }
  /** The form's full desired config, `env` included — what is in the box
   * is what gets stored. */
  | { kind: "addOrUpdateAgentConfig"; config: AgentConfigView }
  | { kind: "removeAgentConfig"; agentId: string }
  /** Drag-drop reorder from Settings — `ids` is the full list order as the
   * view sees it at drop time; the store keeps unnamed records at the tail. */
  | { kind: "reorderAgentConfigs"; ids: readonly string[] }
  | { kind: "reorderIntegrations"; ids: readonly string[] }
  | { kind: "addContextRoot"; sessionId: string }
  | { kind: "removeContextRoot"; sessionId: string; path: string }
  /** Saved roots — the folders every new session starts with. `saveRoot`
   * is the roots chip's shortcut for a root already on the session;
   * `pickSavedRoot` is Settings' add — or, with `replacing`, its edit of
   * that entry in place — through the native folder picker; removal lives
   * in Settings alone. */
  | { kind: "saveRoot"; path: string; scope: SavedRootScope }
  | { kind: "pickSavedRoot"; scope: SavedRootScope; replacing?: string }
  | { kind: "unsaveRoot"; path: string; scope: SavedRootScope }
  /** Byte-carrying attachment adds, both produced by the composer's one
   * ingress processor (composer/ingress.ts) — validated, size-capped, and
   * (for images) normalized there, so the orchestrator never receives bytes
   * it would have to guess about. `base64` is always the raw payload. */
  | { kind: "addImageContext"; sessionId: string; base64: string; mimeType: string; label: string }
  /** An externally-dropped non-image file: bytes with no host path (browsers
   * hide dropped files' paths, and a client-side path means nothing to a
   * remote host anyway) — the orchestrator stages them to a temp file and
   * the chip rides the prompt as a resource_link to it. Empty mimeType =
   * the platform didn't know; it stays unknown, never guessed. */
  | { kind: "addDroppedFileContext"; sessionId: string; name: string; mimeType: string; base64: string }
  | { kind: "addFilePickerContext"; sessionId: string }
  /** The `@` mention picker's workspace tier: the webview never touches the
   * filesystem — it asks, the orchestrator runs
   * `workspace.findFiles` and answers with workspaceFilesListed. */
  | { kind: "queryWorkspaceFiles"; query: string };

/** Words held at the turn-start door — a prompt sent mid-turn, under a
 * standing auth lock, or behind other held words. Held orchestrator-side
 * with a durable copy (the session-continuity row), released one per turn
 * end, on login, or on opening the session; the view carries it only to
 * render the pending rows. Only the user discards: Stop or close clears the
 * queue, the row's × removes one, and the tail's take-back returns one to
 * the composer. */
export interface QueuedPrompt {
  id: string;
  text: string;
  parts?: readonly PromptPart[];
  /** The composer's own form of these words (serialized editor state, the
   * same opaque copy `drafts` holds) — so the tail row can be taken back
   * into the composer exactly, tokens and all. Absent on rows held before
   * the composer started sending it; those copy and fire, never reclaim. */
  draft?: string;
}

/** A context chip as persisted in the session-continuity store. Image
 * bytes never enter the store — they are stashed to the attachments dir at
 * ingress and the row carries the file reference; a reference whose file
 * the OS reclaimed drops on rehydration (the stash is temp-dir ephemeral
 * by design), logged, never an error. */
export type PersistedChip =
  | { kind: "selection" | "file" | "diagnostics"; id: string; label: string; content: string; sourceUri?: string }
  | { kind: "image"; id: string; label: string; mimeType: string; file: string }
  | { kind: "attachment"; id: string; label: string; path: string; mimeType?: string };

/** The survives-reload family: session-scoped state the wire cannot
 * re-report (agents reset knobs on load; roots are the list this client
 * intends to send at the next open, and a `session/list` row reporting
 * the session's roots replaces it — most agents report none; queue,
 * chips, and draft are user-staged input that exists nowhere else).
 * One row per session in stores/session-continuity.ts, dropped when the
 * session leaves for good. */
export interface SessionContinuity {
  knobs?: KnobSeed;
  roots?: readonly string[];
  queue?: readonly QueuedPrompt[];
  chips?: readonly PersistedChip[];
  draft?: string;
}

/** One positional piece of a composed prompt (sendPrompt `parts`). */
export type PromptPart =
  | { kind: "text"; text: string }
  /** An inline `@file` mention — sent as a `resource_link` content block at
   * this position; the agent reads it through the brokered fs path itself. */
  | { kind: "fileRef"; path: string };

// ── Settings Agents — agent launch config (add, edit, and
// remove agents, including launch configuration per agent). Agents are
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
  /** Launch env, values included. They live in SecretStorage and ride the
   * Settings channel only — the owner typed them and reads them back; the
   * form shows what is stored and saves what is in the box. */
  env: Readonly<Record<string, string>>;
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
  /** Present only for agents added from the official ACP registry — links
   * the card to its registry row. The update comparison reads the store's
   * copy orchestrator-side and arrives here as `updates`. */
  registrySource: AgentRegistrySourceView | null;
  /** `agentInfo.version` last captured at connect — what the used-
   * capability cache is actually keyed against (reality over the pinned
   * ask); null until connected at least once. */
  lastSeenVersion: string | null;
}

// ── integrations ────────────────────────────────────────────────────────────

/** Three reaches: "auto" = every agent; an id list = exactly these agents;
 * `{ except }` = every agent minus the listed ones. *(Supersedes the
 * fully-brokered gate, 2026-07-12: fidelity measured the data plane — do the
 * agent's file/terminal bytes proxy through patchbay — while the gate's
 * motive was control-plane consent, which the permission broker already
 * carries for every request_permission-routing agent; the conflation
 * structurally excluded the whole SDK-CLI class from auto forever.)* */
export type IntegrationRoutingView = "auto" | readonly string[] | { readonly except: readonly string[] };

/** Payload for `addCustomIntegration` — the "any MCP server, command or URL,
 * with auth" escape hatch. Registry-backed
 * integrations go through `connectRegistryKey`/`connectRegistryOAuth`
 * instead, since those drive a connect flow rather than taking a source
 * directly. Auth shapes: "header" is a
 * static key in a configurable header (`{headerName}: {valuePrefix}{key}`);
 * "oauth" is the MCP-spec OAuth 2.1 flow, URL-only. */
export type IntegrationSourceView =
  /** `env` values go straight into SecretStorage (stores/secret-env.ts)
   * and come back to their owner in `editJson`. */
  | { kind: "custom-stdio"; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
  | {
      kind: "custom-http";
      url: string;
      authType: "none" | "header" | "oauth";
      headerName?: string;
      valuePrefix?: string;
      token?: string;
    };

/** Result of patchbay's own connect-time MCP handshake with an integration
 * (initialize + tools/list, no agent, no LLM turn). A point-in-time read of
 * the server — always shown with its timestamp, never as a timeless fact. */
export type IntegrationProbeView =
  | { status: "probing"; at: string }
  | {
      status: "ok";
      at: string;
      serverName: string;
      serverVersion: string;
      tools: readonly { name: string; description: string }[];
    }
  | { status: "failed"; at: string; reason: string };

export interface IntegrationView {
  id: string;
  name: string;
  sourceKind: "registry" | "custom-stdio" | "custom-http";
  registryId?: string;
  /** The launch line for a custom-stdio server, or the endpoint URL for a
   * custom-http one — shown mono on the card. */
  command?: string;
  /** A token exists in SecretStorage — never assumed from a pasted/shared
   * config (a shared config carries no
   * credential; connecting is always this user's own explicit act). */
  connected: boolean;
  /** The mute switch: inactive keeps config + credential but the server is
   * excluded from every agent's mcpServers until toggled back. */
  active: boolean;
  routing: IntegrationRoutingView;
  /** "auto" = agents declaring mcp.http connect directly (URL passed
   * through); "bridge" = pinned to patchbay's stdio bridge. Absent meaning
   * for custom-stdio (always handed through as-is). */
  transport: "auto" | "bridge";
  /** Last tool probe — patchbay's own MCP handshake with this server
   * (provider-side truth: "reachable, N tools", never "working in your
   * sessions"). Absent = never probed this session. */
  probe?: IntegrationProbeView;
  /** Present for custom servers only: the editable mcpServers entry JSON,
   * env values and a header key included — the owner typed them and reads
   * them back. OAuth tokens (flow-minted) never appear. */
  editJson?: string;
}

export interface RegistryEntryView {
  id: string;
  name: string;
  /** What the server is for, one line (catalog data) — shown on the row,
   * searched by the catalog filter. */
  description: string;
  /** The vendor's mark (mcp-catalog.ts — the curated-only exception to
   * the Codicons rule): monochrome SVG path data rendered inline with
   * fill=currentColor, so color follows text like a codicon. Every entry
   * has one. */
  brandIcon: { viewBox: string; path: string };
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
 * version — the arm `stopped` used to lie about. Connection status
 * lives here, NOT in the capability matrix: a `CapabilityCell` has no error
 * arm and its used-state is version-keyed persisted — a "connection" row
 * would light up for a dead process. This is live process state; the matrix
 * is durable proven-ness of the declared surface. */
export type AgentStatus = "untested" | "running" | "stopped" | "crashed" | "reconnecting";

/** A registry agent's newer version than the one its config pins — never
 * applied on its own; Upgrade is always the user's click. */
export interface AgentUpdate {
  from: string;
  to: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  status: AgentStatus;
  /** Human-readable status context, e.g. "exited 1 · 14:07". */
  detail?: string;
  /** The process's own last words (stderr tail), present on crash — the
   * reason readable inline, no Output panel required. */
  stderr?: readonly string[];
  /** Launch command line as spawned (shown mono). */
  command?: string;
  /** True while a standing auth lock exists for this agent — raised by a
   * wire `auth_required` or a witnessed logout, cleared only by evidence
   * that actually bears on it (the orchestrator's authority table; a
   * reconnect or a lazy-auth agent's session/new success clears nothing).
   * Survives disconnect and reload: the lock persists machine-side.
   * Distinct from the `auth` capability row: this is "blocked right now,"
   * that row is "has this ever been used successfully." */
  needsAuth: boolean;
  /** The `auth_required` error's own message — the agent's login
   * instruction in its words. The only guidance that exists when an agent
   * declares no actionable auth method (Auggie logged out: "run `auggie
   * login` from your terminal"). Cleared with needsAuth. */
  authReason?: string;
}

/** The live-selection indicator's data (the ghost chip):
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
 * absent or `"agent"` type — the agent handles auth itself via
 * `authenticate`), "terminal-recipe" (a parseable `_meta["terminal-auth"]`
 * recipe — adopted extension, meta.ts; patchbay runs the recipe in a
 * VS Code terminal, never calls `authenticate` on it), and "terminal"
 * (the spec's terminal type; patchbay re-runs the agent's own spawn command
 * with the method's args appended, in a terminal, and likewise never calls
 * `authenticate` on it) are actionable. The recipe/args stay
 * orchestrator-side — the UI only needs to know the method is runnable.
 * "unsupported" is every method patchbay cannot drive (a type outside the
 * spec's `terminal | agent`, or a terminal whose args/env didn't parse):
 * shown as declared, never wired to a Log-in button, and never passed to
 * `authenticate` — the spec allows that call only for the agent type. */
export interface AuthMethodView {
  id: string;
  name: string;
  /** The wire's optional `description` — stable on all method shapes, meant
   * for display; normalized to null when the agent omits it. */
  description: string | null;
  kind: "agent" | "terminal-recipe" | "terminal" | "unsupported";
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
  /** `sessionCapabilities.additionalDirectories` — extra workspace roots may
   * ride session lifecycle requests (new/load/resume/fork). */
  sessionAdditionalDirectories: boolean;
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
  /** Not addable right now — no distribution published for this platform.
   * Shown on the Add Agent picker, never silently hidden. */
  unavailableReason: string | null;
  /** The registry's current version — compared against an added config's
   * own pinned version to drive "update available." */
  version: string;
}

// ── capability matrix ───────────────────────────────────────────────────────
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
  | "session.additionalDirectories"
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

/**
 * True while the free protocol check (session/new + session/fork probe)
 * still has something it can RESOLVE for this agent — the manual Verify
 * control's visibility predicate. One clause: a declared fork not yet
 * proven (the probe's fork round-trip resolves it). The auth row is
 * deliberately absent: the probe's session/new is never an auth proof
 * (non-bearing evidence — auth-evidence.ts), so an auth clause would keep
 * Verify lit forever on every healthy agent, promising a check the button
 * structurally cannot perform. Auth surfaces its own re-check paths: every
 * connect probes anyway (a locked agent re-raises at the chokepoint), and
 * the needsAuth card offers Log in / the out-of-band escape hatch. Every
 * other row is opportunistic or has no active check to retry — the
 * verification-cost split: protocol-level checks are free, behavior probes
 * cost real agent turns.
 */
export function hasUnusedProbe(matrix: CapabilityMatrix): boolean {
  return matrix["session.fork"].declared && !matrix["session.fork"].used;
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
  /** A turn completed while no visible surface showed this session — the
   * blue dot. Reducer-derived (turnEnded off screen), cleared once a
   * visible surface renders it; never persisted — a reload starts with
   * nothing unread. */
  unseen?: boolean;
}

// ── session knobs — one
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

/** One ACP content block as it renders — the wire's own content vocabulary
 * kept through to render instead of flattened to a string (which lost
 * mentions, images and context to placeholder text). Every surface that
 * shows agent or user content maps onto this one set: user messages (sent
 * and replayed alike), agent messages, and tool-call content. */
export type ContentPart =
  | { kind: "text"; text: string }
  /** A resource_link — an `@file` mention in a user's message, a link
   * elsewhere. */
  | { kind: "mention"; name: string; uri: string }
  /** An image. `file` names its copy in the attachments stash
   * (previewable); absent when the bytes couldn't be stashed — degrades to
   * a labeled chip, never an error. */
  | { kind: "image"; mimeType: string; file?: string }
  /** Labeled text snapshot (selection, problems, embedded resource) —
   * text bounded orchestrator-side, same rule as tool rawInput. */
  | { kind: "context"; label: string; text: string }
  /** Honesty placeholder for content kinds without a renderer (audio, blob
   * resources) — a recorded floor, not a gap: nothing plays or saves them. */
  | { kind: "unrendered"; type: string };

/** One piece of a user message: any content part, or a file attached whole
 * (a resource_link chip rather than an inline mention — only a sent prompt
 * carries one). */
export type UserPart = ContentPart | { kind: "attachment"; name: string; path: string };

/** One piece of a tool call's `content`, in the agent's order: a content
 * part, or a terminal the call runs in (by the id `terminal/create`
 * returned — its block renders inside the card). Diff entries don't appear
 * here; they are the card's file rows. */
export type ToolContentPart = ContentPart | { kind: "terminal"; terminalId: string };

/** The transcript block a client terminal renders as — one spelling for the
 * host that creates it and the tool card that embeds it. */
export function terminalBlockId(terminalId: string): string {
  return `term-block-${terminalId}`;
}

/** What a content kind with no renderer says in its place — one wording for
 * the chat and for copied text. Audio is the one kind a player could show;
 * none exists yet, a recorded decision. */
export function unrenderedLabel(type: string): string {
  return type === "audio" ? "audio · not playable here" : `${type} · not shown here`;
}

/** A user message flattened for copy/preview — mentions and chips keep a
 * readable spelling, prose stays verbatim. */
export function userPartsText(parts: readonly UserPart[]): string {
  return parts
    .map((p) => {
      switch (p.kind) {
        case "text":
          return p.text;
        case "mention":
          return `@${p.name}`;
        case "image":
          return `[image ${p.mimeType}]`;
        case "attachment":
          return `@${p.name}`;
        case "context":
          return `[${p.label}]`;
        case "unrendered":
          return `[${unrenderedLabel(p.type)}]`;
      }
    })
    .join("");
}

export interface UserBlock {
  kind: "user";
  id: string;
  parts: readonly UserPart[];
  /** True when the whole message is a harness-injected envelope riding the
   * user role on the wire (task notifications, system reminders, command
   * echoes). A real
   * transcript fact, but not something the human typed: rendered as a dim
   * collapsed line, never a prompt bubble, and never counted as a prompt.
   * Classified orchestrator-side (session-manager harnessEnvelopeTag) —
   * the webview only reads the flag. */
  injected?: boolean;
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

/** A non-text piece of an agent's message or thought (an image, an embedded
 * file, audio) — its own block between prose runs, rendered by the same
 * part renderers as a user's message and a tool call's content. `thought`
 * keeps a thought's piece reading as a thought. */
export interface AgentPartBlock {
  kind: "agentPart";
  id: string;
  part: ContentPart;
  thought: boolean;
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

/** A file a tool call reported, with the 1-based line the agent pointed at
 * (null when it named none). */
export interface ToolLocation {
  path: string;
  line: number | null;
}

export interface ToolCallBlock {
  kind: "toolCall";
  /** == the ACP toolCallId — one block, updated in place as status changes. */
  id: string;
  title: string;
  status: ToolCallStatus;
  toolKind: ToolCallKind;
  /** rawInput/rawOutput as bounded pretty-printed text (collapsed by
   * default, expandable) — null when the agent never sent one.
   * Bounded at the source with an honest truncation marker, never silently. */
  input: string | null;
  output: string | null;
  /** Files this call reported touching (ACP locations), each openable from
   * the card at its line — the per-turn rollup's "N files" is the deduped
   * path set across edit/delete/move calls. */
  locations: readonly ToolLocation[];
  /** The call's `content` minus its diffs, in the agent's order — what the
   * agent meant the user to see. Replaced wholesale by an update that
   * carries `content` (ACP: the field is a collection replacement). */
  content: readonly ToolContentPart[];
  /** Paths with agent-reported diff content (ToolCallContent type:"diff").
   * The texts stay orchestrator-side; expanding the card offers "Open
   * diff", routed to VS Code's native diff editor — never an inline diff
   * view. */
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
 * blocks in the transcript.
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

/** One broker path for every gated action — ACP session/request_permission,
 * and patchbay's own fs.write /
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

/** One form field. Two producers, one card: the agent's own
 * `elicitation/create` (ACP, form mode) and the local MCP server's
 * `request_user_input` tool — the fallback for an agent that asks its
 * questions through MCP instead. */
export interface ElicitationField {
  name: string;
  /** The control to render. "select"/"multiselect" are choices the agent
   * offered (their options ride below); the rest are typed free input. */
  type: "string" | "number" | "integer" | "boolean" | "select" | "multiselect";
  title?: string;
  description?: string;
  required: boolean;
  /** Present exactly on the two choice types — the offered values with the
   * labels the agent gave them. */
  options?: readonly { value: string; label: string; description?: string }[];
  /** The agent's declared default, pre-filled (present only when it fits
   * the field: a string, a number, a boolean, an offered option, or a list
   * of offered options). */
  default?: string | number | boolean | readonly string[];
  /** The limits the form declares, checked before Send. Text: length,
   * pattern, format. Numbers: range. Multi-choice: how many picks. */
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "email" | "uri" | "date" | "date-time";
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

/** How a card was settled: the user's three answers as the wire names
 * them, or the agent's doing before the user chose — "withdrawn" (it took
 * the question back) or "completed" (the page's flow finished without the
 * user). */
export type ElicitationOutcome = "accepted" | "declined" | "cancelled" | "withdrawn" | "completed";

/** Why a link deserves a second look before opening: an encoded
 * international host that can imitate another site, a user name placed
 * before the host to disguise it, a bare IP address instead of a named
 * site, or an unencrypted connection to anything but this machine. */
export type LinkWarning = "punycode" | "credentials" | "ip-host" | "insecure";

/** A page the agent asks the user to open. `href` is exactly what opens —
 * shown in full before consent — and `host` is where it goes. */
export interface ElicitationLink {
  href: string;
  host: string;
  warnings: readonly LinkWarning[];
}

/** What is asked: fields to fill in, or a page to open in the browser. */
export type ElicitationAsk =
  | { mode: "form"; fields: readonly ElicitationField[] }
  | { mode: "url"; link: ElicitationLink };

/** An opened link's follow-up: the agent is waiting on the page, reported
 * it finished, or the session moved on without it. */
export type LinkState = "waiting" | "completed" | "ended";

/** The answer travelling back: the action, plus the content an accept
 * carries. Same vocabulary as ACP's own response, so nothing is translated
 * between the card and the wire. */
export type ElicitationAnswer =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

export type ElicitationBlock = {
  kind: "elicitation";
  id: string;
  message: string;
  resolution: { outcome: ElicitationOutcome } | null;
  /** A url ask's follow-up — absent until the user opens the page. */
  linkState?: LinkState;
} & ElicitationAsk;

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
  | AgentPartBlock
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

/** The in-pane connect state for a chat being started: "+" on a
 * not-yet-running agent connects inside the chat pane itself — a
 * lightweight "Connecting…" resolving into the session, or a failure with
 * the specific reason and a Retry, never a bounce back to the empty state. */
export interface ChatConnectView {
  agentId: string;
  status: "connecting" | "failed";
  reason?: string;
  /** Present when the connect was triggered by opening an existing session
   * (every open — click, palette, own window — is a connect trigger: the
   * running agent is the session's prerequisite). Retry then re-opens that
   * session instead of minting a new one via startChat. */
  forSessionId?: string;
}

/** Machine-scoped behavior defaults (stores/preferences.ts — machine store,
 * non-sensitive). Read fresh orchestrator-side at each point of use
 * (store-truth); this view exists so the Preferences page can render and
 * edit them, and so the agent view can gate its own furniture (the
 * composer's stats read-outs). Declared above AgentViewState because initialAgentViewState
 * seeds from DEFAULT_PREFERENCES. */
export interface PreferencesView {
  /** System chime when a prompt turn finishes (host-side player — a
   * cancelled turn never chimes: the user was present to cancel it). */
  soundOnDone: boolean;
  /** Which system sound the done-chime plays — a basename from the
   * platform's own sound directory (sound.ts enumerates it; SettingsState
   * carries the list as `doneSounds`). "" = the platform default chime. */
  doneSound: string;
  /** What a fresh session's knobs are seeded from: the agent config's
   * defaults, or the last agent-confirmed combination on that agent
   * (stores/composer-knobs.ts, falling back to the defaults when none). */
  knobSource: "agent-default" | "last-session";
  /** Idle-release timer (session-manager reapIdle, condition 5) in
   * minutes; 0 disables the reaper entirely. */
  idleCloseMinutes: number;
  /** The composer's session-stats strip, one switch per read-out — pure
   * render furniture, so hiding any of them loses nothing. Flat keys, not a
   * nested record: the store merges one level deep, so each member keeps its
   * own default. The files chip is a control, not a read-out, and has no
   * switch. */
  statsPrompts: boolean;
  statsToolCalls: boolean;
  statsContext: boolean;
  statsPlanUsage: boolean;
  /** Detached windows (AgentPanelHost): the session menu's "Open in new
   * window" and the whole-view detach command. Off hides the entry points;
   * panels already open stay open — the pref gates opening, not existence. */
  detachWindows: boolean;
  /** Per-attachment size cap in MB (pre-encode bytes), enforced at the
   * composer's ingress — oversize is refused with a visible message, never
   * silently truncated. Bytes travel the webview bridge as base64, so the
   * cap is also what keeps a stray 200MB drop from stalling the view. */
  attachmentMaxMB: number;
}

export const DEFAULT_PREFERENCES: PreferencesView = {
  soundOnDone: false,
  doneSound: "",
  knobSource: "agent-default",
  idleCloseMinutes: 60,
  statsPrompts: true,
  statsToolCalls: true,
  statsContext: true,
  statsPlanUsage: true,
  detachWindows: true,
  attachmentMaxMB: 10,
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
  /** Agents with a newer registry version than they run — the upgrade
   * chip's source. */
  updates: Readonly<Record<string, AgentUpdate>>;
  /** Render cache, per session — rebuilt wholesale from session/load replay. */
  transcripts: Readonly<Record<string, readonly ChatBlock[]>>;
  /** The pinned plan widget's source — the most recent plan snapshot, or
   * none. A plan is *session-level* state spanning many prompts
   * it never enters the per-turn
   * transcript, so an update replaces this snapshot instead of repeating a
   * card per turn. */
  activePlan: Readonly<Record<string, readonly PlanEntry[] | null>>;
  /** ISO start time of the in-flight turn, per session — the live elapsed
   * ticker's basis; cleared when the turn's TurnEndBlock lands. */
  activeTurn: Readonly<Record<string, string>>;
  /** Sessions with a hydration (session/load replay) in flight — the
   * rendering area's per-session loading page signal. */
  hydrating: Readonly<Record<string, true>>;
  commandsBySession: Readonly<Record<string, readonly AvailableCommand[]>>;
  /** Declared/used per agent — replaced wholesale on every (re)connect. */
  capabilities: Readonly<Record<string, CapabilityMatrix>>;
  /** ISO time of the last capabilitiesDeclared — powers the "reset <time>" chip. */
  capabilitiesResetAt: Readonly<Record<string, string>>;
  /** Declared auth methods per agent — the Log-in button's source (the
   * runnable kinds are AuthMethodView's docstring). */
  authMethods: Readonly<Record<string, readonly AuthMethodView[]>>;
  /** Present only once `usage` is used — absence over fake. */
  sessionUsage: Readonly<Record<string, UsageInfo>>;
  /** Per session, per path: cumulative +/- since the session's first-touch
   * baseline (fileBaselines) — the same numbers the files panel's ± opens
   * to, computed orchestrator-side (computeLineDiff) since the texts never
   * reach the webview. Absent for a path until a real change is known
   * (session-manager.noteFileChange) — absence over fake. */
  fileDiffStats: Readonly<Record<string, Readonly<Record<string, { additions: number; deletions: number }>>>>;
  /** Explicitly attached context, pending inclusion in the next prompt. */
  contextChips: Readonly<Record<string, readonly ContextChip[]>>;
  /** Prompts accepted mid-turn, waiting for the turn to end (QueuedPrompt).
   * Orchestrator-owned like everything else here — rendered as removable
   * pending rows above the composer. */
  promptQueue: Readonly<Record<string, readonly QueuedPrompt[]>>;
  /** Per-session composer drafts — the durable copy. The composer owns the
   * live editing buffer and reads this only when switching sessions (or on
   * mount), so patch echoes never fight the keyboard. */
  drafts: Readonly<Record<string, string>>;
  /** Normalized knobs per session (knobs.ts is the only producer) — empty
   * when the agent offers none. */
  sessionKnobs: Readonly<Record<string, readonly SessionKnobView[]>>;
  /** User-added external context roots, per session (workspace folders
   * are always active and need no chip; these are the
   * removable, explicit ones) — seeded at birth from the saved roots, the
   * session's own from then on. Passed to the agent as
   * `additionalDirectories` — only where advertised. ACP sets the list on
   * lifecycle requests alone, so a change after the first turn re-applies
   * through `session/resume` ("sets the complete list"); the session's MCP
   * servers read it at once, and the roots chip says per row who holds it. */
  contextRoots: Readonly<Record<string, readonly string[]>>;
  /** Workspace folders — the always-active roots every session gets as its
   * cwd baseline. Fixed and non-removable in the UI; shown so the roots chip
   * reflects reality instead of counting only the user-added extras. */
  workspaceRoots: readonly string[];
  /** The saved roots, both scopes — the chip names a saved row's scope
   * and offers the save on the rest. */
  savedRoots: SavedRootsView;
  /** Live IDE selection — the ghost chip's presence signal (appears
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
   * gates its own rendering (the composer's stats read-outs). */
  preferences: PreferencesView;
  /** What the visible surfaces are rendering right now — the one input to
   * "on screen" (onScreen). `pointer`: a visible surface follows
   * activeSessionId (the sidebar, the full agent-view panel); `pinned`:
   * sessions shown by visible panels of their own. Reported by the view
   * hosts as visibility flips; nothing is visible until one says so. */
  screen: ScreenView;
}

export interface ScreenView {
  pointer: boolean;
  pinned: readonly string[];
}

/** The sessions some visible surface is rendering — what "the user can see
 * it" means for the unseen mark, the attention indicators, and the native
 * notification alike. */
export function onScreen(state: AgentViewState): ReadonlySet<string> {
  const shown = new Set(state.screen.pinned);
  if (state.screen.pointer && state.activeSessionId !== null) shown.add(state.activeSessionId);
  return shown;
}

export interface UsageInfo {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
  /** Last reading per plan window, when the agent reports any (meta.ts
   * usageUpdate site — vendor `_meta` normalized to this neutral shape).
   * Keyed by window tag because the windows are parallel, independent
   * axes (wire-observed: Claude runs 5h overall, 7d overall, and 7d
   * per-model concurrently) — one slot would let a calm window's reading
   * erase another window's warning. Each entry is sticky: agents emit a
   * reading only when that window's info changes. */
  plan?: Readonly<Record<string, PlanUsageInfo>>;
}

/** One plan window's state — the context gauge's sibling. */
export interface PlanUsageInfo {
  status: "ok" | "warning" | "limited";
  /** Vendor window tag (e.g. "five_hour", "seven_day_opus") — label-mapped
   * in the UI, never gating anything. Absent when the agent didn't say. */
  window?: string;
  /** Raw utilization as reported; unit unverified upstream (fraction vs
   * percent), so the renderer owns the display rule (≤1 reads as a
   * fraction). */
  utilization?: number;
  /** ISO timestamp of the window reset, when reported. */
  resetsAt?: string;
}

interface ContextChipBase {
  id: string;
  label: string;
}

/** Discriminated by kind so each arm carries exactly what its prompt form
 * needs — an image chip without a mimeType is unrepresentable: the spec
 * requires the field, so a send-time default would fabricate it, and the
 * ingress that produced the bytes is the only honest source. */
export type ContextChip =
  | (ContextChipBase & {
      kind: "selection" | "file" | "diagnostics";
      /** Text content, as captured. */
      content: string;
      /** The source's uri where one exists (file/selection — selection carries
       * its line range as a `#L` fragment); absent for aggregates like
       * diagnostics. Rides the embedded-resource prompt form when the agent
       * declares `promptCapabilities.embeddedContext`. */
      sourceUri?: string;
    })
  | (ContextChipBase & {
      kind: "image";
      /** Raw base64 payload — a real ImageContent block where the agent
       * declares `promptCapabilities.image`, the temp-file ResourceLink
       * fallback otherwise (paste is never disabled). */
      content: string;
      /** Describes the payload, always from the platform that produced the
       * bytes (clipboard item type, drop file type, extension map) — never
       * defaulted downstream. */
      mimeType: string;
    })
  | (ContextChipBase & {
      kind: "attachment";
      /** A real file on this machine — an IDE drop's own path, or the temp
       * file an external drop was staged to at ingress. Rides the prompt as
       * a resource_link (the baseline every agent MUST accept); the agent
       * reads the content itself through the brokered fs path. */
      path: string;
      /** Present only when the producer knew it — never guessed. */
      mimeType?: string;
    });

export const initialAgentViewState: AgentViewState = {
  agents: [],
  sessions: [],
  activeSessionId: null,
  chatConnect: null,
  restoring: false,
  registryAgents: [],
  updates: {},
  transcripts: {},
  activePlan: {},
  activeTurn: {},
  hydrating: {},
  commandsBySession: {},
  capabilities: {},
  capabilitiesResetAt: {},
  authMethods: {},
  sessionUsage: {},
  fileDiffStats: {},
  contextChips: {},
  promptQueue: {},
  sessionKnobs: {},
  contextRoots: {},
  drafts: {},
  workspaceRoots: [],
  savedRoots: NO_SAVED_ROOTS,
  liveSelection: null,
  openEditors: [],
  workspaceFiles: { query: "", files: [], dirs: [] },
  preferences: DEFAULT_PREFERENCES,
  screen: { pointer: false, pinned: [] },
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
  | {
      kind: "sessionCreated";
      session: SessionSummary;
      /** false = create the row without stealing the active pointer or an
       * in-flight chatConnect (recreateEmpty's zero-turn root change on a
       * possibly-background session); absent/true = a user-facing create. */
      activate?: boolean;
    }
  /** A session first surfaced by the agent's own `session/list` — adds the
   * row *without* activating it or touching the connect pane, unlike
   * sessionCreated: a connect-time sync of N history rows must not steal
   * focus. The stamp is the wire's, or first-sight time when the wire
   * carries none (honest as ordering, nothing more). */
  | { kind: "sessionListed"; session: SessionSummary }
  /** A known row's metadata moved — from the wire (a later `session/list`
   * sync, the agent's `session_info_update`) or patchbay's own derived
   * first-prompt title. Each field rides only when its witness said
   * something: an absent title or stamp is silence, never a clear. The
   * agent's title wins; the stamp only moves forward. */
  | { kind: "sessionRefreshed"; sessionId: string; title?: string; updatedAt?: string }
  | { kind: "sessionActivated"; sessionId: string }
  /** The visible surfaces changed — shown, hidden, opened, or closed. */
  | ({ kind: "screenChanged" } & ScreenView)
  | { kind: "sessionClosed"; sessionId: string }
  | { kind: "sessionLiveChanged"; sessionId: string; live: boolean }
  /** A session/load hydration is in flight for this session (open of a cold
   * session — session-manager.hydrate). The rendering area holds a loading
   * page while it has nothing else to show; a warm reload keeps its
   * standing content instead (the replay window swaps it wholesale). */
  | { kind: "sessionHydrating"; sessionId: string; hydrating: boolean }
  /** Replay always wins — the transcript is discarded, never merged. */
  | { kind: "transcriptReset"; sessionId: string }
  | { kind: "userMessageAppended"; sessionId: string; blockId: string; parts: readonly UserPart[] }
  /** One replayed user content part (session/load `user_message_chunk`) —
   * delta semantics like the agent chunks, unlike `userMessageAppended`
   * (the live send, which is whole by construction). Consecutive text
   * parts on one block merge in the reducer. */
  | { kind: "userPartAppended"; sessionId: string; blockId: string; part: UserPart; injected?: boolean }
  | { kind: "agentTextDelta"; sessionId: string; blockId: string; text: string }
  | { kind: "agentThoughtDelta"; sessionId: string; blockId: string; text: string }
  | { kind: "agentPartAppended"; sessionId: string; blockId: string; part: ContentPart; thought: boolean }
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
      locations?: readonly ToolLocation[];
      content?: readonly ToolContentPart[];
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
  /** Cumulative baseline-vs-latest +/- for one file this session (the files
   * panel's ± badge) — recomputed on every real content advance: an
   * agent-reported tool_call diff, or an accepted gate write. */
  | { kind: "fileDiffStatChanged"; sessionId: string; path: string; additions: number; deletions: number }
  | { kind: "terminalStarted"; sessionId: string; blockId: string; command: string }
  | { kind: "terminalOutputAppended"; sessionId: string; blockId: string; chunk: string }
  | { kind: "terminalExited"; sessionId: string; blockId: string; exitCode: number | null }
  | ({ kind: "elicitationRequested"; sessionId: string; blockId: string; message: string } & ElicitationAsk)
  | { kind: "elicitationResolved"; sessionId: string; blockId: string; outcome: ElicitationOutcome }
  /** An opened link's follow-up moved: the agent reported the page done,
   * or the session stopped waiting on it. */
  | { kind: "elicitationLinkSettled"; sessionId: string; blockId: string; state: "completed" | "ended" }
  | { kind: "contextChipAdded"; sessionId: string; chip: ContextChip }
  | { kind: "contextChipRemoved"; sessionId: string; chipId: string }
  /** Words held at the turn-start door (mid-turn, auth lock, or behind
   * other held words) — or rehydrated from the continuity row after a
   * reload, or re-emitted in a drain-failure resync. Queued, not refused. */
  | { kind: "promptQueued"; sessionId: string; prompt: QueuedPrompt }
  /** One queued prompt left the queue — fired (drain) or removed by hand. */
  | { kind: "promptUnqueued"; sessionId: string; promptId: string }
  | { kind: "sessionDraftChanged"; sessionId: string; draft: string }
  /** The queue's rows leave at once — a deliberate Stop discarding them,
   * or the prelude of a drain-failure resync (immediately re-emitted as
   * promptQueued rows in firing order; nothing discarded). */
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
      /** Present only on the updates that carry a fresh plan reading. */
      plan?: PlanUsageInfo;
    }
  /** A standing auth lock was raised by the one writer (the evidence
   * authority): a wire `auth_required`, a witnessed logout (the strongest
   * lock), or a failed terminal login. `reason` is the lock's reason — an
   * agent-authored instruction where the wire carried one, null
   * otherwise. */
  | { kind: "agentAuthRequired"; agentId: string; reason: string | null }
  | { kind: "agentAuthResolved"; agentId: string }
  /** Full replace — the registry × overlay merge changed (refresh, or a new
   * version landed upstream). */
  | { kind: "registryChanged"; agents: readonly RegistryAgentView[]; fetchedAt: string }
  /** The complete update fact (never a patch) — one event, both channels. */
  | { kind: "agentUpdatesChanged"; updates: Readonly<Record<string, AgentUpdate>> }
  /** The complete stored preferences (never a patch) — one event, both
   * channels: the Preferences page renders it, the agent view gates its
   * composer stats on it. */
  | { kind: "preferencesChanged"; preferences: PreferencesView }
  /** Both saved lists, complete — one event, both channels: Settings
   * manages them, the roots chip reads them. */
  | { kind: "savedRootsChanged"; savedRoots: SavedRootsView };

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

/** Seeing is what clears the blue dot: every unseen session a visible
 * surface now renders loses it. */
function markSeen(state: AgentViewState): AgentViewState {
  const shown = onScreen(state);
  if (!state.sessions.some((s) => s.unseen === true && shown.has(s.id))) return state;
  return {
    ...state,
    sessions: state.sessions.map((s) => (s.unseen === true && shown.has(s.id) ? { ...s, unseen: undefined } : s)),
  };
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

/** The user-block sibling of upsertTextBlock, in the part vocabulary:
 * consecutive text parts merge (a replay's prose deltas stay one readable
 * span); any other part appends as its own piece. */
function upsertUserBlock(
  state: AgentViewState,
  sessionId: string,
  blockId: string,
  part: UserPart,
  injected?: boolean,
): AgentViewState {
  const blocks = state.transcripts[sessionId] ?? [];
  const i = blocks.findIndex((b) => b.id === blockId);
  if (i === -1) {
    return appendBlock(state, sessionId, {
      kind: "user",
      id: blockId,
      parts: [part],
      ...(injected === true ? { injected: true } : {}),
    });
  }
  const existing = blocks[i] as UserBlock;
  const last = existing.parts[existing.parts.length - 1];
  const parts =
    last !== undefined && last.kind === "text" && part.kind === "text"
      ? [...existing.parts.slice(0, -1), { kind: "text" as const, text: last.text + part.text }]
      : [...existing.parts, part];
  return withTranscript(
    state,
    sessionId,
    blocks.map((b, j) => (j === i ? { ...existing, parts } : b)),
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
      content: event.content ?? [],
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
    content: event.content ?? existing.content,
    diffFiles: event.diffFiles ?? existing.diffFiles,
    // A trailing tool_call_update still wins: the
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
    case "agentUpdatesChanged":
      return { ...state, updates: event.updates };
    case "chatConnectStarted":
      return { ...state, chatConnect: { agentId: event.agentId, status: "connecting", forSessionId: event.forSessionId } };
    case "chatConnectFailed":
      return { ...state, chatConnect: { agentId: event.agentId, status: "failed", reason: event.reason, forSessionId: event.forSessionId } };
    case "chatConnectResolved":
      return { ...state, chatConnect: null };
    case "startupSettled":
      return { ...state, restoring: false };
    case "sessionCreated": {
      // An agent may legally re-mint a closed session's id — replace the
      // row, never duplicate it (sessionListed already dedupes; the
      // asymmetry was the hazard). The per-session maps reset either way:
      // a re-minted id is a new session, not the old one's heir.
      const exists = state.sessions.some((s) => s.id === event.session.id);
      const { [event.session.id]: _d, ...drafts } = state.drafts;
      const { [event.session.id]: _q, ...promptQueue } = state.promptQueue;
      const { [event.session.id]: _u, ...sessionUsage } = state.sessionUsage;
      return {
        ...state,
        sessions: exists
          ? state.sessions.map((s) => (s.id === event.session.id ? event.session : s))
          : [...state.sessions, event.session],
        transcripts: { ...state.transcripts, [event.session.id]: [] },
        commandsBySession: { ...state.commandsBySession, [event.session.id]: [] },
        contextChips: { ...state.contextChips, [event.session.id]: [] },
        sessionKnobs: { ...state.sessionKnobs, [event.session.id]: [] },
        contextRoots: { ...state.contextRoots, [event.session.id]: [] },
        drafts,
        promptQueue,
        sessionUsage,
        // Activation is the event's call, not a side effect: a background
        // recreate must not steal the pointer or wipe another pane's
        // in-flight connect.
        ...(event.activate === false
          ? {}
          : {
              activeSessionId: event.session.id,
              // A session arriving ends any in-pane connect, success or
              // stale failure alike — cleared here so it can't desync.
              chatConnect: null,
            }),
      };
    }
    case "sessionRefreshed":
      // Metadata only — `live` is a liveness fact the sync knows nothing
      // about. The stamp: newest wins — the wire's may trail a local prompt.
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === event.sessionId
            ? {
                ...s,
                title: event.title ?? s.title,
                updatedAt:
                  event.updatedAt !== undefined && event.updatedAt > s.updatedAt
                    ? event.updatedAt
                    : s.updatedAt,
              }
            : s,
        ),
      };
    case "sessionListed": {
      // A row the state already holds is a refresh, whatever the emitter
      // believed — the wire's page and a local create can cross.
      if (state.sessions.some((s) => s.id === event.session.id)) {
        return reduceAgentView(state, {
          kind: "sessionRefreshed",
          sessionId: event.session.id,
          title: event.session.title,
          updatedAt: event.session.updatedAt,
        });
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
        ? markSeen({ ...state, activeSessionId: event.sessionId })
        : state;
    case "screenChanged":
      return markSeen({ ...state, screen: { pointer: event.pointer, pinned: event.pinned } });
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
      const { [event.sessionId]: _d, ...drafts } = state.drafts;
      const { [event.sessionId]: _fds, ...fileDiffStats } = state.fileDiffStats;
      const { [event.sessionId]: _hy, ...hydrating } = state.hydrating ?? {};
      const sessions = state.sessions.filter((s) => s.id !== event.sessionId);
      // Closing the active session lands on home ("+ New chat"), never on a
      // sibling: opening a session is the one hydrate/connect trigger, so a
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
        drafts,
        fileDiffStats,
        hydrating,
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
    case "sessionHydrating": {
      // `?? {}` guards snapshots minted before this field existed.
      const { [event.sessionId]: _h, ...rest } = state.hydrating ?? {};
      return {
        ...state,
        hydrating: event.hydrating ? { ...rest, [event.sessionId]: true } : rest,
      };
    }
    case "transcriptReset": {
      // The strip mirrors only what the agent reports: a reset means replay
      // is about to rebuild the transcript, and the live plan rebuilds from
      // the same replay — a stale strip must not outlive its source. Same
      // for a stale ticker: no turn survives a transcript rebuild.
      const { [event.sessionId]: _a, ...activeTurn } = state.activeTurn;
      // The files strip's ± rows follow the same contract as the texts:
      // after a reset, only what the replay re-reports comes back — a
      // pre-reload badge asserting itself over the replayed reality would
      // be the cache lying.
      const { [event.sessionId]: _fd, ...fileDiffStats } = state.fileDiffStats;
      return {
        ...withTranscript(state, event.sessionId, []),
        activePlan: { ...state.activePlan, [event.sessionId]: null },
        activeTurn,
        fileDiffStats,
      };
    }
    case "userMessageAppended":
      return appendBlock(state, event.sessionId, {
        kind: "user",
        id: event.blockId,
        parts: event.parts,
      });
    case "userPartAppended":
      return upsertUserBlock(state, event.sessionId, event.blockId, event.part, event.injected);
    case "agentTextDelta":
      return upsertTextBlock(state, event.sessionId, event.blockId, "text", event.text);
    case "agentThoughtDelta":
      return upsertTextBlock(state, event.sessionId, event.blockId, "thought", event.text);
    case "agentPartAppended":
      return appendBlock(state, event.sessionId, {
        kind: "agentPart",
        id: event.blockId,
        part: event.part,
        thought: event.thought,
      });
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
        // A turn finished while no visible surface showed it → the blue dot
        // (unseen) until one does. Watching it complete counts as seen.
        sessions: state.sessions.map((s) =>
          s.id === event.sessionId
            ? { ...s, updatedAt: at, unseen: !onScreen(state).has(event.sessionId) || undefined }
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
    case "usageReported": {
      // A fresh reading lands under its own window key; every other
      // window's standing reading survives (parallel axes), and a plain
      // usage update (no reading) erases nothing.
      const priorPlan = state.sessionUsage[event.sessionId]?.plan;
      const plan =
        event.plan === undefined
          ? priorPlan
          : { ...priorPlan, [event.plan.window ?? ""]: event.plan };
      return {
        ...state,
        sessionUsage: {
          ...state.sessionUsage,
          [event.sessionId]: { used: event.used, size: event.size, cost: event.cost, plan },
        },
      };
    }
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
    case "fileDiffStatChanged":
      return {
        ...state,
        fileDiffStats: {
          ...state.fileDiffStats,
          [event.sessionId]: {
            ...state.fileDiffStats[event.sessionId],
            [event.path]: { additions: event.additions, deletions: event.deletions },
          },
        },
      };
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
    case "elicitationRequested": {
      const { kind: _kind, sessionId, blockId, ...asked } = event;
      return appendBlock(state, sessionId, { kind: "elicitation", id: blockId, ...asked, resolution: null });
    }
    case "elicitationResolved":
      return patchBlock<ElicitationBlock>(state, event.sessionId, event.blockId, (b) => ({
        ...b,
        resolution: { outcome: event.outcome },
        // An accepted link opened in the browser; the agent's page is now
        // in play until it reports back. A link the agent finished before
        // the user answered is simply done.
        ...(b.mode === "url" && event.outcome === "accepted" ? { linkState: "waiting" as const } : {}),
        ...(b.mode === "url" && event.outcome === "completed" ? { linkState: "completed" as const } : {}),
      }));
    case "elicitationLinkSettled":
      return patchBlock<ElicitationBlock>(state, event.sessionId, event.blockId, (b) =>
        b.mode === "url" ? { ...b, linkState: event.state } : b,
      );
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
    case "sessionDraftChanged": {
      if (event.draft === "") {
        const { [event.sessionId]: _d, ...drafts } = state.drafts;
        return { ...state, drafts };
      }
      return { ...state, drafts: { ...state.drafts, [event.sessionId]: event.draft } };
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
                content: b.content ?? [],
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
    case "savedRootsChanged":
      return { ...state, savedRoots: event.savedRoots };
    default:
      return state; // events belonging only to the settings channel (same shared union)
  }
}

export const coalesceAgentViewEvent: CoalesceHook<AgentViewEvent> = (prev, next) => {
  // Concatenate text chunks per message.
  if (
    (prev.kind === "agentTextDelta" && next.kind === "agentTextDelta") ||
    (prev.kind === "agentThoughtDelta" && next.kind === "agentThoughtDelta")
  ) {
    if (prev.sessionId === next.sessionId && prev.blockId === next.blockId) {
      return { ...next, text: prev.text + next.text } as AgentViewEvent;
    }
  }
  // Same rule in the part vocabulary: adjacent replayed text parts of one
  // user block ride as a single event.
  if (
    prev.kind === "userPartAppended" &&
    next.kind === "userPartAppended" &&
    prev.sessionId === next.sessionId &&
    prev.blockId === next.blockId &&
    prev.part.kind === "text" &&
    next.part.kind === "text"
  ) {
    return { ...next, part: { kind: "text", text: prev.part.text + next.part.text } };
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
      content: next.content ?? prev.content,
      diffFiles: next.diffFiles ?? prev.diffFiles,
    };
  }
  // Usage can report mid-stream (claude-agent-acp does) — only the latest
  // counters matter, but a plan-window reading is sticky state the reducer
  // deliberately keeps: a plain tick collapsing over it would erase a
  // reading at the transport layer that the reducer would have preserved.
  if (
    prev.kind === "usageReported" &&
    next.kind === "usageReported" &&
    prev.sessionId === next.sessionId
  ) {
    if (next.plan === undefined) {
      return prev.plan === undefined ? next : { ...next, plan: prev.plan };
    }
    // Different windows are parallel axes — both readings must reach the
    // reducer's per-window merge; don't coalesce.
    if (prev.plan === undefined || prev.plan.window === next.plan.window) return next;
    return null;
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
 * state, never persisted (offerings are
 * read, never stored — provider inventory can't be version-keyed honestly).
 * Sourced from the defaults editor's own throwaway session — the surface the
 * agent reports for the defaults being edited (a surface is conditioned on
 * its selections: a model's effort levels exist only once that model is
 * set), re-read after every edit; the entry leaves settings state when the
 * editor collapses or the connection ends. */
export interface AgentKnobsView {
  /** The normalized knob offering (knobs.ts): ids, names, and offered
   * values only — no current value: the stored defaults are the selection,
   * the surface is what can be selected. */
  knobs: readonly {
    id: string;
    name: string;
    category?: string;
    type: "select" | "boolean";
    /** Offered values — empty for boolean options. */
    values: readonly { value: string; name: string }[];
  }[];
  /** Why no surface can be read right now (a latched agent before its
   * first real session; a session the agent refused to open) — the card
   * states it instead of a spinner that never resolves. */
  unavailable?: string;
}

export interface SettingsState {
  /** The open section — host-owned so it survives webview disposal and so
   * openSettings can deep-link (e.g. the Agent View's "Add or manage"). */
  section: SettingsSectionId;
  agents: readonly AgentSummary[];
  registryAgents: readonly RegistryAgentView[];
  /** Agents with a newer registry version than they run — the card's
   * upgrade chip. */
  updates: Readonly<Record<string, AgentUpdate>>;
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
  /** Agents (global, developer-env — never repo-committed): addable,
   * editable, removable from Settings; connecting one goes through the same
   * `connectAgent` action as registry/custom (`{ configuredId }`). */
  agentConfigs: readonly AgentConfigView[];
  /** Stat tile: sessions active today — a projection of the Agent View's
   * canonical rows (their `updatedAt` falls on today), republished by the
   * orchestrator whenever that state moves. Activity, not creation: the
   * wire's `session/list` carries only an activity stamp, so activity is
   * the one definition every row can honor. */
  sessionsActiveToday: number;
  /** Keyed by agentId — observed knob offerings (see AgentKnobsView). */
  agentKnobs: Readonly<Record<string, AgentKnobsView>>;
  /** ISO time of the last successful ACP registry fetch; "" = never. */
  registryFetchedAt: string;
  /** At most one at a time — the Add Agent flow blocks on it. */
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
  /** This machine's system sounds (basenames, sound.ts enumerates the
   * platform's own sound directory at activation) — the Turn-end picker's
   * options. Empty on platforms with no enumerable set. */
  doneSounds: readonly string[];
  /** Saved roots page snapshot — same event as the agent view's copy. */
  savedRoots: SavedRootsView;
}

/** One row of the Data page's storage inventory — a store, where it lives
 * (the placement contract, stated as live
 * reality), and what's in it right now. */
export interface DataInventoryRow {
  id: string;
  label: string;
  placement: "globalStorage file" | "workspaceState" | "SecretStorage" | "workspace storage";
  detail: string;
}

export const initialSettingsState: SettingsState = {
  section: "agents",
  agents: [],
  registryAgents: [],
  updates: {},
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
  agentConfigs: [],
  sessionsActiveToday: 0,
  agentKnobs: {},
  registryFetchedAt: "",
  verifyingAgents: {},
  wireLog: { active: false, until: null },
  dataInventory: null,
  preferences: DEFAULT_PREFERENCES,
  doneSounds: [],
  savedRoots: NO_SAVED_ROOTS,
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
  | { kind: "agentConfigsChanged"; configs: readonly AgentConfigView[] }
  | { kind: "sessionStatsChanged"; sessionsActiveToday: number }
  | { kind: "agentKnobsObserved"; agentId: string; knobs: AgentKnobsView }
  /** The defaults editor ended its session — the surface leaves with it,
   * so a re-expanded card reads fresh instead of showing a stale one. */
  | { kind: "agentKnobsReleased"; agentId: string }
  | { kind: "wireLogChanged"; active: boolean; until: string | null }
  | { kind: "dataInventoryChanged"; rows: readonly DataInventoryRow[] }
  | { kind: "agentVerifyStarted"; agentId: string }
  | { kind: "agentVerifyFinished"; agentId: string }
  | { kind: "sectionChanged"; section: SettingsSectionId };

export function reduceSettings(
  state: SettingsState,
  event: SettingsEvent,
): SettingsState {
  switch (event.kind) {
    case "agentStatusChanged":
      return {
        ...state,
        agents: reduceAgents(state.agents, event),
        // Offerings are connection state — the defaults editor's session
        // rode the connection, so its surface leaves with it; an expanded
        // card reopens one when the agent is back.
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
        agentKnobs: dropKey(state.agentKnobs, event.agentId),
        verifyingAgents: dropKey(state.verifyingAgents, event.agentId),
      };
    case "registryChanged":
      return { ...state, registryAgents: event.agents, registryFetchedAt: event.fetchedAt };
    case "agentUpdatesChanged":
      return { ...state, updates: event.updates };
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
    case "agentConfigsChanged":
      return { ...state, agentConfigs: event.configs };
    case "sessionStatsChanged":
      return { ...state, sessionsActiveToday: event.sessionsActiveToday };
    case "agentKnobsObserved":
      return { ...state, agentKnobs: { ...state.agentKnobs, [event.agentId]: event.knobs } };
    case "agentKnobsReleased":
      return { ...state, agentKnobs: dropKey(state.agentKnobs, event.agentId) };
    case "wireLogChanged":
      return { ...state, wireLog: { active: event.active, until: event.until } };
    case "dataInventoryChanged":
      return { ...state, dataInventory: event.rows };
    case "preferencesChanged":
      return { ...state, preferences: event.preferences };
    case "savedRootsChanged":
      return { ...state, savedRoots: event.savedRoots };
    case "sectionChanged":
      return { ...state, section: event.section };
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
  "agentConfigsChanged",
  "sessionStatsChanged",
  "agentKnobsObserved",
  "agentKnobsReleased",
  "wireLogChanged",
  "dataInventoryChanged",
  "agentVerifyStarted",
  "agentVerifyFinished",
  "sectionChanged",
]);

export const coalesceSettingsEvent: CoalesceHook<SettingsEvent> = (prev, next) => {
  if (SETTINGS_ONLY_KINDS.has(prev.kind) || SETTINGS_ONLY_KINDS.has(next.kind)) return null;
  return coalesceAgentViewEvent(prev as AgentViewEvent, next as AgentViewEvent);
};
