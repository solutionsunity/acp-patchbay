import * as vscode from "vscode";
import { AgentViewProvider, openSettingsPanel } from "./orchestrator/webview-host";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "acpPatchbay.agentView",
      new AgentViewProvider(context.extensionUri),
    ),
    vscode.commands.registerCommand("acpPatchbay.openSettings", () =>
      openSettingsPanel(context.extensionUri),
    ),
  );
}

export function deactivate(): void {}
