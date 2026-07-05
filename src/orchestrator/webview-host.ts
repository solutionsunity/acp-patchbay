// Webview hosting for the two render-only surfaces (Agent View, Settings).
// CSP + nonce pattern after vscode-acp's ChatWebviewProvider (MIT, formulahendry).
// P1 grows this into the snapshot/patch plumbing; webviews stay render-only.
import * as vscode from "vscode";

type Bundle = "agent-view" | "settings";

function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, bundle: Bundle): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "out", `${bundle}.js`));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "out", `${bundle}.css`));
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}'; img-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${n}" src="${script}"></script>
</body>
</html>`;
}

export class AgentViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "out")],
    };
    view.webview.html = webviewHtml(view.webview, this.extensionUri, "agent-view");
  }
}

export function openSettingsPanel(extensionUri: vscode.Uri): void {
  const panel = vscode.window.createWebviewPanel(
    "acpPatchbay.settings",
    "Patchbay — Settings",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out")],
    },
  );
  panel.webview.html = webviewHtml(panel.webview, extensionUri, "settings");
}
