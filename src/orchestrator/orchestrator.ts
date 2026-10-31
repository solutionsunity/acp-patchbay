// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Orchestrator: the single source of truth for sessions, capability tables,
// permission rules, secrets and configuration — every part of the window's
// work that runs without VS Code, composed in one place. Webviews only ever
// see its snapshots and patches; what it needs from the editor arrives
// through its ports (orchestrator-host.ts fills them).
import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  chatPaneShows,
  coalesceAgentViewEvent,
  coalesceSettingsEvent,
  initialAgentViewState,
  initialSettingsState,
  onScreen,
  reduceAgentView,
  reduceSettings,
  type Action,
  type AgentViewEvent,
  type AgentViewState,
  type CommandJudgementView,
  type ConnectAgentSource,
  type DataInventoryRow,
  type ElicitationAnswer,
  type RuleMatchView,
  type SavedRootScope,
  type SavedRootsView,
  type SettingsEvent,
  type SettingsSectionId,
  type SettingsState,
  type TesterShell,
  type WriteLocation,
  type WriteScopeView,
} from "../shared/protocol";
import { typedRun } from "../shared/command-line";
import { openAsks, type OpenAsk } from "../shared/attention";
import { AgentGates, endQuestion, type AgentOperation } from "./agent-gates";
import { AgentsStore, type ConnectionOperations } from "./agents-store";
import { ATTACHMENTS_DIR } from "./attachments";
import { DIFFS_DIR } from "./diff-files";
import { AsksStore, type AskPlace } from "./asks-store";
import { sessionOwner, type SessionOwner } from "./session-owner";
import { PermissionBroker } from "./broker";
import { ClientHost, clientRequestHooks } from "./client-host";
import { readConfiguration, type ConfigurationRead } from "./config-import";
import { exportConfiguration, type ConfigurationFile } from "./config-export";
import { applyImport, type ImportOutcome } from "./config-import-apply";
import { storedRows } from "./stores/inventory";
import { localConfiguration, planImport, type ImportPlan } from "./config-import-plan";
import { commandFound } from "./spawn-resolve";
import { eraseAllData } from "./erase-all";
import { CapabilityTracker } from "./capability-tracker";
import { DefaultsEditor } from "./defaults-editor";
import { ChannelHost } from "./channel";
import { chimePlayer, type SurfaceFacts } from "./chime";
import { count } from "../shared/count";
import type { RequestUserInputParams } from "../mcp/ipc-protocol";
import { McpServerGates } from "./mcp-server-gates";
import { McpServersStore, type McpServerLineOperations } from "./mcp-servers-store";
import { OAuthCallbackRegistry } from "./oauth-callback";
import { elicitationResponseOf, formFieldsOf, type ElicitationScope } from "./readers/elicitation";
import { AgentPool } from "./pool";
import { agentErrorText, authRequiredReasonOf } from "./readers/agent-error";
import { Cancelled, Queue } from "./queue";
import type { AgentUpdate, ExportPart, McpServerWork } from "../shared/protocol";
import { type AttachWork, SessionGates } from "./session-gates";
import { SessionsStore, type SessionConnectionOperations } from "./sessions-store";
import { WireLog } from "./wire-log";
import {
  AcpRegistryStore,
  binaryDigestFor,
  registryAgentView,
} from "./stores/acp-registry";
import { AgentConfigStore } from "./stores/agent-configs";
import { ComposerKnobsStore } from "./stores/composer-knobs";
import { PreferencesStore } from "./stores/preferences";
import { SecretEnvStore } from "./stores/secret-env";
import { resolveLaunch, runtimeName, type DownloadAsk, type DownloadCheck } from "./runtime-resolver";
import { DecisionAuditStore } from "./stores/decision-audit";
import { McpServerConfigStore } from "./stores/mcp-server-configs";
import { McpServerTokenStore } from "./stores/mcp-server-tokens";
import { LastActiveSessionStore } from "./stores/last-active-session";
import { LastConnectedStore } from "./stores/last-connected";
import { DefaultAgentFoldStore } from "./stores/default-agent-fold";
import { type CommandRule, MachineRulesStore, PermissionRulesStore } from "./stores/permission-rules";
import { ShellReader } from "./shell-reading";
import { MachineWriteScopeStore, withWriteEntry, writeScopeRows } from "./stores/write-scope";
import { SavedRootsStore } from "./stores/saved-roots";
import { SECRET_FAMILIES } from "./stores/storage-keys";
import { loadCatalog } from "./stores/mcp-catalog";
import { SpawnRegistryStore } from "./stores/spawn-registry";
import { AuthLockStore } from "./stores/auth-locks";
import { SessionContinuityStore } from "./stores/session-continuity";
import { adoptStashedChips, SessionFilesStore } from "./stores/session-files";
import { UsedCapabilityStore } from "./stores/used-capabilities";
import { sessionsActiveToday } from "./session-stats";
import type { PatchbayAgentId, PatchbayAskId, PatchbayMcpServerId, PatchbaySessionId } from "../shared/ids";
import type { AgentsStoreHooks } from "./agents-store";
import type { KV } from "./stores/kv";
import { IpcHost, type EditorReads } from "./ipc-host";
import type { Logger } from "./logger";
import type { OAuthUserAgent } from "./mcp-oauth";
import type { SecretsLike } from "./stores/mcp-server-tokens";
import type { WireLogSink } from "./wire-log";

/** What the download prompt says of the check — only what is known: held
 * to a published digest, nothing published, or the registry unreadable. */
const DOWNLOAD_CHECK_TEXT: Record<DownloadCheck, string> = {
  sha256: "The download is checked against its published SHA-256.",
  "none-published": "No SHA-256 is published for it, so the download can't be checked.",
  "registry-unreachable": "The ACP registry couldn't be reached for its SHA-256, so the download can't be checked.",
};

/** A permission card's title when neither the request nor the call it
 * asks about named one. */
const PERMISSION_UNTITLED = "Permission request";

/** Where the orchestrator lives: the storage it is given and the folder it
 * works in. The host builds these from its editor; a test, from memory. */
export interface OrchestratorPlace {
  /** This machine's settings and records — shared by every window. */
  machineKV: KV;
  /** This workspace's own — its rules, its saved roots, its last session. */
  workspaceKV: KV;
  secrets: SecretsLike;
  globalStoragePath: string;
  /** The workspace's own storage folder; null in a window with none. */
  storagePath: string | null;
  workspaceCwd: string;
  /** The bundled scripts an agent spawns as MCP servers. */
  scripts: { editorServer: string; bridge: string };
  /** The folder holding the bash grammar the command rules read lines
   * with (`tree-sitter.wasm`, `tree-sitter-bash.wasm`). */
  shellGrammar: string;
  /** The name of the IPC host's socket — one per window. */
  ipcName: string;
}

/** What the orchestrator asks of the editor it runs in — every step that
 * needs VS Code itself: its views' actions, its folders, its dialogs and
 * notifications, its open documents, its browser, its output. */
export interface OrchestratorPorts {
  handleAction(action: Action): void;
  workspaceRoots(): string[];
  /** The editor's own state — what the IPC host answers a subprocess
   * asking for it. */
  editor: EditorReads;
  redirectUri: OAuthUserAgent["redirectUri"];
  openLink(href: string): PromiseLike<boolean>;
  confirm(message: string, choice: string): Promise<boolean>;
  warn(message: string): void;
  runLoginTask: AgentsStoreHooks["runLoginTask"];
  announceUpdates(): Promise<void>;
  wireSink(): WireLogSink;
  onWireLogStateChanged(active: boolean, until: string | null): void;
  pinnedSessions(): readonly string[];
  readTextFileLive(path: string): Promise<string>;
  writeTextFileLive(path: string, content: string): Promise<void>;
  closeAskDiffs(patchbayAskId: PatchbayAskId): Promise<void>;
  connectStartupAgents(): Promise<void>;
  focusComposer(): Promise<void>;
  notifyAsk(patchbaySessionId: PatchbaySessionId, title: string, ask: OpenAsk): void;
  syncDetachContext(): void;
  warnCatch(context: string, what: string): (err: unknown) => void;
}

/** What a view host says of an open agent surface. */
export interface SurfaceReport {
  visible: boolean;
  /** The session it shows; null = it follows the active-session pointer. */
  pinned: string | null;
}

export class Orchestrator {
  readonly agentView: ChannelHost<AgentViewState, AgentViewEvent>;
  readonly settings: ChannelHost<SettingsState, SettingsEvent>;

