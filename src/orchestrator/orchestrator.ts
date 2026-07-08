// Orchestrator: the Node process in the extension host — single source of
// truth for sessions, capability tables, permission rules, secrets,
// configuration. Webviews only ever see its snapshots and patches.
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import {
  coalesceAgentViewEvent,
  coalesceSettingsEvent,
  computeFidelity,
  initialAgentViewState,
  initialSettingsState,
  reduceAgentView,
  reduceSettings,
  type Action,
  type AgentConfigView,
  type AgentKnobsView,
  type AgentViewEvent,
  type AgentViewState,
  type CapabilityRowId,
  type ConnectAgentSource,
  type PermissionOptionView,
  type RosterEntry,
  type SessionConfigOptionView,
  type SettingsEvent,
  type SettingsState,
} from "../shared/protocol";
import { resolveAgentAssets, type FsLike } from "./asset-locations";
import { applyFileWrite, PermissionBroker } from "./broker";
import { eraseAllData } from "./erase-all";
import { CapabilityTracker } from "./capability-tracker";
import { ChannelHost } from "./channel";
import { parseCommandLine } from "./command-line";
import { EditorStateHost } from "./editor-state-host";
import { IntegrationsManager } from "./integrations";
import { OAuthCallbackRegistry } from "./oauth-callback";
import { AgentPool, type LaunchSpec } from "./pool";
import { commandOf, killTree, reapOrphans } from "./process-tree";
import { SessionManager, toConfigOptionView, toModesView } from "./session-manager";
import { type AcpRegistryData, AcpRegistryStore } from "./stores/acp-registry";
import { type AgentConfig, AgentConfigStore } from "./stores/agent-configs";
import { SecretEnvStore } from "./stores/secret-env";
import { installBinary, isBinaryInstalled } from "./stores/binary-installer";
import { DecisionAuditStore } from "./stores/decision-audit";
import { IntegrationConfigStore } from "./stores/integration-configs";
import { IntegrationTokenStore } from "./stores/integration-tokens";
import { LastKnownViewStore } from "./stores/last-known-view";
import { MachineRulesStore, PermissionRulesStore } from "./stores/permission-rules";
import { loadRegistry } from "./stores/registry";
import { loadOverlay, mergeRoster, type RosterAgent } from "./stores/roster";
import { SessionIndexStore } from "./stores/session-index";
import { SpawnRegistryStore } from "./stores/spawn-registry";
import { UsedCapabilityStore } from "./stores/used-capabilities";
import { statusBarContent } from "./status-bar";
import { type TerminalHandle } from "./terminal-runner";

function optionViewsFromAcp(
  options: readonly { optionId: string; name: string; kind: string }[],
): PermissionOptionView[] {
  return options.map((o) => ({
    optionId: o.optionId,
    label: o.name,
    kind: o.kind as PermissionOptionView["kind"],
  }));
}

function rosterEntryView(agent: RosterAgent): RosterEntry {
  const launch = agent.launch;
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    assetsMapped: agent.assets !== null,
    knownBypassBridge: agent.knownBypassBridge,
    unavailableReason: launch.kind === "unavailable" ? launch.reason : null,
    registryId: launch.kind === "local" ? null : launch.registryId,
    registryVersion: launch.kind === "local" ? null : launch.version,
  };
}

export class Orchestrator {
  readonly agentView: ChannelHost<AgentViewState, AgentViewEvent>;
  readonly settings: ChannelHost<SettingsState, SettingsEvent>;

  readonly sessionIndex: SessionIndexStore;
  readonly decisionAudit: DecisionAuditStore;
  readonly lastKnownView: LastKnownViewStore;
  readonly agentConfigs: AgentConfigStore;
  readonly integrationConfigs: IntegrationConfigStore;
  readonly usedCapabilities: UsedCapabilityStore;
  readonly spawnRegistry: SpawnRegistryStore;
  readonly agentEnv: SecretEnvStore;
  readonly integrationEnv: SecretEnvStore;
  readonly acpRegistry: AcpRegistryStore;
  readonly permissionRules: PermissionRulesStore;
  readonly machinePermissionRules: MachineRulesStore;
  /** Registry × overlay merge (roster.ts) — recomputed whenever the ACP
   * registry refreshes; every roster-shaped lookup elsewhere reads this. */
  roster: RosterAgent[];
  readonly pool: AgentPool;
  readonly sessionManager: SessionManager;
  readonly capabilityTracker: CapabilityTracker;
  readonly broker: PermissionBroker;
  readonly editorStateHost: EditorStateHost;
  readonly integrationTokens: IntegrationTokenStore;
  readonly integrations: IntegrationsManager;
  /** Pending OAuth callbacks — extension.ts's UriHandler feeds this. */
  readonly oauthCallbacks = new OAuthCallbackRegistry();

  private readonly workspaceRoot: string | null;
  private readonly binaryCacheDir: string;
  private readonly agentNames = new Map<string, string>();
  /** Agents (global — never repo-committed), resolved to a spawnable
   * LaunchSpec; visible-in-this-workspace subset of agentConfigs.list(). */
  private readonly configuredAgentSpecs = new Map<string, LaunchSpec>();
  /** A registry `binary` distribution awaiting the one-time download
   * confirmation — at most one per agentId in flight. */
  private readonly pendingBinaryConfirms = new Map<
    string,
    { entry: RosterAgent; verifyAfterConnect: boolean }
  >();
  private readonly terminals = new Map<string, TerminalHandle>();
  private terminalCounter = 0;
  private readonly mcpServerScriptPath: string;
  private readonly integrationBridgeScriptPath: string;
  private readonly contextTokenToSession = new Map<string, string>();
  private readonly pendingElicitations = new Map<
    string,
    { sessionId: string; resolve(values: Record<string, unknown> | null): void }
  >();
  private elicitationCounter = 0;
  private isolationCounter = 0;
  private readonly editorSubscriptions: vscode.Disposable[] = [];
  /** Orchestrator-side merge of knob offerings per agent (modes and config
   * options arrive as separate events) — the settings channel gets the
   * merged record on every observation. */
  private readonly observedKnobs = new Map<string, { modes: AgentKnobsView["modes"]; options: AgentKnobsView["options"] }>();
  /** Set by the webview host as the Agent View mounts/unmounts (wired in
   * extension.ts to `AgentViewProvider`'s real `onDidChangeVisibility`
   * signal, P6); defaults to "visible" so native notifications don't fire
   * spuriously before that's connected. */
  isAgentViewVisible: () => boolean = () => true;
  private statusBarItem!: vscode.StatusBarItem;

