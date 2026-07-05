import * as vscode from "vscode";
import { Orchestrator } from "./orchestrator/orchestrator";
import { AgentViewProvider, SettingsPanelHost } from "./orchestrator/webview-host";

export interface ExtensionInternal {
  orchestrator: Orchestrator;
  settingsPanelHost: SettingsPanelHost;
}

export function activate(context: vscode.ExtensionContext): {
  /** Test surface, not API — no stability promise. */
  internal: ExtensionInternal;
} {
  const orchestrator = new Orchestrator(context);
  const settingsPanelHost = new SettingsPanelHost(
    context.extensionUri,
    orchestrator.settings,
  );

  context.subscriptions.push(
    orchestrator,
    vscode.window.registerWebviewViewProvider(
      "acpPatchbay.agentView",
      new AgentViewProvider(context.extensionUri, orchestrator.agentView),
    ),
    vscode.commands.registerCommand("acpPatchbay.openSettings", () =>
      settingsPanelHost.openOrReveal(),
    ),
  );

  return { internal: { orchestrator, settingsPanelHost } };
}

export function deactivate(): void {}