  readonly decisionAudit: DecisionAuditStore;
  readonly lastConnected: LastConnectedStore;
  private readonly defaultAgentFold: DefaultAgentFoldStore;
  private readonly lastActiveSession: LastActiveSessionStore;
  private readonly agentConfigs: AgentConfigStore;
  private readonly mcpServerConfigs: McpServerConfigStore;
  private readonly usedCapabilities: UsedCapabilityStore;
  /** Standing auth locks (auth-evidence.ts) — persisted so reload and
   * reconnect cannot launder a witnessed logout. The agents store owns
   * them: noteAuthEvidence is the one writer of a lock's transitions, and
   * an agent's removal or the erase purges it. */
  private readonly authLocks: AuthLockStore;
  readonly spawnRegistry: SpawnRegistryStore;
  private readonly agentEnv: SecretEnvStore;
  private readonly mcpServerEnv: SecretEnvStore;
  readonly acpRegistry: AcpRegistryStore;
  readonly permissionRules: PermissionRulesStore;
  readonly machinePermissionRules: MachineRulesStore;
  readonly machineWriteScope: MachineWriteScopeStore;
  readonly workspaceSavedRoots: SavedRootsStore;
  readonly machineSavedRoots: SavedRootsStore;
  readonly preferences: PreferencesStore;
  private readonly composerKnobs: ComposerKnobsStore;
  private readonly sessionContinuity: SessionContinuityStore;
  private readonly sessionFiles: SessionFilesStore;
  /** The updates already announced this window ("patchbayAgentId@version") — each
   * newer version is told once. */
  private readonly announcedUpdates = new Set<string>();
  readonly pool: AgentPool;
  /** The agents store without its connection operations — those are
   * reached only through the gates. */
  readonly agents: Omit<AgentsStore, keyof ConnectionOperations>;
  readonly gates: AgentGates;
  /** The sessions store without its connection operations — those are
   * reached only through the session gates. */
  readonly sessions: Omit<SessionsStore, keyof SessionConnectionOperations>;
  readonly sessionGates: SessionGates;
  readonly capabilityTracker: CapabilityTracker;
  readonly defaultsEditor: DefaultsEditor;
  readonly broker: PermissionBroker;
  readonly asks: AsksStore;
  private readonly mcpServerTokens: McpServerTokenStore;
  /** The MCP-servers store without the operations that take time — those
   * are reached only through the MCP gates. */
  readonly mcpServers: Omit<McpServersStore, keyof McpServerLineOperations>;
  readonly mcpServerGates: McpServerGates;
  /** Pending OAuth callbacks — extension.ts's UriHandler feeds this. */
  readonly oauthCallbacks = new OAuthCallbackRegistry();