  constructor(
    context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    this.workspaceRoot = workspaceRoot;
    this.mcpServerScriptPath = vscode.Uri.joinPath(context.extensionUri, "out", "mcp-server.js").fsPath;
    this.integrationBridgeScriptPath = vscode.Uri.joinPath(
      context.extensionUri,
      "out",
      "integration-bridge.js",
    ).fsPath;
    this.binaryCacheDir = join(context.globalStorageUri.fsPath, "bin-cache");

    this.sessionIndex = new SessionIndexStore(context.workspaceState);
    this.permissionRules = new PermissionRulesStore(context.workspaceState);
    this.machinePermissionRules = new MachineRulesStore(context.globalState);
    this.decisionAudit = new DecisionAuditStore(context.storageUri?.fsPath ?? null);
    this.lastKnownView = new LastKnownViewStore(context.storageUri?.fsPath ?? null);
    // Agents and integrations are developer-env, not code-env: global to
    // this machine, never a repo-committed file. Deliberately global-only —
    // workspace binding may return later as an opt-in (see
    // stores/integration-configs.ts's header for the incident that shaped
    // this).
    this.agentConfigs = new AgentConfigStore(context.globalState);
    this.integrationConfigs = new IntegrationConfigStore(context.globalState);
    this.usedCapabilities = new UsedCapabilityStore(context.globalState);
    this.spawnRegistry = new SpawnRegistryStore(context.globalState);
    this.agentEnv = new SecretEnvStore(context.secrets, "acpPatchbay.agent");
    this.integrationEnv = new SecretEnvStore(context.secrets, "acpPatchbay.integration");
    this.integrationTokens = new IntegrationTokenStore(context.secrets);
    // OAuth browser/redirect step (docs/reference-mcp-oauth.md, pitfall §1):
    // the redirect target is this extension's own vscode:// URI, passed
    // through asExternalUri so VS Code resolves it correctly under SSH
    // remote / WSL / Codespaces — never a hand-rolled 127.0.0.1 server.
    // extension.ts's registerUriHandler feeds callbacks into oauthCallbacks.
    const extensionId = context.extension.id; // "solutionsunity.acp-patchbay"
    this.integrations = new IntegrationsManager(
      loadRegistry(),
      this.integrationConfigs,
      this.integrationTokens,
      this.integrationEnv,
      { emit: (...events) => this.settings.emit(...events) },
      {
        redirectUri: async () => {
          const callback = await vscode.env.asExternalUri(
            vscode.Uri.parse(`${vscode.env.uriScheme}://${extensionId}/oauth-callback`),
          );
          return callback.toString(true);
        },
        authorize: async (authorizationUrl, state) => {
          const pending = this.oauthCallbacks.wait(state);
          await vscode.env.openExternal(vscode.Uri.parse(authorizationUrl));
          return pending;
        },
      },
      log,
    );

    // Roster = the official ACP registry (fetched below) merged with our own
    // adapter-observed overlay (roster.ts). Starts registry-empty — every
    // registry-backed entry shows "registry not loaded yet" until the first
    // fetch (cache or network) resolves and republishes via rosterChanged.
    this.roster = mergeRoster(loadOverlay(), []);
    const rosterEntries = this.roster.map(rosterEntryView);

    const onAction = (action: Action) => this.handleAction(action);
    this.agentView = new ChannelHost(
      { ...initialAgentViewState, roster: rosterEntries },
      reduceAgentView,
      coalesceAgentViewEvent,
      onAction,
    );
    const rules = this.permissionRules.get();
    this.settings = new ChannelHost(
      {
        ...initialSettingsState,
        roster: rosterEntries,
        commandRules: rules.commandRules,
        machineCommandRules: this.machinePermissionRules.get().commandRules,
        fileWriteScope: rules.fileWriteScope,
        integrationRegistry: this.integrations.registryViews(),
      },
      reduceSettings,
      coalesceSettingsEvent,
      onAction,
    );

    this.acpRegistry = new AcpRegistryStore(
      join(context.globalStorageUri.fsPath, "registry"),
      (data) => this.applyRegistryData(data),
    );

    // Pool hooks close over `this` and only fire once the pool is actually
    // used (after the constructor returns), so referencing sessionManager /
    // capabilityTracker / broker here — before they're assigned below — is
    // safe; this is the same lazy-closure pattern all three use themselves.
    this.pool = new AgentPool({
      onStatusChanged: (agentId, status, detail, stderr) => {
        const event = { kind: "agentStatusChanged", agentId, status, detail, stderr } as const;
        this.agentView.emit(event);
        this.settings.emit(event);
        const suffix = detail !== undefined ? ` — ${detail}` : "";
        if (status === "crashed") this.log.error(`${agentId}: crashed${suffix}`);
        else this.log.info(`${agentId}: ${status}${suffix}`);
        // A dead or reconnecting connection invalidates every sessionId that
        // rode it — they must reopen (possibly via session/load) before reuse.
        if (status === "crashed" || status === "reconnecting") {
          this.sessionManager.invalidateAgent(agentId);
        }
        // Offerings are connection state (architecture.md § Session model) —
        // gone with the connection; the settings reducer drops its copy off
        // the same event, and the next connect's offering read repopulates.
        if (status !== "running") this.observedKnobs.delete(agentId);
      },
      onIsolatedStatusChanged: (poolKey, _agentId, status) => {
        // Not surfaced in the Agents list (P8: isolated instances are an
        // implementation detail) — only the sessions riding this specific
        // poolKey need to know their process is gone.
        if (status === "crashed" || status === "reconnecting") {
          this.sessionManager.invalidatePoolKey(poolKey);
        }
      },
      onDeclaredCaptured: (agentId, declared, raw) => {
        const version = raw.agentInfo?.version ?? null;
        this.capabilityTracker.onDeclared(agentId, declared, version);
        if (version !== null) void this.recordSeenVersion(agentId, version);
      },
      onSessionUpdate: (agentId, notification) => {
        // A throwaway probe session's late config_option_update still counts
        // as part of the connect-time offering read — some agents deliver
        // the option surface only after session/new returns.
        const probeAgent = this.capabilityTracker.agentForProbeSession(notification.sessionId);
        if (probeAgent !== undefined) {
          if (notification.update.sessionUpdate === "config_option_update") {
            this.noteOfferings(probeAgent, null, notification.update.configOptions.map(toConfigOptionView));
          }
          return;
        }
        this.sessionManager.handleUpdate(agentId, notification);
      },
      onCapabilityUsed: (agentId, row) => this.capabilityTracker.markUsed(agentId, row),
      // Spawn registry (P15c): records live in globalState so an abnormal
      // end (crash, OS kill) leaves exactly what the next activate reaps.
      onProcessSpawned: (pid, command) => void this.spawnRegistry.add(pid, command, "agent"),
      onProcessEnded: (pid) => void this.spawnRegistry.removePid(pid),
      onPermissionRequest: async (_agentId, params) => {
        const subject =
          params.toolCall.kind === "edit" ? (params.toolCall.locations?.[0]?.path ?? null) : null;
        const options = optionViewsFromAcp(params.options);
        const result = await this.broker.resolveAgentPermissionRequest(
          params.sessionId,
          params.toolCall.title ?? "Permission request",
          params.toolCall.kind ?? "other",
          subject,
          options,
        );
        // A rejected request marks its tool-call block denied — "blocked by
        // permission" renders distinct from "failed" (ui-rendering-strategy).
        // Only this path can correlate: the request carries the toolCallId;
        // patchbay's own fs/terminal gates have no id and already show their
        // own permission/diff cards inline.
        const chosen = "cancelled" in result ? undefined : options.find((o) => o.optionId === result.optionId);
        if (chosen !== undefined && chosen.kind.startsWith("reject")) {
          this.agentView.emit({
            kind: "toolCallDenied",
            sessionId: params.sessionId,
            blockId: params.toolCall.toolCallId,
          });
        }
        return "cancelled" in result
          ? { outcome: { outcome: "cancelled" } }
          : { outcome: { outcome: "selected", optionId: result.optionId } };
      },
      onReadTextFile: async (agentId, params) => {
        const content = await this.readTextFileLive(params.path);
        this.markFirstUse(agentId, "fs.readTextFile");
        return { content };
      },
      onWriteTextFile: async (agentId, params) => {
        const { accepted } = await this.broker.gateFileWrite(params.sessionId, params.path, params.content);
        if (accepted) await applyFileWrite(params.path, params.content);
        // A rejected write still counts as used: "brokered" means the agent
        // routes writes through patchbay's gate, and a rejection is the gate
        // working.
        this.markFirstUse(agentId, "fs.writeTextFile");
        return {};
      },
      onCreateTerminal: async (agentId, params) => {
        const command = [params.command, ...(params.args ?? [])].join(" ");
        const { accepted } = await this.broker.gateCommand(params.sessionId, command);
        if (!accepted) throw new Error("command rejected by permission rules");

        const handle = this.broker.runner.create({
          command: params.command,
          args: params.args ?? [],
          env: Object.fromEntries((params.env ?? []).map((e) => [e.name, e.value])),
          cwd: params.cwd ?? null,
          outputByteLimit: params.outputByteLimit ?? null,
        });
        this.markFirstUse(agentId, "terminal");
        const terminalId = `term-${++this.terminalCounter}`;
        this.terminals.set(terminalId, handle);
        if (handle.pid !== null) {
          const pid = handle.pid;
          void commandOf(pid).then((cmd) => {
            // Already exited (fast command) → the record would only be stale.
            if (cmd !== "" && handle.exitStatus() === null) {
              void this.spawnRegistry.add(pid, cmd, "terminal");
            }
          });
          handle.onExit(() => void this.spawnRegistry.removePid(pid));
        }
        const blockId = `term-block-${terminalId}`;
        this.agentView.emit({ kind: "terminalStarted", sessionId: params.sessionId, blockId, command });
        handle.onData((chunk) =>
          this.agentView.emit({
            kind: "terminalOutputAppended",
            sessionId: params.sessionId,
            blockId,
            chunk,
          }),
        );
        handle.onExit((status) =>
          this.agentView.emit({
            kind: "terminalExited",
            sessionId: params.sessionId,
            blockId,
            exitCode: status.exitCode,
          }),
        );
        return { terminalId };
      },
      onTerminalOutput: async (_agentId, params) => {
        const handle = this.terminals.get(params.terminalId);
        if (!handle) throw new Error(`unknown terminal ${params.terminalId}`);
        const { output, truncated } = handle.currentOutput();
        const exit = handle.exitStatus();
        return {
          output,
          truncated,
          exitStatus: exit ? { exitCode: exit.exitCode, signal: exit.signal } : null,
        };
      },
      onWaitForTerminalExit: async (_agentId, params) => {
        const handle = this.terminals.get(params.terminalId);
        if (!handle) throw new Error(`unknown terminal ${params.terminalId}`);
        return handle.waitForExit();
      },
      onKillTerminal: async (_agentId, params) => {
        this.terminals.get(params.terminalId)?.kill();
        return {};
      },
      onReleaseTerminal: async (_agentId, params) => {
        // ACP release semantics: a still-running command is killed — before
        // this, releasing dropped the handle and left the process running
        // with nothing pointing at it (P15c).
        const handle = this.terminals.get(params.terminalId);
        if (handle !== undefined && handle.exitStatus() === null) handle.kill();
        this.terminals.delete(params.terminalId);
        return {};
      },
    }, log);
    this.editorStateHost = new EditorStateHost(String(process.pid), {
      requestUserInput: (contextToken, params) => this.requestUserInput(contextToken, params),
      getIntegrationToken: (integrationId) => this.integrations.getToken(integrationId),
    });
    this.editorStateHost.start();

    // Live editor context for the composer (ui.md § Composer: the selection
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
    );

