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
import { ConfigFileStore, CONFIG_RELATIVE_PATH } from "./stores/config-file";
import { DecisionAuditStore } from "./stores/decision-audit";
import { PermissionRulesStore } from "./stores/permission-rules";
import { SessionIndexStore } from "./stores/session-index";

export class Orchestrator {
  readonly agentView: ChannelHost<AgentViewState, AgentViewEvent>;
  readonly settings: ChannelHost<SettingsState, SettingsEvent>;

  readonly sessionIndex: SessionIndexStore;
  readonly decisionAudit: DecisionAuditStore;
  readonly configFile: ConfigFileStore;
  readonly permissionRules: PermissionRulesStore;

  constructor(context: vscode.ExtensionContext) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

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
  }

  private handleAction(action: Action): void {
    switch (action.kind) {
      case "openSettings":
        void vscode.commands.executeCommand("acpPatchbay.openSettings");
        break;
    }
  }

  dispose(): void {
    this.agentView.flushNow();
    this.settings.flushNow();
  }
}