  /** The one directory this window's work runs in: agents spawn here (and
   * their stdio MCP children inherit it), sessions open here, MCP server
   * probes execute here, relative asset paths resolve here. The process
   * cwd stands in when no folder is open. Derived once — VS Code restarts
   * the extension host when the first folder changes, so it is a process
   * constant; every consumer reads this field, none re-derives it. */
  readonly workspaceCwd: string;
  private readonly binaryCacheDir: string;
  /** The two places VS Code keeps what patchbay stores — read raw only by
   * the Data page's inventory. */
  private readonly kvs: { machine: KV; workspace: KV };
  readonly clientHost: ClientHost;
  /** The socket the subprocesses an agent spawns from a session's
   * mcpServers entries ask through. */
  readonly ipcHost: IpcHost;
  /** The session the last-open pointer names, by this window's id for it —
   * null until one is activated here. */
  private pointerRow: string | null = null;
  /** In-flight session/list syncs per agent — awaited by the startup
   * restore so "found or not" is judged against a settled list. */
  private readonly pendingSyncs = new Map<string, Promise<void>>();
  /** The import the Import/Export page is reviewing: the file as read.
   * Lives as long as the review. */
  configImport: { id: number; fileName: string; read: ConfigurationRead } | null = null;
  private importCount = 0;
  /** Live agent-view surfaces, by the id their host gave them, in the
   * order they opened: whether each is visible, the session it pins (null
   * = follows the active-session pointer), and whether the user has
   * touched it since its page loaded. The view hosts report visibility
   * and closing through noteSurface; the page reports its touch. */
  private readonly surfaces = new Map<string, SurfaceFacts & { pinned: string | null }>();
  /** Open asks already accounted for by the native notification — each
   * new one is judged once, as it arrives. */
  private knownAsks = new Set<string>();
  /** Wire log (Audit page): channel and status pill exist only while it's
   * ever been / is on — a transient state gets transient surfaces. */
  wireLog!: WireLog;
  constructor(
    place: OrchestratorPlace,
    private readonly ports: OrchestratorPorts,
    private readonly log: Logger,
  ) {
    this.workspaceCwd = place.workspaceCwd;
    this.binaryCacheDir = join(place.globalStoragePath, "bin-cache");
    const machineKV = place.machineKV;
    this.kvs = { machine: machineKV, workspace: place.workspaceKV };
    this.permissionRules = new PermissionRulesStore(place.workspaceKV);
    this.machinePermissionRules = new MachineRulesStore(machineKV);
    this.machineWriteScope = new MachineWriteScopeStore(machineKV);
    this.workspaceSavedRoots = new SavedRootsStore(place.workspaceKV, "workspace");
    this.machineSavedRoots = new SavedRootsStore(machineKV, "machine");
    this.decisionAudit = new DecisionAuditStore(place.storagePath);
    this.lastConnected = new LastConnectedStore(place.workspaceKV);
    this.defaultAgentFold = new DefaultAgentFoldStore(machineKV);
    this.lastActiveSession = new LastActiveSessionStore(place.workspaceKV);
    // Agents and MCP servers are developer-env, not code-env: global to
    // this machine, never a repo-committed file. Deliberately global-only —
    // workspace binding may return later as an opt-in (see
    // stores/mcp-server-configs.ts's header for the incident that shaped
    // this).
    this.agentConfigs = new AgentConfigStore(machineKV);
    this.mcpServerConfigs = new McpServerConfigStore(machineKV);
    this.preferences = new PreferencesStore(machineKV);
    this.composerKnobs = new ComposerKnobsStore(machineKV);
    this.sessionContinuity = new SessionContinuityStore(machineKV);
    this.sessionFiles = new SessionFilesStore(join(place.globalStoragePath, "session-files"));
    this.usedCapabilities = new UsedCapabilityStore(machineKV);
    this.authLocks = new AuthLockStore(machineKV);
    this.spawnRegistry = new SpawnRegistryStore(machineKV, log);
    this.agentEnv = new SecretEnvStore(place.secrets, SECRET_FAMILIES.agent, (m) => log.warn(`agent env: ${m}`));
    this.mcpServerEnv = new SecretEnvStore(place.secrets, SECRET_FAMILIES.mcpServer, (m) =>
      log.warn(`MCP server env: ${m}`),
    );
    this.mcpServerTokens = new McpServerTokenStore(place.secrets);
    // The management side's tools for MCP servers: a line per server (its
    // probe, its remove) and one per connect under way, and the gates over
    // them. What the lines hold is the MCP side's busy state, so every move
    // republishes it.
    const republish = () => void this.mcpServers.refresh();
    const serverLine = new Queue<McpServerWork>(republish);
    const connectLine = new Queue<"connect">(republish);
    const mcpServers = new McpServersStore(
      loadCatalog(),
      this.mcpServerConfigs,
      this.mcpServerTokens,
      this.mcpServerEnv,
      { emit: (...events) => this.settings.emit(...events) },
      { busy: (patchbayMcpServerId) => serverLine.held(patchbayMcpServerId), connecting: () => connectLine.holding() },
      {
        editorServerScript: place.scripts.editorServer,
        bridgeScript: place.scripts.bridge,
        socketPath: () => this.ipcHost.socketPath,
        crossing: (value) => this.wireLog.registerSecret(value),
      },
      this.workspaceCwd,
      {
        redirectUri: () => this.ports.redirectUri(),
        authorize: async (authorizationUrl, state, signal) => {
          const pending = this.oauthCallbacks.wait(state, signal);
          await this.ports.openLink(authorizationUrl);
          return pending;
        },
      },
      log,
    );
    this.mcpServers = mcpServers;
    this.mcpServerGates = new McpServerGates(mcpServers, serverLine, connectLine);

    // The registry starts empty — the picker fills when the first fetch
    // (cache or network) resolves and publishes via registryChanged.
    const onAction = (action: Action) => this.ports.handleAction(action);
    const workspaceRootsView = () => this.ports.workspaceRoots();
    this.agentView = new ChannelHost(
      {
        ...initialAgentViewState,
        // No session rows here: the agent's own session/list is the only
        // list — the startup connects repopulate the drawer from the wire.
        // Hold the loading page only when there is actually a last open
        // session to come back to — startupSettled clears it either way.
        restoring: this.lastActiveSession.stored(),
        workspaceRoots: workspaceRootsView(),
        savedRoots: this.savedRootsView(),
        preferences: this.preferences.get(),
      },
      reduceAgentView,
      coalesceAgentViewEvent,
      onAction,
    );
    const rules = this.permissionRules.get();
    this.settings = new ChannelHost(
      {
        ...initialSettingsState,
        commandRules: rules.commandRules,
        machineCommandRules: this.machinePermissionRules.get().commandRules,
        writeScope: this.writeScopeView(),
        mcpCatalog: this.mcpServers.catalogViews(),
        preferences: this.preferences.get(),
        savedRoots: this.savedRootsView(),
      },
      reduceSettings,
      coalesceSettingsEvent,
      onAction,
    );

    this.acpRegistry = new AcpRegistryStore(
      join(place.globalStoragePath, "registry"),
      // A fetch that landed is the registry's fresh word — the moment a
      // newer version becomes news (the cached copy at start is not).
      () => {
        this.publishRegistry();
        void this.ports.announceUpdates();
      },
      () => this.preferences.get(),
      log,
    );

    // Wire log: sink is lazy (no empty Output channel for a feature never
    // used); state changes feed the settings channel and the status pill.
    this.wireLog = new WireLog(
      () => this.ports.wireSink(),
      (active, until) => this.ports.onWireLogStateChanged(active, until),
    );

    // Pool hooks close over `this` and only fire once the pool is actually
    // used (after the constructor returns), so referencing sessions /
    // capabilityTracker / broker here — before they're assigned below — is
    // safe; this is the same lazy-closure pattern all three use themselves.
    this.pool = new AgentPool({
      onStatusChanged: (patchbayAgentId, status, detail) => {
        this.agents.noteStatus(patchbayAgentId, status, detail);
        if (status !== "running") this.settleAsksOn(patchbayAgentId);
        // Every way a connection ends detaches the sessions that rode it —
        // they reopen (session/load or resume) before reuse, keeping what
        // they hold.
        this.sessions.agentStatusChanged(patchbayAgentId, status);
        // The editor's session rode the connection that just ended, and so
        // did any completion notice still waiting for its question.
        if (status !== "running") {
          this.defaultsEditor.forget(patchbayAgentId);
          this.asks.forgetAgent(patchbayAgentId);
        }
        // Every connect of a list-capable agent syncs its own session
        // history into the list — the wire is the ONLY list (patchbay
        // persists no session records). The promise is tracked so the
        // startup restore can wait for the lists before deciding whether
        // the last-active pointer still resolves.
        if (status === "running") {
          const sync = this.sessions
            .syncAgentSessions(patchbayAgentId)
            // A session opened before its agent connected sat blank (no
            // replay to run yet) — attach whatever is on view now that a
            // process exists.
            .then(() => this.sessionGates.reattachViewed(patchbayAgentId))
            .catch(this.logCatch(`session/list sync for ${patchbayAgentId}`))
            .finally(() => {
              if (this.pendingSyncs.get(patchbayAgentId) === sync) this.pendingSyncs.delete(patchbayAgentId);
            });
          this.pendingSyncs.set(patchbayAgentId, sync);
        }
        // Offerings are connection state — the settings reducer drops its
        // copy off the row's status; the defaults editor forgot its session
        // above, and an expanded card reopens one once running.
      },
      onDeclaredCaptured: (patchbayAgentId) => this.agents.noteDeclared(patchbayAgentId),
      onSessionUpdate: (patchbayAgentId, sessionId, update) => {
        // Throwaway sessions never reach a transcript: the probe's traffic
        // is dropped, the defaults editor's feeds its own surface.
        switch (this.ownerOf(patchbayAgentId, sessionId).kind) {
          case "probe":
            return;
          case "defaultsEditor":
            this.defaultsEditor.handleUpdate(patchbayAgentId, sessionId, update);
            return;
          default:
            this.sessions.handleUpdate(patchbayAgentId, sessionId, update);
        }
      },
      onCapabilityEvidence: (patchbayAgentId, row, evidence) => this.agents.noteEvidence(patchbayAgentId, row, evidence),
      onAuthWireFact: (patchbayAgentId, method, settled, startedAt, reason) =>
        this.agents.noteAuthWireFact(patchbayAgentId, method, settled, startedAt, reason),
      wireLogActive: () => this.wireLog.active,
      onWireFrame: (patchbayAgentId, direction, line) => this.wireLog.frame(patchbayAgentId, direction, line),
      onProcessSpawned: (process) => void this.spawnRegistry.track(process, "agent"),
      onElicitation: async (patchbayAgentId, reading, signal) => {
        if (reading.kind === "invalid") throw RequestError.invalidParams({ reason: reading.why });
        // A question patchbay can't present reaches no one: no user declined
        // it, so it is answered as dismissed — `decline` is the user's own no.
        if (reading.kind === "refuse") {
          this.log.info(`${patchbayAgentId}: cancelled an elicitation no one could be shown — ${reading.why}`);
          return { action: "cancel" };
        }
        const { message, ask, elicitationId } = reading;
        const at = this.questionPlace(patchbayAgentId, reading);
        if (at === null) return { action: "cancel" };
        const answer = await this.broker.askElicitation(
          at,
          { message, ask, ...(elicitationId !== undefined ? { completion: { patchbayAgentId, elicitationId } } : {}) },
          signal,
        );
        return elicitationResponseOf(ask, answer, signal);
      },
      onElicitationComplete: (patchbayAgentId, elicitationId) => this.asks.completeLink(patchbayAgentId, elicitationId),
      onPermissionRequest: async (patchbayAgentId, request, signal) => {
        const { sessionId, call, options } = request;
        // A throwaway session — the probe's or the defaults editor's — can
        // trip real agent-side gates (Auggie's workspace-indexing question
        // rides session/new). No surface renders one, so the card/toast
        // path would leave the agent's RPC dangling forever — a JSON-RPC
        // request is always owed an answer. Least privilege instead: the
        // question re-asks on the user's first real session, and the probe
        // dir is never the workspace.
        const owner = this.ownerOf(patchbayAgentId, sessionId);
        if (owner.kind === "probe" || owner.kind === "defaultsEditor") {
          const title = call.title ?? PERMISSION_UNTITLED;
          this.log.info(`${patchbayAgentId}: auto-declined "${title}" on a throwaway session`);
          return this.broker.resolveProbePermissionRequest(patchbayAgentId, sessionId, title, options);
        }
        // A session patchbay doesn't hold has no card to show — the request
        // is still owed an answer, and nobody saw it: cancelled.
        if (owner.kind === "none") {
          this.log.info(`${patchbayAgentId}: cancelled a permission request on session ${sessionId}, which patchbay doesn't hold`);
          return { cancelled: true };
        }
        const { patchbaySessionId } = owner;
        const { title, view, proposals } = this.sessions.permissionCall(patchbaySessionId, call);
        const result = await this.broker.resolveAgentPermissionRequest(
          patchbaySessionId,
          { title: title ?? PERMISSION_UNTITLED, call: view, options, proposals },
          signal,
        );
        // A rejected request marks its tool-call block denied — "blocked by
        // permission" renders distinct from "failed".
        // Only this path can correlate: the request carries the toolCallId;
        // patchbay's own fs/terminal gates have no id and already show their
        // own permission/diff cards inline.
        const chosen = "cancelled" in result ? undefined : options.find((o) => o.optionId === result.optionId);
        if (chosen !== undefined && chosen.kind.startsWith("reject")) {
          this.agentView.emit({ kind: "toolCallDenied", patchbaySessionId, blockId: call.toolCallId });
        }
        return result;
      },
      ...clientRequestHooks(
        () => this.clientHost,
        // only the user's session reads, writes or runs anything
        (patchbayAgentId, sessionId) => {
          const owner = this.ownerOf(patchbayAgentId, sessionId);
          return owner.kind === "user" ? owner.patchbaySessionId : undefined;
        },
      ),
    }, log, {
      // Launch prerequisites (runtime-resolver.ts), as phases of the
      // connect on the agent's card: a registry binary agent's own archive,
      // and — detect-first, sandbox-fallback — the interpreter an npx/uvx
      // launcher needs, downloaded into bin-cache only on a failed gate.
      // Every download passes the same explicit confirmation.
      resolveLaunch: (spec, onPhase, signal) =>
        resolveLaunch(spec, {
          cacheRoot: this.binaryCacheDir,
          log: this.log,
          onPhase,
          signal,
          confirmDownload: (ask) => this.confirmDownload(ask),
          digestFor: (distribution, version, pinned) =>
            binaryDigestFor(this.acpRegistry.current().agents, distribution, version, pinned),
          readRegistry: async () => (await this.acpRegistry.read("download")).ok,
        }),
    });

    const sessions = new SessionsStore(
      this.pool,
      {
        emit: (...events) => {
          this.agentView.emit(...events);
          this.recordLastActive(events);
          this.maybeChime(events);
        },
        // The session/load replay window: canonical state advances (and the
        // settings/last-active relays stay truthful) but no patches ride to
        // the webview — resyncView closes the window with one wholesale swap.
        emitSilent: (...events) => {
          this.agentView.emitSilent(...events);
          this.recordLastActive(events);
        },
        resyncView: () => this.agentView.resync(),
        // The deferred-probe trigger for latched agents
        // (extensions/first-session-mcp-latch) — and, for everyone, the
        // signal that a real session now owns this id (any probe entry
        // still carrying it is retired).
        onRealSessionAttached: (patchbayAgentId, sessionId) =>
          this.capabilityTracker.noteRealSessionOpened(patchbayAgentId, sessionId),
        // From the agent's saved config, never the pool entry's spec: that
        // one is a connect-time snapshot, and a Settings edit to defaults
        // must reach the very next session, not wait for a reconnect. The
        // knobSource preference is read just as fresh. Defaults themselves
        // are written only by the Settings save path — read-only to
        // everything here.
        seedFor: (patchbayAgentId) => this.agents.knobSeed(patchbayAgentId, this.preferences.get().knobSource),
        onKnobsConfirmed: (patchbayAgentId, seed) => this.agents.recordKnobs(patchbayAgentId, seed),
        rootsChanged: (patchbaySessionId) => {
          // Every subprocess of the session was spawned with one of its
          // tokens (one per attach; a re-attach mints a fresh one).
          for (const token of this.sessions.tokensOf(patchbaySessionId)) this.ipcHost.notifyRootsChanged(token);
        },
        workspaceRoots: workspaceRootsView,
        savedRoots: () => {
          const saved = this.savedRootsView();
          return [...(saved.workspace ?? []), ...saved.machine];
        },
        rootExists: isFolder,
        // a skipped saved root earns its mark in Settings now, not at the
        // page's next unrelated refresh
        rootsMissing: () => this.publishSavedRoots(),
        currentTranscript: (patchbaySessionId) => this.agentView.current.transcripts[patchbaySessionId] ?? [],
        capabilities: (patchbayAgentId) => this.agents.matrix(patchbayAgentId),
        isActiveSession: (patchbaySessionId) =>
          this.agentView.current.activePatchbaySessionId === patchbaySessionId ||
          this.ports.pinnedSessions().includes(patchbaySessionId),
        isUnseen: (patchbaySessionId) =>
          this.agentView.current.sessions.find((s) => s.id === patchbaySessionId)?.unseen === true,
        cancelAsks: (patchbaySessionId) => this.asks.stopSession(patchbaySessionId),
        endTurnAsks: (patchbaySessionId, turn, stopped) => this.asks.endTurn(patchbaySessionId, turn, stopped),
        authLocked: (patchbayAgentId) => this.agents.authLocked(patchbayAgentId),
        // the pointer names the session the agent's way, which a re-mint moves
        sessionIdChanged: (patchbaySessionId) => {
          if (this.pointerRow === patchbaySessionId) this.recordPointer(patchbaySessionId);
        },
      },
      this.sessionContinuity,
      this.sessionFiles,
      () => this.workspaceCwd,
      // A session's MCP servers, composed by their store; the agent's
      // mcp.http claim is read here, where the stores meet. Declared, not
      // used, and that's correct (prompt.image mechanics): passthrough is
      // how the claim gets exercised at all — a used-gate would deadlock the
      // row forever.
      (contextToken, patchbayAgentId) =>
        this.mcpServers.mcpServersFor(
          patchbayAgentId,
          contextToken,
          this.agents.matrix(patchbayAgentId)?.["mcp.http"]?.declared === true,
        ),
      log,
    );
    // The socket answers only through what each attach was given: its
    // token, the session it served, and the servers it got.
    this.ipcHost = new IpcHost(
      place.ipcName,
      {
        admits: (contextToken) => this.sessions.admits(contextToken),
        requestUserInput: (contextToken, params) => this.requestUserInput(contextToken, params),
        // Same token discipline as requestUserInput: a token whose session is
        // gone has no roots.
        sessionRoots: (contextToken) => {
          const patchbaySessionId = this.sessions.sessionOfToken(contextToken);
          return patchbaySessionId === undefined ? [] : this.sessions.rootsOf(patchbaySessionId);
        },
        getMcpServerToken: (contextToken, patchbayMcpServerId) => {
          const patchbayAgentId = this.sessions.bridgedTo(contextToken, patchbayMcpServerId);
          return patchbayAgentId === undefined ? Promise.resolve(null) : this.mcpServers.credentialFor(patchbayMcpServerId, patchbayAgentId);
        },
      },
      ports.editor,
    );
    this.ipcHost.start();

    // The management side's tools for sessions: two lines per session —
    // its attachment work and its turn — and the gates, the one way any
    // door reaches an operation on a session's connection. What the lines
    // hold is the session's busy state, so every move re-sends it.
    const publishBusy = (patchbaySessionId: PatchbaySessionId) =>
      this.agentView.emit({ kind: "sessionBusyChanged", patchbaySessionId, busy: this.sessionGates.busy(patchbaySessionId) });
    this.sessions = sessions;
    this.sessionGates = new SessionGates(
      sessions,
      new Queue<AttachWork, PatchbaySessionId>(publishBusy),
      new Queue<"prompt", PatchbaySessionId>(publishBusy),
      {
        connect: (patchbaySessionId) => void this.connectForSession(patchbaySessionId),
        failed: (context, err) => this.logCatch(context)(err),
        agentSettled: (patchbayAgentId) => this.gates.settled(patchbayAgentId),
        connectionSettled: (patchbayAgentId) => this.gates.connectionSettled(patchbayAgentId),
      },
      // Read fresh every sweep (store-truth) — 0 in Preferences disables.
      () => {
        const minutes = this.preferences.get().idleCloseMinutes;
        return minutes <= 0 ? null : minutes * 60_000;
      },
    );
    this.capabilityTracker = new CapabilityTracker(
      this.pool,
      this.usedCapabilities,
      {
        changed: (patchbayAgentId) => this.agents.publish(patchbayAgentId),
        probeRoot: (patchbayAgentId) => this.agents.probeRoot(patchbayAgentId),
        registryIdOf: (patchbayAgentId) => this.agents.linkedRegistryId(patchbayAgentId),
      },
      log,
    );
    this.defaultsEditor = new DefaultsEditor(
      this.pool,
      {
        probeRoot: (patchbayAgentId) => this.agents.probeRoot(patchbayAgentId),
        defaultsFor: (patchbayAgentId) => this.agents.spec(patchbayAgentId)?.defaults ?? {},
        mayOpen: (patchbayAgentId) => !this.capabilityTracker.isProbeDeferred(patchbayAgentId),
        emit: (...events) => this.settings.emit(...events),
      },
      log,
    );
    // The management side's tools for agents: the queue keeps each agent's
    // turns, and the gates — the one way any door reaches an operation on
    // an agent's connection — decide how each operation meets it, and put
    // the one question before a connection ends. What the queue holds is
    // the agent's busy state, so every move re-sends its row.
    const queue = new Queue<AgentOperation, PatchbayAgentId>((patchbayAgentId) => this.agents.publish(patchbayAgentId));
    const agents = new AgentsStore(
      {
        pool: this.pool,
        configs: this.agentConfigs,
        env: this.agentEnv,
        authLocks: this.authLocks,
        usedCapabilities: this.usedCapabilities,
        composerKnobs: this.composerKnobs,
        lastConnected: this.lastConnected,
        defaultAgentFold: this.defaultAgentFold,
        registry: this.acpRegistry,
        tracker: this.capabilityTracker,
        busy: (patchbayAgentId) => queue.held(patchbayAgentId),
        workspaceCwd: this.workspaceCwd,
        binaryCacheDir: this.binaryCacheDir,
        probeRootBase: join(place.globalStoragePath, "probe"),
      },
      {
        emit: (...events) => {
          this.agentView.emit(...events);
          this.settings.emit(...events);
        },
        emitSettings: (...events) => this.settings.emit(...events),
        warn: (message) => this.ports.warn(message),
        runLoginTask: (name, recipe) => this.ports.runLoginTask(name, recipe),
        removed: (patchbayAgentId) => {
          this.sessions.forgetAgentSessions(patchbayAgentId);
          void this.mcpServers.forgetAgent(patchbayAgentId).catch(this.logCatch(`forget ${patchbayAgentId} in MCP reach`));
          // A chat pane on the agent — still starting, or failed with a
          // Retry — has nothing left to wait for or retry.
          if (this.agentView.current.chatConnect?.patchbayAgentId === patchbayAgentId) {
            this.agentView.emit({ kind: "chatConnectResolved" });
          }
        },
        authCleared: (patchbayAgentId) => this.sessionGates.lockCleared(patchbayAgentId),
        defaultsChanged: (patchbayAgentId) => void this.defaultsEditor.defaultsChanged(patchbayAgentId),
      },
      log,
    );
    this.agents = agents;
    this.gates = new AgentGates(agents, queue, {
      name: (patchbayAgentId) => agents.name(patchbayAgentId),
      openWork: (patchbayAgentId) => this.sessions.openWork(patchbayAgentId),
      confirm: (message, choice) => this.ports.confirm(message, choice),
    });
    // The editor's sessions exist only to serve the open panel — they end
    // with it.
    this.settings.onAttachment((attached) => {
      if (attached) void this.acpRegistry.read("settings");
      else void this.defaultsEditor.closeAll();
    });
    this.asks = new AsksStore(this.decisionAudit, {
      emit: (...events) => this.agentView.emit(...events),
      emitAgent: (patchbayAgentId, event) => this.settings.emit({ kind: "agentQuestion", patchbayAgentId, event }),
      turnOf: (patchbaySessionId) => this.sessions.turnOf(patchbaySessionId),
      onAuditWritten: () => void this.refreshAuditTail(),
      pairOf: (patchbaySessionId) => this.sessions.pairOf(patchbaySessionId),
      openLink: (href) => void this.ports.openLink(href),
      ended: (patchbayAskId) => void this.ports.closeAskDiffs(patchbayAskId).catch(this.logCatch(`closeAskDiffs ${patchbayAskId}`)),
    });
    this.broker = new PermissionBroker(
      this.permissionRules,
      this.asks,
      (patchbaySessionId) => this.sessions.grantedRoots(patchbaySessionId),
      (text) => this.wireLog.redact(text),
      new ShellReader(place.shellGrammar),
      this.machinePermissionRules,
      this.machineWriteScope,
      (path) => this.ports.readTextFileLive(path),
    );
    this.clientHost = new ClientHost({
      broker: this.broker,
      readLive: (path) => this.ports.readTextFileLive(path),
      writeLive: (path, content) => this.ports.writeTextFileLive(path, content),
      emit: (event) => this.agentView.emit(event),
      trackProcess: (process) => void this.spawnRegistry.track(process, "terminal"),
    });

    void this.refreshAuditTail();
    void this.agents.publishAll();
    void this.mcpServers.refresh();
    // Registry links are put right from the registry's copy before any
    // agent starts: a link an edit should have dropped would otherwise
    // launch the registry's build over the command typed.
    const registryLoaded = this.acpRegistry
      .load()
      .then(() => this.agents.relinkAll())
      .catch(this.logCatch("registry links"));
    void registryLoaded.then(() => {
      this.publishRegistry();
      void this.acpRegistry.read("startup");
    });

    // Projections of canonical Agent View state via ChannelHost.onChange —
    // the Settings "active today" tile (another channel, same source): same
    // state, read where it lives, never a second counter.
    this.agentView.onChange(() => {
      this.publishSessionStats();
      this.notifyNewAsks();
    });
    this.publishSessionStats();

    // What gone windows left running is ended before this one starts its
    // own agents. Chips staged before sessions kept their own files move
    // into them before any session can read its chips back.
    void this.spawnRegistry
      .reapLeftovers()
      .then(() =>
        adoptStashedChips(this.sessionContinuity, this.sessionFiles, ATTACHMENTS_DIR).catch(this.logCatch("adopt stashed chips")),
      )
      .then(() => registryLoaded)
      .then(() => this.ports.connectStartupAgents())
      // Settles the view's restore hold no matter how the connects went —
      // the loading page must never outlive the startup sequence.
      .finally(() => this.agentView.emit({ kind: "startupSettled" }));
  }