    this.sessionManager = new SessionManager(
      this.pool,
      this.sessionIndex,
      {
        emit: (...events) => {
          this.agentView.emit(...events);
          this.persistLastKnownViewIfNeeded(events);
          this.relaySettingsDerived(events);
        },
        mapContextToken: (token, sessionId) => this.contextTokenToSession.set(token, sessionId),
        resolveProcessFor: (agentId) => this.resolveProcessFor(agentId),
        isForkUsed: (agentId) =>
          this.agentView.current.capabilities[agentId]?.["session.fork"]?.used ?? false,
        defaultsFor: (agentId) => this.pool.get(agentId)?.spec.defaults,
        lastKnownView: (sessionId) => this.lastKnownView.load(sessionId),
        contextRootsFor: (sessionId) => this.agentView.current.contextRoots[sessionId] ?? [],
      },
      () => this.workspaceRoot ?? process.cwd(),
      async (contextToken, agentId) => {
        // McpServerStdio is the untagged union member (architecture.md's
        // "uniform stdio presentation" — no discriminant needed since it's
        // the only variant every agent is guaranteed to accept).
        const editorServer = {
          name: "patchbay",
          command: process.execPath,
          args: [this.mcpServerScriptPath],
          env: [
            { name: "ACP_PATCHBAY_IPC", value: this.editorStateHost.socketPath },
            { name: "ACP_PATCHBAY_SESSION_ID", value: contextToken },
          ],
        };
        const matrix = this.agentView.current.capabilities[agentId];
        const roster = this.roster.find((a) => a.id === agentId);
        const isFullyBrokered =
          matrix !== undefined &&
          computeFidelity(matrix, roster?.knownBypassBridge ?? false) === "fully-brokered";
        const integrationServers = await this.integrations.mcpServersFor(
          agentId,
          isFullyBrokered,
          this.integrationBridgeScriptPath,
          this.editorStateHost.socketPath,
        );
        return [editorServer, ...integrationServers];
      },
      log,
    );
    this.capabilityTracker = new CapabilityTracker(
      this.pool,
      this.usedCapabilities,
      {
        emit: (...events) => {
          this.agentView.emit(...events);
          this.settings.emit(...events);
        },
        currentMatrix: (agentId) => this.agentView.current.capabilities[agentId],
        onOfferings: (agentId, modes, configOptions) =>
          this.noteOfferings(
            agentId,
            modes ? toModesView(modes).available : null,
            configOptions && configOptions.length > 0
              ? configOptions.map(toConfigOptionView)
              : null,
          ),
      },
      log,
    );
    this.broker = new PermissionBroker(
      this.permissionRules,
      this.decisionAudit,
      {
        emit: (...events) => this.agentView.emit(...events),
        onAuditWritten: () => void this.refreshAuditTail(),
        notifyPending: (requestId, title, detail, options) =>
          this.notifyIfHidden(requestId, title, detail, options),
      },
      () => this.workspaceRoot,
      undefined, // default NodeTerminalRunner
      this.machinePermissionRules,
    );

    void this.refreshAuditTail();
    this.loadAgentConfigs();
    void this.integrations.refresh();
    void this.acpRegistry.start().then((cached) => this.applyRegistryData(cached));
    this.publishSessionStats();

    // Native surfaces (P11): the status bar mirrors canonical state via
    // ChannelHost.onChange — no webview in the path (architecture.md § UI
    // layer: "direct orchestrator consumers: same state, no webview").
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = "acpPatchbay.agentView.focus";
    this.statusBarItem.show();
    this.agentView.onChange(() => this.refreshStatusBar());
    this.refreshStatusBar();

    // Orphan reaping strictly before the default agent spawns (P15c): the
    // registry must be settled before new pids start landing in it.
    void this.reapLeftoverProcesses().then(() => this.connectDefaultAgent());
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

  /** "Disconnect & erase all data" (plan.md P18): stop reality first —
   * every agent process (graceful ladder) and terminal tree — then the
   * erase sweep (erase-all.ts owns the ordering constraint), then both
   * channels catch up through ordinary events: agents and sessions leave
   * row by row, configs/integrations/rules/audit republish empty. Never
   * automatic; the Settings action is the only caller. */
  private async eraseEverything(): Promise<void> {
    this.log.info("erase all data: stopping every process");
    for (const handle of this.terminals.values()) {
      if (handle.pid !== null && handle.exitStatus() === null) killTree(handle.pid, "SIGKILL");
    }
    this.terminals.clear();
    await this.pool.disposeAll();
    this.sessionManager.reset();

    await eraseAllData({
      agentConfigs: this.agentConfigs,
      integrationConfigs: this.integrationConfigs,
      usedCapabilities: this.usedCapabilities,
      spawnRegistry: this.spawnRegistry,
      sessionIndex: this.sessionIndex,
      agentEnv: this.agentEnv,
      integrationEnv: this.integrationEnv,
      integrationTokens: this.integrationTokens,
      permissionRules: this.permissionRules,
      machineRules: this.machinePermissionRules,
      decisionAudit: this.decisionAudit,
      lastKnownView: this.lastKnownView,
    });

    this.configuredAgentSpecs.clear();
    this.agentNames.clear();
    this.observedKnobs.clear();

    for (const session of this.agentView.current.sessions) {
      this.agentView.emit({ kind: "sessionClosed", sessionId: session.id });
    }
    for (const agent of this.agentView.current.agents) {
      const removed = { kind: "agentRemoved", agentId: agent.id } as const;
      this.agentView.emit(removed);
      this.settings.emit(removed);
    }
    this.agentView.emit({ kind: "chatConnectResolved" });
    await this.refreshAgentConfigs();
    await this.integrations.refresh();
    this.publishRules();
    await this.refreshAuditTail();
    this.log.info("erase all data: complete — factory state");
  }

