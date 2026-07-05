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
      new AgentViewProvider(context.extensionUri, orchestrator.agentView, (visible) => {
        orchestrator.isAgentViewVisible = () => visible;
      }),
    ),
    vscode.commands.registerCommand("acpPatchbay.openSettings", () =>
      settingsPanelHost.openOrReveal(),
    ),
    vscode.commands.registerCommand("acpPatchbay.newSession", () => orchestrator.newSessionCommand()),
    vscode.commands.registerCommand("acpPatchbay.switchSession", () => orchestrator.switchSessionCommand()),
    vscode.commands.registerCommand("acpPatchbay.connectAgent", () => orchestrator.connectAgentCommand()),
    vscode.commands.registerCommand("acpPatchbay.addSelectionToContext", () =>
      orchestrator.addSelectionToContextCommand(),
    ),
  );

  return { internal: { orchestrator, settingsPanelHost } };
}

export function deactivate(): void {}
