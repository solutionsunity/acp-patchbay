// vscode glue between webviews and channel hosts. Webviews are render-only:
// they die when hidden and resurrect via ready → snapshot.
// CSP + nonce pattern after vscode-acp's ChatWebviewProvider (MIT, formulahendry).
//
// CSP is authored here and never widened silently (stack.md). The record:
// - P13a: React/Radix apply their "inline styles" through the CSSOM
//   (element.style), which `style-src` does not govern — no widening needed.
// - P13b: Shiki runs its JS regex engine — `wasm-unsafe-eval` never added.
// - P13c follow-up (Mermaid): style-src gains 'unsafe-inline'. Mermaid's
//   rendered SVG carries <style> elements and style="" attributes as
//   parsed markup, which strict style-src blocks and which cannot be
//   nonce'd (attributes take no nonce). Scope: styles only — script-src
//   stays nonce-strict, and agent-authored HTML cannot reach a <style>
//   element anyway (Streamdown sanitizes it). The mermaid bundle itself
//   loads lazily via a <script> carrying this same nonce.
// - script-src also carries 'strict-dynamic': the nonce'd entry bundle may
//   load further scripts (the lazy mermaid bundle) and nonce propagation
//   via document.currentScript proved unreliable inside the webview iframe
//   — strict-dynamic is CSP3's designed answer: trust what the trusted
//   script loads, transitively. Host/scheme sources are ignored under it,
//   which is fine — nonce was already the only script source.
import * as vscode from "vscode";
import type { ViewToHost } from "../shared/protocol";
import type { ChannelEndpoint } from "./channel";

type Bundle = "agent-view" | "settings";

export function nonce(): string {
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
  const codiconStyle = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "out", "codicons", "codicon.css"),
  );
  // Declared, not derived: lazy-loaded sibling bundles (mermaid.js) need the
  // out/ base URL, and document.currentScript is null by the time a lazily
  // initialized module reads it (lazy-script.ts).
  const outBase = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "out"));
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}' 'strict-dynamic'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="patchbay-out-base" content="${outBase}/">
  <link rel="stylesheet" href="${codiconStyle}">
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
    /** Fires on mount and every visibility flip — the source of truth for
     * "is the Agent View hidden right now" (native permission notifications
     * gate on this; features.md § Editor Surface). */
    private readonly onVisibilityChanged?: (visible: boolean) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const disposables: vscode.Disposable[] = [];
    const webview = view.webview; // .webview throws once disposed — capture now
    bind(webview, this.channel, this.extensionUri, "agent-view", disposables);
    this.onVisibilityChanged?.(view.visible);
    disposables.push(view.onDidChangeVisibility(() => this.onVisibilityChanged?.(view.visible)));
    view.onDidDispose(() => {
      this.onVisibilityChanged?.(false);
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