  /** deactivate's bounded best-effort (plan.md P15): terminal trees get a
   * straight SIGKILL (batch commands — no protocol to be graceful about),
   * agents get the pool ladder on its tight budget, and the whole sweep is
   * raced against the ~2s VS Code actually waits before killing the host.
   * Whatever this couldn't reach, the next activate's reap covers. */
  async shutdown(): Promise<void> {
    for (const handle of this.terminals.values()) {
      if (handle.pid !== null && handle.exitStatus() === null) killTree(handle.pid, "SIGKILL");
    }
    await Promise.race([
      this.pool.disposeAll(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
    ]);
  }

  /** "Default agent" (VS Code native settings, architecture.md § UI layer —
   * deliberately near-empty, flat scalars only): connects it once, only if
   * nothing is connected yet. The user's own configured choice, not patchbay
   * picking an agent for them (prd.md's routing scope decision is about
   * choosing among agents for a given task, not this). */
  private async connectDefaultAgent(): Promise<void> {
    const defaultAgentId = vscode.workspace.getConfiguration("acpPatchbay").get<string>("defaultAgent", "");
    if (defaultAgentId === "" || this.pool.list().length > 0) return;
    const entry = this.roster.find((a) => a.id === defaultAgentId);
    if (entry === undefined) return;
    await this.connectFromSource({ rosterId: defaultAgentId });
  }

  /** Active session · agent health · usage when reported (features.md § 3) —
   * click jumps to the Agent View, which already shows that same session. */
  private refreshStatusBar(): void {
    const { text, tooltip } = statusBarContent(this.agentView.current);
    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = tooltip;
  }

  /** Command palette (features.md § 3): "new session" — every configured
   * agent with its readiness inline, single agent skips the pick, and a
   * not-running choice connects on demand (P17: the same startChat path as
   * the view's "+"). */
  async newSessionCommand(): Promise<void> {
    const agents = this.agentView.current.agents;
    if (agents.length === 0) {
      void vscode.window.showInformationMessage("Add an agent first — Patchbay Settings § Agents.");
      await vscode.commands.executeCommand("acpPatchbay.openSettings");
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

  /** "Switch session." */
  async switchSessionCommand(): Promise<void> {
    const sessions = this.agentView.current.sessions;
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage("No sessions yet.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: s.title,
        description: this.agentNames.get(s.agentId) ?? s.agentId,
        sessionId: s.id,
      })),
      { placeHolder: "Switch to session…" },
    );
    if (picked === undefined) return;
    this.sessionManager.activate(picked.sessionId);
    await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
  }

  /** "Connect agent" — the palette shortcut into the one add path (Settings
   * § Agents' persist-connect-verify flow, P17): roster or custom command,
   * same `connectFromSource` either way. */
  async connectAgentCommand(): Promise<void> {
    const items = [
      ...this.roster
        .filter((a) => a.launch.kind !== "unavailable")
        .map((a) => ({ label: a.name, rosterId: a.id as string | undefined })),
      { label: "Custom command…", rosterId: undefined as string | undefined },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Connect agent…" });
    if (picked === undefined) return;
    if (picked.rosterId === undefined) {
      const command = await vscode.window.showInputBox({ placeHolder: "command that speaks ACP…" });
      if (command === undefined || command.trim() === "") return;
      await this.connectFromSource({ command });
    } else {
      await this.connectFromSource({ rosterId: picked.rosterId });
    }
    await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
  }

  /** Editor right-click (features.md § 3: "add to context / ask the agent
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

  /** The local MCP server's `request_user_input` tool (elicitation fallback
   * — architecture.md's adapter table; native ACP elicitation is still
   * unstable in the SDK, so this is the only path in v1, see plan.md P7).
   * `contextToken` is what the MCP server subprocess was spawned with —
   * translated back to the real sessionId so the form lands in the right
   * transcript. */
  private requestUserInput(
    contextToken: string,
    params: { message: string; properties: Array<{ name: string; type: string; title?: string; description?: string; required?: boolean }> },
  ): Promise<Record<string, unknown> | null> {
    const sessionId = this.contextTokenToSession.get(contextToken) ?? contextToken;
    const blockId = `elicit-${++this.elicitationCounter}`;
    this.agentView.emit({
      kind: "elicitationRequested",
      sessionId,
      blockId,
      message: params.message,
      fields: params.properties.map((p) => ({
        name: p.name,
        type: p.type as "string" | "number" | "integer" | "boolean",
        title: p.title,
        description: p.description,
        required: p.required ?? false,
      })),
    });
    return new Promise((resolve) => {
      this.pendingElicitations.set(blockId, { sessionId, resolve });
    });
  }

  /** Process-policy decision for a new top-level session (architecture.md §
   * process model): `isolated` always isolates; `shared` always shares;
   * `auto` (default) shares only once concurrent-session behavior has been
   * *used* on the primary connection, isolating every session before
   * that — a fork always rides its parent's poolKey regardless (SessionManager
   * never calls this for a fork), so the signal bootstraps organically the
   * first time a branch shares a connection with an existing session. */
  private async resolveProcessFor(agentId: string): Promise<string> {
    const primary = this.pool.get(agentId);
    if (primary === undefined) return agentId;
    const policy = primary.spec.processPolicy ?? "auto";
    const hasExisting = primary.sessions.length > 0;
    const used = this.agentView.current.capabilities[agentId]?.concurrentSessions?.used ?? false;
    const isolate = policy === "isolated" || (policy === "auto" && hasExisting && !used);
    if (!isolate) return agentId;
    const poolKey = `${agentId}::iso::${++this.isolationCounter}`;
    await this.pool.connect(primary.spec, { poolKey, reportAs: agentId, isolated: true });
    return poolKey;
  }

  /** Opportunistic behavior-level marking (architecture.md § capability
   * matrix; plan.md P5's "first fs success / first terminal" hooks): marks a
   * row used the first time its path is genuinely exercised on the wire.
   * Guarded on current state so a chatty agent (many reads per turn) doesn't
   * flood the patch stream with idempotent events. */
  private markFirstUse(agentId: string, row: CapabilityRowId): void {
    if (this.agentView.current.capabilities[agentId]?.[row]?.used) return;
    this.capabilityTracker.markUsed(agentId, row);
  }

  /** Settings-side projections of session-manager events (ui.md § Settings
   * Agents): the sessions-today stat tile, and per-agent knob offerings so
   * default knobs render only where the agent actually offers them. */
  private relaySettingsDerived(events: readonly AgentViewEvent[]): void {
    for (const event of events) {
      if (event.kind === "sessionCreated" || event.kind === "sessionClosed") {
        this.publishSessionStats();
      } else if (event.kind === "sessionModesSet" || event.kind === "sessionConfigOptionsChanged") {
        const agentId = this.sessionIndex.get(event.sessionId)?.agentId;
        if (agentId === undefined) continue;
        if (event.kind === "sessionModesSet") {
          this.noteOfferings(agentId, event.modes?.available ?? null, null);
        } else {
          this.noteOfferings(agentId, null, event.options);
        }
      }
    }
  }

  /** The one merge point for knob offerings — connection-scoped, in-memory
   * only (architecture.md § Session model: offerings are read, never
   * stored). Sources: the connect-time probe read, and every live session's
   * responses/notifications. Modes and options arrive separately (null =
   * nothing new for that half); the settings channel gets the merged record
   * on every observation. */
  private noteOfferings(
    agentId: string,
    modes: AgentKnobsView["modes"] | null,
    options: readonly SessionConfigOptionView[] | null,
  ): void {
    const merged = this.observedKnobs.get(agentId) ?? { modes: null, options: [] };
    if (modes !== null) merged.modes = modes;
    if (options !== null) {
      merged.options = options.map((o) =>
        o.type === "select"
          ? {
              id: o.id,
              name: o.name,
              category: o.category,
              type: "select" as const,
              values: o.options.flatMap((entry) =>
                "group" in entry
                  ? entry.options.map((v) => ({ value: v.value, name: v.name }))
                  : [{ value: entry.value, name: entry.name }],
              ),
            }
          : { id: o.id, name: o.name, category: o.category, type: "boolean" as const, values: [] },
      );
    }
    this.observedKnobs.set(agentId, merged);
    this.settings.emit({ kind: "agentKnobsObserved", agentId, knobs: { ...merged } });
  }

  private publishSessionStats(): void {
    const today = new Date().toDateString();
    const sessionsToday = this.sessionIndex
      .list()
      .filter((e) => new Date(e.createdAt).toDateString() === today).length;
    this.settings.emit({ kind: "sessionStatsChanged", sessionsToday });
  }

  /** Persists the render cache to workspace storage for agents that never
   * declared `session/load` — the only continuation available for them once
   * their connection dies is the emulated one seeded from this file
   * (architecture.md § State: "Last-known view... a labeled fallback, not a
   * competing truth"). Cheap and coarse on purpose: the whole transcript,
   * rewritten on every event touching a tracked session — same trade P1's
   * stores already make for workspaceState-sized data. */
  private persistLastKnownViewIfNeeded(events: readonly AgentViewEvent[]): void {
    const sessionIds = new Set<string>();
    for (const event of events) {
      const sessionId = (event as { sessionId?: string }).sessionId;
      if (sessionId !== undefined) sessionIds.add(sessionId);
    }
    for (const sessionId of sessionIds) {
      const agentId = this.sessionIndex.get(sessionId)?.agentId;
      if (agentId === undefined) continue;
      if (this.pool.get(agentId)?.declared?.loadSession) continue; // real replay exists — no fallback needed
      const blocks = this.agentView.current.transcripts[sessionId];
      if (blocks === undefined) continue;
      void this.lastKnownView.save(sessionId, blocks, new Date().toISOString());
    }
  }

  /** Live-buffer read: an open, possibly-unsaved editor wins over disk
   * (architecture.md § Local MCP server — "the agent sees what the user
   * sees"). Falls back to disk for files with no open editor. */
  private async readTextFileLive(path: string): Promise<string> {
    const uri = vscode.Uri.file(path);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path);
    if (open !== undefined) return open.getText();
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  }

