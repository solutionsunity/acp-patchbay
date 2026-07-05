// Orchestrator: the Node process in the extension host — single source of
// truth for sessions, capability tables, permission rules, secrets,
// configuration. Webviews only ever see its snapshots and patches.
import * as vscode from "vscode";
import {
  coalesceAgentViewEvent,
  coalesceSettingsEvent,
  initialAgentViewState,
  initialSettingsState,
  reduceAgentView,
  reduceSettings,
  type Action,
  type AgentViewEvent,
  type AgentViewState,
  type ConnectAgentSource,
  type SettingsEvent,
  type SettingsState,
} from "../shared/protocol";
import { CapabilityVerifier } from "./capability-verifier";
import { ChannelHost } from "./channel";
import { parseCommandLine } from "./command-line";
import { AgentPool, type LaunchSpec } from "./pool";
import { SessionManager } from "./session-manager";
import { ConfigFileStore, CONFIG_RELATIVE_PATH } from "./stores/config-file";
import { DecisionAuditStore } from "./stores/decision-audit";
import { PermissionRulesStore } from "./stores/permission-rules";
import { loadRoster, type RosterAgent } from "./stores/roster";
import { SessionIndexStore } from "./stores/session-index";

export class Orchestrator {
  readonly agentView: ChannelHost<AgentViewState, AgentViewEvent>;
  readonly settings: ChannelHost<SettingsState, SettingsEvent>;

  readonly sessionIndex: SessionIndexStore;
  readonly decisionAudit: DecisionAuditStore;
  readonly configFile: ConfigFileStore;
  readonly permissionRules: PermissionRulesStore;
  readonly roster: RosterAgent[];
  readonly pool: AgentPool;
  readonly sessionManager: SessionManager;
  readonly capabilityVerifier: CapabilityVerifier;

  private readonly workspaceRoot: string | null;
  private readonly agentNames = new Map<string, string>();

  constructor(context: vscode.ExtensionContext) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    this.workspaceRoot = workspaceRoot;

    this.sessionIndex = new SessionIndexStore(context.workspaceState);
    this.permissionRules = new PermissionRulesStore(context.workspaceState);
    this.decisionAudit = new DecisionAuditStore(context.storageUri?.fsPath ?? null);
    this.configFile = new ConfigFileStore(
      workspaceRoot === null
        ? null
        : vscode.Uri.joinPath(
            vscode.Uri.file(workspaceRoot),
            CONFIG_RELATIVE_PATH,
          ).fsPath,
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
    this.settings = new ChannelHost(
      { ...initialSettingsState, roster: rosterEntries },
      reduceSettings,
      coalesceSettingsEvent,
      onAction,
    );
    // Pool hooks close over `this` and only fire once the pool is actually
    // used (after the constructor returns), so referencing sessionManager /
    // capabilityVerifier here — before they're assigned below — is safe;
    // this is the same lazy-closure pattern both use themselves.
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
      onDeclaredCaptured: (agentId, declared) => this.capabilityVerifier.onDeclared(agentId, declared),
      onSessionUpdate: (agentId, notification) =>
        this.sessionManager.handleUpdate(agentId, notification),
      onConcurrentSessionsVerified: (agentId) =>
        this.capabilityVerifier.markVerified(agentId, "concurrentSessions"),
    });
    this.sessionManager = new SessionManager(
      this.pool,
      this.sessionIndex,
      { emit: (...events) => this.agentView.emit(...events) },
      () => this.workspaceRoot ?? process.cwd(),
    );
    this.capabilityVerifier = new CapabilityVerifier(this.pool, {
      emit: (...events) => {
        this.agentView.emit(...events);
        this.settings.emit(...events);
      },
    });
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
        void this.sessionManager.close(action.sessionId);
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
    void this.pool.disposeAll();
    this.agentView.flushNow();
    this.settings.flushNow();
  }
}