  /** Export: the picked parts read fresh from the stores, beside the
   * secrets their records name (config-export.ts). */
  exportConfiguration(parts: readonly ExportPart[]): Promise<ConfigurationFile> {
    return exportConfiguration(new Set(parts), {
      entries: [
        this.agentConfigs,
        this.composerKnobs,
        this.mcpServerConfigs,
        this.preferences,
        this.machinePermissionRules,
        this.machineWriteScope,
        this.machineSavedRoots,
      ],
      agents: {
        ids: () => this.agentConfigs.list().map((c) => c.id),
        env: (id) => this.agentEnv.get(id),
      },
      mcpServers: {
        ids: () => this.mcpServerConfigs.list().map((c) => c.id),
        env: (id) => this.mcpServerEnv.get(id),
        headerKey: (id) => this.mcpServers.headerKey(id as PatchbayMcpServerId),
      },
    });
  }

  /** The updates not yet told this window — each newer version is told
   * once, so these are now counted as told. */
  updatesToAnnounce(): [PatchbayAgentId, AgentUpdate][] {
    const fresh = [...this.agents.updates()].filter(([patchbayAgentId, u]) => !this.announcedUpdates.has(`${patchbayAgentId}@${u.to}`));
    for (const [patchbayAgentId, u] of fresh) this.announcedUpdates.add(`${patchbayAgentId}@${u.to}`);
    return fresh;
  }