  /** vscode.workspace.fs, shaped to asset-locations.ts's vscode-free FsLike
   * so the resolution logic itself stays unit-testable (P10). */
  private readonly assetFs: FsLike = {
    stat: async (path) => {
      try {
        const s = await vscode.workspace.fs.stat(vscode.Uri.file(path));
        return { isDirectory: (s.type & vscode.FileType.Directory) !== 0 };
      } catch {
        return null; // not present in this workspace — an honest outcome, not an error
      }
    },
    readdir: async (path) => {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
      return entries.map(([name, type]) => ({ name, isDirectory: (type & vscode.FileType.Directory) !== 0 }));
    },
  };

  /** Rules/skills/commands (architecture.md § Rules, skills, commands): v1
   * is management, not delivery — lists what's on disk per the roster's
   * mapping, an unmapped agent shown as such, never guessed. Runs on every
   * connect and on the Settings section's explicit refresh. */
  private async refreshAgentAssets(agentId: string): Promise<void> {
    const roster = this.roster.find((a) => a.id === agentId);
    const assets = await resolveAgentAssets(
      this.assetFs,
      this.workspaceRoot ?? process.cwd(),
      agentId,
      roster?.assets ?? null,
    );
    this.settings.emit({ kind: "agentAssetsChanged", assets });
  }

