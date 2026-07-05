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
  type SettingsEvent,
  type SettingsState,
} from "../shared/protocol";
import { ChannelHost } from "./channel";
import { AgentPool, type LaunchSpec } from "./pool";
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

    const onAction = (action: Action) => this.handleAction(action);
    this.agentView = new ChannelHost(
      initialAgentViewState,
      reduceAgentView,
      coalesceAgentViewEvent,
      onAction,
    );
    this.settings = new ChannelHost(
      initialSettingsState,
      reduceSettings,
      coalesceSettingsEvent,
      onAction,
    );

    this.roster = loadRoster();
    this.pool = new AgentPool({
      onStatusChanged: (agentId, status, detail) => {
        const event = { kind: "agentStatusChanged", agentId, status, detail } as const;
        this.agentView.emit(event);
        this.settings.emit(event);
      },
      onDeclaredCaptured: () => {
        // capability tables land in state at P5
      },
      onSessionUpdate: () => {
        // chat streaming lands at P4
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
    }
  }

  dispose(): void {
    void this.pool.disposeAll();
    this.agentView.flushNow();
    this.settings.flushNow();
  }
}
