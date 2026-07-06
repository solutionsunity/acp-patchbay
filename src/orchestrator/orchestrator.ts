// Orchestrator: the Node process in the extension host — single source of
// truth for sessions, capability tables, permission rules, secrets,
// configuration. Webviews only ever see its snapshots and patches.
import { join } from "node:path";
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
  type PermissionOptionView,
  type SettingsEvent,
  type SettingsState,
} from "../shared/protocol";
import { resolveAgentAssets, type FsLike } from "./asset-locations";
import { applyFileWrite, PermissionBroker } from "./broker";
import { CapabilityVerifier } from "./capability-verifier";
import { ChannelHost } from "./channel";
import { parseCommandLine } from "./command-line";
import { EditorStateHost } from "./editor-state-host";
import { IntegrationsManager } from "./integrations";
import { OAuthCallbackRegistry } from "./oauth-callback";
import { AgentPool, type LaunchSpec } from "./pool";
import { SessionManager } from "./session-manager";
import { WorkspaceAgentAdoptionStore } from "./stores/adoption";
import { ConfigFileStore, CONFIG_RELATIVE_PATH, type AgentConfig } from "./stores/config-file";
import { DecisionAuditStore } from "./stores/decision-audit";
import { IntegrationTokenStore } from "./stores/integration-tokens";
import { LastKnownViewStore } from "./stores/last-known-view";
import { PermissionRulesStore } from "./stores/permission-rules";
import { loadRegistry } from "./stores/registry";
import { loadRoster, type RosterAgent } from "./stores/roster";
import { SessionIndexStore } from "./stores/session-index";
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

  readonly sessionIndex: SessionIndexStore;
  readonly decisionAudit: DecisionAuditStore;
  readonly lastKnownView: LastKnownViewStore;
  readonly configFile: ConfigFileStore;
  readonly permissionRules: PermissionRulesStore;
  readonly adoption: WorkspaceAgentAdoptionStore;
  readonly roster: RosterAgent[];
  readonly pool: AgentPool;
  readonly sessionManager: SessionManager;
  readonly capabilityVerifier: CapabilityVerifier;
  readonly broker: PermissionBroker;
  readonly editorStateHost: EditorStateHost;
  readonly integrationTokens: IntegrationTokenStore;
  readonly integrations: IntegrationsManager;
  /** Pending OAuth callbacks — extension.ts's UriHandler feeds this. */
  readonly oauthCallbacks = new OAuthCallbackRegistry();

  private readonly workspaceRoot: string | null;
  private readonly agentNames = new Map<string, string>();
  private readonly workspaceAgentSpecs = new Map<string, LaunchSpec>();
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
  /** Set by the webview host as the Agent View mounts/unmounts (wired in
   * extension.ts to `AgentViewProvider`'s real `onDidChangeVisibility`
   * signal, P6); defaults to "visible" so native notifications don't fire
   * spuriously before that's connected. */
  isAgentViewVisible: () => boolean = () => true;
  private statusBarItem!: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    this.workspaceRoot = workspaceRoot;
    this.mcpServerScriptPath = vscode.Uri.joinPath(context.extensionUri, "out", "mcp-server.js").fsPath;
    this.integrationBridgeScriptPath = vscode.Uri.joinPath(
      context.extensionUri,
      "out",
      "integration-bridge.js",
    ).fsPath;

    this.sessionIndex = new SessionIndexStore(context.workspaceState);
    this.permissionRules = new PermissionRulesStore(context.workspaceState);
    this.adoption = new WorkspaceAgentAdoptionStore(context.workspaceState);
    this.decisionAudit = new DecisionAuditStore(context.storageUri?.fsPath ?? null);
    this.lastKnownView = new LastKnownViewStore(context.storageUri?.fsPath ?? null);
    this.configFile = new ConfigFileStore(
      workspaceRoot === null
        ? null
        : vscode.Uri.joinPath(
            vscode.Uri.file(workspaceRoot),
            CONFIG_RELATIVE_PATH,
          ).fsPath,
    );
    this.integrationTokens = new IntegrationTokenStore(context.secrets);
    // OAuth browser/redirect step (docs/reference-mcp-oauth.md, pitfall §1):
    // the redirect target is this extension's own vscode:// URI, passed
    // through asExternalUri so VS Code resolves it correctly under SSH
    // remote / WSL / Codespaces — never a hand-rolled 127.0.0.1 server.
    // extension.ts's registerUriHandler feeds callbacks into oauthCallbacks.
    const extensionId = context.extension.id; // "solutionsunity.acp-patchbay"
    this.integrations = new IntegrationsManager(
      loadRegistry(),
      this.configFile,
      this.integrationTokens,
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
    );

    this.roster = loadRoster();
    const rosterEntries = this.roster.map((a) => ({
      id: a.id,
      name: a.name,
      assetsMapped: a.assets !== null,
      knownBypassBridge: a.knownBypassBridge,
    }));

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
        fileWriteScope: rules.fileWriteScope,
        integrationRegistry: this.integrations.registryViews(),
      },
      reduceSettings,
      coalesceSettingsEvent,
      onAction,
    );
    // Pool hooks close over `this` and only fire once the pool is actually
    // used (after the constructor returns), so referencing sessionManager /
    // capabilityVerifier / broker here — before they're assigned below — is
    // safe; this is the same lazy-closure pattern all three use themselves.
    this.pool = new AgentPool({
      onStatusChanged: (agentId, status, detail) => {
        const event = { kind: "agentStatusChanged", agentId, status, detail } as const;
        this.agentView.emit(event);
        this.settings.emit(event);
        // A dead or reconnecting connection invalidates every sessionId that
        // rode it — they must reopen (possibly via session/load) before reuse.
        if (status === "crashed" || status === "reconnecting") {
          this.sessionManager.invalidateAgent(agentId);
        }
      },
      onIsolatedStatusChanged: (poolKey, _agentId, status) => {
        // Not surfaced in the Agents list (P8: isolated instances are an
        // implementation detail) — only the sessions riding this specific
        // poolKey need to know their process is gone.
        if (status === "crashed" || status === "reconnecting") {
          this.sessionManager.invalidatePoolKey(poolKey);
        }
      },
      onDeclaredCaptured: (agentId, declared) => this.capabilityVerifier.onDeclared(agentId, declared),
      onSessionUpdate: (agentId, notification) =>
        this.sessionManager.handleUpdate(agentId, notification),
      onConcurrentSessionsVerified: (agentId) =>
        this.capabilityVerifier.markVerified(agentId, "concurrentSessions"),
      onPermissionRequest: async (_agentId, params) => {
        const subject =
          params.toolCall.kind === "edit" ? (params.toolCall.locations?.[0]?.path ?? null) : null;
        const result = await this.broker.resolveAgentPermissionRequest(
          params.sessionId,
          params.toolCall.title ?? "Permission request",
          params.toolCall.kind ?? "other",
          subject,
          optionViewsFromAcp(params.options),
        );
        return "cancelled" in result
          ? { outcome: { outcome: "cancelled" } }
          : { outcome: { outcome: "selected", optionId: result.optionId } };
      },
      onReadTextFile: async (agentId, params) => {
        const content = await this.readTextFileLive(params.path);
        this.verifyObserved(agentId, "fs.readTextFile");
        return { content };
      },
      onWriteTextFile: async (agentId, params) => {
        const { accepted } = await this.broker.gateFileWrite(params.sessionId, params.path, params.content);
        if (accepted) await applyFileWrite(params.path, params.content);
        // A rejected write still verifies: "brokered" means the agent routes
        // writes through patchbay's gate, and a rejection is the gate working.
        this.verifyObserved(agentId, "fs.writeTextFile");
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
        this.verifyObserved(agentId, "terminal");
        const terminalId = `term-${++this.terminalCounter}`;
        this.terminals.set(terminalId, handle);
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
        this.terminals.delete(params.terminalId);
        return {};
      },
    });
    this.editorStateHost = new EditorStateHost(String(process.pid), {
      requestUserInput: (contextToken, params) => this.requestUserInput(contextToken, params),
      getIntegrationToken: (integrationId) => this.integrations.getToken(integrationId),
    });
    this.editorStateHost.start();

    this.sessionManager = new SessionManager(
      this.pool,
      this.sessionIndex,
      {
        emit: (...events) => {
          this.agentView.emit(...events);
          this.persistLastKnownViewIfNeeded(events);
        },
        mapContextToken: (token, sessionId) => this.contextTokenToSession.set(token, sessionId),
        resolveProcessFor: (agentId) => this.resolveProcessFor(agentId),
        isForkVerified: (agentId) =>
          this.agentView.current.capabilities[agentId]?.["session.fork"]?.verified ?? false,
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
    );
    this.capabilityVerifier = new CapabilityVerifier(this.pool, {
      emit: (...events) => {
        this.agentView.emit(...events);
        this.settings.emit(...events);
      },
    });
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
    );

    void this.refreshAuditTail();
    void this.loadWorkspaceConfigAgents();
    void this.integrations.refresh();

    // Native surfaces (P11): the status bar mirrors canonical state via
    // ChannelHost.onChange — no webview in the path (architecture.md § UI
    // layer: "direct orchestrator consumers: same state, no webview").
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = "acpPatchbay.agentView.focus";
    this.statusBarItem.show();
    this.agentView.onChange(() => this.refreshStatusBar());
    this.refreshStatusBar();

    void this.connectDefaultAgent();
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

  /** Command palette (features.md § 3): "new session" — pick a running
   * agent, create, and focus the Agent View on it. */
  async newSessionCommand(): Promise<void> {
    const running = this.pool.list().filter((a) => a.status === "running");
    if (running.length === 0) {
      void vscode.window.showInformationMessage("Connect an agent first.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      running.map((a) => ({
        label: this.agentNames.get(a.spec.agentId) ?? a.spec.agentId,
        agentId: a.spec.agentId,
      })),
      { placeHolder: "New session with…" },
    );
    if (picked === undefined) return;
    const agentName = this.agentNames.get(picked.agentId);
    if (agentName === undefined) return;
    await this.sessionManager.createSession(picked.agentId, agentName, this.workspaceRoot ?? process.cwd());
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

  /** "Connect agent" — the same roster-or-custom-command choice the Agent
   * View's Agents drawer offers, reachable without opening it first. */
  async connectAgentCommand(): Promise<void> {
    const items = [
      ...this.roster.map((a) => ({ label: a.name, rosterId: a.id as string | undefined })),
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
   * `auto` (default) shares only once concurrent-session behavior is
   * *verified* on the primary connection, isolating every session before
   * that — a fork always rides its parent's poolKey regardless (SessionManager
   * never calls this for a fork), so verification bootstraps organically the
   * first time a branch shares a connection with an existing session. */
  private async resolveProcessFor(agentId: string): Promise<string> {
    const primary = this.pool.get(agentId);
    if (primary === undefined) return agentId;
    const policy = primary.spec.processPolicy ?? "auto";
    const hasExisting = primary.sessions.length > 0;
    const verified = this.agentView.current.capabilities[agentId]?.concurrentSessions?.verified ?? false;
    const isolate = policy === "isolated" || (policy === "auto" && hasExisting && !verified);
    if (!isolate) return agentId;
    const poolKey = `${agentId}::iso::${++this.isolationCounter}`;
    await this.pool.connect(primary.spec, { poolKey, reportAs: agentId, isolated: true });
    return poolKey;
  }

  /** Opportunistic behavior-level verification (architecture.md § capability
   * matrix; plan.md P5's "first fs success / first terminal" hooks): marks a
   * row verified the first time its path is genuinely exercised on the wire.
   * Guarded on current state so a chatty agent (many reads per turn) doesn't
   * flood the patch stream with idempotent events. */
  private verifyObserved(agentId: string, row: CapabilityRowId): void {
    if (this.agentView.current.capabilities[agentId]?.[row]?.verified) return;
    this.capabilityVerifier.markVerified(agentId, row);
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

  private async loadWorkspaceConfigAgents(): Promise<void> {
    const result = await this.configFile.read();
    if (!result.ok) return;
    for (const agent of result.config.agents) {
      const spec: LaunchSpec = {
        agentId: agent.id,
        name: agent.name,
        command: agent.command,
        args: agent.args,
        env: agent.env,
        cwd: this.workspaceRoot ?? process.cwd(),
        processPolicy: agent.processPolicy,
        defaults: agent.defaults,
      };
      this.workspaceAgentSpecs.set(agent.id, spec);
      if (this.adoption.isAdopted(agent.id)) {
        this.agentNames.set(agent.id, agent.name);
        continue; // already adopted in an earlier session — connect stays a user action, not automatic
      }
      this.settings.emit({
        kind: "workspaceAgentPending",
        agent: { agentId: agent.id, name: agent.name, command: launchCommandText(agent) },
      });
    }
    await this.refreshAgentConfigs();
  }

  /** Settings § Agents (features.md: "add, edit, and remove agents,
   * including launch configuration per agent") — persists to the same
   * workspace config file repo-defined agents already use. Adoption is
   * marked immediately: the user just typed this command themselves, right
   * now, which is exactly the trust the one-time adoption gate exists to
   * establish for a config file someone else might have authored. */
  private async addOrUpdateAgentConfig(config: AgentConfigView): Promise<void> {
    await this.configFile.upsertAgent({
      id: config.id,
      name: config.name,
      command: config.command,
      args: [...config.args],
      env: { ...config.env },
      processPolicy: config.processPolicy,
      defaults: { ...config.defaults },
    });
    await this.adoption.adopt(config.id);
    this.workspaceAgentSpecs.set(config.id, {
      agentId: config.id,
      name: config.name,
      command: config.command,
      args: [...config.args],
      env: { ...config.env },
      cwd: this.workspaceRoot ?? process.cwd(),
      processPolicy: config.processPolicy,
      defaults: config.defaults,
    });
    this.agentNames.set(config.id, config.name);
    await this.refreshAgentConfigs();
  }

  private async removeAgentConfig(agentId: string): Promise<void> {
    await this.configFile.removeAgent(agentId);
    this.workspaceAgentSpecs.delete(agentId);
    await this.refreshAgentConfigs();
  }

  private async refreshAgentConfigs(): Promise<void> {
    const result = await this.configFile.read();
    const configs: AgentConfigView[] = result.ok
      ? result.config.agents.map((a) => ({
          id: a.id,
          name: a.name,
          command: a.command,
          args: a.args,
          env: a.env,
          processPolicy: a.processPolicy,
          defaults: a.defaults,
        }))
      : [];
    this.settings.emit({ kind: "agentConfigsChanged", configs });
  }

  /** Connect an agent from config or roster; upserts it into both channel states. */
  async connectAgent(spec: LaunchSpec): Promise<void> {
    this.agentNames.set(spec.agentId, spec.name);
    const upsert = {
      kind: "agentUpserted",
      agent: { id: spec.agentId, name: spec.name, status: "reconnecting" },
    } as const;
    this.agentView.emit(upsert);
    this.settings.emit(upsert);
    await this.pool.connect(spec);
    void this.refreshAgentAssets(spec.agentId);
  }

  launchSpecForRosterAgent(agent: RosterAgent): LaunchSpec {
    return {
      agentId: agent.id,
      name: agent.name,
      command: agent.command,
      args: agent.args,
      env: agent.env,
      cwd: this.workspaceRoot ?? process.cwd(),
    };
  }

  private handleAction(action: Action): void {
    switch (action.kind) {
      case "openSettings":
        void vscode.commands.executeCommand("acpPatchbay.openSettings");
        break;
      case "connectAgent":
        void this.connectFromSource(action.source);
        break;
      case "restartAgent":
        // failure surfaces as a crashed status patch — no reply channel by design
        void this.pool.restart(action.agentId).catch(() => {});
        break;
      case "stopAgent":
        void this.pool.stop(action.agentId);
        break;
      case "newSession": {
        const agentName = this.agentNames.get(action.agentId);
        if (agentName === undefined) break; // unknown agent — nothing to create
        void this.sessionManager.createSession(
          action.agentId,
          agentName,
          this.workspaceRoot ?? process.cwd(),
        );
        break;
      }
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
        void this.sessionManager.branch(action.sessionId, transcript).catch(() => {});
        break;
      }
      case "reloadSession":
        void this.sessionManager.reload(action.sessionId).catch(() => {});
        break;
      case "setSessionMode":
        void this.sessionManager.setMode(action.sessionId, action.modeId);
        break;
      case "setSessionConfigOption":
        void this.sessionManager.setConfigOption(action.sessionId, action.configId, action.value);
        break;
      case "sendPrompt":
        // failure surfaces as sessionLiveChanged(false) with no new text — no reply channel by design
        void this.sessionManager.sendPrompt(action.sessionId, action.text).catch(() => {});
        break;
      case "stopTurn":
        void this.sessionManager.stopTurn(action.sessionId);
        break;
      case "runDiagnostics":
        void this.capabilityVerifier.runDiagnostics(action.agentId);
        break;
      case "resolvePermission":
        this.broker.resolve(action.requestId, action.optionId);
        break;
      case "resolveDiff":
        this.broker.resolve(action.requestId, action.accept ? "accept" : "reject");
        break;
      case "adoptWorkspaceAgent":
        void this.adoptWorkspaceAgent(action.agentId);
        break;
      case "addCommandRule": {
        const rules = this.permissionRules.get();
        void this.permissionRules
          .set({ ...rules, commandRules: [...rules.commandRules, action.rule] })
          .then(() => this.publishRules());
        break;
      }
      case "removeCommandRule": {
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
        void this.integrations.addCustom(action.id, action.name, action.source, action.routing);
        break;
      case "disconnectIntegration":
        void this.integrations.disconnect(action.integrationId);
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
      case "openAssetFile":
        this.openAssetFile(action.path);
        break;
      case "addOrUpdateAgentConfig":
        void this.addOrUpdateAgentConfig(action.config);
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

  /** "Explicit share command that copies config and reattaches credentials
   * only on confirm" (plan.md P9): the sanitized config entry (no
   * credential — none exists here by construction, see config-file.ts) goes
   * to the clipboard for the user to paste into another workspace's config
   * file. Reattaching a credential is never automatic: a pasted entry's
   * `id` has no token in that workspace's own SecretStorage until its user
   * explicitly connects there — workspace-scoped storage makes "following"
   * impossible without extra machinery (features.md's incident-driven rule). */
  private async shareIntegrationConfig(integrationId: string): Promise<void> {
    const result = await this.configFile.read();
    if (!result.ok) return;
    const integration = result.config.integrations.find((i) => i.id === integrationId);
    if (integration === undefined) return;
    await vscode.env.clipboard.writeText(JSON.stringify(integration, null, 2));
  }

  private publishRules(): void {
    const rules = this.permissionRules.get();
    this.settings.emit({
      kind: "permissionRulesChanged",
      commandRules: rules.commandRules,
      fileWriteScope: rules.fileWriteScope,
    });
  }

  private async adoptWorkspaceAgent(agentId: string): Promise<void> {
    if (!vscode.workspace.isTrusted) return; // adoption requires workspace trust, no exceptions
    const spec = this.workspaceAgentSpecs.get(agentId);
    if (spec === undefined) return;
    await this.adoption.adopt(agentId);
    this.settings.emit({ kind: "workspaceAgentAdopted", agentId });
    try {
      await this.connectAgent(spec);
    } catch {
      // pool already emitted the crashed status with detail
    }
  }

  private async connectFromSource(source: ConnectAgentSource): Promise<void> {
    let spec: LaunchSpec | null = null;
    if ("rosterId" in source) {
      const entry = this.roster.find((a) => a.id === source.rosterId);
      if (entry) spec = this.launchSpecForRosterAgent(entry);
    } else if ("configuredId" in source) {
      spec = this.workspaceAgentSpecs.get(source.configuredId) ?? null;
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
    try {
      await this.connectAgent(spec);
    } catch {
      // pool already emitted the crashed status with detail
    }
  }

  dispose(): void {
    this.editorStateHost.stop();
    void this.pool.disposeAll();
    this.agentView.flushNow();
    this.settings.flushNow();
    this.statusBarItem.dispose();
  }
}

function launchCommandText(agent: AgentConfig): string {
  return [agent.command, ...agent.args].join(" ");
}
