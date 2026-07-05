// vscode glue between webviews and channel hosts. Webviews are render-only:
// they die when hidden and resurrect via ready → snapshot.
// CSP + nonce pattern after vscode-acp's ChatWebviewProvider (MIT, formulahendry).
import * as vscode from "vscode";
import type { ViewToHost } from "../shared/protocol";
import type { ChannelEndpoint } from "./channel";

type Bundle = "agent-view" | "settings";

function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  bundle: Bundle,
): string {
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "out", `${bundle}.js`),
  );
  const style = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "out", `${bundle}.css`),
  );
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

/** Wire one webview to its channel host for the webview's lifetime. */
function bind(
  webview: vscode.Webview,
  channel: ChannelEndpoint,
  extensionUri: vscode.Uri,
  bundle: Bundle,
  disposables: vscode.Disposable[],
): void {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out")],
  };
  webview.html = webviewHtml(webview, extensionUri, bundle);
  channel.attach(webview);
  disposables.push(
    webview.onDidReceiveMessage((msg: ViewToHost) =>
      channel.handleViewMessage(msg),
    ),
  );
}

export class AgentViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly channel: ChannelEndpoint,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const disposables: vscode.Disposable[] = [];
    const webview = view.webview; // .webview throws once disposed — capture now
    bind(webview, this.channel, this.extensionUri, "agent-view", disposables);
    view.onDidDispose(() => {
      this.channel.detach(webview);
      for (const d of disposables) d.dispose();
    });
  }
}

export class SettingsPanelHost {
  private panel: vscode.WebviewPanel | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly channel: ChannelEndpoint,
  ) {}

  get currentPanel(): vscode.WebviewPanel | null {
    return this.panel;
  }

  openOrReveal(): void {
    if (this.panel !== null) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "acpPatchbay.settings",
      "Patchbay — Settings",
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    const disposables: vscode.Disposable[] = [];
    const webview = panel.webview; // .webview throws once disposed — capture now
    bind(webview, this.channel, this.extensionUri, "settings", disposables);
    panel.onDidDispose(() => {
      this.channel.detach(webview);
      for (const d of disposables) d.dispose();
      if (this.panel === panel) this.panel = null;
    });
    this.panel = panel;
  }
}
