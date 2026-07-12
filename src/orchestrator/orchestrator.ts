// Orchestrator: the Node process in the extension host — single source of
// truth for sessions, capability tables, permission rules, secrets,
// configuration. Webviews only ever see its snapshots and patches.
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  type AgentViewEvent,
  type AgentViewState,
  type CapabilityRowId,
  type ConnectAgentSource,
  type DataInventoryRow,
  type PermissionOptionView,
  type SettingsEvent,
  type SettingsState,
} from "../shared/protocol";
import { ASSET_LOCATIONS, resolveAgentAssets, type FsLike } from "./asset-locations";
import { applyFileWrite, PermissionBroker, sliceTextFileRead } from "./broker";
import { eraseAllData } from "./erase-all";
import { CapabilityTracker } from "./capability-tracker";
import { ChannelHost } from "./channel";
import { parseCommandLine } from "./command-line";
import { EditorStateHost } from "./editor-state-host";
import { IntegrationsManager } from "./integrations";
import { OAuthCallbackRegistry } from "./oauth-callback";
import { applyConfigUpdate, foldSeed, normalizeKnobs, toOfferedKnobs, type NormalizedKnobs } from "./knobs";
import { checkPathDivergence } from "./launcher-health";
import { terminalAuthRecipeOf, type TerminalAuthRecipe } from "./meta";
import { AgentPool, type LaunchSpec } from "./pool";
import { commandOf, killTree, reapOrphans } from "./process-tree";
import { SessionManager } from "./session-manager";
import { nonce } from "./webview-host";
import { WireLog } from "./wire-log";
import { playDoneSound } from "./sound";
import {
  type AcpRegistryData,
  AcpRegistryStore,
  KNOWN_BYPASS_BRIDGES,
  type RegistryAgent,
  registryAgentView,
  resolveDistribution,
} from "./stores/acp-registry";
import { type AgentConfig, AgentConfigStore } from "./stores/agent-configs";
import { LastKnobsStore } from "./stores/last-knobs";
import { PreferencesStore } from "./stores/preferences";
import { SecretEnvStore } from "./stores/secret-env";
import { installBinary, isBinaryInstalled } from "./stores/binary-installer";
import { DecisionAuditStore } from "./stores/decision-audit";
import { IntegrationConfigStore } from "./stores/integration-configs";
import { IntegrationTokenStore } from "./stores/integration-tokens";
import { LastActiveSessionStore } from "./stores/last-active-session";
import { LastConnectedStore } from "./stores/last-connected";
import { MachineRulesStore, PermissionRulesStore } from "./stores/permission-rules";
import { loadRegistry } from "./stores/registry";
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

export class Orchestrator {
  readonly agentView: ChannelHost<AgentViewState, AgentViewEvent>;
  readonly settings: ChannelHost<SettingsState, SettingsEvent>;

  readonly decisionAudit: DecisionAuditStore;
  readonly lastConnected: LastConnectedStore;
  readonly lastActiveSession: LastActiveSessionStore;
  readonly agentConfigs: AgentConfigStore;
  readonly integrationConfigs: IntegrationConfigStore;
  readonly usedCapabilities: UsedCapabilityStore;
  readonly spawnRegistry: SpawnRegistryStore;
  readonly agentEnv: SecretEnvStore;
  readonly integrationEnv: SecretEnvStore;
  readonly acpRegistry: AcpRegistryStore;
  readonly permissionRules: PermissionRulesStore;
  readonly machinePermissionRules: MachineRulesStore;
  readonly preferences: PreferencesStore;
  readonly lastKnobs: LastKnobsStore;
  /** The current ACP registry snapshot (agents + icons) — replaced whenever
   * the registry refreshes; every agent lookup elsewhere reads this. */
  private registryData: AcpRegistryData = { fetchedAt: "", agents: [], icons: {} };
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
  /** Standing probe workspaces, one per agent (`probe/<agentId>`) — created
   * idempotently at each probe, deleted only with the agent's config. Never
   * mid-connection: a probe session may hold its root agent-side for the
   * connection's life (capability-tracker.ts hooks.probeRoot). */
  private readonly probeRootBase: string;
  private readonly agentNames = new Map<string, string>();
  /** agentId:pathVersion:bundledVersion triples already warned about —
   * warnOnPathDivergence fires once per exact pair, never per reconnect. */
  private readonly divergenceWarned = new Set<string>();
  /** Agents (global — never repo-committed), resolved to a spawnable
   * LaunchSpec; visible-in-this-workspace subset of agentConfigs.list(). */
  private readonly configuredAgentSpecs = new Map<string, LaunchSpec>();
  /** A registry `binary` distribution awaiting the one-time download
   * confirmation — at most one per agentId in flight. */
  private readonly pendingBinaryConfirms = new Map<
    string,
    { agent: RegistryAgent; verifyAfterConnect: boolean }
  >();
  private readonly terminals = new Map<string, TerminalHandle>();
  private terminalCounter = 0;
  /** agentId → methodId → terminal-auth login recipe (meta.ts), captured
   * fresh at every connect from the raw initialize response — never
   * persisted, never sent to a webview. */
  private readonly authRecipes = new Map<string, ReadonlyMap<string, TerminalAuthRecipe>>();
  private readonly mcpServerScriptPath: string;
  private readonly integrationBridgeScriptPath: string;
  private readonly contextTokenToSession = new Map<string, string>();
  /** In-flight session/list syncs per agent — awaited by the startup
   * restore so "found or not" is judged against a settled list. */
  private readonly pendingSyncs = new Map<string, Promise<void>>();
  private readonly pendingElicitations = new Map<
    string,
    { sessionId: string; resolve(values: Record<string, unknown> | null): void }
  >();
  private elicitationCounter = 0;
  private isolationCounter = 0;
  private readonly editorSubscriptions: vscode.Disposable[] = [];
  /** Set by the webview host as the Agent View mounts/unmounts (wired in
   * extension.ts to `AgentViewProvider`'s real `onDidChangeVisibility`
   * signal, P6); defaults to "visible" so native notifications don't fire
   * spuriously before that's connected. */
  isAgentViewVisible: () => boolean = () => true;
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
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    this.workspaceRoot = workspaceRoot;
    this.mcpServerScriptPath = vscode.Uri.joinPath(context.extensionUri, "out", "mcp-server.js").fsPath;
    this.integrationBridgeScriptPath = vscode.Uri.joinPath(
      context.extensionUri,
      "out",
      "integration-bridge.js",
    ).fsPath;
    this.binaryCacheDir = join(context.globalStorageUri.fsPath, "bin-cache");
    this.probeRootBase = join(context.globalStorageUri.fsPath, "probe");