  /** The agent of the session the last-open pointer names, if any. */
  lastActiveAgent(): PatchbayAgentId | undefined {
    return this.lastActiveSession.get()?.patchbayAgentId;
  }

  /** "Disconnect & erase all data": everything stopped, the erase sweep
   * (each owner erases its own facts, secrets first), everything republished —
   * empty. Never automatic; the Settings action is the only caller. */
  async eraseEverything(): Promise<void> {
    this.log.info("erase all data: stopping every process");
    await this.stopEverything();
    await eraseAllData({
      agents: this.agents,
      mcpServers: this.mcpServers,
      sessions: this.sessions,
      spawnRegistry: this.spawnRegistry,
      permissionRules: this.permissionRules,
      machineRules: this.machinePermissionRules,
      machineWriteScope: this.machineWriteScope,
      decisionAudit: this.decisionAudit,
      lastActiveSession: this.lastActiveSession,
      lastConnected: this.lastConnected,
      defaultAgentFold: this.defaultAgentFold,
      preferences: this.preferences,
      workspaceSavedRoots: this.workspaceSavedRoots,
      machineSavedRoots: this.machineSavedRoots,
      tempStashes: {
        wipe: async () => {
          await rm(ATTACHMENTS_DIR, { recursive: true, force: true });
          await rm(DIFFS_DIR, { recursive: true, force: true });
        },
      },
    });
    await this.republishAll();
    this.log.info("erase all data: complete — factory state");
  }

  /** Import, first half: the file the user picked, read and set against
   * this machine for review — or refused, saying why. Nothing moves yet. */
  async readConfigImport(fileName: string, text: string): Promise<void> {
    const id = ++this.importCount;
    this.configImport = null;
    const outcome = readConfiguration(text);
    if (!outcome.ok) {
      this.settings.emit({ kind: "configImportChanged", configImport: { id, stage: "refused", fileName, reason: outcome.reason } });
      return;
    }
    const { read } = outcome;
    const plan = await this.importPlan(read);
    this.configImport = { id, fileName, read };
    this.settings.emit({
      kind: "configImportChanged",
      configImport: {
        id,
        stage: "review",
        fileName,
        patchbayVersion: read.patchbayVersion,
        newer: read.newer,
        exportedAt: read.exportedAt,
        parts: [...read.parts],
        items: plan.items,
        unread: read.unread,
      },
    });
  }

  /** Import, second half: the ticked items land, as a restart in place —
   * the one question first when work is open, everything stopped, the
   * items written, everything republished, and what was running (and what
   * connects on window open) connected again. */
  async applyConfigImport(importId: number, take: readonly string[]): Promise<void> {
    const pending = this.configImport;
    if (pending === null || pending.id !== importId) return;
    const work = this.agentConfigs.list().reduce(
      (sum, agent) => {
        const open = this.sessions.openWork(agent.id);
        return { conversations: sum.conversations + open.conversations, turns: sum.turns + open.turns };
      },
      { conversations: 0, turns: 0 },
    );
    const question = endQuestion("import", "patchbay", work);
    if (question !== null && !(await this.ports.confirm(question.message, question.choice))) return;
    if (this.configImport?.id !== importId) return;
    this.configImport = null;
    const { fileName } = pending;
    this.settings.emit({ kind: "configImportChanged", configImport: { id: importId, stage: "applying", fileName } });
    this.log.info(`import ${fileName}: stopping every process`);
    // What runs now is what the restart brings back, as a reload would.
    await this.agents.stampRunning();
    await this.stopEverything();
    let outcome: ImportOutcome;
    try {
      // Planned again against what the stores hold now: the review showed
      // the machine as it was when the file was read.
      outcome = await applyImport(pending.read, await this.importPlan(pending.read), new Set(take), {
        agents: this.agents,
        mcpServers: this.mcpServers,
        preferences: this.preferences,
        machineRules: this.machinePermissionRules,
        machineWriteScope: this.machineWriteScope,
        machineSavedRoots: this.machineSavedRoots,
      });
    } catch (err) {
      // Whatever landed before it stopped stays, and the restart still runs.
      outcome = { landed: 0, failures: [`the import stopped — ${agentErrorText(err)}`] };
    }
    await this.agents.relinkAll();
    await this.republishAll();
    this.log.info(`import ${fileName}: ${outcome.landed} landed${outcome.failures.map((f) => `; ${f}`).join("")}`);
    this.settings.emit({
      kind: "configImportChanged",
      configImport: { id: importId, stage: "applied", fileName, landed: outcome.landed, failures: outcome.failures },
    });
    await this.ports.connectStartupAgents();
  }

  /** A file's plan against this machine as its stores hold it now. */
  private async importPlan(read: ConfigurationRead): Promise<ImportPlan> {
    const local = await localConfiguration({
      agentConfigs: this.agentConfigs,
      agentEnv: this.agentEnv,
      composerKnobs: this.composerKnobs,
      mcpServerConfigs: this.mcpServerConfigs,
      mcpServerEnv: this.mcpServerEnv,
      headerKey: (id) => this.mcpServers.headerKey(id as PatchbayMcpServerId),
      preferences: this.preferences,
      machineRules: this.machinePermissionRules,
      machineWriteScope: this.machineWriteScope,
      machineSavedRoots: this.machineSavedRoots,
    });
    return planImport(read, local, { commandFound: (command) => commandFound(command), pathExists: (path) => existsSync(path) });
  }