  /** A rendered mermaid SVG, opened as an editor-area panel — the agent
   * view's column is narrow; the files area is where a diagram can breathe.
   * Static content: no scripts at all, styles allowed for the SVG's own
   * inline styling (same CSP posture as the chat webview that rendered it). */
  private openDiagram(svg: string): void {
    const panel = vscode.window.createWebviewPanel(
      "acpPatchbay.diagram",
      "Diagram",
      vscode.ViewColumn.Active,
      {},
    );
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
  <style>
    body { margin: 0; height: 100vh; display: grid; place-items: center; overflow: auto; }
    svg { max-width: 95vw; max-height: 95vh; height: auto; }
  </style>
</head>
<body>${svg}</body>
</html>`;
  }

  /** Agent-reported tool-call diffs open in VS Code's native diff editor,
   * never an inline webview diff (ui-rendering-strategy § tool call card
   * design) — the texts come back from the session-manager's stash, written
   * to temp files so vscode.diff has real URIs to compare. */
  private async openToolCallDiff(sessionId: string, toolCallId: string, path: string): Promise<void> {
    const diff = this.sessionManager.toolCallDiff(sessionId, toolCallId, path);
    if (diff === null) return; // stale id after a close — nothing to show
    const dir = join(tmpdir(), "acp-patchbay-diffs", toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    await mkdir(dir, { recursive: true });
    const name = basename(path);
    const left = join(dir, `before-${name}`);
    const right = join(dir, `after-${name}`);
    await writeFile(left, diff.oldText, "utf8");
    await writeFile(right, diff.newText, "utf8");
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(left),
      vscode.Uri.file(right),
      `${name} — agent-proposed change`,
    );
  }

  /** Real editing happens in VS Code's own editor, never a webview dialect
   * (render-only-webview.md) — Settings is a navigational index onto files
   * that already live in the agent's own native locations. */
  private openAssetFile(path: string): void {
    const abs = vscode.Uri.file(join(this.workspaceRoot ?? process.cwd(), path));
    void vscode.window.showTextDocument(abs);
  }

  /** Native notification mirroring the inline card, shown only when the
   * Agent View isn't visible (features.md § Editor Surface: "impossible to
   * miss when the view is hidden"). `requestId` is the inline card's own
   * blockId — resolving through it is the same call the card's buttons make,
   * so whichever surface the user acts on first wins. */
  private notifyIfHidden(
    requestId: string,
    title: string,
    detail: string,
    options: readonly PermissionOptionView[],
  ): void {
    if (this.isAgentViewVisible()) return;
    const labels = options.map((o) => o.label);
    void vscode.window.showWarningMessage(`${title}: ${detail}`, ...labels).then((picked) => {
      if (picked === undefined) return;
      const option = options.find((o) => o.label === picked);
      if (option !== undefined) this.broker.resolve(requestId, option.optionId);
    });
  }

  private async refreshAuditTail(): Promise<void> {
    const entries = await this.decisionAudit.tail(20);
    this.settings.emit({ kind: "auditTailChanged", entries });
  }

  /** Loads globally-stored agent configs — replaces the old workspace-file
   * bootstrap (and the one-time-adoption gate that existed only because
   * that file could be repo-authored by someone else; a global,
   * developer-owned record needs no such gate). Every config is upserted
   * into both channels' agent lists right here (P16): the Agent View knows
   * every configured agent from the first frame, with an honest status —
   * `untested` (never initialized successfully at any version) or `stopped`
   * (has connected before; `lastSeenVersion` is the durable marker) —
   * instead of agents existing only once connected in-window. */
  private loadAgentConfigs(): void {
    for (const agent of this.agentConfigs.list()) {
      // env deliberately empty here: values live in SecretStorage and are
      // joined onto the spec at spawn time (connectAgent), read fresh per
      // connect — never cached in this map.
      this.configuredAgentSpecs.set(agent.id, {
        agentId: agent.id,
        name: agent.name,
        command: agent.command,
        args: agent.args,
        env: {},
        cwd: this.workspaceRoot ?? process.cwd(),
        processPolicy: agent.processPolicy,
        defaults: agent.defaults,
      });
      this.agentNames.set(agent.id, agent.name);
      const upsert = {
        kind: "agentUpserted",
        agent: {
          id: agent.id,
          name: agent.name,
          status: agent.lastSeenVersion === null ? "untested" : "stopped",
          command: [agent.command, ...agent.args].join(" "),
          needsAuth: false,
        },
      } as const;
      this.agentView.emit(upsert);
      this.settings.emit(upsert);
    }
    void this.refreshAgentConfigs();
  }

  /** Settings § Agents (features.md: "add, edit, and remove agents,
   * including launch configuration per agent") — persists globally. The
   * Edit form sends the launch line raw (render-only-webview: parsing is
   * logic), so an empty args array means "parse `command` here" — the same
   * quote-aware house parser custom Add uses, never a naive split.
   * `env` is the form's submitted set: the full desired key list, an empty
   * value meaning "keep the stored value" (the form never sees values, so
   * that's its only way to say unchanged); keys the user deleted are gone
   * from the submitted set and thus removed. Values go to SecretStorage
   * only (stores/agent-env.ts). */
  private async addOrUpdateAgentConfig(
    config: AgentConfigView,
    env: Readonly<Record<string, string>>,
  ): Promise<void> {
    let { command, args } = { command: config.command, args: [...config.args] };
    if (args.length === 0) {
      const parsed = parseCommandLine(command);
      if (parsed === null) {
        this.log.error(`agent config ${config.id}: command line has an unterminated quote`);
        return;
      }
      ({ command } = parsed);
      args = parsed.args;
    }
    const stored = await this.agentEnv.get(config.id);
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== "") merged[key] = value;
      else if (key in stored) merged[key] = stored[key]!;
      // a blank value for a key that has no stored value: nothing to keep
    }
    await this.agentEnv.set(config.id, merged);
    await this.agentConfigs.upsert({
      id: config.id,
      name: config.name,
      command,
      args,
      processPolicy: config.processPolicy,
      defaults: { ...config.defaults },
      registrySource: config.registrySource,
      lastSeenVersion: config.lastSeenVersion,
    });
    this.configuredAgentSpecs.set(config.id, {
      agentId: config.id,
      name: config.name,
      command,
      args,
      env: {},
      cwd: this.workspaceRoot ?? process.cwd(),
      processPolicy: config.processPolicy,
      defaults: config.defaults,
    });
    this.agentNames.set(config.id, config.name);
    await this.refreshAgentConfigs();
  }

  /** Remove is stop + forget (features.md: "add, edit, and remove agents") —
   * the process goes down (isolated instances included), its live sessions
   * are invalidated, the agent leaves both channel states via the
   * `agentRemoved` event, and its per-agent facts (used capabilities,
   * observed knobs) are purged so a future re-add starts honest. The
   * session index is deliberately left alone: it's patchbay's own record
   * of sessions that happened (decisions are recorded, not deleted). */
  private async removeAgentConfig(agentId: string): Promise<void> {
    await this.pool.stopAllFor(agentId);
    this.sessionManager.invalidateAgent(agentId);
    await this.agentConfigs.remove(agentId);
    await this.usedCapabilities.remove(agentId);
    await this.agentEnv.remove(agentId);
    this.configuredAgentSpecs.delete(agentId);
    this.agentNames.delete(agentId);
    this.observedKnobs.delete(agentId);
    const removed = { kind: "agentRemoved", agentId } as const;
    this.agentView.emit(removed);
    this.settings.emit(removed);
    await this.refreshAgentConfigs();
  }

  private async refreshAgentConfigs(): Promise<void> {
    // Key names only — env values never leave SecretStorage for a webview
    // state snapshot (no-secret-exposure.md); the form edits them write-only.
    const configs: AgentConfigView[] = await Promise.all(
      this.agentConfigs.list().map(async (c) => ({
        id: c.id,
        name: c.name,
        command: c.command,
        args: c.args,
        envKeys: Object.keys(await this.agentEnv.get(c.id)),
        processPolicy: c.processPolicy,
        defaults: c.defaults,
        registrySource: c.registrySource,
        lastSeenVersion: c.lastSeenVersion,
      })),
    );
    this.settings.emit({ kind: "agentConfigsChanged", configs });
  }

  /** `agentInfo.version` is reality (whoami.md: "reality is the source of
   * truth") — recorded on the config so the roster's live registry version
   * can be compared against what actually answered, driving "update
   * available" without ever trusting the pinned ask over the wire's fact. */
  private async recordSeenVersion(agentId: string, version: string): Promise<void> {
    const existing = this.agentConfigs.get(agentId);
    if (existing === undefined || existing.lastSeenVersion === version) return;
    // Knob offerings need no reset here: they're connection-scoped, and a
    // version can only change on a fresh connect, whose own offering read
    // just repopulated them.
    await this.agentConfigs.upsert({ ...existing, lastSeenVersion: version });
    await this.refreshAgentConfigs();
  }

  private applyRegistryData(data: AcpRegistryData): void {
    this.roster = mergeRoster(loadOverlay(), data.agents);
    const rosterEntries = this.roster.map(rosterEntryView);
    this.agentView.emit({ kind: "rosterChanged", roster: rosterEntries });
    this.settings.emit(
      { kind: "rosterChanged", roster: rosterEntries },
      { kind: "registryUpdated", at: data.fetchedAt },
    );
  }

  /** Connect an agent from config or roster; upserts it into both channel
   * states. The single env-injection point: values are read fresh from
   * SecretStorage per connect (stores/agent-env.ts) — the spec maps and the
   * config store never carry them. */
  async connectAgent(spec: LaunchSpec): Promise<void> {
    this.agentNames.set(spec.agentId, spec.name);
    const upsert = {
      kind: "agentUpserted",
      agent: {
        id: spec.agentId,
        name: spec.name,
        status: "reconnecting",
        command: [spec.command, ...spec.args].join(" "),
        needsAuth: false,
      },
    } as const;
    this.agentView.emit(upsert);
    this.settings.emit(upsert);
    const env = await this.agentEnv.get(spec.agentId);
    await this.pool.connect({ ...spec, env: { ...spec.env, ...env } });
    void this.refreshAgentAssets(spec.agentId);
  }

  /** Resolves a roster entry's declared distribution into a spawnable spec.
   * npx/uvx are ecosystem-managed installs — spawning them *is* installing,
   * nothing extra to do. A `binary` distribution not yet cached for this
   * exact version gates on an explicit download confirmation (no checksum
   * exists in the registry spec, binary-installer.ts) — `confirmed` skips
   * that gate once the user has already said yes. Returns null when the
   * entry can't be resolved right now (unavailable) or a confirmation is
   * now pending. */
  private async resolveRosterLaunch(
    entry: RosterAgent,
    verifyAfterConnect: boolean,
    confirmed = false,
  ): Promise<{ spec: LaunchSpec; registrySource: AgentConfig["registrySource"] } | null> {
    const launch = entry.launch;
    const cwd = this.workspaceRoot ?? process.cwd();
    switch (launch.kind) {
      case "unavailable":
        return null; // reason already visible on the roster entry
      case "local":
        return {
          spec: { agentId: entry.id, name: entry.name, command: launch.command, args: [...launch.args], env: { ...launch.env }, cwd },
          registrySource: null,
        };
      case "npx":
      case "uvx":
        return {
          spec: { agentId: entry.id, name: entry.name, command: launch.command, args: [...launch.args], env: { ...launch.env }, cwd },
          registrySource: { registryId: launch.registryId, distributionKind: launch.kind, pinnedVersion: launch.version },
        };
      case "binary": {
        const installed =
          confirmed || (await isBinaryInstalled(this.binaryCacheDir, entry.id, launch.version, launch.cmd));
        if (!installed) {
          this.pendingBinaryConfirms.set(entry.id, { entry, verifyAfterConnect });
          this.settings.emit({
            kind: "binaryInstallPending",
            install: { agentId: entry.id, name: entry.name, archiveUrl: launch.archiveUrl, cmd: launch.cmd },
          });
          return null;
        }
        const binary = await installBinary(this.binaryCacheDir, {
          agentId: entry.id,
          version: launch.version,
          archiveUrl: launch.archiveUrl,
          cmd: launch.cmd,
          args: launch.args,
          env: launch.env,
        });
        return {
          spec: { agentId: entry.id, name: entry.name, command: binary.command, args: [...binary.args], env: { ...binary.env }, cwd: binary.cwd },
          registrySource: { registryId: launch.registryId, distributionKind: "binary", pinnedVersion: launch.version },
        };
      }
    }
  }

  /** Persists the launch as a global agent config — "add" and "connect" are
   * one action now (features.md: adding an agent means it's activated —
   * checked spawnable, ready to start conversations on), not two decoupled
   * steps a user could leave half-done. Preserves any hand-edited
   * process-policy/defaults an existing config already carries. */
  private async persistAgentConfig(
    spec: LaunchSpec,
    registrySource: AgentConfig["registrySource"],
  ): Promise<void> {
    const existing = this.agentConfigs.get(spec.agentId);
    // Registry-declared launch env (part of the distribution recipe) goes to
    // the same SecretStorage record user-entered env lives in — one source
    // at spawn time. Registry values win for their own keys; the user's
    // other keys survive a re-add/Upgrade.
    if (Object.keys(spec.env).length > 0) {
      const stored = await this.agentEnv.get(spec.agentId);
      await this.agentEnv.set(spec.agentId, { ...stored, ...spec.env });
    }
    await this.agentConfigs.upsert({
      id: spec.agentId,
      name: spec.name,
      command: spec.command,
      args: [...spec.args],
      processPolicy: existing?.processPolicy ?? spec.processPolicy ?? "auto",
      defaults: existing?.defaults ?? spec.defaults ?? {},
      registrySource: registrySource ?? existing?.registrySource ?? null,
      lastSeenVersion: existing?.lastSeenVersion ?? null,
    });
    this.configuredAgentSpecs.set(spec.agentId, { ...spec, env: {} });
    await this.refreshAgentConfigs();
  }

  private handleAction(action: Action): void {
    switch (action.kind) {
      case "openSettings":
        void vscode.commands.executeCommand("acpPatchbay.openSettings");
        break;
      case "connectAgent":
        void this.connectFromSource(action.source, action.verifyAfterConnect ?? false);
        break;
      case "restartAgent":
        // failure surfaces as a crashed status patch — no reply channel by design
        void this.pool.restart(action.agentId).catch(this.logCatch(`restart ${action.agentId}`));
        break;
      case "stopAgent":
        void this.pool.stop(action.agentId);
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
      case "switchSession":
        this.sessionManager.activate(action.sessionId);
        break;
      case "renameSession":
        void this.sessionManager.rename(action.sessionId, action.title);
        break;
      case "closeSession":
        void this.sessionManager
          .close(action.sessionId)
          .then(() => this.lastKnownView.remove(action.sessionId));
        break;
      case "branchSession": {
        const transcript = this.agentView.current.transcripts[action.sessionId] ?? [];
        void this.sessionManager
          .branch(action.sessionId, transcript)
          .catch(this.logCatch(`branch ${action.sessionId}`));
        break;
      }
      case "reloadSession":
        void this.sessionManager.reload(action.sessionId).catch(this.logCatch(`reload ${action.sessionId}`));
        break;
      case "setSessionMode":
        void this.sessionManager.setMode(action.sessionId, action.modeId);
        break;
      case "setSessionConfigOption":
        void this.sessionManager.setConfigOption(action.sessionId, action.configId, action.value);
        break;
      case "sendPrompt":
        // failure surfaces as sessionLiveChanged(false) with no new text — no reply channel by design
        void this.sessionManager
          .sendPrompt(action.sessionId, action.text)
          .catch(this.logCatch(`sendPrompt ${action.sessionId}`));
        break;
      case "stopTurn":
        void this.sessionManager.stopTurn(action.sessionId);
        break;
      case "verifyAgent":
        void this.runVerify(action.agentId);
        break;
      case "resolvePermission":
        this.broker.resolve(action.requestId, action.optionId);
        break;
      case "resolveDiff":
        this.broker.resolve(action.requestId, action.accept ? "accept" : "reject");
        break;
      case "authenticateAgent":
        // failure leaves needsAuth set — the honest signal, no separate reply channel
        void this.capabilityTracker
          .authenticate(action.agentId, action.methodId)
          .catch(this.logCatch(`authenticate ${action.agentId}`));
        break;
      case "confirmBinaryInstall":
        void this.confirmBinaryInstall(action.agentId);
        break;
      case "cancelBinaryInstall":
        this.cancelBinaryInstall(action.agentId);
        break;
      case "upgradeAgent":
        void this.upgradeAgent(action.agentId);
        break;
      case "refreshRoster":
        void this.acpRegistry.refresh();
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
      case "resolveElicitation": {
        const pending = this.pendingElicitations.get(action.requestId);
        if (pending === undefined) break;
        this.pendingElicitations.delete(action.requestId);
        this.agentView.emit({
          kind: "elicitationResolved",
          sessionId: pending.sessionId,
          blockId: action.requestId,
          cancelled: action.values === null,
        });
        pending.resolve(action.values);
        break;
      }
      case "addSelectionContext": {
        const selection = this.editorStateHost.getSelection();
        if (selection === null) break;
        this.sessionManager.addContext(action.sessionId, {
          id: `chip-${Date.now()}`,
          kind: "selection",
          label: `Selection: ${selection.file}:${selection.startLine}-${selection.endLine}`,
          content: selection.text,
        });
        break;
      }
      case "addFileContext": {
        const file = this.editorStateHost.getCurrentFile();
        if (file === null) break;
        this.sessionManager.addContext(action.sessionId, {
          id: `chip-${Date.now()}`,
          kind: "file",
          label: `File: ${file.file}`,
          content: file.content,
        });
        break;
      }
      case "addDiagnosticsContext": {
        const diagnostics = this.editorStateHost.getDiagnostics();
        if (diagnostics.length === 0) break;
        this.sessionManager.addContext(action.sessionId, {
          id: `chip-${Date.now()}`,
          kind: "diagnostics",
          label: `Problems (${diagnostics.length})`,
          content: diagnostics.map((d) => `${d.file}:${d.line} [${d.severity}] ${d.message}`).join("\n"),
        });
        break;
      }
      case "removeContextChip":
        this.sessionManager.removeContext(action.sessionId, action.chipId);
        break;
      case "connectRegistryKey":
        void this.integrations.connectRegistryWithKey(action.registryId, action.token, action.url);
        break;
      case "connectRegistryOAuth":
        void this.integrations.connectRegistryOAuth(action.registryId, action.url);
        break;
      case "addCustomIntegration":
        void this.integrations.addCustom(action.name, action.source, action.routing);
        break;
      case "importIntegrationsJson":
        void this.integrations.importJson(action.json);
        break;
      case "updateIntegrationJson":
        void this.integrations.updateFromJson(action.integrationId, action.json);
        break;
      case "cancelIntegrationConnect":
        this.integrations.cancelConnect(action.integrationId);
        break;
      case "setIntegrationActive":
        void this.integrations.setActive(action.integrationId, action.active);
        break;
      case "removeIntegration":
        void this.integrations.remove(action.integrationId);
        break;
      case "setIntegrationRouting":
        void this.integrations.setRouting(action.integrationId, action.routing);
        break;
      case "shareIntegrationConfig":
        void this.shareIntegrationConfig(action.integrationId);
        break;
      case "refreshAgentAssets":
        void this.refreshAgentAssets(action.agentId);
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
      case "openAssetFile":
        this.openAssetFile(action.path);
        break;
      case "addOrUpdateAgentConfig":
        void this.addOrUpdateAgentConfig(action.config, action.env);
        break;
      case "removeAgentConfig":
        void this.removeAgentConfig(action.agentId);
        break;
      case "addContextRoot":
        void this.addContextRoot(action.sessionId);
        break;
      case "removeContextRoot":
        this.sessionManager.removeRoot(action.sessionId, action.path);
        break;
      case "addImageContext":
        this.sessionManager.addContext(action.sessionId, {
          id: `chip-${Date.now()}`,
          kind: "image",
          label: action.label,
          content: action.dataUrl,
          mimeType: action.mimeType,
        });
        break;
      case "addFilePickerContext":
        void this.addFilePickerContext(action.sessionId);
        break;
      case "addOpenEditorContext":
        void this.readTextFileLive(action.path).then((content) =>
          this.sessionManager.addContext(action.sessionId, {
            id: `chip-${Date.now()}`,
            kind: "file",
            label: `File: ${action.path}`,
            content,
          }),
        );
        break;
    }
  }

  /** "Add workspace folders as session context roots" (features.md § Chat) —
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
    this.sessionManager.addRoot(sessionId, uri.fsPath);
  }

  /** "Attach files by... picker" (features.md § Chat) — reuses the same
   * context-chip mechanism the composer's "current file" adder already
   * uses, just for an arbitrary file the user picks rather than the active
   * editor. */
  private async addFilePickerContext(sessionId: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: false,
      canSelectFiles: true,
      canSelectMany: false,
      openLabel: "Attach to context",
    });
    const uri = picked?.[0];
    if (uri === undefined) return;
    const bytes = await vscode.workspace.fs.readFile(uri);
    this.sessionManager.addContext(sessionId, {
      id: `chip-${Date.now()}`,
      kind: "file",
      label: `File: ${uri.fsPath}`,
      content: Buffer.from(bytes).toString("utf8"),
    });
  }

  /** "Explicit share command that copies config" (plan.md P9): the
   * sanitized config entry (no credential — none exists here by
   * construction, see integration-configs.ts) goes to the clipboard.
   * Reattaching a credential is never automatic: a pasted entry's `id` has
   * no token in SecretStorage until its user explicitly connects —
   * SecretStorage itself is global, keyed only by integration id (never
   * workspace-namespaced), so this has always been the real trust boundary. */
  private async shareIntegrationConfig(integrationId: string): Promise<void> {
    const integration = this.integrationConfigs.get(integrationId);
    if (integration === undefined) return;
    await vscode.env.clipboard.writeText(JSON.stringify(integration, null, 2));
    void vscode.window.showInformationMessage(
      `Copied "${integration.name}" config to the clipboard — no credential included.`,
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

  private async confirmBinaryInstall(agentId: string): Promise<void> {
    const pending = this.pendingBinaryConfirms.get(agentId);
    this.pendingBinaryConfirms.delete(agentId);
    this.settings.emit({ kind: "binaryInstallResolved", agentId });
    if (pending === undefined) return;
    await this.connectFromSource({ rosterId: pending.entry.id }, pending.verifyAfterConnect, true);
  }

  private cancelBinaryInstall(agentId: string): void {
    this.pendingBinaryConfirms.delete(agentId);
    this.settings.emit({ kind: "binaryInstallResolved", agentId });
  }

  /** Re-resolves the roster's current (possibly newer) pinned version and
   * reconnects — the same path a first Add takes, so the version-keyed
   * used-capability cache and the binary-install confirmation both apply
   * exactly as they would for a brand-new agent. Never silent: a
   * still-uncached binary version re-gates on the download confirmation. */
  private async upgradeAgent(agentId: string): Promise<void> {
    const config = this.agentConfigs.get(agentId);
    if (config === undefined || config.registrySource === null) return;
    if (this.pool.get(agentId)?.status === "running") await this.pool.stop(agentId);
    await this.connectFromSource({ rosterId: agentId });
  }

  /** One intent, one click (P17): connect if needed, then create and
   * activate the session — all inside the chat pane. Uses the saved config
   * path (env injected from SecretStorage at spawn, process policy
   * respected), never a bare pool.connect. Failure lands inline with the
   * specific reason and a Retry — never a silent bounce to the empty
   * state. */
  private async startChat(agentId: string): Promise<void> {
    const agentName = this.agentNames.get(agentId);
    if (agentName === undefined) return; // unknown agent — nothing to start
    if (this.agentView.current.chatConnect?.status === "connecting") return; // one at a time
    this.agentView.emit({ kind: "chatConnectStarted", agentId });
    try {
      if (this.pool.get(agentId)?.status !== "running") {
        const spec = this.configuredAgentSpecs.get(agentId);
        if (spec === undefined) throw new Error("no saved launch configuration — re-add it in Settings");
        await this.connectAgent(spec);
      }
      // sessionCreated itself clears the connect pane (reducer) — success
      // needs no extra event.
      await this.sessionManager.createSession(agentId, agentName, this.workspaceRoot ?? process.cwd());
    } catch (err) {
      // Prefer the pool's own crash detail (spawn failed / initialize
      // failed with the interactive-setup hint) over a raw wire error; map
      // auth_required to the action that actually unblocks it.
      const raw = err instanceof Error ? err.message : String(err);
      const reason =
        err instanceof RequestError && err.code === -32000
          ? "needs login first — use Log in on this agent in Settings § Agents"
          : (this.pool.get(agentId)?.detail ?? raw);
      this.agentView.emit({ kind: "chatConnectFailed", agentId, reason });
      this.log.error(`startChat ${agentId}: ${raw}`);
    }
  }

  private async connectFromSource(
    source: ConnectAgentSource,
    verifyAfterConnect = false,
    confirmed = false,
  ): Promise<void> {
    let spec: LaunchSpec | null = null;
    let registrySource: AgentConfig["registrySource"] = null;
    let shouldPersist = true;
    if ("rosterId" in source) {
      const entry = this.roster.find((a) => a.id === source.rosterId);
      if (entry === undefined) return;
      const resolved = await this.resolveRosterLaunch(entry, verifyAfterConnect, confirmed);
      if (resolved === null) return; // unavailable, or a binary install confirmation is now pending
      spec = resolved.spec;
      registrySource = resolved.registrySource;
    } else if ("configuredId" in source) {
      spec = this.configuredAgentSpecs.get(source.configuredId) ?? null;
      shouldPersist = false; // already persisted — this is a reconnect of an existing config
    } else {
      const parsed = parseCommandLine(source.command);
      if (parsed) {
        const id = `custom-${parsed.command.replace(/[^\w.-]+/g, "-")}`;
        spec = {
          agentId: id,
          name: parsed.command,
          command: parsed.command,
          args: parsed.args,
          env: {},
          cwd: this.workspaceRoot ?? process.cwd(),
        };
      }
    }
    if (spec === null) return;
    if (this.pool.get(spec.agentId)?.status === "running") return;
    if (shouldPersist) await this.persistAgentConfig(spec, registrySource);
    try {
      await this.connectAgent(spec);
      if (verifyAfterConnect) void this.runVerify(spec.agentId);
    } catch {
      // pool already emitted the crashed status with detail
    }
  }

  /** Formats a swallowed action failure for the Output channel — these
   * actions have no reply channel by design (state itself is the only
   * signal back to the UI), but silently dropping the error entirely left
   * nothing to debug from. */
  private logCatch(context: string): (err: unknown) => void {
    return (err) => this.log.error(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** Brackets a Verify round-trip (manual click or "Verify after add") with
   * the settings-only in-flight signal — the card's Verify control dims and
   * reads "Verifying…" for exactly the span of the free protocol check. */
  private async runVerify(agentId: string): Promise<void> {
    this.settings.emit({ kind: "agentVerifyStarted", agentId });
    this.log.debug(`${agentId}: verify started`);
    try {
      await this.capabilityTracker.verify(agentId);
    } finally {
      this.settings.emit({ kind: "agentVerifyFinished", agentId });
      this.log.debug(`${agentId}: verify finished`);
    }
  }

  dispose(): void {
    for (const d of this.editorSubscriptions) d.dispose();
    this.editorStateHost.stop();
    this.acpRegistry.dispose();
    void this.pool.disposeAll();
    this.agentView.flushNow();
    this.settings.flushNow();
    this.statusBarItem.dispose();
  }
}
