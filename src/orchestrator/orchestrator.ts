// Orchestrator: the Node process in the extension host — single source of
// truth for sessions, capability tables, permission rules, secrets,
// configuration. Webviews only ever see its snapshots and patches.
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
  type AgentViewEvent,
  type AgentViewState,
  type ConnectAgentSource,
  type PermissionOptionView,
  type SettingsEvent,
  type SettingsState,
} from "../shared/protocol";
import { applyFileWrite, PermissionBroker } from "./broker";
import { CapabilityVerifier } from "./capability-verifier";
import { ChannelHost } from "./channel";
import { parseCommandLine } from "./command-line";
import { EditorStateHost } from "./editor-state-host";
import { IntegrationsManager } from "./integrations";
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
  /** Set by the webview host as the Agent View mounts/unmounts (P11 wires
   * the real visibility signal); defaults to "visible" so native
   * notifications don't fire spuriously before that's connected. */
  isAgentViewVisible: () => boolean = () => true;

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
    this.integrations = new IntegrationsManager(loadRegistry(), this.configFile, this.integrationTokens, {
      emit: (...events) => this.settings.emit(...events),
    });

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
      onReadTextFile: async (_agentId, params) => ({ content: await this.readTextFileLive(params.path) }),
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
      case "connectRegistryIntegration":
        void this.integrations.connectRegistry(action.registryId);
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
    }
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
  }
}

function launchCommandText(agent: AgentConfig): string {
  return [agent.command, ...agent.args].join(" ");
}