    this.permissionRules = new PermissionRulesStore(context.workspaceState);
    this.machinePermissionRules = new MachineRulesStore(context.globalState);
    this.decisionAudit = new DecisionAuditStore(context.storageUri?.fsPath ?? null);
    this.lastConnected = new LastConnectedStore(context.workspaceState);
    this.lastActiveSession = new LastActiveSessionStore(context.workspaceState);
    // Agents and integrations are developer-env, not code-env: global to
    // this machine, never a repo-committed file. Deliberately global-only —
    // workspace binding may return later as an opt-in (see
    // stores/integration-configs.ts's header for the incident that shaped
    // this).
    this.agentConfigs = new AgentConfigStore(context.globalState);
    this.integrationConfigs = new IntegrationConfigStore(context.globalState);
    this.preferences = new PreferencesStore(context.globalState);
    this.lastKnobs = new LastKnobsStore(context.globalState);
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
        integrationRegistry: this.integrations.registryViews(),
        preferences: this.preferences.get(),
      },
      reduceSettings,
      coalesceSettingsEvent,
      onAction,
    );

    this.acpRegistry = new AcpRegistryStore(
      join(context.globalStorageUri.fsPath, "registry"),
      (data) => this.applyRegistryData(data),
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
        // Every connect of a list-capable agent syncs its own session
        // history into the list — the wire is the ONLY list (patchbay
        // persists no session records). The promise is tracked so the
        // startup restore can wait for the lists before deciding whether
        // the last-active pointer still resolves.
        if (status === "running") {
          const sync = this.sessionManager
            .syncAgentSessions(agentId)
            .then(() => {
              // A session opened before its agent connected sat blank (no
              // replay to run yet) — hydrate it now that one exists.
              const active = this.agentView.current.activeSessionId;
              if (active !== null && this.sessionManager.agentFor(active) === agentId) {
                return this.sessionManager.hydrate(active);
              }
            })
            .catch(this.logCatch(`session/list sync for ${agentId}`))
            .finally(() => {
              if (this.pendingSyncs.get(agentId) === sync) this.pendingSyncs.delete(agentId);
            });
          this.pendingSyncs.set(agentId, sync);
        }
        // Offerings are connection state (architecture.md § Session model) —
        // the settings reducer drops its copy off this same event, and the
        // next connect's offering read repopulates it.
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
        this.capabilityTracker.onDeclared(agentId, declared, version, raw.protocolVersion);
        if (version !== null) void this.recordSeenVersion(agentId, version);
        // terminal-auth recipes (meta.ts), fresh per connect — command paths
        // are machine-absolute and never persisted; the webview only ever
        // sees the method's kind, the recipe stays host-side.
        const recipes = new Map<string, TerminalAuthRecipe>();
        for (const m of raw.authMethods ?? []) {
          const recipe = terminalAuthRecipeOf(m._meta);
          if (recipe !== null) recipes.set(m.id, recipe);
        }
        this.authRecipes.set(agentId, recipes);
      },
      onSessionUpdate: (agentId, notification) => {
        // A throwaway probe session's late config_option_update still counts
        // as part of the connect-time offering read — some agents deliver
        // the option surface only after session/new returns.
        const probeAgent = this.capabilityTracker.agentForProbeSession(notification.sessionId);
        if (probeAgent !== undefined) {
          if (notification.update.sessionUpdate === "config_option_update") {
            this.noteOfferings(probeAgent, applyConfigUpdate(notification.update.configOptions));
          }
          return;
        }
        this.sessionManager.handleUpdate(agentId, notification);
      },
      onCapabilityEvidence: (agentId, row, evidence) => this.noteEvidence(agentId, row, evidence),
      onAuthRequired: (agentId, reason) => {
        const event = { kind: "agentAuthRequired", agentId, reason } as const;
        this.agentView.emit(event);
        this.settings.emit(event);
      },
      wireLogActive: () => this.wireLog.active,
      onWireFrame: (agentId, direction, line) => this.wireLog.frame(agentId, direction, line),
      // Spawn registry (P15c): records live in globalState so an abnormal
      // end (crash, OS kill) leaves exactly what the next activate reaps.
      onProcessSpawned: (pid, command) => void this.spawnRegistry.add(pid, command, "agent"),
      onProcessEnded: (pid) => void this.spawnRegistry.removePid(pid),
      onPermissionRequest: async (_agentId, params) => {
        const options = optionViewsFromAcp(params.options);
        const title = params.toolCall.title ?? "Permission request";
        // A throwaway probe session can trip real agent-side gates (Auggie's
        // workspace-indexing question rides session/new). No surface renders
        // a probe session, so the card/toast path would leave the agent's
        // RPC dangling forever — a JSON-RPC request is always owed an
        // answer. Least privilege instead: the question re-asks on the
        // user's first real session, and the probe's temp dir is about to
        // be deleted anyway.
        const probeAgent = this.capabilityTracker.agentForProbeSession(params.sessionId);
        if (probeAgent !== undefined) {
          this.log.info(`${probeAgent}: auto-declined "${title}" on a probe session`);
          const auto = await this.broker.resolveProbePermissionRequest(
            params.sessionId,
            title,
            options,
          );
          return "cancelled" in auto
            ? { outcome: { outcome: "cancelled" as const } }
            : { outcome: { outcome: "selected" as const, optionId: auto.optionId } };
        }
        const subject =
          params.toolCall.kind === "edit" ? (params.toolCall.locations?.[0]?.path ?? null) : null;
        const result = await this.broker.resolveAgentPermissionRequest(
          params.sessionId,
          title,
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
      // fs/terminal used-marking happens in pool.ts's incoming-request
      // chokepoint when these handlers resolve (capabilities.ts
      // CAPABILITY_PROOFS) — a rejected write still resolves, so it still
      // counts: the agent routing writes through patchbay's gate is the
      // brokered path firing, and a rejection is the gate working.
      onReadTextFile: async (_agentId, params) => {
        const content = await this.readTextFileLive(params.path);
        return { content: sliceTextFileRead(content, params.line, params.limit) };
      },
      onWriteTextFile: async (_agentId, params) => {
        const { accepted } = await this.broker.gateFileWrite(params.sessionId, params.path, params.content);
        if (accepted) await applyFileWrite(params.path, params.content);
        return {};
      },
      onCreateTerminal: async (_agentId, params) => {
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
      vscode.workspace.onDidChangeWorkspaceFolders(() =>
        this.agentView.emit({ kind: "workspaceRootsChanged", roots: workspaceRootsView() }),
      ),
    );

    this.sessionManager = new SessionManager(
      this.pool,
      {
        emit: (...events) => {
          this.agentView.emit(...events);
          this.relaySettingsDerived(events);
          this.recordLastActive(events);
          this.maybeChime(events);
        },
        // The session/load replay window: canonical state advances (and the
        // settings/last-active relays stay truthful) but no patches ride to
        // the webview — resyncView closes the window with one wholesale swap.
        emitSilent: (...events) => {
          this.agentView.emitSilent(...events);
          this.relaySettingsDerived(events);
          this.recordLastActive(events);
        },
        resyncView: () => this.agentView.resync(),
        mapContextToken: (token, sessionId) => this.contextTokenToSession.set(token, sessionId),
        resolveProcessFor: (agentId) => this.resolveProcessFor(agentId),
        // From the store-backed spec map, never the pool entry's spec: that
        // one is a connect-time snapshot, and a Settings edit to defaults
        // must reach the very next session, not wait for a reconnect. The
        // knobSource preference is read just as fresh: last-session takes
        // the recorded combination, falling back to the configured defaults
        // (a never-used agent has no "last").
        seedFor: (agentId) => {
          const defaults = this.configuredAgentSpecs.get(agentId)?.defaults;
          if (this.preferences.get().knobSource !== "last-session") return defaults;
          return this.lastKnobs.get(agentId) ?? defaults;
        },
        onKnobsConfirmed: (agentId, seed) => void this.lastKnobs.record(agentId, seed),
        contextRootsFor: (sessionId) => this.agentView.current.contextRoots[sessionId] ?? [],
        currentTranscript: (sessionId) => this.agentView.current.transcripts[sessionId] ?? [],
        isDeleteUsed: (agentId) =>
          this.agentView.current.capabilities[agentId]?.["session.delete"]?.used ?? false,
        isActiveSession: (sessionId) => this.agentView.current.activeSessionId === sessionId,
        isUnseen: (sessionId) =>
          this.agentView.current.sessions.find((s) => s.id === sessionId)?.unseen === true,
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
        const isFullyBrokered =
          matrix !== undefined &&
          computeFidelity(matrix, KNOWN_BYPASS_BRIDGES.has(agentId)) === "fully-brokered";
        const integrationServers = await this.integrations.mcpServersFor(
          agentId,
          isFullyBrokered,
          this.integrationBridgeScriptPath,
          this.editorStateHost.socketPath,
        );
        // Env values are secrets by classification (no-secret-exposure.md),
        // and this is the one place they cross to the wire — register every
        // one with the wire log's redaction set. Over-redaction (plumbing
        // values like socket paths get masked too) is the safe direction.
        for (const server of [editorServer, ...integrationServers]) {
          if ("env" in server && server.env !== undefined) {
            for (const { value } of server.env) this.wireLog.registerSecret(value);
          }
        }
        return [editorServer, ...integrationServers];
      },
      log,
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
        emit: (...events) => {
          this.agentView.emit(...events);
          this.settings.emit(...events);
        },
        currentMatrix: (agentId) => this.agentView.current.capabilities[agentId],
        onOfferings: (agentId, modes, configOptions) =>
          this.noteOfferings(agentId, normalizeKnobs(modes, configOptions)),
        probeRoot: async (agentId) => {
          const dir = join(this.probeRootBase, agentId);
          await mkdir(dir, { recursive: true });
          return dir;
        },
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
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = "acpPatchbay.agentView.focus";
    this.statusBarItem.show();
    this.agentView.onChange(() => this.refreshStatusBar());
    this.refreshStatusBar();

    // Orphan reaping strictly before any startup agent spawns (P15c): the
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
      agentEnv: this.agentEnv,
      integrationEnv: this.integrationEnv,
      integrationTokens: this.integrationTokens,
      permissionRules: this.permissionRules,
      machineRules: this.machinePermissionRules,
      decisionAudit: this.decisionAudit,
      lastActiveSession: this.lastActiveSession,
      lastConnected: this.lastConnected,
      preferences: this.preferences,
      lastKnobs: this.lastKnobs,
    });

    this.configuredAgentSpecs.clear();
    this.agentNames.clear();

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
    // An open Preferences page settles back to the defaults it now holds.
    this.settings.emit({ kind: "preferencesChanged", preferences: this.preferences.get() });
    await this.refreshAuditTail();
    // An open Data page should watch its own inventory hit zero.
    await this.publishDataInventory();
    this.log.info("erase all data: complete — factory state");
  }

  /** deactivate's bounded best-effort (plan.md P15): terminal trees get a
   * straight SIGKILL (batch commands — no protocol to be graceful about),
   * agents get the pool ladder on its tight budget, and the whole sweep is
   * raced against the ~2s VS Code actually waits before killing the host.
   * Whatever this couldn't reach, the next activate's reap covers. */
  async shutdown(): Promise<void> {
    // Reload-continuation stamp, written before any killing — the running
    // set as it stood when the window went down is what the next activate
    // restores (if it comes soon enough to be a reload; last-connected.ts).
    // A Memento write is milliseconds; it must land inside the budget.
    await this.lastConnected.write(
      this.pool.list().filter((v) => v.status === "running").map((v) => v.spec.agentId),
    );
    for (const handle of this.terminals.values()) {
      if (handle.pid !== null && handle.exitStatus() === null) killTree(handle.pid, "SIGKILL");
    }
    await Promise.race([
      this.pool.disposeAll(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
    ]);
  }

  /** Startup connections: the union of every config flagged auto-connect
   * and the reload-continuation stamp (stores/last-connected.ts — what was
   * still running at the last shutdown, honored only while fresh). The
   * union's two halves answer different questions — "always there" vs.
   * "was there when the window reloaded" — so neither subsumes the other:
   * a flagged agent the user manually stopped before reload stays in the
   * flagged half (autoConnect means every window open); a manually
   * connected, unflagged agent rides only the stamp and therefore survives
   * reload but not quit-and-reopen-later. Always the user's own configured
   * choices, never patchbay picking an agent for them (prd.md's routing
   * scope decision is about choosing among agents for a task, not this). */
  private async connectStartupAgents(): Promise<void> {
    // Legacy `acpPatchbay.defaultAgent` (superseded by the per-agent flag):
    // folded into the config once, so the old setting keeps working without
    // two mechanisms living on. The raw value stays readable after the
    // contribution's removal — unregistered keys still surface.
    const legacy = vscode.workspace.getConfiguration("acpPatchbay").get<string>("defaultAgent", "");
    if (legacy !== "") {
      const existing = this.agentConfigs.get(legacy);
      if (existing !== undefined && !existing.autoConnect) {
        await this.agentConfigs.upsert({ ...existing, autoConnect: true });
        await this.refreshAgentConfigs();
        this.log.info(`migrated acpPatchbay.defaultAgent ("${legacy}") to the per-agent auto-connect flag`);
      }
    }
    const stamped = await this.lastConnected.consume();
    const flagged = this.agentConfigs.list().filter((c) => c.autoConnect).map((c) => c.id);
    const ids = new Set([...flagged, ...stamped]);
    if (legacy !== "") ids.add(legacy); // config may not exist yet — resolved below
    await Promise.allSettled(
      [...ids].map((id) => {
        if (this.configuredAgentSpecs.has(id)) return this.connectFromSource({ configuredId: id });
        // Only the legacy setting can name an agent with no config on this
        // machine (a stamp or flag implies one was persisted) — the registry
        // path covers it, and persists the config it was missing.
        if (id === legacy) return this.connectFromSource({ registryId: id });
        this.log.debug(`startup connect: ${id} has no config (removed since the stamp) — skipped`);
        return Promise.resolve();
      }),
    );
    await this.restoreLastActiveSession();
  }

  /** Reload continuity's third rung (flag → list → pointer): return to the
   * session that was open when the window went down. One rule, found or
   * not: the pointer (a bare sessionId) is looked up in what the startup
   * connects' own session/list syncs brought back — found activates
   * (load/resume via the same open path as a drawer click), not found
   * lands on the default screen, regardless of why (agent removed, session
   * deleted externally, agent that can't list). The pointer itself is left
   * alone on a miss: not-found ≠ gone — a failed connect this window must
   * not erase where a later window could still return. Never spawns a
   * process the startup rules didn't start. */
  private async restoreLastActiveSession(): Promise<void> {
    const sessionId = this.lastActiveSession.get();
    if (sessionId === undefined) return;
    await Promise.allSettled([...this.pendingSyncs.values()]);
    if (this.agentView.current.activeSessionId !== null) return;
    if (!this.sessionManager.knows(sessionId)) return;
    this.sessionManager.activate(sessionId);
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
   * § Agents' persist-connect-verify flow, P17): registry or custom command,
   * same `connectFromSource` either way. */
  async connectAgentCommand(): Promise<void> {
    const items = [
      ...this.registryData.agents
        .filter((a) => !("error" in resolveDistribution(a)))
        .map((a) => ({ label: a.name, registryId: a.id as string | undefined })),
      { label: "Custom command…", registryId: undefined as string | undefined },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Connect agent…" });
    if (picked === undefined) return;
    if (picked.registryId === undefined) {
      const command = await vscode.window.showInputBox({ placeHolder: "command that speaks ACP…" });
      if (command === undefined || command.trim() === "") return;
      await this.connectFromSource({ command });
    } else {
      await this.connectFromSource({ registryId: picked.registryId });
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
    // The policy is a config decision about placing *new* sessions — read
    // from the store-backed spec map so a Settings edit applies to the next
    // session, not the next reconnect; the pool snapshot is only the
    // fallback for a connection with no config write behind it.
    const policy =
      this.configuredAgentSpecs.get(agentId)?.processPolicy ?? primary.spec.processPolicy ?? "auto";
    const hasExisting = primary.sessions.length > 0;
    const used = this.agentView.current.capabilities[agentId]?.concurrentSessions?.used ?? false;
    const isolate = policy === "isolated" || (policy === "auto" && hasExisting && !used);
    if (!isolate) return agentId;
    const poolKey = `${agentId}::iso::${++this.isolationCounter}`;
    // Deliberately the pool entry's spec, snapshot and all: an isolated
    // instance is a sibling of the *running* process (same binary, same
    // env), not a fresh config connect — every live session of one agent
    // must ride the same process reality until an actual (re)connect.
    await this.pool.connect(primary.spec, { poolKey, reportAs: agentId, isolated: true });
    return poolKey;
  }

  /** The single sink for pool.ts's proof-table hits (capabilities.ts
   * CAPABILITY_PROOFS): marks a row used the first time its path is
   * genuinely exercised on the wire, or suspect the first time it rides a
   * failed request. Guarded on current state so a chatty agent (many reads
   * per turn, a usage_update per turn) doesn't flood the patch stream with
   * idempotent events — and so suspicion never speaks over proof. */
  private noteEvidence(agentId: string, row: CapabilityRowId, evidence: "used" | "suspect"): void {
    const cell = this.agentView.current.capabilities[agentId]?.[row];
    if (cell?.used) return;
    if (evidence === "used") this.capabilityTracker.markUsed(agentId, row);
    else if (cell?.suspect !== true) this.capabilityTracker.markSuspect(agentId, row);
  }

  /** Settings-side projections of session-manager events (ui.md § Settings
   * Agents): the sessions-today stat tile. Live sessions' knob surfaces
   * deliberately do NOT feed the Settings offerings: a set_config_option
   * response is the session's option surface *given its current selections*
   * (fast mode exists only on some models, effort lists vary per model) —
   * session state, not provider inventory. Republishing it as agent-level
   * offerings made the Settings default-knob rows track whichever session
   * last touched a knob. Offerings come only from session-independent
   * reads: the connect-time probe (noteOfferings via the capability
   * tracker, plus the probe session's late config_option_update). */
  private relaySettingsDerived(events: readonly AgentViewEvent[]): void {
    for (const event of events) {
      if (event.kind === "sessionCreated" || event.kind === "sessionClosed") {
        this.publishSessionStats();
      }
    }
  }

  /** Knob offerings for Settings — connection-scoped, in-memory only
   * (architecture.md § Session model: offerings are read, never stored).
   * Sources: the connect-time probe read only (session/new response plus
   * the probe's late config_option_update) — a fresh session at agent
   * defaults, so its surface is the one a new session will actually offer.
   * Never live sessions: their surfaces are conditioned on their own
   * selections (see relaySettingsDerived). Each read is a complete
   * normalized surface (knobs.ts exclusivity killed the old modes/options
   * two-half merge), so every observation replaces wholesale. An empty
   * surface is not an observation. */
  private noteOfferings(agentId: string, normalized: NormalizedKnobs): void {
    if (normalized.surface === "none") return;
    this.settings.emit({
      kind: "agentKnobsObserved",
      agentId,
      knobs: { knobs: toOfferedKnobs(normalized.knobs) },
    });
  }

  /** The "last open session" pointer (stores/last-active-session.ts).
   * Every activation flows through the session-manager emit hook, so this
   * one chokepoint keeps the pointer honest; close (user click or prune)
   * clears it only while it still points there. */
  private recordLastActive(events: readonly AgentViewEvent[]): void {
    for (const event of events) {
      if (event.kind === "sessionActivated") void this.lastActiveSession.set(event.sessionId);
      else if (event.kind === "sessionClosed") void this.lastActiveSession.clearIf(event.sessionId);
    }
  }

  /** Done-sound (Preferences): the system chime as a turn resolves —
   * host-side (sound.ts header: webviews die when hidden). A cancelled
   * turn never chimes: the user was present to cancel it. */
  private maybeChime(events: readonly AgentViewEvent[]): void {
    for (const event of events) {
      if (event.kind !== "turnEnded" || event.stopReason === "cancelled") continue;
      if (!this.preferences.get().soundOnDone) return;
      playDoneSound(this.log);
      return; // one chime per batch, however many turns settled together
    }
  }

  private publishSessionStats(): void {
    this.settings.emit({
      kind: "sessionStatsChanged",
      sessionsToday: this.sessionManager.createdTodayCount(),
    });
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
   * is management, not delivery — lists what's on disk per the asset table's
   * mapping, an unmapped agent shown as such, never guessed. Runs on every
   * connect and on the Settings section's explicit refresh. */
  private async refreshAgentAssets(agentId: string): Promise<void> {
    // Keyed by the registry id when the config records one (heals configs
    // whose own id predates the registry naming), the agent id otherwise.
    const key = this.agentConfigs.get(agentId)?.registrySource?.registryId ?? agentId;
    const assets = await resolveAgentAssets(
      this.assetFs,
      this.workspaceRoot ?? process.cwd(),
      agentId,
      ASSET_LOCATIONS[key] ?? null,
    );
    this.settings.emit({ kind: "agentAssetsChanged", assets });
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
        // Stored {mode, options} folds to the knob-id-keyed seed here — the
        // one door legacy defaults re-enter memory through.
        defaults: foldSeed(agent.defaults),
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
      autoConnect: config.autoConnect,
      // The view's folded seed is stored under `options` alone — the legacy
      // `mode` field is read (foldSeed) but never written again.
      defaults: { options: { ...config.defaults } },
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
   * the process goes down (isolated instances included), the agent leaves
   * both channel states via the `agentRemoved` event, its per-agent facts
   * (used capabilities, observed knobs) are purged so a future re-add
   * starts honest, and its session rows leave the drawer. Nothing to ask
   * the user: patchbay holds no session history — the sessions live on in
   * the agent's own store and reappear via session/list on a re-add. */
  private async removeAgentConfig(agentId: string): Promise<void> {
    await this.pool.stopAllFor(agentId);
    this.sessionManager.invalidateAgent(agentId);
    this.sessionManager.forgetAgentSessions(agentId);
    await this.agentConfigs.remove(agentId);
    await this.usedCapabilities.remove(agentId);
    await this.agentEnv.remove(agentId);
    await rm(join(this.probeRootBase, agentId), { recursive: true, force: true }).catch(() => {});
    this.configuredAgentSpecs.delete(agentId);
    this.agentNames.delete(agentId);
    const removed = { kind: "agentRemoved", agentId } as const;
    this.agentView.emit(removed);
    this.settings.emit(removed);
    await this.refreshAgentConfigs();
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
    const n = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
    const agentConfigs = this.agentConfigs.list();
    const agentEnvCount = (await Promise.all(agentConfigs.map((c) => this.agentEnv.get(c.id)))).reduce(
      (sum, env) => sum + Object.keys(env).length,
      0,
    );
    const integrations = this.integrationConfigs.list();
    const integrationEnvCount = (
      await Promise.all(integrations.map((i) => this.integrationEnv.get(i.id)))
    ).reduce((sum, env) => sum + Object.keys(env).length, 0);
    let tokenCount = 0;
    for (const i of integrations) {
      if ((await this.integrationTokens.get(i.id)) !== null) tokenCount++;
    }
    const rules = this.permissionRules.get();
    const machineRules = this.machinePermissionRules.get();
    const rows: DataInventoryRow[] = [
      { id: "agent-configs", label: "Agent configs", placement: "globalState", detail: n(agentConfigs.length, "agent") },
      { id: "integration-configs", label: "MCP server configs", placement: "globalState", detail: n(integrations.length, "server") },
      { id: "used-capabilities", label: "Used-capability cache", placement: "globalState", detail: n(this.usedCapabilities.list().length, "agent record") },
      { id: "machine-rules", label: "Command rules — this machine", placement: "globalState", detail: n(machineRules.commandRules.length, "rule") },
      { id: "spawn-registry", label: "Spawn registry", placement: "globalState", detail: n(this.spawnRegistry.list().length, "process record") },
      {
        id: "preferences",
        label: "Preferences",
        placement: "globalState",
        detail: (() => {
          const p = this.preferences.get();
          const idle = p.idleCloseMinutes <= 0 ? "never" : `${p.idleCloseMinutes} min`;
          return `sound ${p.soundOnDone ? "on" : "off"} · knobs: ${p.knobSource === "last-session" ? "last used" : "agent defaults"} · idle release ${idle}`;
        })(),
      },
      { id: "last-knobs", label: "Last-used knobs", placement: "globalState", detail: n(this.lastKnobs.count(), "agent record") },
      {
        id: "secrets",
        label: "Credentials & env values",
        placement: "SecretStorage",
        detail: `${n(agentEnvCount + integrationEnvCount, "env value")} · ${n(tokenCount, "OAuth token")}`,
      },
      {
        id: "workspace-rules",
        label: "Command rules & file-write scope — this workspace",
        placement: "workspaceState",
        detail: `${n(rules.commandRules.length, "rule")} · scope: ${rules.fileWriteScope}`,
      },
      { id: "decision-audit", label: "Decision audit", placement: "workspace storage", detail: n(await this.decisionAudit.count(), "entry") },
    ];
    this.settings.emit({ kind: "dataInventoryChanged", rows });
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
        autoConnect: c.autoConnect,
        defaults: foldSeed(c.defaults),
        registrySource: c.registrySource,
        lastSeenVersion: c.lastSeenVersion,
      })),
    );
    this.settings.emit({ kind: "agentConfigsChanged", configs });
  }

  /** `agentInfo.version` is reality (whoami.md: "reality is the source of
   * truth") — recorded on the config so the registry's live version
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
    this.registryData = data;
    const event = {
      kind: "registryChanged",
      agents: data.agents.map((a) => registryAgentView(a, data.icons)),
      fetchedAt: data.fetchedAt,
    } as const;
    this.agentView.emit(event);
    this.settings.emit(event);
  }

  /** Connect an agent from config or registry; upserts it into both channel
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
    const merged = { ...spec, env: { ...spec.env, ...env } };
    await this.pool.connect(merged);
    void this.refreshAgentAssets(spec.agentId);
    void this.warnOnPathDivergence(merged);
  }

  /** Two installs, one memory: a PATH-installed sibling CLI shares the
   * agent's per-user state store with the copy patchbay runs — by design,
   * but a wide version gap means two writers of different vintages on one
   * store (launcher-health.ts PATH_SIBLINGS). Warning only, never a gate;
   * once per exact version pair so reconnects don't nag. */
  private async warnOnPathDivergence(spec: LaunchSpec): Promise<void> {
    try {
      const d = await checkPathDivergence(spec);
      if (d === null) return;
      const key = `${spec.agentId}:${d.pathVersion}:${d.bundledVersion}`;
      if (this.divergenceWarned.has(key)) return;
      this.divergenceWarned.add(key);
      void vscode.window.showWarningMessage(
        `${spec.name}: the \`${d.bin}\` on your PATH is v${d.pathVersion}, but patchbay runs v${d.bundledVersion}. Both share the same ${d.bin} state (sessions, auth, config) — a wide version gap between the two writers can bite. Consider updating the PATH install.`,
      );
    } catch {
      // A diagnostic nicety must never affect a connect.
    }
  }

  /** Restart is a spawn, so it reads reality like any connect: the current
   * config spec and fresh SecretStorage env — never the pool entry's
   * connect-time snapshot (a command edit or key rotation in Settings must
   * reach the very next spawn). No config behind the connection: the
   * snapshot is all there is, and pool.restart falls back to it. */
  private async restartAgent(agentId: string): Promise<void> {
    const spec = this.configuredAgentSpecs.get(agentId);
    if (spec === undefined) {
      await this.pool.restart(agentId);
      return;
    }
    const env = await this.agentEnv.get(agentId);
    await this.pool.restart(agentId, { ...spec, env: { ...spec.env, ...env } });
  }

  /** Resolves a registry agent's declared distribution into a spawnable
   * spec. npx/uvx are ecosystem-managed installs — spawning them *is*
   * installing, nothing extra to do. A `binary` distribution not yet cached
   * for this exact version gates on an explicit download confirmation (no
   * checksum exists in the registry spec, binary-installer.ts) — `confirmed`
   * skips that gate once the user has already said yes. Returns null when
   * the agent can't be resolved right now (unavailable on this platform) or
   * a confirmation is now pending. */
  private async resolveRegistryLaunch(
    agent: RegistryAgent,
    verifyAfterConnect: boolean,
    confirmed = false,
  ): Promise<{ spec: LaunchSpec; registrySource: AgentConfig["registrySource"] } | null> {
    const launch = resolveDistribution(agent);
    const cwd = this.workspaceRoot ?? process.cwd();
    if ("error" in launch) return null; // reason already visible on the picker row
    switch (launch.kind) {
      case "npx":
      case "uvx":
        return {
          spec: { agentId: agent.id, name: agent.name, command: launch.command, args: [...launch.args], env: { ...launch.env }, cwd },
          registrySource: { registryId: agent.id, distributionKind: launch.kind, pinnedVersion: agent.version },
        };
      case "binary": {
        const installed =
          confirmed || (await isBinaryInstalled(this.binaryCacheDir, agent.id, agent.version, launch.cmd));
        if (!installed) {
          this.pendingBinaryConfirms.set(agent.id, { agent, verifyAfterConnect });
          this.settings.emit({
            kind: "binaryInstallPending",
            install: { agentId: agent.id, name: agent.name, archiveUrl: launch.archiveUrl, cmd: launch.cmd },
          });
          return null;
        }
        const binary = await installBinary(this.binaryCacheDir, {
          agentId: agent.id,
          version: agent.version,
          archiveUrl: launch.archiveUrl,
          cmd: launch.cmd,
          args: [...launch.args],
          env: { ...launch.env },
        });
        return {
          spec: { agentId: agent.id, name: agent.name, command: binary.command, args: [...binary.args], env: { ...binary.env }, cwd: binary.cwd },
          registrySource: { registryId: agent.id, distributionKind: "binary", pinnedVersion: agent.version },
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
      autoConnect: existing?.autoConnect ?? false,
      defaults: existing?.defaults ?? (spec.defaults !== undefined ? { options: spec.defaults } : {}),
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
        void this.restartAgent(action.agentId).catch(this.logCatch(`restart ${action.agentId}`));
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
      case "setWireLog":
        void this.setWireLog(action.active);
        break;
      case "refreshDataInventory":
        void this.publishDataInventory();
        break;
      case "switchSession":
        // Switching NEVER closes the session being left — open sessions
        // stay attached until the idle reaper's full predicate says
        // otherwise (session-manager.ts reapIdle).
        this.sessionManager.activate(action.sessionId);
        // A session click is a connect trigger — the running agent is the
        // session's prerequisite (composer stays disabled until then).
        void this.connectForSession(action.sessionId);
        break;
      case "closeSession":
        void this.sessionManager.close(action.sessionId);
        this.broker.cancelPending(action.sessionId); // same duty: an abandoned turn answers cancelled
        break;
      case "reloadSession":
        void this.sessionManager.reload(action.sessionId).catch(this.logCatch(`reload ${action.sessionId}`));
        break;
      // A rejected set leaves authoritative state unchanged — republish it
      // (fresh identity) so the pill's pending spinner settles back to truth.
      case "setSessionKnob":
        void this.sessionManager
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
        // failure surfaces as sessionLiveChanged(false) with no new text — no reply channel by design
        void this.sessionManager
          .sendPrompt(action.sessionId, action.text, action.parts)
          .catch(this.logCatch(`sendPrompt ${action.sessionId}`));
        break;
      case "stopTurn":
        void this.sessionManager.stopTurn(action.sessionId);
        // Spec § Cancellation (MUST): pending permission requests resolve
        // with the cancelled outcome — the agent is not left hanging.
        this.broker.cancelPending(action.sessionId);
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
      case "authenticateAgent": {
        // failure leaves needsAuth set — the honest signal, no separate reply channel
        const recipe = this.authRecipes.get(action.agentId)?.get(action.methodId);
        if (recipe !== undefined) {
          // terminal-recipe method: the login runs in a visible terminal,
          // `authenticate` is never called on it (meta.ts).
          void this.loginViaTerminal(action.agentId, recipe).catch(
            this.logCatch(`terminal login ${action.agentId}`),
          );
        } else {
          void this.capabilityTracker
            .authenticate(action.agentId, action.methodId)
            .catch(this.logCatch(`authenticate ${action.agentId}`));
        }
        break;
      }
      case "logoutAgent":
        // the UI only offers this on a declared auth.logout; the follow-up
        // probe re-raises needsAuth if sessions now need a login again
        void this.capabilityTracker
          .logout(action.agentId)
          .catch(this.logCatch(`logout ${action.agentId}`));
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
      case "refreshRegistry":
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
      case "setPreferences":
        void this.preferences
          .set(action.patch)
          .then((preferences) => this.settings.emit({ kind: "preferencesChanged", preferences }));
        break;
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
          sourceUri: `${vscode.Uri.file(selection.file)}#L${selection.startLine}-${selection.endLine}`,
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
          sourceUri: vscode.Uri.file(file.file).toString(),
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
        void this.sessionManager
          .removeRoot(action.sessionId, action.path)
          .catch(this.logCatch(`removeRoot ${action.sessionId}`));
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
      case "queryWorkspaceFiles":
        void this.queryWorkspaceFiles(action.query).catch(
          this.logCatch(`queryWorkspaceFiles "${action.query}"`),
        );
        break;
    }
  }

  /** The `@` mention picker's workspace tier (render-only-webview: the
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
      const name = path.split(/[\\/]/).pop()!.toLowerCase();
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
    await this.sessionManager.addRoot(sessionId, uri.fsPath);
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
      sourceUri: uri.toString(),
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
    await this.connectFromSource({ registryId: pending.agent.id }, pending.verifyAfterConnect, true);
  }

  private cancelBinaryInstall(agentId: string): void {
    this.pendingBinaryConfirms.delete(agentId);
    this.settings.emit({ kind: "binaryInstallResolved", agentId });
  }

  /** Re-resolves the registry's current (possibly newer) pinned version and
   * reconnects — the same path a first Add takes, so the version-keyed
   * used-capability cache and the binary-install confirmation both apply
   * exactly as they would for a brand-new agent. Never silent: a
   * still-uncached binary version re-gates on the download confirmation. */
  private async upgradeAgent(agentId: string): Promise<void> {
    const config = this.agentConfigs.get(agentId);
    if (config === undefined || config.registrySource === null) return;
    if (this.pool.get(agentId)?.status === "running") await this.pool.stop(agentId);
    await this.connectFromSource({ registryId: config.registrySource.registryId });
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
    // A still-new (never-prompted) session for this agent already IS the
    // new session — focus it instead of minting a sibling blank shell.
    const draft = this.sessionManager.findNeverPrompted(agentId);
    if (draft !== undefined) {
      this.sessionManager.activate(draft);
      return;
    }
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
      const raw = err instanceof Error ? err.message : String(err);
      this.agentView.emit({ kind: "chatConnectFailed", agentId, reason: this.connectFailureReason(agentId, err, raw) });
      this.log.error(`startChat ${agentId}: ${raw}`);
    }
  }

  /** The session-click half of P17's connect-on-demand: opening a session
   * whose configured agent is off spawns it, through the same in-pane
   * chatConnect states startChat uses — but no session is minted: on
   * success the status-running hook re-syncs and hydrates the now-active
   * session, and `forSessionId` makes the failure pane's Retry re-open this
   * session instead of starting a new chat. Unconfigured agents stay
   * untouched — the row is a readable record, nothing more to offer. */
  private async connectForSession(sessionId: string): Promise<void> {
    const agentId = this.sessionManager.agentFor(sessionId);
    if (agentId === undefined) return;
    if (this.pool.get(agentId)?.status === "running") return;
    const spec = this.configuredAgentSpecs.get(agentId);
    if (spec === undefined) return;
    if (this.agentView.current.chatConnect?.status === "connecting") return; // one at a time
    this.agentView.emit({ kind: "chatConnectStarted", agentId, forSessionId: sessionId });
    try {
      await this.connectAgent(spec);
      this.agentView.emit({ kind: "chatConnectResolved" });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      this.agentView.emit({
        kind: "chatConnectFailed",
        agentId,
        reason: this.connectFailureReason(agentId, err, raw),
        forSessionId: sessionId,
      });
      this.log.error(`connect for session ${sessionId} (${agentId}): ${raw}`);
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
    if ("registryId" in source) {
      const agent = this.registryData.agents.find((a) => a.id === source.registryId);
      if (agent === undefined) return;
      const resolved = await this.resolveRegistryLaunch(agent, verifyAfterConnect, confirmed);
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

  /** Prefer the pool's own crash detail (spawn failed / initialize failed)
   * over a raw wire error; map auth_required to what actually unblocks it —
   * the agent's own instruction when it gave one beyond the bare
   * "authentication required" (an agent with no login methods, like Auggie,
   * names the exact CLI command there), the Settings § Agents pointer
   * otherwise. */
  private connectFailureReason(agentId: string, err: unknown, raw: string): string {
    if (err instanceof RequestError && err.code === -32000) {
      const informative =
        raw.trim() !== "" && !/^authentication required\.?$/i.test(raw.trim());
      return informative ? raw : "needs login first — use Log in on this agent in Settings § Agents";
    }
    return this.pool.get(agentId)?.detail ?? raw;
  }

  /** Formats a swallowed action failure for the Output channel — these
   * actions have no reply channel by design (state itself is the only
   * signal back to the UI), but silently dropping the error entirely left
   * nothing to debug from. */
  private logCatch(context: string): (err: unknown) => void {
    return (err) => this.log.error(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** terminal-auth login (meta.ts): runs the method's recipe in a visible
   * VS Code terminal — the user watches the login happen in the agent's own
   * flow. The terminal closing is the only "done" signal the convention
   * gives; whether it *worked* is never guessed: the follow-up re-probe
   * (same span as Verify, so the card reads "Verifying…") either clears
   * needsAuth or re-raises it through the one -32000 chokepoint. */
  private async loginViaTerminal(agentId: string, recipe: TerminalAuthRecipe): Promise<void> {
    const terminal = vscode.window.createTerminal({
      name: recipe.label ?? `${this.agentNames.get(agentId) ?? agentId} login`,
      shellPath: recipe.command,
      shellArgs: [...recipe.args],
      env: recipe.env,
    });
    terminal.show();
    await new Promise<void>((resolve) => {
      const sub = vscode.window.onDidCloseTerminal((t) => {
        if (t !== terminal) return;
        sub.dispose();
        resolve();
      });
    });
    await this.runVerify(agentId);
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
    this.sessionManager.dispose();
    for (const d of this.editorSubscriptions) d.dispose();
    this.editorStateHost.stop();
    this.acpRegistry.dispose();
    void this.pool.disposeAll();
    this.agentView.flushNow();
    this.settings.flushNow();
    this.statusBarItem.dispose();
    this.wireLog.dispose();
    this.wireChannel?.dispose();
    this.wireStatusItem?.dispose();
    if (this.wireStatusTimer !== null) clearInterval(this.wireStatusTimer);
  }
}
