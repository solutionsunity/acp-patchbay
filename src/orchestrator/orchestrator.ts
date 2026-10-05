// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Orchestrator: the Node process in the extension host — single source of
// truth for sessions, capability tables, permission rules, secrets,
// configuration. Webviews only ever see its snapshots and patches.
import { statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
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
  type ConnectAgentSource,
  type DataInventoryRow,
  type ElicitationAnswer,
  type PermissionOptionView,
  type SavedRootScope,
  type SavedRootsView,
  type SettingsEvent,
  type SettingsState,
} from "../shared/protocol";
import { openAsks, type OpenAsk } from "../shared/attention";
import { AgentGates, type AgentOperation } from "./agent-gates";
import { AgentsStore, type ConnectionOperations } from "./agents-store";
import { ATTACHMENTS_DIR, pickedFileForm } from "./attachments";
import { applyFileWrite, PermissionBroker } from "./broker";
import { ClientHost, clientRequestHooks } from "./client-host";
import { eraseAllData } from "./erase-all";
import { CapabilityTracker } from "./capability-tracker";
import { DefaultsEditor } from "./defaults-editor";
import { ChannelHost } from "./channel";
import { count } from "../shared/count";
import type { RequestUserInputParams } from "../mcp/ipc-protocol";
import { EditorStateHost } from "./editor-state-host";
import { McpServerGates } from "./mcp-server-gates";
import { McpServersStore, type McpServerLineOperations } from "./mcp-servers-store";
import { OAuthCallbackRegistry } from "./oauth-callback";
import { normalizeKnobs } from "./knobs";
import { elicitationResponseOf, formFieldsOf, readElicitationRequest } from "./elicitation";
import { sessionKnobExtras } from "./extensions";
import { runLoginTask } from "./login-task";
import { AgentPool, authRequiredReasonOf } from "./pool";
import { commandOf, killTree, reapOrphans } from "./process-tree";
import { Cancelled, Queue } from "./queue";
import type { McpServerWork } from "../shared/protocol";
import { type AttachWork, SessionGates } from "./session-gates";
import { normalizeRootPath, SessionsStore, type SessionConnectionOperations } from "./sessions-store";
import { nonce } from "./webview-host";
import { WireLog } from "./wire-log";
import { listDoneSounds, playDoneSound } from "./sound";
import {
  AcpRegistryStore,
  binaryDigestFor,
  registryAgentView,
  resolveDistribution,
} from "./stores/acp-registry";
import { AgentConfigStore } from "./stores/agent-configs";
import { ComposerKnobsStore } from "./stores/composer-knobs";
import { PreferencesStore } from "./stores/preferences";
import { SecretEnvStore } from "./stores/secret-env";
import { resolveLaunch, runtimeName, type DownloadAsk, type DownloadCheck } from "./runtime-resolver";
import { DecisionAuditStore } from "./stores/decision-audit";
import { FileKV } from "./stores/file-kv";
import { recoverLegacyGlobalState } from "./stores/vscdb-recovery";
import { McpServerConfigStore } from "./stores/mcp-server-configs";
import { McpServerTokenStore } from "./stores/mcp-server-tokens";
import { LastActiveSessionStore } from "./stores/last-active-session";
import { LastConnectedStore } from "./stores/last-connected";
import { MachineRulesStore, PermissionRulesStore } from "./stores/permission-rules";
import { SavedRootsStore } from "./stores/saved-roots";
import { loadCatalog } from "./stores/mcp-catalog";
import { SpawnRegistryStore } from "./stores/spawn-registry";
import { AuthLockStore } from "./stores/auth-locks";
import { SessionContinuityStore } from "./stores/session-continuity";
import { UsedCapabilityStore } from "./stores/used-capabilities";
import { sessionsActiveToday } from "./session-stats";
import { statusBarContent } from "./status-bar";
import { editorLineOf } from "./tool-locations";

/** Context-chip id mint. The timestamp alone collided once a multi-file
 * drop started dispatching several adds in the same millisecond (duplicate
 * React keys; removeContextChip pulling the wrong chip) — the counter makes
 * every id unique for the process's lifetime, which is exactly a chip's. */
let chipSeq = 0;
const chipId = () => `chip-${Date.now()}-${chipSeq++}`;

/** What the download prompt says of the check — only what is known: held
 * to a published digest, nothing published, or the registry unreadable. */
const DOWNLOAD_CHECK_TEXT: Record<DownloadCheck, string> = {
  sha256: "The download is checked against its published SHA-256.",
  "none-published": "No SHA-256 is published for it, so the download can't be checked.",
  "registry-unreachable": "The ACP registry couldn't be reached for its SHA-256, so the download can't be checked.",
};

/** A web page in the system browser — outside the editor, so neither
 * patchbay nor an agent's model sees the page or what the user types. The
 * one way patchbay opens a page: an MCP server's sign-in and an agent's link
 * alike. */
function openInBrowser(href: string): Thenable<boolean> {
  return vscode.env.openExternal(vscode.Uri.parse(href));
}

/** A modal question with one affirmative choice — true when it was chosen. */
async function askModal(message: string, choice: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true }, choice)) === choice;
}

function optionViewsFromAcp(
  options: readonly { optionId: string; name: string; kind: string }[],
): PermissionOptionView[] {
  return options.map((o) => ({
    optionId: o.optionId,
    label: o.name,
    kind: o.kind as PermissionOptionView["kind"],
  }));
}

export class Orchestrator {
  readonly agentView: ChannelHost<AgentViewState, AgentViewEvent>;
  readonly settings: ChannelHost<SettingsState, SettingsEvent>;

  readonly decisionAudit: DecisionAuditStore;
  readonly lastConnected: LastConnectedStore;
  readonly lastActiveSession: LastActiveSessionStore;
  readonly agentConfigs: AgentConfigStore;
  readonly mcpServerConfigs: McpServerConfigStore;
  readonly usedCapabilities: UsedCapabilityStore;
  /** Standing auth locks (auth-evidence.ts) — persisted so reload and
   * reconnect cannot launder a witnessed logout. Written only by the agents
   * store's noteAuthEvidence, the one auth-state writer. */
  readonly authLocks: AuthLockStore;
  readonly spawnRegistry: SpawnRegistryStore;
  readonly agentEnv: SecretEnvStore;
  readonly mcpServerEnv: SecretEnvStore;
  readonly acpRegistry: AcpRegistryStore;
  readonly permissionRules: PermissionRulesStore;
  readonly machinePermissionRules: MachineRulesStore;
  readonly workspaceSavedRoots: SavedRootsStore;
  readonly machineSavedRoots: SavedRootsStore;
  readonly preferences: PreferencesStore;
  readonly composerKnobs: ComposerKnobsStore;
  readonly sessionContinuity: SessionContinuityStore;
  /** The updates already announced this window ("agentId@version") — each
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
  private readonly defaultsEditor: DefaultsEditor;
  readonly broker: PermissionBroker;
  readonly editorStateHost: EditorStateHost;
  readonly mcpServerTokens: McpServerTokenStore;
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
  private readonly workspaceCwd: string;
  private readonly binaryCacheDir: string;
  private readonly clientHost: ClientHost;
  private readonly mcpServerScriptPath: string;
  private readonly mcpBridgeScriptPath: string;
  /** The session the last-open pointer names, by this window's id for it —
   * null until one is activated here. */
  private pointerRow: string | null = null;
  /** In-flight session/list syncs per agent — awaited by the startup
   * restore so "found or not" is judged against a settled list. */
  private readonly pendingSyncs = new Map<string, Promise<void>>();
  private readonly editorSubscriptions: vscode.Disposable[] = [];
  /** Visible agent-view surfaces → the session each pins (null = follows
   * the active-session pointer). Hidden or disposed surfaces are absent;
   * the view hosts report through noteSurface. */
  private readonly visibleSurfaces = new Map<object, string | null>();
  /** Open asks already accounted for by the native notification — each
   * new one is judged once, as it arrives. */
  private knownAsks = new Set<string>();
  /** Sessions shown in their own detached panels (AgentPanelHost, assigned
   * in extension.ts) — reaper-exempt like the active-in-view session: a
   * session in its own window is being looked at. */
  pinnedSessions: () => readonly string[] = () => [];
  private statusBarItem!: vscode.StatusBarItem;
  /** Wire log (Audit page): channel and status pill exist only while it's
   * ever been / is on — a transient state gets transient surfaces. */
  private wireLog!: WireLog;
  private wireChannel: vscode.OutputChannel | null = null;
  private wireStatusItem: vscode.StatusBarItem | null = null;
  private wireStatusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    this.mcpServerScriptPath = vscode.Uri.joinPath(context.extensionUri, "out", "mcp-server.js").fsPath;
    this.mcpBridgeScriptPath = vscode.Uri.joinPath(
      context.extensionUri,
      "out",
      "mcp-bridge.js",
    ).fsPath;
    this.binaryCacheDir = join(context.globalStorageUri.fsPath, "bin-cache");