  /** Stops reality before the stores move under it: every terminal tree,
   * every agent's work ended and its process down (graceful ladder), every
   * MCP server's line — so nothing launches for a record the move forgets
   * or replaces. The views see each session close and any pending connect
   * or import review end — a review was read against the stores now moving. */
  private async stopEverything(): Promise<void> {
    this.clientHost.killAll();
    this.clientHost.clear();
    await this.endAllWork();
    this.sessions.reset();
    for (const session of this.agentView.current.sessions) {
      this.agentView.emit({ kind: "sessionClosed", patchbaySessionId: session.id });
    }
    this.agentView.emit({ kind: "chatConnectResolved" });
    this.mcpServers.dropImport();
    if (this.configImport !== null) {
      this.configImport = null;
      this.settings.emit({ kind: "configImportChanged", configImport: null });
    }
  }

  /** The stores moved: both channels catch up from what they now hold,
   * through ordinary events — agents, MCP servers, rules, saved roots,
   * preferences, the audit and the Data page's inventory. The stores read
   * on demand (composer knobs at a session's open, the startup pointers at
   * a window's start) need no publish. */
  private async republishAll(): Promise<void> {
    await this.agents.republish(this.agentView.current.agents.map((a) => a.id));
    await this.mcpServers.refresh();
    this.publishRules();
    this.publishSavedRoots();
    // An open Preferences page settles on what the store now holds (and
    // the agent view's composer stats with it).
    const preferences = this.preferences.get();
    this.settings.emit({ kind: "preferencesChanged", preferences });
    this.agentView.emit({ kind: "preferencesChanged", preferences });
    this.ports.syncDetachContext();
    await this.refreshAuditTail();
    await this.publishDataInventory();
  }

