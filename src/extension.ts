import * as vscode from "vscode";
import { Orchestrator } from "./orchestrator/orchestrator";
import { AgentViewProvider, SettingsPanelHost } from "./orchestrator/webview-host";

export interface ExtensionInternal {
  orchestrator: Orchestrator;
  settingsPanelHost: SettingsPanelHost;
}

/** For deactivate — the only hook VS Code gives us at shutdown, and it must
 * reach the live orchestrator. */
let activeOrchestrator: Orchestrator | null = null;

export function activate(context: vscode.ExtensionContext): {
  /** Test surface, not API — no stability promise. */
  internal: ExtensionInternal;
} {
  // Shows up in the Output panel's channel dropdown as "Patchbay" (matches
  // the command-palette category) — the one place agent lifecycle, verify
  // runs, and swallowed action failures are visible without opening devtools.
  const log = vscode.window.createOutputChannel("Patchbay", { log: true });
  context.subscriptions.push(log);
  const orchestrator = new Orchestrator(context, log);
  activeOrchestrator = orchestrator;
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
    // OAuth redirect target (docs/reference-mcp-oauth.md): integrations'
    // browser flows come back as vscode://solutionsunity.acp-patchbay/...
    // URIs — resolved correctly in every environment by asExternalUri,
    // unlike a loopback HTTP server.
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        orchestrator.oauthCallbacks.handle(uri.query);
      },
    }),
  );

  return { internal: { orchestrator, settingsPanelHost } };
}

// Fires on window close, reload, disable, and uninstall alike — best-effort
// only (never on a crash or OS kill; the next activate's orphan reap covers
// those). Returning the promise makes VS Code wait for the bounded sweep
// (plan.md P15): agents down the graceful ladder, terminal trees killed.
export function deactivate(): Thenable<void> | undefined {
  const pending = activeOrchestrator?.shutdown();
  activeOrchestrator = null;
  return pending;
}