    // Machine scope lives in a file this extension owns (file-kv.ts), not
    // in globalState: state.vscdb is editor-owned, shared by every
    // extension, and has been observed truncated to zero bytes by an
    // unclean shutdown — taking every agent config with it. First load
    // drains any old globalState keys into the file.
    const machineKV = new FileKV(
      join(context.globalStorageUri.fsPath, "state.json"),
      context.globalState,
      (message) => log.info(`state file: ${message}`),
    );
    // One-shot fill of anything the 0.82.6 publisher-casing flip orphaned
    // in the old-cased globalState row. FileKV updates take effect as they
    // are issued (microtask-paced at worst), and this constructor only
    // wires stores — their first real read comes later on the event loop,
    // after the fill has fully landed.
    void recoverLegacyGlobalState({
      kv: machineKV,
      vscdbPath: join(dirname(context.globalStorageUri.fsPath), "state.vscdb"),
      log: (message) => log.info(`legacy recovery: ${message}`),
    }).catch((error: unknown) => log.info(`legacy recovery failed: ${String(error)}`));
    this.permissionRules = new PermissionRulesStore(context.workspaceState);
    this.machinePermissionRules = new MachineRulesStore(machineKV);
    this.workspaceSavedRoots = new SavedRootsStore(context.workspaceState, "workspace");
    this.machineSavedRoots = new SavedRootsStore(machineKV, "machine");
    this.decisionAudit = new DecisionAuditStore(context.storageUri?.fsPath ?? null);
    this.lastConnected = new LastConnectedStore(context.workspaceState);
    this.lastActiveSession = new LastActiveSessionStore(context.workspaceState);
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
    this.usedCapabilities = new UsedCapabilityStore(machineKV);
    this.authLocks = new AuthLockStore(machineKV);
    this.spawnRegistry = new SpawnRegistryStore(machineKV);
    this.agentEnv = new SecretEnvStore(context.secrets, "acpPatchbay.agent");
    this.mcpServerEnv = new SecretEnvStore(context.secrets, "acpPatchbay.integration");
    this.mcpServerTokens = new McpServerTokenStore(context.secrets);
    // OAuth browser/redirect step:
    // the redirect target is this extension's own vscode:// URI, passed
    // through asExternalUri so VS Code resolves it correctly under SSH
    // remote / WSL / Codespaces — never a hand-rolled 127.0.0.1 server.
    // extension.ts's registerUriHandler feeds callbacks into oauthCallbacks.
    const extensionId = context.extension.id; // "solutionsunity.acp-patchbay"
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
      { busy: (serverId) => serverLine.held(serverId), connecting: () => connectLine.holding() },
      this.workspaceCwd,
      {
        redirectUri: async () => {
          const callback = await vscode.env.asExternalUri(
            vscode.Uri.parse(`${vscode.env.uriScheme}://${extensionId}/oauth-callback`),
          );
          return callback.toString(true);
        },
        authorize: async (authorizationUrl, state) => {
          const pending = this.oauthCallbacks.wait(state);
          await openInBrowser(authorizationUrl);
          return pending;
        },
      },
      log,
    );
    this.mcpServers = mcpServers;
    this.mcpServerGates = new McpServerGates(mcpServers, serverLine, connectLine);

    // The registry starts empty — the picker fills when the first fetch
    // (cache or network) resolves and publishes via registryChanged.
    const onAction = (action: Action) => this.handleAction(action);
    const workspaceRootsView = () =>
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    this.agentView = new ChannelHost(
      {
        ...initialAgentViewState,
        // No session rows here: the agent's own session/list is the only
        // list — the startup connects repopulate the drawer from the wire.
        // Hold the loading page only when there is actually a last open
        // session to come back to — startupSettled clears it either way.
        restoring: this.lastActiveSession.get() !== undefined,
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
        fileWriteScope: rules.fileWriteScope,
        mcpCatalog: this.mcpServers.registryViews(),
        preferences: this.preferences.get(),
        doneSounds: listDoneSounds(),
        savedRoots: this.savedRootsView(),
      },
      reduceSettings,
      coalesceSettingsEvent,
      onAction,
    );

    this.acpRegistry = new AcpRegistryStore(
      join(context.globalStorageUri.fsPath, "registry"),
      // A fetch that landed is the registry's fresh word — the moment a
      // newer version becomes news (the cached copy at start is not).
      () => {
        this.publishRegistry();
        void this.announceUpdates();
      },
      log,
    );

    // Wire log: sink is lazy (no empty Output channel for a feature never
    // used); state changes feed the settings channel and the status pill.
    this.wireLog = new WireLog(
      () => {
        this.wireChannel ??= vscode.window.createOutputChannel("ACP Patchbay — Wire");
        return this.wireChannel;
      },
      (active, until) => this.onWireLogStateChanged(active, until),
    );

    // Pool hooks close over `this` and only fire once the pool is actually
    // used (after the constructor returns), so referencing sessions /
    // capabilityTracker / broker here — before they're assigned below — is
    // safe; this is the same lazy-closure pattern all three use themselves.
    this.pool = new AgentPool({
      onStatusChanged: (agentId, status, detail) => {
        this.agents.noteStatus(agentId, status, detail);
        if (status !== "running") this.settleAsksOn(agentId);
        // Every way a connection ends detaches the sessions that rode it —
        // they reopen (session/load or resume) before reuse, keeping what
        // they hold.
        this.sessions.agentStatusChanged(agentId, status);
        // The editor's session rode the connection that just ended, and so
        // did any completion notice still waiting for its question.
        if (status !== "running") {
          this.defaultsEditor.forget(agentId);
          this.broker.forgetAgent(agentId);
        }
        // Every connect of a list-capable agent syncs its own session
        // history into the list — the wire is the ONLY list (patchbay
        // persists no session records). The promise is tracked so the
        // startup restore can wait for the lists before deciding whether
        // the last-active pointer still resolves.
        if (status === "running") {
          const sync = this.sessions
            .syncAgentSessions(agentId)
            // A session opened before its agent connected sat blank (no
            // replay to run yet) — attach whatever is on view now that a
            // process exists.
            .then(() => this.sessionGates.reattachViewed(agentId))
            .catch(this.logCatch(`session/list sync for ${agentId}`))
            .finally(() => {
              if (this.pendingSyncs.get(agentId) === sync) this.pendingSyncs.delete(agentId);
            });
          this.pendingSyncs.set(agentId, sync);
        }
        // Offerings are connection state — the settings reducer drops its
        // copy off the row's status; the defaults editor forgot its session
        // above, and an expanded card reopens one once running.
      },
      onDeclaredCaptured: (agentId) => this.agents.noteDeclared(agentId),
      onSessionUpdate: (agentId, notification) => {
        // Throwaway sessions never reach a transcript: the probe's traffic
        // is dropped, the defaults editor's feeds its own surface.
        if (this.capabilityTracker.isProbeSession(agentId, notification.sessionId)) return;
        if (this.defaultsEditor.owns(agentId, notification.sessionId)) {
          this.defaultsEditor.handleUpdate(agentId, notification);
          return;
        }
        this.sessions.handleUpdate(agentId, notification);
      },
      onCapabilityEvidence: (agentId, row, evidence) => this.agents.noteEvidence(agentId, row, evidence),
      onAuthWireFact: (agentId, method, settled, startedAt, reason) =>
        this.agents.noteAuthWireFact(agentId, method, settled, startedAt, reason),
      wireLogActive: () => this.wireLog.active,
      onWireFrame: (agentId, direction, line) => this.wireLog.frame(agentId, direction, line),
      // Spawn registry: records persist machine-scoped so an abnormal
      // end (crash, OS kill) leaves exactly what the next activate reaps.
      onProcessSpawned: (pid, command) => void this.spawnRegistry.add(pid, command, "agent"),
      onProcessEnded: (pid) => void this.spawnRegistry.removePid(pid),
      onElicitation: async (agentId, params, signal) => {
        const reading = readElicitationRequest(params);
        if (reading.kind === "invalid") throw RequestError.invalidParams({ reason: reading.why });
        if (reading.kind === "refuse") {
          this.log.info(`${agentId}: declined an elicitation — ${reading.why}`);
          return { action: "decline" };
        }
        const { message, ask, elicitationId } = reading;
        // A throwaway session — the probe's or the defaults editor's — is
        // invisible by construction; the user never saw the question, which
        // is exactly what `cancel` means (same rule as permission asks).
        if (
          this.capabilityTracker.isProbeSession(agentId, reading.sessionId) ||
          this.defaultsEditor.owns(agentId, reading.sessionId)
        ) {
          this.log.info(`${agentId}: cancelled an elicitation on a throwaway session`);
          return { action: "cancel" };
        }
        // So is a session patchbay doesn't hold: no transcript to ask in.
        const sessionId = this.sessions.rowFor(agentId, reading.sessionId);
        if (sessionId === undefined) {
          this.log.info(`${agentId}: cancelled an elicitation on session ${reading.sessionId}, which patchbay doesn't hold`);
          return { action: "cancel" };
        }
        const answer = await this.broker.askElicitation(
          sessionId,
          { message, ask, ...(elicitationId !== undefined ? { completion: { agentId, elicitationId } } : {}) },
          signal,
        );
        return elicitationResponseOf(ask, answer, signal);
      },
      onElicitationComplete: (agentId, elicitationId) => this.broker.completeLink(agentId, elicitationId),
      onPermissionRequest: async (agentId, params) => {
        const options = optionViewsFromAcp(params.options);
        const title = params.toolCall.title ?? "Permission request";
        // A throwaway session — the probe's or the defaults editor's — can
        // trip real agent-side gates (Auggie's workspace-indexing question
        // rides session/new). No surface renders one, so the card/toast
        // path would leave the agent's RPC dangling forever — a JSON-RPC
        // request is always owed an answer. Least privilege instead: the
        // question re-asks on the user's first real session, and the probe
        // dir is never the workspace.
        if (
          this.capabilityTracker.isProbeSession(agentId, params.sessionId) ||
          this.defaultsEditor.owns(agentId, params.sessionId)
        ) {
          this.log.info(`${agentId}: auto-declined "${title}" on a throwaway session`);
          const auto = await this.broker.resolveProbePermissionRequest(
            params.sessionId,
            title,
            options,
          );
          return "cancelled" in auto
            ? { outcome: { outcome: "cancelled" as const } }
            : { outcome: { outcome: "selected" as const, optionId: auto.optionId } };
        }
        // A session patchbay doesn't hold has no card to show — the request
        // is still owed an answer, and nobody saw it: cancelled.
        const sessionId = this.sessions.rowFor(agentId, params.sessionId);
        if (sessionId === undefined) {
          this.log.info(`${agentId}: cancelled "${title}" on session ${params.sessionId}, which patchbay doesn't hold`);
          return { outcome: { outcome: "cancelled" } };
        }
        const result = await this.broker.resolveAgentPermissionRequest(
          sessionId,
          title,
          params.toolCall.kind ?? "other",
          params.toolCall.locations?.map((l) => l.path) ?? [],
          options,
        );
        // A rejected request marks its tool-call block denied — "blocked by
        // permission" renders distinct from "failed".
        // Only this path can correlate: the request carries the toolCallId;
        // patchbay's own fs/terminal gates have no id and already show their
        // own permission/diff cards inline.
        const chosen = "cancelled" in result ? undefined : options.find((o) => o.optionId === result.optionId);
        if (chosen !== undefined && chosen.kind.startsWith("reject")) {
          this.agentView.emit({ kind: "toolCallDenied", sessionId, blockId: params.toolCall.toolCallId });
        }
        return "cancelled" in result
          ? { outcome: { outcome: "cancelled" } }
          : { outcome: { outcome: "selected", optionId: result.optionId } };
      },
      ...clientRequestHooks(
        () => this.clientHost,
        (agentId, agentSessionId) => this.sessions.rowFor(agentId, agentSessionId),
      ),
    }, log, {
      // Launch prerequisites (runtime-resolver.ts), as phases of the
      // connect on the agent's card: a registry binary agent's own archive,
      // and — detect-first, sandbox-fallback — the interpreter an npx/uvx
      // launcher needs, downloaded into bin-cache only on a failed gate.
      // Every download passes the same explicit confirmation.
      resolveLaunch: (spec, onPhase) =>
        resolveLaunch(spec, {
          cacheRoot: this.binaryCacheDir,
          log: this.log,
          onPhase,
          confirmDownload: (ask) => this.confirmDownload(ask),
          digestFor: (agentId, version, pinned) =>
            binaryDigestFor(this.acpRegistry.current().agents, agentId, version, pinned),
          refreshRegistry: async () => (await this.acpRegistry.refresh("download")).ok,
        }),
    });
    // The socket answers only through what each attach was given: its
    // token, the session it served, and the servers it got.
    this.editorStateHost = new EditorStateHost(String(process.pid), {
      admits: (contextToken) => this.sessions.admits(contextToken),
      requestUserInput: (contextToken, params) => this.requestUserInput(contextToken, params),
      // Same token discipline as requestUserInput: a token whose session is
      // gone has no roots.
      sessionRoots: (contextToken) => {
        const sessionId = this.sessions.sessionOfToken(contextToken);
        return sessionId === undefined ? [] : this.sessions.rootsOf(sessionId);
      },
      getMcpServerToken: (contextToken, serverId) => {
        const agentId = this.sessions.bridgedTo(contextToken, serverId);
        return agentId === undefined ? Promise.resolve(null) : this.mcpServers.credentialFor(serverId, agentId);
      },
    });
    this.editorStateHost.start();

    // Live editor context for the composer (the selection
    // ghost chip appears only while the IDE has a selection; the @ mention
    // picker lists open editors). Position/paths only — the selection text
    // is read host-side at the moment the user solidifies it. High-frequency
    // sources; the channel's coalescing keeps only the latest.
    const pushEditorContext = () => {
      const s = this.editorStateHost.getSelection();
      this.agentView.emit({
        kind: "editorContextChanged",
        selection: s === null ? null : { file: s.file, startLine: s.startLine, endLine: s.endLine },
        openEditors: this.editorStateHost.getOpenEditors(),
      });
    };
    this.editorSubscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(pushEditorContext),
      vscode.window.onDidChangeActiveTextEditor(pushEditorContext),
      vscode.workspace.onDidOpenTextDocument(pushEditorContext),
      vscode.workspace.onDidCloseTextDocument(pushEditorContext),
      vscode.workspace.onDidChangeTextDocument(pushEditorContext), // dirty-flag flips
      vscode.workspace.onDidSaveTextDocument(pushEditorContext),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        // The chip and the wire read the same folders: the view re-renders
        // from reality, and every live session's additional directories are
        // re-applied so the agent's list moves with it.
        this.agentView.emit({ kind: "workspaceRootsChanged", roots: workspaceRootsView() });
        // the first folder in, or the last out, opens or closes this
        // workspace's saved list
        this.publishSavedRoots();
        void this.sessionGates.reapplyWorkspaceRoots().catch(this.logCatch("reapply workspace roots"));
      }),
    );

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
        onRealSessionAttached: (agentId, sessionId) =>
          this.capabilityTracker.noteRealSessionOpened(agentId, sessionId),
        // From the agent's saved config, never the pool entry's spec: that
        // one is a connect-time snapshot, and a Settings edit to defaults
        // must reach the very next session, not wait for a reconnect. The
        // knobSource preference is read just as fresh. Defaults themselves
        // are written only by the Settings save path — read-only to
        // everything here.
        seedFor: (agentId) => this.agents.knobSeed(agentId, this.preferences.get().knobSource),
        onKnobsConfirmed: (agentId, seed) => this.agents.recordKnobs(agentId, seed),
        rootsChanged: (sessionId) => {
          // Every subprocess of the session was spawned with one of its
          // tokens (one per attach; a re-attach mints a fresh one).
          for (const token of this.sessions.tokensOf(sessionId)) this.editorStateHost.notifyRootsChanged(token);
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
        currentTranscript: (sessionId) => this.agentView.current.transcripts[sessionId] ?? [],
        isDeleteUsed: (agentId) => this.agents.matrix(agentId)?.["session.delete"]?.used ?? false,
        isActiveSession: (sessionId) =>
          this.agentView.current.activeSessionId === sessionId ||
          this.pinnedSessions().includes(sessionId),
        isUnseen: (sessionId) =>
          this.agentView.current.sessions.find((s) => s.id === sessionId)?.unseen === true,
        cancelAsks: (sessionId) => this.broker.cancelPending(sessionId),
        authLocked: (agentId) => this.agents.authLocked(agentId),
        // the pointer names the session the agent's way, which a re-mint moves
        handleChanged: (sessionId) => {
          if (this.pointerRow === sessionId) this.recordPointer(sessionId);
        },
      },
      this.sessionContinuity,
      () => this.workspaceCwd,
      async (contextToken, agentId) => {
        // McpServerStdio is the untagged union member — no discriminant
        // needed since it's the only variant every agent is guaranteed to
        // accept, which is also why the editor server itself always rides
        // stdio (configured servers get capability-conditional transport).
        const editorServer = {
          name: "patchbay",
          command: process.execPath,
          args: [this.mcpServerScriptPath],
          env: [
            { name: "ACP_PATCHBAY_IPC", value: this.editorStateHost.socketPath },
            { name: "ACP_PATCHBAY_SESSION_ID", value: contextToken },
          ],
        };
        // Declared, not used, and that's correct here (prompt.image
        // mechanics): passthrough is how the mcp.http claim gets exercised
        // at all — a used-gate would deadlock the row forever.
        const declaresHttp = this.agents.matrix(agentId)?.["mcp.http"]?.declared === true;
        const { servers: configuredServers, given } = await this.mcpServers.mcpServersFor(
          agentId,
          this.mcpBridgeScriptPath,
          this.editorStateHost.socketPath,
          contextToken,
          declaresHttp,
        );
        // Env and header values are secrets by classification, and this
        // is the one place they cross to
        // the wire — register every one with the wire log's redaction set.
        // Over-redaction (plumbing values like socket paths get masked too)
        // is the safe direction.
        for (const server of [editorServer, ...configuredServers]) {
          if ("env" in server && server.env !== undefined) {
            for (const { value } of server.env) this.wireLog.registerSecret(value);
          }
          if ("headers" in server && server.headers !== undefined) {
            for (const { value } of server.headers) this.wireLog.registerSecret(value);
          }
        }
        return { servers: [editorServer, ...configuredServers], given };
      },
      log,
    );
    // The management side's tools for sessions: two lines per session —
    // its attachment work and its turn — and the gates, the one way any
    // door reaches an operation on a session's connection. What the lines
    // hold is the session's busy state, so every move re-sends it.
    const publishBusy = (sessionId: string) =>
      this.agentView.emit({ kind: "sessionBusyChanged", sessionId, busy: this.sessionGates.busy(sessionId) });
    this.sessions = sessions;
    this.sessionGates = new SessionGates(
      sessions,
      new Queue<AttachWork>(publishBusy),
      new Queue<"prompt">(publishBusy),
      {
        connect: (sessionId) => void this.connectForSession(sessionId),
        failed: (context, err) => this.logCatch(context)(err),
        agentSettled: (agentId) => this.gates.settled(agentId),
      },
      {
        // Read fresh every sweep (store-truth) — 0 in Preferences disables.
        idleCloseMs: () => {
          const minutes = this.preferences.get().idleCloseMinutes;
          return minutes <= 0 ? null : minutes * 60_000;
        },
      },
    );
    this.capabilityTracker = new CapabilityTracker(
      this.pool,
      this.usedCapabilities,
      {
        changed: (agentId) => this.agents.publish(agentId),
        probeRoot: (agentId) => this.agents.probeRoot(agentId),
      },
      log,
    );
    this.defaultsEditor = new DefaultsEditor(
      this.pool,
      {
        probeRoot: (agentId) => this.agents.probeRoot(agentId),
        defaultsFor: (agentId) => this.agents.spec(agentId)?.defaults ?? {},
        normalize: (response) =>
          normalizeKnobs(response.modes, response.configOptions, sessionKnobExtras(response), (m) =>
            this.log.info(m),
          ),
        mayOpen: (agentId) => !this.capabilityTracker.isProbeDeferred(agentId),
        emit: (...events) => this.settings.emit(...events),
      },
      log,
    );
    // The management side's tools for agents: the queue keeps each agent's
    // turns, and the gates — the one way any door reaches an operation on
    // an agent's connection — decide how each operation meets it, and put
    // the one question before a connection ends. What the queue holds is
    // the agent's busy state, so every move re-sends its row.
    const queue = new Queue<AgentOperation>((agentId) => this.agents.publish(agentId));
    const agents = new AgentsStore(
      {
        pool: this.pool,
        configs: this.agentConfigs,
        env: this.agentEnv,
        authLocks: this.authLocks,
        usedCapabilities: this.usedCapabilities,
        composerKnobs: this.composerKnobs,
        lastConnected: this.lastConnected,
        registry: this.acpRegistry,
        tracker: this.capabilityTracker,
        busy: (agentId) => queue.held(agentId),
        workspaceCwd: this.workspaceCwd,
        binaryCacheDir: this.binaryCacheDir,
        probeRootBase: join(context.globalStorageUri.fsPath, "probe"),
      },
      {
        emit: (...events) => {
          this.agentView.emit(...events);
          this.settings.emit(...events);
        },
        emitSettings: (...events) => this.settings.emit(...events),
        warn: (message) => void vscode.window.showWarningMessage(message),
        runLoginTask: (name, recipe) => runLoginTask(name, recipe),
        removed: (agentId) => {
          this.sessions.forgetAgentSessions(agentId);
          // A chat pane on the agent — still starting, or failed with a
          // Retry — has nothing left to wait for or retry.
          if (this.agentView.current.chatConnect?.agentId === agentId) {
            this.agentView.emit({ kind: "chatConnectResolved" });
          }
        },
        authCleared: (agentId) => this.sessionGates.lockCleared(agentId),
        defaultsChanged: (agentId) => void this.defaultsEditor.defaultsChanged(agentId),
      },
      log,
    );
    this.agents = agents;
    this.gates = new AgentGates(agents, queue, {
      name: (agentId) => agents.name(agentId),
      openWork: (agentId) => this.sessions.openWork(agentId),
      confirm: askModal,
    });
    // The editor's sessions exist only to serve the open panel — they end
    // with it.
    this.settings.onAttachment((attached) => {
      if (attached) void this.acpRegistry.refresh("settings");
      else void this.defaultsEditor.closeAll();
    });
    this.broker = new PermissionBroker(
      this.permissionRules,
      this.decisionAudit,
      {
        emit: (...events) => this.agentView.emit(...events),
        onAuditWritten: () => void this.refreshAuditTail(),
        redact: (text) => this.wireLog.redact(text),
        openLink: (href) => void openInBrowser(href),
      },
      (sessionId) => this.sessions.grantedRoots(sessionId),
      undefined, // default NodeTerminalRunner
      this.machinePermissionRules,
    );
    this.clientHost = new ClientHost({
      broker: this.broker,
      readLive: (path) => this.readTextFileLive(path),
      writeLive: (path, content) => this.writeTextFileLive(path, content),
      emit: (event) => this.agentView.emit(event),
      trackProcess: (handle) => {
        if (handle.pid === null) return;
        const pid = handle.pid;
        void commandOf(pid).then((cmd) => {
          // Already exited (fast command) → the record would only be stale.
          if (cmd !== "" && handle.exitStatus() === null) {
            void this.spawnRegistry.add(pid, cmd, "terminal");
          }
        });
        handle.onExit(() => void this.spawnRegistry.removePid(pid));
      },
    });

    void this.refreshAuditTail();
    void this.agents.publishAll();
    void this.mcpServers.refresh();
    void this.acpRegistry.load().then(() => {
      this.publishRegistry();
      void this.acpRegistry.refresh("startup");
    });

    // Projections of canonical Agent View state via ChannelHost.onChange —
    // the status bar (native surface, no webview in the path) and the
    // Settings "active today" tile (another channel, same source): same
    // state, read where it lives, never a second counter.
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = "acpPatchbay.agentView.focus";
    this.statusBarItem.show();
    this.agentView.onChange(() => {
      this.refreshStatusBar();
      this.publishSessionStats();
      this.notifyNewAsks();
    });
    this.refreshStatusBar();
    this.publishSessionStats();
    this.syncDetachContext();

    // Orphan reaping strictly before any startup agent spawns: the
    // registry must be settled before new pids start landing in it.
    void this.reapLeftoverProcesses()
      .then(() => this.connectStartupAgents())
      // Settles the view's restore hold no matter how the connects went —
      // the loading page must never outlive the startup sequence.
      .finally(() => this.agentView.emit({ kind: "startupSettled" }));
  }

  /** Sweeps spawn-registry records left by a session that never ran its
   * cleanup (crash, OS kill, host death). Kill only what still matches the
   * recorded command line — a mismatch is a reused pid and is spared, always
   * the safe direction (process-tree.ts). Every record is spent either way. */
  private async reapLeftoverProcesses(): Promise<void> {
    const records = this.spawnRegistry.list();
    if (records.length === 0) return;
    const { killed, spared } = await reapOrphans(records);
    for (const record of records) await this.spawnRegistry.removePid(record.pid);
    for (const record of killed) {
      this.log.info(`reaped orphan ${record.kind} process (pid ${record.pid}) from a previous session`);
    }
    for (const record of spared) {
      this.log.debug(`spared pid ${record.pid} — command line changed, pid was reused`);
    }
  }

  /** "Disconnect & erase all data": stop reality first —
   * every agent's work ended and its process down (graceful ladder), every
   * terminal tree — so nothing launches for an agent the sweep forgets, then
   * the erase sweep (erase-all.ts owns the ordering constraint), then both
   * channels catch up through ordinary events: agents and sessions leave
   * row by row, configs/MCP servers/rules/audit republish empty. Never
   * automatic; the Settings action is the only caller. */
  private async eraseEverything(): Promise<void> {
    this.log.info("erase all data: stopping every process");
    for (const pid of this.clientHost.runningPids()) killTree(pid, "SIGKILL");
    this.clientHost.clear();
    await Promise.all([this.gates.stopAll(), this.sessionGates.endAll(), this.mcpServerGates.endAll()]);
    this.sessions.reset();

    await eraseAllData({
      agentConfigs: this.agentConfigs,
      mcpServerConfigs: this.mcpServerConfigs,
      usedCapabilities: this.usedCapabilities,
      authLocks: this.authLocks,
      spawnRegistry: this.spawnRegistry,
      agentEnv: this.agentEnv,
      mcpServerEnv: this.mcpServerEnv,
      mcpServerTokens: this.mcpServerTokens,
      permissionRules: this.permissionRules,
      machineRules: this.machinePermissionRules,
      decisionAudit: this.decisionAudit,
      lastActiveSession: this.lastActiveSession,
      lastConnected: this.lastConnected,
      preferences: this.preferences,
      composerKnobs: this.composerKnobs,
      sessionContinuity: this.sessionContinuity,
      workspaceSavedRoots: this.workspaceSavedRoots,
      machineSavedRoots: this.machineSavedRoots,
      tempStashes: {
        wipe: async () => {
          await rm(ATTACHMENTS_DIR, { recursive: true, force: true });
          await rm(join(tmpdir(), "acp-patchbay-diffs"), { recursive: true, force: true });
        },
      },
    });

    for (const session of this.agentView.current.sessions) {
      this.agentView.emit({ kind: "sessionClosed", sessionId: session.id });
    }
    await this.agents.erased(this.agentView.current.agents.map((a) => a.id));
    this.agentView.emit({ kind: "chatConnectResolved" });
    await this.mcpServers.refresh();
    this.publishRules();
    this.publishSavedRoots();
    // An open Preferences page settles back to the defaults it now holds
    // (and the agent view's composer stats with it).
    const preferences = this.preferences.get();
    this.settings.emit({ kind: "preferencesChanged", preferences });
    this.agentView.emit({ kind: "preferencesChanged", preferences });
    this.syncDetachContext();
    await this.refreshAuditTail();
    // An open Data page should watch its own inventory hit zero.
    await this.publishDataInventory();
    this.log.info("erase all data: complete — factory state");
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
    for (const pid of this.clientHost.runningPids()) killTree(pid, "SIGKILL");
    await Promise.race([
      Promise.all([this.gates.stopAll(), this.sessionGates.endAll(), this.mcpServerGates.endAll()]),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
    ]);
  }

  /** Startup: what the agents store says this window opens with is
   * connected, then the last open session is restored. The raw
   * `acpPatchbay.defaultAgent` value stays readable after the
   * contribution's removal — unregistered keys still surface — and the
   * store folds it into the per-agent flag. */
  private async connectStartupAgents(): Promise<void> {
    const legacy = vscode.workspace.getConfiguration("acpPatchbay").get<string>("defaultAgent", "");
    const sources = await this.agents.startupSources(legacy);
    await Promise.allSettled(sources.map((source) => this.connectFrom(source)));
    await this.restoreLastActiveSession();
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
   * not erase where a later window could still return. Never spawns a
   * process the startup rules didn't start. */
  private async restoreLastActiveSession(): Promise<void> {
    const pointer = this.lastActiveSession.get();
    if (pointer === undefined) return;
    await Promise.allSettled([...this.pendingSyncs.values()]);
    if (this.agentView.current.activeSessionId !== null) return;
    const sessionId = this.sessions.rowFor(pointer.agentId, pointer.sessionId);
    if (sessionId === undefined) return;
    this.sessionGates.activate(sessionId);
  }

  /** Mirrors the detachWindows preference into a when-clause context key —
   * package.json gates the view-title button and the palette command on it
   * (native surfaces can't read the store; this is their one bridge). */
  private syncDetachContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "acpPatchbay.detachEnabled",
      this.preferences.get().detachWindows,
    );
  }

  /** Active session · agent health · usage when reported —
   * click jumps to the Agent View, which already shows that same session. */
  private refreshStatusBar(): void {
    const { text, tooltip } = statusBarContent(this.agentView.current);
    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = tooltip;
  }

  /** Command palette: "new session" — every configured
   * agent with its readiness inline, single agent skips the pick, and a
   * not-running choice connects on demand (the same startChat path as
   * the view's "+"). */
  async newSessionCommand(): Promise<void> {
    const agents = this.agents.rows();
    if (agents.length === 0) {
      void vscode.window.showInformationMessage("Add an agent first — Patchbay Settings › Agents.");
      this.handleAction({ kind: "openSettings", section: "agents" });
      return;
    }
    let agentId = agents[0]!.id;
    if (agents.length > 1) {
      const picked = await vscode.window.showQuickPick(
        agents.map((a) => ({
          label: a.name,
          description: a.detail ?? (a.status === "running" ? "ready" : a.status === "untested" ? "never connected" : a.status),
          agentId: a.id,
        })),
        { placeHolder: "New session with…" },
      );
      if (picked === undefined) return;
      agentId = picked.agentId;
    }
    await this.startChat(agentId);
    await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
  }

  /** "Switch session." The pick is a read of the list — the same re-read
   * as the drawer opening — and, like the drawer, it opens on what is known
   * now and re-fills when the re-read lands: a running agent that never
   * answers must not hold the palette hostage (pool requests carry no
   * deadline). */
  async switchSessionCommand(): Promise<void> {
    type Item = vscode.QuickPickItem & { sessionId: string };
    const items = (): Item[] =>
      this.agentView.current.sessions.map((s) => ({
        label: s.title,
        description: this.agents.name(s.agentId) ?? s.agentId,
        sessionId: s.id,
      }));
    const pick = vscode.window.createQuickPick<Item>();
    pick.placeholder = "Switch to session…";
    pick.items = items();
    pick.busy = true;
    const picked = await new Promise<Item | undefined>((resolve) => {
      let open = true;
      pick.onDidAccept(() => resolve(pick.selectedItems[0]));
      pick.onDidHide(() => {
        open = false;
        resolve(undefined);
      });
      void this.sessions.syncRunningAgents().finally(() => {
        if (!open) return;
        pick.items = items();
        pick.busy = false;
        if (pick.items.length === 0) {
          void vscode.window.showInformationMessage("No sessions yet.");
          pick.hide();
        }
      });
      pick.show();
    });
    pick.dispose();
    if (picked === undefined) return;
    await this.revealSession(picked.sessionId);
  }

  /** "Connect agent" — the palette shortcut into the one add path (the
   * Settings Agents save-connect-verify flow): registry or custom command,
   * the same `connectFrom` either way. */
  async connectAgentCommand(): Promise<void> {
    const items = [
      ...this.acpRegistry.current().agents
        .filter((a) => !("error" in resolveDistribution(a)))
        .map((a) => ({ label: a.name, registryId: a.id as string | undefined })),
      { label: "Custom command…", registryId: undefined as string | undefined },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Connect agent…" });
    if (picked === undefined) return;
    if (picked.registryId === undefined) {
      const command = await vscode.window.showInputBox({ placeHolder: "command that speaks ACP…" });
      if (command === undefined || command.trim() === "") return;
      await this.connectFrom({ command });
    } else {
      await this.connectFrom({ registryId: picked.registryId });
    }
    await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
  }

  /** Editor right-click ("add to context / ask the agent
   * about it") — reuses the composer's own add-selection action so there's
   * one path for "a selection became context," native gesture or button
   * alike; focusing the Agent View afterward is what lets the user ask
   * about it, the same composer flow either way. */
  async addSelectionToContextCommand(): Promise<void> {
    const sessionId = this.agentView.current.activeSessionId;
    if (sessionId === null) {
      void vscode.window.showInformationMessage("Start a Patchbay session first, then add a selection.");
      return;
    }
    this.handleAction({ kind: "addSelectionContext", sessionId });
    await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
  }

  /** The local MCP server's `request_user_input` tool — the fallback for an
   * agent that asks through MCP instead of ACP's own elicitation request.
   * `contextToken` is what the MCP server subprocess was spawned with —
   * translated back to the real sessionId so the form lands in the right
   * transcript. */
  private requestUserInput(
    contextToken: string,
    params: RequestUserInputParams,
  ): Promise<ElicitationAnswer> {
    // A token whose session is gone has no transcript to ask in, so the
    // user never saw the question — a cancel, never a guessed session.
    const sessionId = this.sessions.sessionOfToken(contextToken);
    if (sessionId === undefined) return Promise.resolve({ action: "cancel" });
    // Same parser as the agent's own elicitation request. A field it cannot
    // present fails the tool call with the reason, rather than rendering a
    // guessed control.
    const fields = params.requestedSchema === undefined ? [] : formFieldsOf(params.requestedSchema);
    if (fields === null) return Promise.reject(new Error("the form has a field patchbay cannot present"));
    return this.broker.askElicitation(sessionId, { message: params.message, ask: { mode: "form", fields } });
  }

  /** The "last open session" pointer (stores/last-active-session.ts).
   * Every activation flows through the sessions-store emit hook, so this
   * one chokepoint keeps the pointer honest; a close (user click or prune)
   * clears it only while it still points there. */
  private recordLastActive(events: readonly AgentViewEvent[]): void {
    for (const event of events) {
      if (event.kind === "sessionActivated") this.recordPointer(event.sessionId);
      else if (event.kind === "sessionClosed" && event.sessionId === this.pointerRow) {
        this.pointerRow = null;
        void this.lastActiveSession.wipe();
      }
    }
  }

  /** The pointer names the session the way the next window can find it:
   * its agent, and the agent's own id for it. */
  private recordPointer(sessionId: string): void {
    const agentId = this.sessions.agentFor(sessionId);
    const handle = this.sessions.handleOf(sessionId);
    if (agentId === undefined || handle === undefined) return;
    this.pointerRow = sessionId;
    void this.lastActiveSession.set({ agentId, sessionId: handle });
  }

  /** Done-sound (Preferences): the system chime as a turn resolves —
   * host-side (sound.ts header: webviews die when hidden). A cancelled
   * turn never chimes: the user was present to cancel it. */
  private maybeChime(events: readonly AgentViewEvent[]): void {
    for (const event of events) {
      if (event.kind !== "turnEnded" || event.stopReason === "cancelled") continue;
      const prefs = this.preferences.get();
      if (!prefs.soundOnDone) return;
      playDoneSound(this.log, prefs.doneSound);
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

  /** Opens a file in the editor its type calls for (text, image preview,
   * …). A location line puts the cursor on that line's first non-blank
   * character, scrolled into view; a file with no text to land in (binary)
   * opens without one. A directory — some agents report a shell command's
   * working directory as its location — is revealed in the Explorer, never
   * opened as a folder. */
  private async openFileAt(path: string, line: number | undefined): Promise<void> {
    const uri = vscode.Uri.file(path);
    if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) {
      await vscode.commands.executeCommand("revealInExplorer", uri);
      return;
    }
    let selection: vscode.Range | undefined;
    if (line !== undefined) {
      const doc = await vscode.workspace.openTextDocument(uri).then(
        (d) => d,
        () => null,
      );
      if (doc !== null) {
        const at = doc.lineAt(editorLineOf(line, doc.lineCount));
        const pos = new vscode.Position(at.lineNumber, at.firstNonWhitespaceCharacterIndex);
        selection = new vscode.Range(pos, pos);
      }
    }
    await vscode.commands.executeCommand("vscode.open", uri, selection === undefined ? undefined : { selection });
  }

  /** Live-buffer read: an open, possibly-unsaved editor wins over disk
   * ("the agent sees what the user sees"). Falls back to disk for files
   * with no open editor. */
  private async readTextFileLive(path: string): Promise<string> {
    const uri = vscode.Uri.file(path);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path);
    if (open !== undefined) return open.getText();
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  }

  /** Live-buffer write — the mirror of readTextFileLive: when the file is
   * open in an editor the write lands in that
   * buffer via WorkspaceEdit, then saves — the user sees the change, it joins
   * the undo stack, and disk matches the buffer at once. This closes the
   * divergence window both ways: no more agent write silently lost to a stale
   * dirty buffer's next save, no more terminal reading a disk the buffer
   * contradicts. Falls back to a plain disk write when no editor holds the
   * file. A failed apply throws — the agent must know the write didn't land;
   * a silent disk fallback would recreate the divergence. */
  private async writeTextFileLive(path: string, content: string): Promise<void> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path);
    if (open === undefined) return applyFileWrite(path, content);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(open.uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), content);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error(`failed to apply write to the open editor for ${path}`);
    }
    // save() resolves false for a non-dirty doc (identical content → no-op
    // edit), which is success here, not failure — only save a dirty buffer.
    if (open.isDirty && !(await open.save())) {
      throw new Error(`failed to save ${path} after write`);
    }
  }

  /** A rendered mermaid SVG, opened as an editor-area panel — the agent
   * view's column is narrow (even the in-chat fullscreen stops at it); the
   * files area is where a diagram can breathe. Pan/zoom is hand-rolled
   * vanilla (wheel = zoom around cursor, drag = pan, double-click = reset):
   * CSP allows exactly one nonce'd inline script for it — a deliberate,
   * recorded widening of this panel's previous no-script posture, still
   * default-src 'none' and the SVG is mermaid's sanitized output. */
  private openDiagram(svg: string): void {
    const panel = vscode.window.createWebviewPanel(
      "acpPatchbay.diagram",
      "Diagram",
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    const n = nonce();
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}'; img-src data:;">
  <style>
    body { margin: 0; height: 100vh; overflow: hidden; cursor: grab; }
    body.dragging { cursor: grabbing; }
    #stage { height: 100%; display: grid; place-items: center; }
    #wrap { transform-origin: 0 0; }
    svg { max-width: 95vw; max-height: 95vh; height: auto; display: block; }
  </style>
</head>
<body>
  <div id="stage"><div id="wrap">${svg}</div></div>
  <script nonce="${n}">
    "use strict";
    const wrap = document.getElementById("wrap");
    let scale = 1, x = 0, y = 0, drag = null;
    const apply = () => { wrap.style.transform = \`translate(\${x}px, \${y}px) scale(\${scale})\`; };
    window.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const next = Math.min(10, Math.max(0.2, scale * factor));
      // keep the point under the cursor fixed while scaling
      x = e.clientX - (e.clientX - x) * (next / scale);
      y = e.clientY - (e.clientY - y) * (next / scale);
      scale = next;
      apply();
    }, { passive: false });
    window.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY };
      document.body.classList.add("dragging");
    });
    window.addEventListener("pointermove", (e) => {
      if (drag === null) return;
      x += e.clientX - drag.x;
      y += e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      apply();
    });
    const end = () => { drag = null; document.body.classList.remove("dragging"); };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("dblclick", () => { scale = 1; x = 0; y = 0; apply(); });
  </script>
</body>
</html>`;
  }

  /** One stash text → one temp file with a real URI, for vscode.diff — both
   * native-diff openers share this (diffs always open in VS Code's own diff
   * editor, never an inline webview diff). */
  private async diffTempFile(scope: string, fileName: string, content: string): Promise<vscode.Uri> {
    const dir = join(tmpdir(), "acp-patchbay-diffs", scope.replace(/[^a-zA-Z0-9_-]/g, "_"));
    await mkdir(dir, { recursive: true });
    const file = join(dir, fileName);
    await writeFile(file, content, "utf8");
    return vscode.Uri.file(file);
  }

  /** A pending write proposal, in full — the card is a bounded preview and
   * the decision deserves the whole change. Left: the file as it is on disk
   * at proposal time (the gate's own reading — a new file diffs against
   * empty); right: what the agent wants to write. Both are snapshots the
   * broker holds only while the decision is open, so a stale click after
   * resolution is a no-op, like the other openers. */
  private async openProposedDiff(blockId: string): Promise<void> {
    const proposal = this.broker.proposedDiff(blockId);
    if (proposal === null) return;
    const name = basename(proposal.path);
    await vscode.commands.executeCommand(
      "vscode.diff",
      await this.diffTempFile(blockId, `current-${name}`, proposal.oldText),
      await this.diffTempFile(blockId, `proposed-${name}`, proposal.newText),
      `${name} — proposed write (accept or reject on the card)`,
    );
  }

  /** Agent-reported tool-call diffs — the texts come back from the
   * sessions store's stash; both sides are snapshots, so both ride temp files. */
  private async openToolCallDiff(sessionId: string, toolCallId: string, path: string): Promise<void> {
    const diff = this.sessions.toolCallDiff(sessionId, toolCallId, path);
    if (diff === null) return; // stale id after a close — nothing to show
    const name = basename(path);
    await vscode.commands.executeCommand(
      "vscode.diff",
      await this.diffTempFile(toolCallId, `before-${name}`, diff.oldText),
      await this.diffTempFile(toolCallId, `after-${name}`, diff.newText),
      `${name} — agent-proposed change`,
    );
  }

  /** A surface became visible or hidden (or went away): the view hosts
   * report here, and the screen fact follows — emitted only on a real
   * change. `pinned` is the session the surface shows; null = it follows
   * the active-session pointer. */
  noteSurface(surface: object, visible: boolean, pinned: string | null): void {
    if (visible) this.visibleSurfaces.set(surface, pinned);
    else this.visibleSurfaces.delete(surface);
    const shows = [...this.visibleSurfaces.values()];
    const pointer = shows.includes(null);
    const pinnedIds = [...new Set(shows.filter((id): id is string => id !== null))].sort();
    const current = this.agentView.current.screen;
    if (current.pointer === pointer && current.pinned.join("\n") === pinnedIds.join("\n")) return;
    this.agentView.emit({ kind: "screenChanged", pointer, pinned: pinnedIds });
  }

  /** A connection that ended can no longer take an answer: every ask still
   * open on it settles as cancelled — the same answer a stopped turn gives —
   * so no card, and no "waiting" mark, outlives the process it was asked
   * on. Read before the sessions are invalidated. */
  private settleAsksOn(agentId: string): void {
    for (const sessionId of this.sessions.sessionsOn(agentId)) this.broker.cancelPending(sessionId);
  }

  /** The native notification is a projection of the waiting fact, not a
   * call each ask remembers to make: every ask that starts while its
   * session is off screen raises one — whatever kind it is. An ask that
   * arrived on screen never does, even if the user looks away before
   * answering (the badge and header still count it). */
  private notifyNewAsks(): void {
    const state = this.agentView.current;
    const shown = onScreen(state);
    const open = new Set<string>();
    for (const session of state.sessions) {
      for (const ask of openAsks(state.transcripts[session.id] ?? [])) {
        open.add(ask.id);
        if (!this.knownAsks.has(ask.id) && !shown.has(session.id)) this.notifyAsk(session.id, session.title, ask);
      }
    }
    this.knownAsks = open;
  }

  /** Mirrors the inline card: its own answers where a button can give them
   * (the same actions the card sends, so whichever surface the user acts
   * on first wins — a second answer is a no-op), and Open, which brings
   * the session up. A question is answered only in its card. */
  private notifyAsk(sessionId: string, title: string, ask: OpenAsk): void {
    const answers: { label: string; action: Action }[] =
      ask.kind === "permission"
        ? ask.options.map((o) => ({
            label: o.label,
            action: { kind: "resolvePermission", requestId: ask.id, optionId: o.optionId },
          }))
        : ask.kind === "diff"
          ? [
              { label: "Accept", action: { kind: "resolveDiff", requestId: ask.id, accept: true } },
              { label: "Reject", action: { kind: "resolveDiff", requestId: ask.id, accept: false } },
            ]
          : [];
    const what =
      ask.kind === "permission" ? `${ask.title}: ${ask.detail}` : ask.kind === "diff" ? `File write: ${ask.file}` : ask.message;
    const labels = [...answers.map((a) => a.label), "Open"];
    void vscode.window.showWarningMessage(`${title} — ${what}`, ...labels).then((picked) => {
      if (picked === "Open") void this.revealSession(sessionId);
      else {
        const answer = answers.find((a) => a.label === picked);
        if (answer !== undefined) this.handleAction(answer.action);
      }
    });
  }

  /** Brings a session up in the Agent View — the one path for every
   * "take me there" (the switch-session command, a notification's Open). */
  private async revealSession(sessionId: string): Promise<void> {
    this.sessionGates.open(sessionId);
    await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
  }

  private async refreshAuditTail(): Promise<void> {
    const entries = await this.decisionAudit.tail(20);
    this.settings.emit({ kind: "auditTailChanged", entries });
  }

  /** Enable goes through the disclosure prompt — every entry point (Audit
   * page toggle, status pill, palette command) shares this one consent
   * gate; the confirming state event fires only after the user says yes. */
  private async setWireLog(active: boolean): Promise<void> {
    if (!active) {
      this.wireLog.disable();
      return;
    }
    if (this.wireLog.active) return;
    const ENABLE = "Enable for 30 minutes";
    const pick = await vscode.window.showWarningMessage(
      "Enable the ACP wire log?",
      {
        modal: true,
        detail:
          "Every JSON-RPC frame on the agent wire goes to the Output panel — prompts, file contents, " +
          "and tool traffic will be readable there. Credentials patchbay injected are masked at the seam; " +
          "anything an agent echoes back on its own is not. Turns itself off in 30 minutes.",
      },
      ENABLE,
    );
    if (pick !== ENABLE) return;
    this.wireLog.enable();
    this.wireChannel?.show(true);
  }

  /** Status-pill click and the palette command land here: consent+enable
   * when off; a stop-first quick pick when on (at minute 25 the state
   * you're usually in is "not done yet" — extending must not require
   * re-toggling, but stop stays the fast path). */
  async wireLogCommand(): Promise<void> {
    if (!this.wireLog.active) {
      await this.setWireLog(true);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(debug-stop) Stop now", action: "stop" as const },
        { label: "$(watch) Extend 30 minutes", action: "extend" as const },
      ],
      {
        placeHolder: `Wire log is on — auto-off at ${new Date(this.wireLog.until ?? Date.now()).toLocaleTimeString()}`,
      },
    );
    if (pick?.action === "stop") this.wireLog.disable();
    else if (pick?.action === "extend") this.wireLog.extend();
  }

  private onWireLogStateChanged(active: boolean, until: string | null): void {
    this.settings.emit({ kind: "wireLogChanged", active, until });
    if (!active) {
      this.wireStatusItem?.dispose();
      this.wireStatusItem = null;
      if (this.wireStatusTimer !== null) clearInterval(this.wireStatusTimer);
      this.wireStatusTimer = null;
      return;
    }
    if (this.wireStatusItem === null) {
      // Transient pill, right side next to the main item — its existence IS
      // the state; warning background is the platform's own "temporarily
      // elevated" grammar.
      this.wireStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
      this.wireStatusItem.command = "acpPatchbay.wireLog";
      this.wireStatusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
    this.updateWireStatusText();
    this.wireStatusItem.show();
    if (this.wireStatusTimer === null) {
      this.wireStatusTimer = setInterval(() => this.updateWireStatusText(), 30_000);
      this.wireStatusTimer.unref?.();
    }
  }

  private updateWireStatusText(): void {
    if (this.wireStatusItem === null) return;
    const until = this.wireLog.until;
    const mins =
      until === null ? 0 : Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 60_000));
    this.wireStatusItem.text = `$(pulse) Wire log · ${mins}m`;
    this.wireStatusItem.tooltip =
      "ACP wire log is on — every frame goes to Output. Click to stop or extend.";
  }

  /** The Data page's storage inventory — recomputed from the live stores on
   * every request, never cached (reality is the source of truth). Counts
   * only — never values. */
  private async publishDataInventory(): Promise<void> {
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
    const rules = this.permissionRules.get();
    const machineRules = this.machinePermissionRules.get();
    const rows: DataInventoryRow[] = [
      { id: "agent-configs", label: "Agent configs", placement: "globalStorage file", detail: count(agentConfigs.length, "agent") },
      { id: "mcp-server-configs", label: "MCP server configs", placement: "globalStorage file", detail: count(mcpServerConfigs.length, "server") },
      { id: "used-capabilities", label: "Used-capability cache", placement: "globalStorage file", detail: count(this.usedCapabilities.list().length, "agent record") },
      { id: "machine-rules", label: "Command rules — this machine", placement: "globalStorage file", detail: count(machineRules.commandRules.length, "rule") },
      { id: "spawn-registry", label: "Spawn registry", placement: "globalStorage file", detail: count(this.spawnRegistry.list().length, "process record") },
      {
        id: "preferences",
        label: "Preferences",
        placement: "globalStorage file",
        detail: (() => {
          const p = this.preferences.get();
          const idle = p.idleCloseMinutes <= 0 ? "never" : `${p.idleCloseMinutes} min`;
          const stats = [p.statsPrompts, p.statsToolCalls, p.statsContext, p.statsPlanUsage].filter(Boolean).length;
          return `sound ${p.soundOnDone ? "on" : "off"} · knobs: ${p.knobSource === "last-session" ? "last used" : "agent defaults"} · idle release ${idle} · composer stats ${stats}/4 shown`;
        })(),
      },
      { id: "composer-knobs", label: "Composer knobs (last used)", placement: "globalStorage file", detail: count(this.composerKnobs.count(), "agent record") },
      {
        id: "secrets",
        label: "Credentials & env values",
        placement: "SecretStorage",
        detail: `${count(agentEnvCount + mcpServerEnvCount, "env value")} · ${count(tokenCount, "OAuth token")}`,
      },
      {
        id: "workspace-rules",
        label: "Command rules & file-write scope — this workspace",
        placement: "workspaceState",
        detail: `${count(rules.commandRules.length, "rule")} · scope: ${rules.fileWriteScope}`,
      },
      { id: "machine-saved-roots", label: "Saved roots — every workspace", placement: "globalStorage file", detail: count(this.machineSavedRoots.list().length, "folder") },
      { id: "workspace-saved-roots", label: "Saved roots — this workspace", placement: "workspaceState", detail: count(this.workspaceSavedRoots.list().length, "folder") },
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

  /** Tells the user about each newer agent version once per window, with
   * the upgrade one click away: a single update upgrades from the
   * notification; several open a pick of which to upgrade, all checked.
   * Every upgrade takes the one Upgrade path, its confirmation included —
   * and only while the update is still the fact: a notification answered
   * after the agent was upgraded elsewhere restarts nothing. */
  private async announceUpdates(): Promise<void> {
    const fresh = Object.entries(this.agents.updates()).filter(([id, u]) => !this.announcedUpdates.has(`${id}@${u.to}`));
    if (fresh.length === 0) return;
    for (const [id, u] of fresh) this.announcedUpdates.add(`${id}@${u.to}`);
    const nameOf = (id: string) => this.agents.name(id) ?? id;
    if (fresh.length === 1) {
      const [id, u] = fresh[0]!;
      const picked = await vscode.window.showInformationMessage(
        `${nameOf(id)} ${u.to} is available — you run ${u.from}.`,
        "Upgrade",
      );
      if (picked === "Upgrade" && this.agents.updates()[id] !== undefined) {
        await this.gates.upgrade(id).catch(this.logCatch(`upgrade ${id}`));
      }
      return;
    }
    const picked = await vscode.window.showInformationMessage(
      `Updates are available for ${fresh.length} agents.`,
      "Upgrade…",
    );
    if (picked !== "Upgrade…") return;
    const chosen = await vscode.window.showQuickPick(
      fresh.map(([id, u]) => ({ label: nameOf(id), description: `${u.from} → ${u.to}`, picked: true, id })),
      { canPickMany: true, placeHolder: "Upgrade which agents?" },
    );
    for (const item of chosen ?? []) {
      if (this.agents.updates()[item.id] !== undefined) {
        await this.gates.upgrade(item.id).catch(this.logCatch(`upgrade ${item.id}`));
      }
    }
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
    return askModal(message, "Download");
  }

  private handleAction(action: Action): void {
    switch (action.kind) {
      case "openSettings":
        // Navigate after the reveal settles: an already-open panel keeps its
        // section, so without this a deep-linking caller ("Add or manage
        // agents") reads as a dead click.
        void vscode.commands
          .executeCommand("acpPatchbay.openSettings")
          .then(() => {
            if (action.section !== undefined)
              this.settings.emit({ kind: "sectionChanged", section: action.section });
          }, this.logCatch("openSettings"));
        break;
      case "setSettingsSection":
        this.settings.emit({ kind: "sectionChanged", section: action.section });
        break;
      case "connectAgent":
        void this.connectFrom(action.source, action.verifyAfterConnect ?? false);
        break;
      case "restartAgent":
        // failure surfaces as a crashed status patch — no reply channel by design
        void this.gates.restart(action.agentId).catch(this.logCatch(`restart ${action.agentId}`));
        break;
      case "stopAgent":
        void this.gates.stop(action.agentId).catch(this.logCatch(`stop ${action.agentId}`));
        break;
      case "startChat":
        void this.startChat(action.agentId);
        break;
      case "dismissChatConnect":
        this.agentView.emit({ kind: "chatConnectResolved" });
        break;
      case "eraseAllData":
        void this.eraseEverything().catch(this.logCatch("eraseAllData"));
        break;
      case "setWireLog":
        void this.setWireLog(action.active);
        break;
      case "refreshDataInventory":
        void this.publishDataInventory();
        break;
      case "syncSessions":
        void this.sessions.syncRunningAgents();
        break;
      case "switchSession":
        // Switching NEVER closes the session being left — open sessions
        // stay attached until the idle reaper's full predicate says
        // otherwise (sessions-store `idle`).
        this.sessionGates.open(action.sessionId);
        break;
      case "closeSession":
        void this.sessionGates.close(action.sessionId).catch(this.logCatch(`close ${action.sessionId}`));
        break;
      case "copySessionId": {
        const handle = this.sessions.handleOf(action.sessionId);
        if (handle !== undefined) void vscode.env.clipboard.writeText(handle);
        break;
      }
      case "reloadSession":
        void this.sessionGates.reload(action.sessionId).catch(this.logCatch(`reload ${action.sessionId}`));
        break;
      // A rejected set leaves authoritative state unchanged — republish it
      // (fresh identity) so the pill's pending spinner settles back to truth.
      case "setSessionKnob":
        void this.sessionGates
          .setKnob(action.sessionId, action.knobId, action.value)
          .catch((err) => {
            this.logCatch(`setKnob ${action.sessionId}`)(err);
            const knobs = this.agentView.current.sessionKnobs[action.sessionId];
            if (knobs !== undefined) {
              this.agentView.emit({ kind: "sessionKnobsSet", sessionId: action.sessionId, knobs: [...knobs] });
            }
          });
        break;
      case "sendPrompt":
        // Pure dispatch: the turn-start door is the session gates', where
        // every prompt passes — a guard here would cover only this entrance.
        // A failure leaves the turn's end, or the words held, with no reply
        // channel by design.
        void this.sessionGates
          .prompt(action.sessionId, {
            text: action.text,
            ...(action.parts !== undefined ? { parts: action.parts } : {}),
            ...(action.draft !== undefined ? { draft: action.draft } : {}),
          })
          .catch(this.logCatch(`sendPrompt ${action.sessionId}`));
        break;
      case "detachSession":
        // Preference-gated at the source of truth, not only in the menu
        // that hid itself (render-only webviews don't get to be the gate).
        if (!this.preferences.get().detachWindows) break;
        // The panel host lives in extension.ts (like Settings) — reach it by
        // command. Then the one open ceremony, pinned: the panel renders
        // this session by id, so the active pointer stays where it is.
        void vscode.commands.executeCommand("acpPatchbay.detachSession", action.sessionId);
        this.sessionGates.open(action.sessionId, { pin: true });
        break;
      case "removeQueuedPrompt":
        this.sessions.removeQueuedPrompt(action.sessionId, action.promptId);
        break;
      case "reclaimQueuedPrompt":
        this.sessions.takeBack(action.sessionId, action.promptId);
        break;
      case "setSessionDraft":
        // The composer's debounced durable save.
        this.sessions.saveDraft(action.sessionId, action.draft);
        break;
      case "stopTurn":
        void this.sessionGates.stop(action.sessionId).catch(this.logCatch(`stop turn ${action.sessionId}`));
        break;
      case "verifyAgent":
        void this.gates.verify(action.agentId).catch(this.logCatch(`verify ${action.agentId}`));
        break;
      case "editAgentDefaults":
        void (action.open ? this.defaultsEditor.open(action.agentId) : this.defaultsEditor.close(action.agentId));
        break;
      case "resolvePermission":
        this.broker.resolve(action.requestId, action.optionId);
        break;
      case "resolveDiff":
        this.broker.resolve(action.requestId, action.accept ? "accept" : "reject");
        break;
      case "authenticateAgent":
        // failure leaves needsAuth set — the honest signal, no separate reply channel
        void this.gates.login(action.agentId, action.methodId).catch(this.logCatch(`login ${action.agentId}`));
        break;
      case "logoutAgent":
        // the UI only offers this on a declared auth.logout; a successful
        // logout raises needsAuth directly (capability-tracker.logout)
        void this.gates.logout(action.agentId).catch(this.logCatch(`logout ${action.agentId}`));
        break;
      case "upgradeAgent":
        void this.gates.upgrade(action.agentId).catch(this.logCatch(`upgrade ${action.agentId}`));
        break;
      case "refreshRegistry":
        void this.acpRegistry.refresh("manual");
        break;
      case "addCommandRule": {
        if (action.layer === "machine") {
          const machine = this.machinePermissionRules.get().commandRules;
          void this.machinePermissionRules
            .set([...machine, action.rule])
            .then(() => this.publishRules());
          break;
        }
        const rules = this.permissionRules.get();
        void this.permissionRules
          .set({ ...rules, commandRules: [...rules.commandRules, action.rule] })
          .then(() => this.publishRules());
        break;
      }
      case "removeCommandRule": {
        if (action.layer === "machine") {
          const machine = this.machinePermissionRules.get().commandRules;
          void this.machinePermissionRules
            .set(machine.filter((r) => r.pattern !== action.pattern))
            .then(() => this.publishRules());
          break;
        }
        const rules = this.permissionRules.get();
        void this.permissionRules
          .set({
            ...rules,
            commandRules: rules.commandRules.filter((r) => r.pattern !== action.pattern),
          })
          .then(() => this.publishRules());
        break;
      }
      case "setFileWriteScope": {
        const rules = this.permissionRules.get();
        void this.permissionRules
          .set({ ...rules, fileWriteScope: action.scope })
          .then(() => this.publishRules());
        break;
      }
      case "setPreferences":
        void this.preferences.set(action.patch).then((preferences) => {
          // One truth, both channels: the Preferences page and the agent
          // view (composer stats) render the same stored object.
          this.settings.emit({ kind: "preferencesChanged", preferences });
          this.agentView.emit({ kind: "preferencesChanged", preferences });
          this.syncDetachContext();
        });
        break;
      case "previewDoneSound":
        // Preview only — plays exactly what a finishing turn would, stores
        // nothing (the selection persists via setPreferences on change).
        playDoneSound(this.log, action.sound);
        break;
      case "resolveElicitation":
        this.broker.resolveElicitation(action.requestId, action.answer);
        break;
      case "reopenElicitationLink":
        this.broker.reopenLink(action.requestId);
        break;
      case "addSelectionContext": {
        const selection = this.editorStateHost.getSelection();
        if (selection === null) {
          void vscode.window.showInformationMessage("No selection — select text in a visible editor first.");
          break;
        }
        void this.sessions
          .addContext(action.sessionId, {
            id: chipId(),
            kind: "selection",
            label: `Selection: ${selection.file}:${selection.startLine}-${selection.endLine}`,
            content: selection.text,
            sourceUri: `${vscode.Uri.file(selection.file)}#L${selection.startLine}-${selection.endLine}`,
          })
          .catch(this.logCatch(`add context ${action.sessionId}`));
        break;
      }
      case "addFileContext": {
        const file = this.editorStateHost.getCurrentFile();
        if (file === null) {
          void vscode.window.showInformationMessage("No current file — open a file in an editor first.");
          break;
        }
        void this.sessions
          .addContext(action.sessionId, {
            id: chipId(),
            kind: "file",
            label: `File: ${file.file}`,
            content: file.content,
            sourceUri: vscode.Uri.file(file.file).toString(),
          })
          .catch(this.logCatch(`add context ${action.sessionId}`));
        break;
      }
      case "addDiagnosticsContext": {
        const diagnostics = this.editorStateHost.getDiagnostics();
        if (diagnostics.length === 0) break;
        void this.sessions
          .addContext(action.sessionId, {
            id: chipId(),
            kind: "diagnostics",
            label: `Problems (${diagnostics.length})`,
            content: diagnostics.map((d) => `${d.file}:${d.line} [${d.severity}] ${d.message}`).join("\n"),
          })
          .catch(this.logCatch(`add context ${action.sessionId}`));
        break;
      }
      case "removeContextChip":
        this.sessions.removeContext(action.sessionId, action.chipId);
        break;
      // A connect's failure is the store's to hold and show; the log has it
      // already.
      case "connectRegistryKey":
        void this.mcpServerGates.connectWithKey(action.registryId, action.token, action.url).catch(() => {});
        break;
      case "connectRegistryOAuth":
        void this.mcpServerGates.connectOAuth(action.registryId, action.url).catch(() => {});
        break;
      case "addCustomMcpServer":
        void this.mcpServerGates.addCustom(action.name, action.source, action.routing).catch(() => {});
        break;
      case "importMcpServersJson":
        void this.mcpServerGates.importJson(action.json).catch(this.logCatch("import MCP servers"));
        break;
      case "updateMcpServerJson":
        void this.mcpServers.updateFromJson(action.serverId, action.json);
        break;
      case "cancelMcpServerConnect":
        void this.mcpServerGates.cancel(action.key).catch(this.logCatch(`cancel ${action.key}`));
        break;
      case "setMcpServerActive":
        // Switched on, it is probed at once: the user just acted on it.
        void this.mcpServers
          .setActive(action.serverId, action.active)
          .then(() => (action.active ? this.mcpServerGates.probe(action.serverId) : undefined))
          .catch(this.logCatch(`switch ${action.serverId}`));
        break;
      case "removeMcpServer":
        void this.mcpServerGates.remove(action.serverId).catch(this.logCatch(`remove ${action.serverId}`));
        break;
      case "setMcpServerRouting":
        void this.mcpServers.setRouting(action.serverId, action.routing);
        break;
      case "setMcpServerTransport":
        void this.mcpServers.setTransport(action.serverId, action.transport);
        break;
      case "probeMcpServer":
        void this.mcpServerGates.probe(action.serverId).catch(this.logCatch(`probe ${action.serverId}`));
        break;
      case "copyMcpServerJson":
        void this.copyMcpServerJson(action.serverId);
        break;
      case "openProposedDiff":
        void this.openProposedDiff(action.blockId).catch(this.logCatch(`openProposedDiff ${action.blockId}`));
        break;
      case "openToolCallDiff":
        void this.openToolCallDiff(action.sessionId, action.toolCallId, action.path).catch(
          this.logCatch(`openToolCallDiff ${action.path}`),
        );
        break;
      case "openDiagram":
        this.openDiagram(action.svg);
        break;
      case "reportWebviewError":
        // the webviews' own runtime errors — surfaced here so the Output
        // channel is the durable record behind the in-view errors chip
        this.log.error(`webview ${action.view}: ${action.message}`);
        break;
      case "openFile":
        // files panel rows and tool-call locations — absolute paths
        void this.openFileAt(action.path, action.line).catch(this.logCatch(`openFile ${action.path}`));
        break;
      case "addOrUpdateAgentConfig":
        void this.agents.save(action.config);
        break;
      case "removeAgentConfig":
        void this.gates.remove(action.agentId).catch(this.logCatch(`remove ${action.agentId}`));
        break;
      case "reorderAgentConfigs":
        void this.agents.reorder(action.ids).catch(this.logCatch("reorderAgentConfigs"));
        break;
      case "reorderMcpServers":
        void this.mcpServers.reorder(action.ids);
        break;
      case "addContextRoot":
        void this.addContextRoot(action.sessionId);
        break;
      case "saveRoot":
        void this.saveRoot(action.scope, action.path).catch(this.logCatch("saveRoot"));
        break;
      case "pickSavedRoot":
        void this.pickSavedRoot(action.scope, action.replacing).catch(this.logCatch("pickSavedRoot"));
        break;
      case "unsaveRoot":
        void this.savedRootsIn(action.scope)
          .remove(action.path)
          .then(() => this.publishSavedRoots(), this.logCatch("unsaveRoot"));
        break;
      case "removeContextRoot":
        void this.sessionGates
          .removeRoot(action.sessionId, action.path)
          .catch(this.logCatch(`removeRoot ${action.sessionId}`));
        break;
      case "addImageContext":
        void this.sessions
          .addContext(action.sessionId, {
            id: chipId(),
            kind: "image",
            label: action.label,
            content: action.base64,
            mimeType: action.mimeType,
          })
          .catch(this.logCatch(`add context ${action.sessionId}`));
        break;
      case "addDroppedFileContext":
        void this.addDroppedFileContext(action).catch(
          this.logCatch(`addDroppedFileContext ${action.name}`),
        );
        break;
      case "addFilePickerContext":
        void this.addFilePickerContext(action.sessionId);
        break;
      case "queryWorkspaceFiles":
        void this.queryWorkspaceFiles(action.query).catch(
          this.logCatch(`queryWorkspaceFiles "${action.query}"`),
        );
        break;
    }
  }

  /** The `@` mention picker's workspace tier (the
   * webview asks, never reads the filesystem). One findFiles sweep per
   * query, ranked host-side — basename prefix, then basename substring,
   * then path substring — and cut to a menu-sized answer. Directories come
   * from the same sweep (every matched file's ancestors up to its workspace
   * folder) — no second walk. `files.exclude` applies through findFiles
   * itself; node_modules is excluded explicitly since only `search.exclude`
   * covers it by default. */
  private async queryWorkspaceFiles(query: string): Promise<void> {
    const uris = await vscode.workspace.findFiles("**/*", "**/node_modules/**", 2000);
    const q = query.toLowerCase();
    const rankOf = (path: string): number => {
      const name = basename(path).toLowerCase();
      return name.startsWith(q) ? 0 : name.includes(q) ? 1 : path.toLowerCase().includes(q) ? 2 : 3;
    };
    const rank = (paths: Iterable<string>) =>
      [...paths]
        .map((path) => ({ path, rank: rankOf(path) }))
        .filter((e) => e.rank < 3)
        .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length);
    const dirSet = new Set<string>();
    for (const uri of uris) {
      const stop = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
      let dir = uri.fsPath;
      for (;;) {
        const cut = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
        const parent = cut > 0 ? dir.slice(0, cut) : "";
        if (parent === "" || parent === stop || parent === dir) break;
        dirSet.add(parent);
        dir = parent;
      }
    }
    this.agentView.emit({
      kind: "workspaceFilesListed",
      query,
      files: rank(uris.map((u) => u.fsPath)).slice(0, 20).map((e) => e.path),
      dirs: rank(dirSet).slice(0, 8).map((e) => e.path),
    });
  }

  /** "Add workspace folders as session context roots" —
   * a native folder picker, since only the extension host can browse the
   * real filesystem; the result is just another context-root path,
   * patchbay never indexes what's inside it. */
  private async addContextRoot(sessionId: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Add as context root",
    });
    const uri = picked?.[0];
    if (uri === undefined) return;
    await this.sessionGates.addRoot(sessionId, uri.fsPath);
  }

  /** The saved roots as both channels show them: this workspace's list
   * exists only while a folder is open — an empty window has no workspace
   * to save to. */
  private savedRootsView(): SavedRootsView {
    const workspaceOpen = (vscode.workspace.workspaceFolders ?? []).length > 0;
    const workspace = workspaceOpen ? this.workspaceSavedRoots.list() : null;
    const machine = this.machineSavedRoots.list();
    return {
      workspace,
      machine,
      missing: [...new Set([...(workspace ?? []), ...machine])].filter((p) => !isFolder(p)),
    };
  }

  private savedRootsIn(scope: SavedRootScope): SavedRootsStore {
    return scope === "workspace" ? this.workspaceSavedRoots : this.machineSavedRoots;
  }

  /** The one writer of a saved root, from the chip or from Settings.
   * Saving shapes the sessions born from now on — never a live one. What
   * is stored is an absolute path to a folder that exists: a relative one
   * resolves against the workspace here, once, so every later session
   * reads the same folder; anything that isn't a folder is refused, said. */
  private async saveRoot(scope: SavedRootScope, path: string, replacing?: string): Promise<void> {
    if (scope === "workspace" && this.savedRootsView().workspace === null) return;
    const absolute = normalizeRootPath(isAbsolute(path) ? path : resolve(this.workspaceCwd, path));
    if (!isFolder(absolute)) {
      void vscode.window.showWarningMessage(`Not saved: ${absolute} is not a folder on this machine.`);
      return;
    }
    const store = this.savedRootsIn(scope);
    await (replacing === undefined ? store.add(absolute) : store.replace(replacing, absolute));
    this.publishSavedRoots();
  }

  /** Settings' add, or its edit of one entry: the picker opens where that
   * entry points while the folder still exists — a gone one opens at the
   * picker's default, the user is finding its new home. */
  private async pickSavedRoot(scope: SavedRootScope, replacing?: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: replacing === undefined ? "Save as root" : "Use this folder",
      ...(replacing !== undefined && isFolder(replacing) ? { defaultUri: vscode.Uri.file(replacing) } : {}),
    });
    const uri = picked?.[0];
    if (uri === undefined) return;
    await this.saveRoot(scope, uri.fsPath, replacing);
  }

  private publishSavedRoots(): void {
    const event = { kind: "savedRootsChanged", savedRoots: this.savedRootsView() } as const;
    this.settings.emit(event);
    this.agentView.emit(event);
  }

  /** Composer drop of an external non-image file: the webview holds
   * bytes with no host path — browsers hide dropped files' paths, and in a
   * remote setup the client-side path would be meaningless here anyway.
   * Staged to a temp file once, at add time; the chip rides the prompt as a
   * resource_link to it (the sessions store's attachment arm). The ingress
   * processor already validated and size-capped the bytes webview-side. */
  private async addDroppedFileContext(action: {
    sessionId: string;
    name: string;
    mimeType: string;
    base64: string;
  }): Promise<void> {
    // Same stash as image parts (attachments.ts) — one directory, one
    // webview resource root.
    await mkdir(ATTACHMENTS_DIR, { recursive: true });
    const dir = ATTACHMENTS_DIR;
    // The original name stays visible in the staged filename (the agent sees
    // it in the resource_link) — id-prefixed so two drops of "notes.txt"
    // never overwrite each other.
    const safe = action.name.replace(/[^\w.-]+/g, "_");
    const path = join(dir, `${chipId()}-${safe}`);
    await writeFile(path, Buffer.from(action.base64, "base64"));
    await this.sessions.addContext(action.sessionId, {
      id: chipId(),
      kind: "attachment",
      label: `File: ${action.name}`,
      path,
      // "" = the platform didn't know the type; absent stays absent.
      ...(action.mimeType !== "" ? { mimeType: action.mimeType } : {}),
    });
  }

  /** "Attach file" picker — the host-side byte producer: the file already
   * has a host path, so no bytes cross the webview. Images in the wire set
   * ride as image chips (bytes read here); everything else — including
   * images too big or too exotic for the wire — becomes an attachment chip
   * at its real path, whose resource_link the agent reads itself. That
   * fallback is strictly honest, so nothing picked is ever refused. A
   * picked file is at rest on disk, hence a link, not a text snapshot: the
   * inline `file` chip is for the editor buffer, which may be dirty. */
  private async addFilePickerContext(sessionId: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: false,
      canSelectFiles: true,
      canSelectMany: false,
      openLabel: "Attach to context",
    });
    const uri = picked?.[0];
    if (uri === undefined) return;
    const name = basename(uri.fsPath);
    const { size } = await vscode.workspace.fs.stat(uri);
    const form = pickedFileForm(name, size, this.preferences.get().attachmentMaxMB * 1024 * 1024);
    if (form.kind === "image") {
      const bytes = await vscode.workspace.fs.readFile(uri);
      await this.sessions.addContext(sessionId, {
        id: chipId(),
        kind: "image",
        label: `Image: ${name}`,
        content: Buffer.from(bytes).toString("base64"),
        mimeType: form.mimeType,
      });
    } else {
      await this.sessions.addContext(sessionId, {
        id: chipId(),
        kind: "attachment",
        label: `File: ${name}`,
        path: uri.fsPath,
      });
    }
  }

  /** Copy config: the server as an `mcpServers` document (the shape Import
   * reads back) goes to the clipboard, carrying what its owner typed — env
   * values, a header key — and never an OAuth token. Copy and paste are
   * the owner's explicit acts; configs never ride a repo, so nothing can
   * follow a user between workspaces on its own. */
  private async copyMcpServerJson(serverId: string): Promise<void> {
    const config = this.mcpServerConfigs.get(serverId);
    const json = await this.mcpServers.exportJson(serverId);
    if (config === undefined || json === undefined) return;
    await vscode.env.clipboard.writeText(json);
    void vscode.window.showInformationMessage(
      `Copied "${config.name}" as an mcpServers entry.`,
    );
  }

  private publishRules(): void {
    const rules = this.permissionRules.get();
    this.settings.emit({
      kind: "permissionRulesChanged",
      commandRules: rules.commandRules,
      machineCommandRules: this.machinePermissionRules.get().commandRules,
      fileWriteScope: rules.fileWriteScope,
    });
  }

  /** Add — and every connect a door names by its source (Settings Connect,
   * the palette, startup): the store saves what is new, then the connect
   * and, when asked, the free check pass the gates. */
  private async connectFrom(source: ConnectAgentSource, verifyAfterConnect = false): Promise<void> {
    const agentId = await this.agents.saveFrom(source);
    if (agentId === undefined) return;
    try {
      await this.gates.connect(agentId);
      if (verifyAfterConnect) void this.gates.verify(agentId).catch(this.logCatch(`verify ${agentId}`));
    } catch {
      // the pool already put how the launch ended — its crash and reason,
      // or a stop — on the row
    }
  }

  /** One intent, one click: connect if needed, then create and
   * activate the session — all inside the chat pane. Uses the saved config
   * path (env injected from SecretStorage at spawn), never a bare
   * pool.connect. Failure lands inline with the
   * specific reason and a Retry — never a silent bounce to the empty
   * state. */
  private async startChat(agentId: string): Promise<void> {
    void this.acpRegistry.refresh("new-session");
    const agentName = this.agents.name(agentId);
    if (agentName === undefined) return; // unknown agent — nothing to start
    // A still-new (never-prompted) session for this agent already IS the
    // new session — focus it instead of minting a sibling blank shell.
    // One whose connection died is still that session: it is minted again
    // from its row (the ladder's zero-turn rung) on the same path a fresh
    // create takes, connect-on-demand included.
    const draft = this.sessions.findNeverPrompted(agentId);
    if (draft !== undefined && this.sessions.isLive(draft)) {
      this.sessionGates.activate(draft);
      return;
    }
    this.agentView.emit({ kind: "chatConnectStarted", agentId });
    try {
      // A running agent serves the chat now — it never waits behind the
      // agent's other work (a terminal login can take minutes). One that
      // isn't takes the connect's turn, joining one already under way.
      if (this.agents.row(agentId)?.status !== "running") await this.gates.connect(agentId);
      if (!this.paneShows(agentId)) return;
      // sessionCreated itself clears the connect pane (reducer) — success
      // needs no extra event; the re-mint emits the same event.
      if (draft !== undefined) await this.sessionGates.revive(draft);
      else await this.sessions.createSession(agentId, agentName, this.workspaceCwd);
    } catch (err) {
      this.logCatch(`startChat ${agentId}`)(err);
      this.chatPaneFailed(agentId, err);
    }
  }

  /** The connect half of the session gates' open ceremony (their
   * `connect` ask): opening a session whose configured agent is off spawns
   * it, through the same in-pane chatConnect states startChat uses — but
   * no session is minted: on success the status-running hook re-syncs and
   * attaches whatever is on view, and `forSessionId` makes
   * the failure pane's Retry re-open this session instead of starting a
   * new chat. Unconfigured agents stay untouched — the row is a readable
   * record, nothing more to offer. */
  private async connectForSession(sessionId: string): Promise<void> {
    const agentId = this.sessions.agentFor(sessionId);
    if (agentId === undefined) return;
    const row = this.agents.row(agentId);
    if (row === undefined || row.status === "running") return;
    this.agentView.emit({ kind: "chatConnectStarted", agentId, forSessionId: sessionId });
    try {
      await this.gates.connect(agentId);
      if (this.paneShows(agentId, sessionId)) this.agentView.emit({ kind: "chatConnectResolved" });
    } catch (err) {
      this.logCatch(`connect for session ${sessionId} (${agentId})`)(err);
      this.chatPaneFailed(agentId, err, sessionId);
    }
  }

  /** A chat that didn't land on its agent: the pane says why, with a Retry
   * — unless the user's own Stop or Remove ended it, and the pane just
   * goes. A pane taken by a later request is not this one's to touch. */
  private chatPaneFailed(agentId: string, err: unknown, forSessionId?: string): void {
    if (!this.paneShows(agentId, forSessionId)) return;
    if (err instanceof Cancelled) {
      this.agentView.emit({ kind: "chatConnectResolved" });
      return;
    }
    const raw = err instanceof Error ? err.message : String(err);
    this.agentView.emit({
      kind: "chatConnectFailed",
      agentId,
      reason: this.connectFailureReason(agentId, err, raw),
      forSessionId,
    });
  }

  /** The latest connect on demand owns the chat pane: an earlier one whose
   * pane was taken stands down when its connect settles — its agent still
   * comes up, but its chat neither lands nor fails over the later one. A
   * repeat of the same request shows the same pane and shares its work —
   * the connect it joined, the new session it asked for. */
  private paneShows(agentId: string, forSessionId?: string): boolean {
    return chatPaneShows(this.agentView.current.chatConnect, agentId, forSessionId);
  }

  /** Prefer the pool's own crash detail (spawn failed / initialize failed)
   * over a raw wire error; map auth_required to what actually unblocks it —
   * the agent's own instruction when it gave one beyond the bare
   * "authentication required" (an agent with no login methods, like Auggie,
   * names the exact CLI command there), the Settings Agents pointer
   * otherwise. */
  private connectFailureReason(agentId: string, err: unknown, raw: string): string {
    const auth = authRequiredReasonOf(err);
    if (auth !== null) {
      return auth.reason !== null && !/^authentication required\.?$/i.test(auth.reason.trim())
        ? auth.reason
        : "needs login first — use Log in on this agent in Settings › Agents";
    }
    return this.agents.row(agentId)?.detail ?? raw;
  }

  /** Formats a swallowed action failure for the Output channel — these
   * actions have no reply channel by design (state itself is the only
   * signal back to the UI), but silently dropping the error entirely left
   * nothing to debug from. */
  private logCatch(context: string): (err: unknown) => void {
    return (err) => {
      // Ended by the user's own hand — an agent's Stop or Remove, a
      // session's Stop, Reload or Close — no failure.
      if (err instanceof Cancelled) this.log.info(`${context}: ${err.message}`);
      else this.log.error(`${context}: ${err instanceof Error ? err.message : String(err)}`);
    };
  }

  dispose(): void {
    this.sessionGates.dispose();
    for (const d of this.editorSubscriptions) d.dispose();
    this.editorStateHost.stop();
    void this.sessionGates.endAll();
    void this.mcpServerGates.endAll();
    void this.gates.stopAll();
    this.agentView.flushNow();
    this.settings.flushNow();
    this.statusBarItem.dispose();
    this.wireLog.dispose();
    this.wireChannel?.dispose();
    this.wireStatusItem?.dispose();
    if (this.wireStatusTimer !== null) clearInterval(this.wireStatusTimer);
  }
}

/** A root is a folder on disk right now — the one reality read behind
 * every lifecycle request's roots, the MCP servers' list, the saved lists'
 * marks, and a save. */
function isFolder(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}