  /** deactivate's bounded best-effort: terminal trees get a
   * straight SIGKILL (batch commands — no protocol to be graceful about),
   * agents get the pool ladder on its tight budget — their work ended first,
   * so nothing waiting on them launches as they go down — and the whole
   * sweep is raced against the ~2s VS Code actually waits before killing the host.
   * Whatever this couldn't reach, the next activate's reap covers. */
  async shutdown(): Promise<void> {
    // Reload-continuation stamp, written before any killing — the running
    // set as it stood when the window went down is what the next activate
    // restores (if it comes soon enough to be a reload; last-connected.ts).
    // A Memento write is milliseconds; it must land inside the budget.
    await this.agents.stampRunning();
    this.clientHost.killAll();
    await Promise.race([this.endAllWork(), new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref())]);
  }

  /** Every agent stopped, every session's and MCP server's line ended. */
  private async endAllWork(): Promise<void> {
    await Promise.all([this.gates.stopAll(), this.sessionGates.endAll(), this.mcpServerGates.endAll()]);
  }

  /** Settles once every list sync a connect started has run, however it
   * ended. */
  async listsSynced(): Promise<void> {
    await Promise.allSettled([...this.pendingSyncs.values()]);
  }

  /** Reload continuity's third rung (flag → list → pointer): return to the
   * session that was open when the window went down. One rule, found or
   * not: the pointer (an agent and its id for the session) is looked up in
   * what the startup connects' own session/list syncs brought back — found
   * activates
   * (load/resume via the same open path as a drawer click), not found
   * lands on the default screen, regardless of why (agent removed, session
   * deleted externally, agent that can't list). The pointer itself is left
   * alone on a miss: not-found ≠ gone — a failed connect this window must
   * not erase where a later window could still return. A bare id an older
   * version stored is folded into its pair against the same lists. Never
   * spawns a process the startup rules didn't start. */
  async restoreLastActiveSession(): Promise<void> {
    if (!this.lastActiveSession.stored()) return;
    await this.listsSynced();
    const pointer = await this.lastActiveSession.resolve((sessionId) => this.sessions.pairsNamed(sessionId));
    if (pointer === undefined) return;
    if (this.agentView.current.activePatchbaySessionId !== null) return;
    const patchbaySessionId = this.sessions.rowFor(pointer.patchbayAgentId, pointer.sessionId);
    if (patchbaySessionId === undefined) return;
    this.sessionGates.activate(patchbaySessionId);
  }

  /** The local MCP server's `request_user_input` tool — the fallback for an
   * agent that asks through MCP instead of ACP's own elicitation request.
   * `contextToken` is what the MCP server subprocess was spawned with —
   * translated back to the session it was minted for, so the form lands in
   * the right transcript. */
  requestUserInput(
    contextToken: string,
    params: RequestUserInputParams,
  ): Promise<ElicitationAnswer> {
    // A token whose session is gone has no transcript to ask in, so the
    // user never saw the question — a cancel, never a guessed session.
    const patchbaySessionId = this.sessions.sessionOfToken(contextToken);
    if (patchbaySessionId === undefined) return Promise.resolve({ action: "cancel" });
    // Same parser as the agent's own elicitation request. A field it cannot
    // present fails the tool call with the reason, rather than rendering a
    // guessed control.
    const fields = params.requestedSchema === undefined ? [] : formFieldsOf(params.requestedSchema);
    if (fields === null) return Promise.reject(new Error("the form has a field patchbay cannot present"));
    return this.broker.askElicitation({ patchbaySessionId }, { message: params.message, ask: { mode: "form", fields } });
  }

  /** The "last open session" pointer (stores/last-active-session.ts).
   * Every activation flows through the sessions-store emit hook, so this
   * one chokepoint keeps the pointer honest; a close (user click or prune)
   * clears it only while it still points there. */
  private recordLastActive(events: readonly AgentViewEvent[]): void {
    for (const event of events) {
      if (event.kind === "sessionActivated") this.recordPointer(event.patchbaySessionId);
      else if (event.kind === "sessionClosed" && event.patchbaySessionId === this.pointerRow) {
        this.pointerRow = null;
        void this.lastActiveSession.wipe();
      }
    }
  }

  /** The pointer names the session the way the next window can find it:
   * its agent, and the agent's own id for it. */
  private recordPointer(patchbaySessionId: PatchbaySessionId): void {
    const patchbayAgentId = this.sessions.agentFor(patchbaySessionId);
    const sessionId = this.sessions.sessionIdOf(patchbaySessionId);
    if (patchbayAgentId === undefined || sessionId === undefined) return;
    this.pointerRow = patchbaySessionId;
    void this.lastActiveSession.set({ patchbayAgentId, sessionId });
  }

  /** The turn-end chime (Preferences), as a turn resolves — decided here,
   * played by the one surface `chimePlayer` picks. A cancelled turn never
   * chimes: the user was present to cancel it. */
  private maybeChime(events: readonly AgentViewEvent[]): void {
    for (const event of events) {
      if (event.kind !== "turnEnded" || event.stopReason === "cancelled") continue;
      if (!this.preferences.get().soundOnDone) return;
      const surface = chimePlayer(this.surfaces);
      if (surface === null) this.log.debug("turn-end chime: no open Agent View the user has touched — silent");
      else this.agentView.emit({ kind: "chimed", surface });
      return; // one chime per batch, however many turns settled together
    }
  }

  /** The Settings "active today" tile — recomputed from canonical Agent
   * View rows on every change, emitted only when the number moved (the
   * change hook fires per chunk; the Settings channel must not). Live
   * sessions' knob surfaces deliberately do NOT feed the Settings
   * offerings — a session's surface is conditioned on its own selections,
   * so republishing it would make the default-knob rows track whichever
   * session last touched a knob; the defaults editor reads its own session
   * instead. */
  private publishSessionStats(): void {
    const count = sessionsActiveToday(this.agentView.current.sessions);
    if (count === this.settings.current.sessionsActiveToday) return;
    this.settings.emit({ kind: "sessionStatsChanged", sessionsActiveToday: count });
  }

  /** A surface opened, became visible or hidden, or closed (`report`
   * null): the view hosts report here, and the screen fact follows —
   * emitted only on a real change. `pinned` is the session the surface
   * shows; null = it follows the active-session pointer. */
  noteSurface(surface: string, report: SurfaceReport | null): void {
    if (report === null) this.surfaces.delete(surface);
    else this.surfaces.set(surface, { activated: this.surfaces.get(surface)?.activated ?? false, ...report });
    const shows = [...this.surfaces.values()].filter((s) => s.visible).map((s) => s.pinned);
    const pointer = shows.includes(null);
    const pinnedIds = [...new Set(shows.filter((id): id is string => id !== null))].sort();
    const current = this.agentView.current.screen;
    if (current.pointer === pointer && current.pinned.join("\n") === pinnedIds.join("\n")) return;
    this.agentView.emit({ kind: "screenChanged", pointer, pinned: pinnedIds });
  }

  /** A surface's page says whether the user has touched it since it
   * loaded — as it loads (a page loaded again starts untouched), and on
   * its first touch. A surface already closed has nothing to note. */
  noteSurfaceActivation(surface: string, activated: boolean): void {
    const facts = this.surfaces.get(surface);
    if (facts !== undefined) facts.activated = activated;
  }

  /** A connection that ended can no longer take an answer: every ask still
   * open on it settles as cancelled — the same answer a stopped turn gives —
   * so no card, and no "waiting" mark, outlives the process it was asked
   * on. Read before the sessions are invalidated. */
  private settleAsksOn(patchbayAgentId: PatchbayAgentId): void {
    for (const patchbaySessionId of this.sessions.sessionsOn(patchbayAgentId)) this.asks.stopSession(patchbaySessionId);
    this.asks.stopAgent(patchbayAgentId);
  }

  /** Where an agent's question is asked: the session it names, as
   * patchbay holds it, or — for one riding a request outside any session,
   * as during login — the agent itself. Null for one no one can be shown,
   * answered cancel: no user saw it, so none declined it. */
  private questionPlace(patchbayAgentId: PatchbayAgentId, scope: ElicitationScope): AskPlace | null {
    if (!("sessionId" in scope)) return { patchbayAgentId };
    const owner = this.ownerOf(patchbayAgentId, scope.sessionId);
    switch (owner.kind) {
      case "user":
        return { patchbaySessionId: owner.patchbaySessionId };
      case "none":
        this.log.info(`${patchbayAgentId}: cancelled an elicitation on session ${scope.sessionId}, which patchbay doesn't hold`);
        return null;
      default:
        this.log.info(`${patchbayAgentId}: cancelled an elicitation on a throwaway session`);
        return null;
    }
  }

  /** Whose session the agent names by this id. */
  private ownerOf(patchbayAgentId: PatchbayAgentId, sessionId: string): SessionOwner {
    return sessionOwner(
      { probe: this.capabilityTracker, defaultsEditor: this.defaultsEditor, sessions: this.sessions },
      patchbayAgentId,
      sessionId,
    );
  }

  /** The native notification is raised from the waiting fact, not by a
   * call each ask remembers to make: every ask that starts while its
   * session is off screen raises one — whatever kind it is. An ask that
   * arrived on screen never does, even if the user looks away before
   * answering (the badge and header still count it). It can't follow the
   * fact back — VS Code gives no way to close a notification — so one
   * answered elsewhere stays until dismissed; its buttons check the ask
   * when pressed. */
  private notifyNewAsks(): void {
    const state = this.agentView.current;
    const shown = onScreen(state);
    const open = new Set<string>();
    for (const session of state.sessions) {
      for (const ask of openAsks(state.transcripts[session.id] ?? [])) {
        open.add(ask.id);
        if (!this.knownAsks.has(ask.id) && !shown.has(session.id)) this.ports.notifyAsk(session.id, session.title, ask);
      }
    }
    this.knownAsks = open;
  }

  /** Brings a session up in the Agent View — the one path for every
   * "take me there" (the switch-session command, a notification's Open). */
  async revealSession(patchbaySessionId: PatchbaySessionId): Promise<void> {
    this.sessionGates.open(patchbaySessionId);
    await this.ports.focusComposer();
  }

  private async refreshAuditTail(): Promise<void> {
    const entries = await this.decisionAudit.tail(20);
    this.settings.emit({ kind: "auditTailChanged", entries });
  }

  /** The Data page's storage inventory — recomputed from the live stores on
   * every request, never cached (reality is the source of truth). Counts
   * only — never values. */
  async publishDataInventory(): Promise<void> {
    const agentConfigs = this.agentConfigs.list();
    const agentEnvCount = (await Promise.all(agentConfigs.map((c) => this.agentEnv.get(c.id)))).reduce(
      (sum, env) => sum + Object.keys(env).length,
      0,
    );
    const mcpServerConfigs = this.mcpServerConfigs.list();
    const mcpServerEnvCount = (
      await Promise.all(mcpServerConfigs.map((i) => this.mcpServerEnv.get(i.id)))
    ).reduce((sum, env) => sum + Object.keys(env).length, 0);
    let tokenCount = 0;
    for (const i of mcpServerConfigs) {
      if ((await this.mcpServerTokens.get(i.id)) !== null) tokenCount++;
    }
    const rows: DataInventoryRow[] = [
      ...storedRows({ machine: (key) => this.kvs.machine.get(key), workspace: (key) => this.kvs.workspace.get(key) }),
      {
        id: "secrets",
        label: "Credentials & env values",
        placement: "SecretStorage",
        detail: `${count(agentEnvCount + mcpServerEnvCount, "env value")} · ${count(tokenCount, "OAuth token")}`,
      },
      { id: "decision-audit", label: "Decision audit", placement: "workspace storage", detail: count(await this.decisionAudit.count(), "entry") },
    ];
    this.settings.emit({ kind: "dataInventoryChanged", rows });
  }

  /** Tells both views what the registry holds now — the store is the one
   * holder; nothing here keeps a copy. */
  private publishRegistry(): void {
    const data = this.acpRegistry.current();
    const event = {
      kind: "registryChanged",
      agents: data.agents.map((a) => registryAgentView(a, data.icons)),
      fetchedAt: data.fetchedAt,
    } as const;
    this.agentView.emit(event);
    this.settings.emit(event);
    this.agents.registryChanged();
  }

  /** The one explicit, visible gate on any download the launch phase needs
   * — a managed runtime or a registry agent's own binary; nothing is ever
   * fetched and run silently, and the ask says whether the bytes will be
   * checked against a published SHA-256. Modal on purpose: the connect is
   * already waiting on this decision, and declining fails it honestly on
   * the card. */
  private async confirmDownload(ask: DownloadAsk): Promise<boolean> {
    const message =
      ask.kind === "runtime"
        ? `This agent is launched with ${ask.runtime === "node" ? "npx, which needs Node.js" : "uvx, which needs uv"} — and no usable install was found on this system. Download ${runtimeName(ask.runtime)} ${ask.version} into the extension's own storage? ${DOWNLOAD_CHECK_TEXT[ask.check]} Nothing is installed system-wide, and removing the extension removes it.`
        : `${ask.name} ${ask.version} is distributed as a binary. Download it from ${new URL(ask.archiveUrl).host} into the extension's own storage and run it? ${DOWNLOAD_CHECK_TEXT[ask.check]} Once per version; nothing is installed system-wide, and removing the extension removes it.`;
    return this.ports.confirm(message, "Download");
  }

  /** The saved roots as both channels show them: this workspace's list
   * exists only while a folder is open — an empty window has no workspace
   * to save to. */
  savedRootsView(): SavedRootsView {
    const workspaceOpen = this.ports.workspaceRoots().length > 0;
    const workspace = workspaceOpen ? this.workspaceSavedRoots.list() : null;
    const machine = this.machineSavedRoots.list();
    return {
      workspace,
      machine,
      missing: [...new Set([...(workspace ?? []), ...machine])].filter((p) => !isFolder(p)),
    };
  }

  /** Settings moves to a section. Opening MCP Servers reads what
   * patchbay's own servers serve — once a window; the card's refresh reads
   * again. */
  showSettingsSection(section: SettingsSectionId): void {
    this.settings.emit({ kind: "sectionChanged", section });
    if (section === "mcpServers")
      void this.mcpServerGates.checkBuiltin().catch(this.logCatch("check the built-in MCP servers"));
  }

  savedRootsIn(scope: SavedRootScope): SavedRootsStore {
    return scope === "workspace" ? this.workspaceSavedRoots : this.machineSavedRoots;
  }

  publishSavedRoots(): void {
    const event = { kind: "savedRootsChanged", savedRoots: this.savedRootsView() } as const;
    this.settings.emit(event);
    this.agentView.emit(event);
  }

  publishRules(): void {
    const rules = this.permissionRules.get();
    this.settings.emit({
      kind: "permissionRulesChanged",
      commandRules: rules.commandRules,
      machineCommandRules: this.machinePermissionRules.get().commandRules,
      writeScope: this.writeScopeView(),
    });
  }

  private writeScopeView(): WriteScopeView {
    return { rows: writeScopeRows(this.machineWriteScope.get(), this.permissionRules.get().writeScope), tempDir: tmpdir() };
  }

  /** The Commands page's tester: how the gate would judge `line` run as
   * `shell`, with `draft` counted as added — told to Settings. */
  async testCommand(line: string, shell: TesterShell, draft: RuleMatchView | null): Promise<void> {
    const run = typedRun(line, shell);
    const judgement: CommandJudgementView =
      run === null
        ? { verdict: "ask", commands: [], unreadable: [{ text: line, reason: "not a command line — a quote is left open" }] }
        : await this.broker.judgeRun(run, draft ?? undefined);
    this.settings.emit({ kind: "commandJudged", line, shell, judgement });
  }

  /** One layer's command rules, changed through that layer's store, then
   * shown. */
  async setCommandRules(layer: "workspace" | "machine", change: (rules: readonly CommandRule[]) => CommandRule[]): Promise<void> {
    if (layer === "machine") await this.machinePermissionRules.set(change(this.machinePermissionRules.get().commandRules));
    else {
      const rules = this.permissionRules.get();
      await this.permissionRules.set({ ...rules, commandRules: change(rules.commandRules) });
    }
    this.publishRules();
  }

  /** One place's answer at one layer, written through that layer's store. */
  async setWriteLocation(location: WriteLocation, layer: "workspace" | "machine", on: boolean | null): Promise<void> {
    if (layer === "machine") {
      await this.machineWriteScope.set(withWriteEntry(this.machineWriteScope.get(), location, on));
      return;
    }
    const rules = this.permissionRules.get();
    await this.permissionRules.set({ ...rules, writeScope: withWriteEntry(rules.writeScope, location, on) });
  }

  /** Add — and every connect a door names by its source (Settings Connect,
   * the palette, startup): the store saves what is new, then the connect
   * passes the gates (and runs the free check, as every connect does).
   * Answers which agent, once its connect has settled either way. */
  async connectFrom(source: ConnectAgentSource): Promise<PatchbayAgentId | undefined> {
    const patchbayAgentId = await this.agents.saveFrom(source);
    if (patchbayAgentId === undefined) return undefined;
    try {
      await this.gates.connect(patchbayAgentId);
    } catch {
      // the pool already put how the launch ended — its crash and reason,
      // or a stop — on the row
    }
    return patchbayAgentId;
  }

  /** One intent, one click: connect if needed, then create and
   * activate the session — all inside the chat pane. Uses the saved config
   * path (env injected from SecretStorage at spawn), never a bare
   * pool.connect. Failure lands inline with the
   * specific reason and a Retry — never a silent bounce to the empty
   * state. */
  async startChat(patchbayAgentId: PatchbayAgentId): Promise<void> {
    void this.acpRegistry.read("new-session");
    const agentName = this.agents.name(patchbayAgentId);
    if (agentName === undefined) return; // unknown agent — nothing to start
    // A still-new (never-prompted) session for this agent already IS the
    // new session — focus it instead of minting a sibling blank shell.
    // One whose connection died is still that session: it is minted again
    // from its row (the ladder's zero-turn rung) on the same path a fresh
    // create takes, connect-on-demand included.
    const draft = this.sessions.findNeverPrompted(patchbayAgentId);
    if (draft !== undefined && this.sessions.isLive(draft)) {
      this.sessionGates.activate(draft);
      return;
    }
    this.agentView.emit({ kind: "chatConnectStarted", patchbayAgentId });
    try {
      // A running agent serves the chat now — it never waits behind the
      // agent's other work (a terminal login can take minutes). One that
      // isn't takes the connect's turn, joining one already under way.
      if (this.agents.row(patchbayAgentId)?.status !== "running") await this.gates.connect(patchbayAgentId);
      if (!this.paneShows(patchbayAgentId)) return;
      // A created session's arrival clears the connect pane itself
      // (sessionCreated); a revived one is a row the view already holds, so
      // the pane is closed here — still showing only if nothing else did.
      if (draft !== undefined) await this.sessionGates.revive(draft);
      else await this.sessionGates.create(patchbayAgentId, agentName, this.workspaceCwd);
      if (this.paneShows(patchbayAgentId)) this.agentView.emit({ kind: "chatConnectResolved" });
    } catch (err) {
      this.logCatch(`startChat ${patchbayAgentId}`)(err);
      this.chatPaneFailed(patchbayAgentId, err);
    }
  }

  /** The connect half of the session gates' open ceremony (their
   * `connect` ask): opening a session whose configured agent is off spawns
   * it, through the same in-pane chatConnect states startChat uses — but
   * no session is minted: on success the status-running hook re-syncs and
   * attaches whatever is on view, and `forPatchbaySessionId` makes
   * the failure pane's Retry re-open this session instead of starting a
   * new chat. Unconfigured agents stay untouched — the row is a readable
   * record, nothing more to offer. */
  private async connectForSession(patchbaySessionId: PatchbaySessionId): Promise<void> {
    const patchbayAgentId = this.sessions.agentFor(patchbaySessionId);
    if (patchbayAgentId === undefined) return;
    const row = this.agents.row(patchbayAgentId);
    if (row === undefined || row.status === "running") return;
    this.agentView.emit({ kind: "chatConnectStarted", patchbayAgentId, forPatchbaySessionId: patchbaySessionId });
    try {
      await this.gates.connect(patchbayAgentId);
      if (this.paneShows(patchbayAgentId, patchbaySessionId)) this.agentView.emit({ kind: "chatConnectResolved" });
    } catch (err) {
      this.logCatch(`connect for session ${patchbaySessionId} (${patchbayAgentId})`)(err);
      this.chatPaneFailed(patchbayAgentId, err, patchbaySessionId);
    }
  }

  /** The menu's Fork: its agent connected if it is off, then the fork —
   * which opens in the view; one the agent refuses says why. */
  async forkSession(patchbaySessionId: PatchbaySessionId): Promise<void> {
    const session = this.agentView.current.sessions.find((s) => s.id === patchbaySessionId);
    if (session === undefined) return;
    try {
      if (this.agents.row(session.patchbayAgentId)?.status !== "running") await this.gates.connect(session.patchbayAgentId);
      await this.sessionGates.fork(patchbaySessionId, session.title);
    } catch (err) {
      this.ports.warnCatch(`fork ${patchbaySessionId}`, `"${session.title}" was not forked`)(err);
    }
  }

  /** The session menu's Delete: the agent removes the session from its
   * history, which nothing brings back — so the user confirms first. The
   * delete needs the agent: one that is off is connected for it. A delete
   * that fails says why, and the session stays. */
  async deleteSession(patchbaySessionId: PatchbaySessionId): Promise<void> {
    const session = this.agentView.current.sessions.find((s) => s.id === patchbaySessionId);
    const agent = session === undefined ? undefined : this.agents.row(session.patchbayAgentId);
    if (session === undefined || agent === undefined) return;
    const confirmed = await this.ports.confirm(
      `Delete "${session.title}"? ${agent.name} removes it from its history, and this can't be undone.`,
      "Delete",
    );
    if (!confirmed) return;
    try {
      if (this.agents.row(agent.id)?.status !== "running") await this.gates.connect(agent.id);
      await this.sessionGates.delete(patchbaySessionId);
    } catch (err) {
      this.ports.warnCatch(`delete ${patchbaySessionId}`, `"${session.title}" was not deleted`)(err);
    }
  }

  /** A chat that didn't land on its agent: the pane says why, with a Retry
   * — unless the user's own Stop or Remove ended it, and the pane just
   * goes. A pane taken by a later request is not this one's to touch. */
  private chatPaneFailed(patchbayAgentId: PatchbayAgentId, err: unknown, forPatchbaySessionId?: PatchbaySessionId): void {
    if (!this.paneShows(patchbayAgentId, forPatchbaySessionId)) return;
    if (err instanceof Cancelled) {
      this.agentView.emit({ kind: "chatConnectResolved" });
      return;
    }
    this.agentView.emit({
      kind: "chatConnectFailed",
      patchbayAgentId,
      reason: this.connectFailureReason(patchbayAgentId, err, agentErrorText(err)),
      forPatchbaySessionId,
    });
  }

  /** The latest connect on demand owns the chat pane: an earlier one whose
   * pane was taken stands down when its connect settles — its agent still
   * comes up, but its chat neither lands nor fails over the later one. A
   * repeat of the same request shows the same pane and shares its work —
   * the connect it joined, the new session it asked for. */
  private paneShows(patchbayAgentId: PatchbayAgentId, forPatchbaySessionId?: PatchbaySessionId): boolean {
    return chatPaneShows(this.agentView.current.chatConnect, patchbayAgentId, forPatchbaySessionId);
  }

  /** Prefer the pool's own crash detail (spawn failed / initialize failed)
   * over a raw wire error; map auth_required to what actually unblocks it —
   * the agent's own instruction when it gave one beyond the bare
   * "authentication required" (an agent with no login methods, like Auggie,
   * names the exact CLI command there), the Settings Agents pointer
   * otherwise. */
  private connectFailureReason(patchbayAgentId: PatchbayAgentId, err: unknown, raw: string): string {
    const auth = authRequiredReasonOf(err);
    if (auth !== null) {
      return auth.reason !== null && !/^authentication required\.?$/i.test(auth.reason.trim())
        ? auth.reason
        : "needs login first — use Log in on this agent in Settings › Agents";
    }
    return this.agents.row(patchbayAgentId)?.detail ?? raw;
  }

  agentName(patchbayAgentId: PatchbayAgentId): string {
    return this.agents.name(patchbayAgentId) ?? patchbayAgentId;
  }

  /** Formats a swallowed action failure for the Output channel — these
   * actions have no reply channel by design (state itself is the only
   * signal back to the UI), but silently dropping the error entirely left
   * nothing to debug from. */
  logCatch(context: string): (err: unknown) => void {
    return (err) => {
      // Ended by the user's own hand — an agent's Stop or Remove, a
      // session's Stop, Reload or Close — no failure.
      if (err instanceof Cancelled) this.log.info(`${context}: ${err.message}`);
      else this.log.error(`${context}: ${agentErrorText(err)}`);
    };
  }
  /** Ends this window's work and flushes the views; the host releases
   * its own surfaces around it. */
  dispose(): void {
    this.sessionGates.dispose();
    void this.sessionGates.endAll();
    void this.mcpServerGates.endAll();
    void this.gates.stopAll();
    this.agentView.flushNow();
    this.settings.flushNow();
    this.wireLog.dispose();
    this.ipcHost.stop();
  }
}

/** A root is a folder on disk right now — the one reality read behind
 * every lifecycle request's roots, the MCP servers' list, the saved lists'
 * marks, and a save. */
export function isFolder(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}
