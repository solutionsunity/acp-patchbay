// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

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
  /** Pins the agent-view bundle to one session (detached session panel) —
   * rides in as a meta tag, URI-encoded (session ids are agent-authored). */
  pinSessionId?: string,
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
  <meta name="patchbay-out-base" content="${outBase}/">${
    pinSessionId !== undefined
      ? `\n  <meta name="patchbay-pin-session" content="${encodeURIComponent(pinSessionId)}">`
      : ""
  }
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
  pinSessionId?: string,
): void {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out")],
  };
  webview.html = webviewHtml(webview, extensionUri, bundle, pinSessionId);
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

/** An editor-area panel bound to its channel for the panel's lifetime
 * (attach on create, detach + disposable sweep on dispose) — the one
 * WebviewPanel constructor, shared by Settings and the detached agent-view
 * surfaces. */
function boundPanel(
  viewType: string,
  title: string,
  channel: ChannelEndpoint,
  extensionUri: vscode.Uri,
  bundle: Bundle,
  pinSessionId?: string,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Active, {
    enableScripts: true,
  });
  const disposables: vscode.Disposable[] = [];
  const webview = panel.webview; // .webview throws once disposed — capture now
  bind(webview, channel, extensionUri, bundle, disposables, pinSessionId);
  panel.onDidDispose(() => {
    channel.detach(webview);
    for (const d of disposables) d.dispose();
  });
  return panel;
}

/** Detached agent-view surfaces (editor-area WebviewPanels, floatable into
 * auxiliary windows for multi-screen): one optional full agent view, plus
 * any number of per-session pinned panels. All of them are ordinary
 * render-only webviews on the same multi-view channel — the sidebar keeps
 * working alongside; a pinned panel merely renders one session and ignores
 * the shared active-session pointer. */
export class AgentPanelHost {
  private main: vscode.WebviewPanel | null = null;
  private pinned = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly channel: ChannelEndpoint,
  ) {}

  /** The reaper-exemption surface: a session shown in its own window is
   * being looked at, active-pointer or not. */
  pinnedSessionIds(): readonly string[] {
    return [...this.pinned.keys()];
  }

  /** The whole agent view as an editor panel, floated into a new window. */
  async openMain(): Promise<void> {
    if (this.main !== null) {
      this.main.reveal();
      return;
    }
    this.main = this.createPanel("Patchbay — Agents", undefined);
    this.main.onDidDispose(() => (this.main = null));
    await this.floatActiveEditor();
  }

  /** One session in its own window; a second open reveals the existing one. */
  async openPinned(sessionId: string, title: string): Promise<void> {
    const existing = this.pinned.get(sessionId);
    if (existing !== undefined) {
      existing.reveal();
      return;
    }
    const panel = this.createPanel(title, sessionId);
    this.pinned.set(sessionId, panel);
    panel.onDidDispose(() => {
      if (this.pinned.get(sessionId) === panel) this.pinned.delete(sessionId);
    });
    await this.floatActiveEditor();
  }

  /** Mirror of the sessions list (wired to channel.onChange in extension.ts):
   * a pinned panel whose session closed disposes — nothing to render, and
   * agent-truth says the session is gone; titles follow renames. */
  syncSessions(sessions: ReadonlyArray<{ id: string; title: string }>): void {
    for (const [sessionId, panel] of [...this.pinned]) {
      const session = sessions.find((s) => s.id === sessionId);
      if (session === undefined) panel.dispose();
      else if (panel.title !== session.title) panel.title = session.title;
    }
  }

  private createPanel(title: string, pinSessionId: string | undefined): vscode.WebviewPanel {
    return boundPanel("acpPatchbay.agentPanel", title, this.channel, this.extensionUri, "agent-view", pinSessionId);
  }

  /** The just-created panel is the active editor — moving it out gives the
   * detached, multi-screen window in one gesture. Best-effort: on a VS Code
   * without auxiliary windows the panel simply stays an editor tab. */
  private async floatActiveEditor(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    } catch {
      /* editor tab is the honest fallback */
    }
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
    const panel = boundPanel("acpPatchbay.settings", "Patchbay — Settings", this.channel, this.extensionUri, "settings");
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = null;
    });
    this.panel = panel;
  }
}
