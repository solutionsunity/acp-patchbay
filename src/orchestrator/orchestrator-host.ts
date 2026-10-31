// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The orchestrator's host: everything VS Code itself does for the window —
// the views' webviews and their actions, the editor's state and documents,
// dialogs, notifications, the status bar, the browser. It builds the
// orchestrator (orchestrator.ts) from this editor's storage and fills the
// ports it asks through.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import * as vscode from "vscode";
import {
  type Action,
  type ConnectAgentSource,
  type SavedRootScope,
} from "../shared/protocol";
import { askNotice } from "../shared/ask-notice";
import { type OpenAsk } from "../shared/attention";
import { chipId, fileChipLabel, pickedFileForm } from "./attachments";
import { diffDir } from "./diff-files";
import { applyFileWrite } from "./client-host";
import { configurationText, writeConfigurationFile } from "./config-export";
import { EditorStateHost } from "./editor-state-host";
import { runLoginTask } from "./login-task";
import { agentErrorText } from "./readers/agent-error";
import { Cancelled } from "./queue";
import type { ExportPart } from "../shared/protocol";
import { normalizeRootPath } from "./sessions-store";
import { nonce } from "./webview-host";
import {
  resolveDistribution,
} from "./stores/acp-registry";
import { FileKV } from "./stores/file-kv";
import { sameRule, withRule } from "./stores/permission-rules";
import { recoverLegacyGlobalState } from "./stores/vscdb-recovery";
import { statusBarContent } from "./status-bar";
import { editorLineOf } from "./tool-locations";
import type { PatchbayAskId, PatchbayMcpServerId, PatchbaySessionId } from "../shared/ids";
import { isFolder, Orchestrator } from "./orchestrator";

/** A web page in the system browser — outside the editor, so neither
 * patchbay nor an agent's model sees the page or what the user types. The
 * one way patchbay opens a page: an MCP server's sign-in and an agent's link
 * alike. */
function openInBrowser(href: string): Thenable<boolean> {
  return vscode.env.openExternal(vscode.Uri.parse(href));
}

/** A modal question with one affirmative choice — true when it was chosen. */
async function askModal(message: string, choice: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true }, choice)) === choice;
}

export class OrchestratorHost {
  /** The window's orchestrator: everything that runs without VS Code. */
  readonly orchestrator: Orchestrator;
  readonly editorStateHost: EditorStateHost;
  private readonly editorSubscriptions: vscode.Disposable[] = [];
  /** Sessions shown in their own detached panels (AgentPanelHost, assigned
   * in extension.ts) — reaper-exempt like the active-in-view session: a
   * session in its own window is being looked at. */
  pinnedSessions: () => readonly string[] = () => [];
  private statusBarItem!: vscode.StatusBarItem;
  private wireChannel: vscode.OutputChannel | null = null;
  private wireStatusItem: vscode.StatusBarItem | null = null;
  private wireStatusTimer: ReturnType<typeof setInterval> | null = null;
  constructor(
    context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {

    // Machine scope lives in a file this extension owns (file-kv.ts), not
    // in globalState: state.vscdb is editor-owned, shared by every
    // extension, and has been observed truncated to zero bytes by an
    // unclean shutdown — taking every agent config with it. First load
    // drains any old globalState keys into the file.
    const machineKV = new FileKV(
      join(context.globalStorageUri.fsPath, "state.json"),
      context.globalState,
      (message) => log.info(`state file: ${message}`),
    );
    // One-shot fill of anything the 0.82.6 publisher-casing flip orphaned
    // in the old-cased globalState row. FileKV updates take effect as they
    // are issued (microtask-paced at worst), and this constructor only
    // wires stores — their first real read comes later on the event loop,
    // after the fill has fully landed.
    void recoverLegacyGlobalState({
      kv: machineKV,
      vscdbPath: join(dirname(context.globalStorageUri.fsPath), "state.vscdb"),
      log: (message) => log.info(`legacy recovery: ${message}`),
    }).catch((error: unknown) => log.info(`legacy recovery failed: ${String(error)}`));
    // OAuth browser/redirect step:
    // the redirect target is this extension's own vscode:// URI, passed
    // through asExternalUri so VS Code resolves it correctly under SSH
    // remote / WSL / Codespaces — never a hand-rolled 127.0.0.1 server.
    // extension.ts's registerUriHandler feeds callbacks into oauthCallbacks.
    const extensionId = context.extension.id; // "solutionsunity.acp-patchbay"
    const workspaceRootsView = () =>
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    // The editor's own state, read where only VS Code can; the
    // orchestrator's IPC host answers spawned subprocesses with it.
    this.editorStateHost = new EditorStateHost();
    this.editorStateHost.start();
    this.orchestrator = new Orchestrator(
      {
        ipcName: `acp-patchbay-${process.pid}`,
        machineKV,
        workspaceKV: context.workspaceState,
        secrets: context.secrets,
        globalStoragePath: context.globalStorageUri.fsPath,
        storagePath: context.storageUri?.fsPath ?? null,
        workspaceCwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        scripts: {
          editorServer: vscode.Uri.joinPath(context.extensionUri, "out", "mcp-server.js").fsPath,
          bridge: vscode.Uri.joinPath(context.extensionUri, "out", "mcp-bridge.js").fsPath,
        },
        shellGrammar: vscode.Uri.joinPath(context.extensionUri, "out", "tree-sitter").fsPath,
      },
      {
        handleAction: (action) => this.handleAction(action),
        workspaceRoots: workspaceRootsView,
        editor: this.editorStateHost,
        redirectUri: async () => {
          const callback = await vscode.env.asExternalUri(
            vscode.Uri.parse(`${vscode.env.uriScheme}://${extensionId}/oauth-callback`),
          );
          return callback.toString(true);
        },
        openLink: (href) => openInBrowser(href),
        confirm: askModal,
        warn: (message) => void vscode.window.showWarningMessage(message),
        runLoginTask: (name, recipe) => runLoginTask(name, recipe),
        announceUpdates: () => this.announceUpdates(),
        wireSink: () => {
          this.wireChannel ??= vscode.window.createOutputChannel("ACP Patchbay — Wire");
          return this.wireChannel;
        },
        onWireLogStateChanged: (active, until) => this.onWireLogStateChanged(active, until),
        pinnedSessions: () => this.pinnedSessions(),
        readTextFileLive: (path) => this.readTextFileLive(path),
        writeTextFileLive: (path, content) => this.writeTextFileLive(path, content),
        closeAskDiffs: (patchbayAskId) => this.closeAskDiffs(patchbayAskId),
        connectStartupAgents: () => this.connectStartupAgents(),
        focusComposer: () => this.focusComposer(),
        notifyAsk: (patchbaySessionId, title, ask) => this.notifyAsk(patchbaySessionId, title, ask),
        syncDetachContext: () => this.syncDetachContext(),
        warnCatch: (context, what) => this.warnCatch(context, what),
      },
      log,
    );


    // Live editor context for the composer (the selection
    // ghost chip appears only while the IDE has a selection; the @ mention
    // picker lists open editors). Position/paths only — the selection text
    // is read host-side at the moment the user solidifies it. High-frequency
    // sources; the channel's coalescing keeps only the latest.
    const pushEditorContext = () => {
      const s = this.editorStateHost.getSelection();
      this.orchestrator.agentView.emit({
        kind: "editorContextChanged",
        selection: s === null ? null : { file: s.file, startLine: s.startLine, endLine: s.endLine },
        openEditors: this.editorStateHost.getOpenEditors(),
      });
    };
    this.editorSubscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(pushEditorContext),
      vscode.window.onDidChangeActiveTextEditor(pushEditorContext),
      vscode.workspace.onDidOpenTextDocument(pushEditorContext),
      vscode.workspace.onDidCloseTextDocument(pushEditorContext),
      vscode.workspace.onDidChangeTextDocument(pushEditorContext), // dirty-flag flips
      vscode.workspace.onDidSaveTextDocument(pushEditorContext),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        // The chip and the wire read the same folders: the view re-renders
        // from reality, and every live session's additional directories are
        // re-applied so the agent's list moves with it.
        this.orchestrator.agentView.emit({ kind: "workspaceRootsChanged", roots: workspaceRootsView() });
        // the first folder in, or the last out, opens or closes this
        // workspace's saved list
        this.orchestrator.publishSavedRoots();
        void this.orchestrator.sessionGates.reapplyWorkspaceRoots().catch(this.orchestrator.logCatch("reapply workspace roots"));
      }),
    );

    // The status bar projects canonical Agent View state via
    // ChannelHost.onChange — a native surface, no webview in the path: the
    // state read where it lives, never a second counter.
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = "acpPatchbay.focusComposer";
    this.statusBarItem.show();
    this.orchestrator.agentView.onChange(() => {
      this.refreshStatusBar();
    });
    this.refreshStatusBar();
    this.syncDetachContext();
  }

  /** Export: the picked parts read fresh from the stores, written where
   * the user says. */
  private async exportToFile(parts: readonly ExportPart[]): Promise<void> {
    const file = await this.orchestrator.exportConfiguration(parts);
    const target = await vscode.window.showSaveDialog({
      title: "Export patchbay configuration",
      defaultUri: vscode.Uri.file(join(homedir(), `patchbay-config-${file.exportedAt.slice(0, 10)}.json`)),
      filters: { JSON: ["json"] },
    });
    if (target === undefined) return;
    try {
      // A remote window's dialog also offers the machine the editor runs on
      // (Windows, from WSL): that file is not on this host's disk, so it is
      // written through the editor's file system, where no mode can be set.
      if (target.scheme === "file") await writeConfigurationFile(target.fsPath, file);
      else await vscode.workspace.fs.writeFile(target, Buffer.from(configurationText(file), "utf8"));
    } catch (err) {
      this.log.error(`export to ${target.toString()}: ${agentErrorText(err)}`);
      void vscode.window.showErrorMessage(`Export failed — ${agentErrorText(err)}`);
      return;
    }
    void vscode.window.showInformationMessage(
      `Exported to ${target.fsPath}. It holds your env values and keys in plain text — keep it as you would a password.`,
    );
  }

  /** Startup: what the agents store says this window opens with is
   * connected, and the last open session is restored once its own agent's
   * connect has settled — a connect waits for its agent's answer however
   * long it takes, and another agent's slow download or silent start is no
   * reason to keep the chat away. A bare id still to fold needs every
   * startup list, so it (and a pointer at an agent nothing started) waits
   * for them all. The raw
   * `acpPatchbay.defaultAgent` value stays readable after the
   * contribution's removal — unregistered keys still surface — and the
   * store folds it into the per-agent flag. */
  private async connectStartupAgents(): Promise<void> {
    const legacy = vscode.workspace.getConfiguration("acpPatchbay").get<string>("defaultAgent", "");
    const sources = await this.orchestrator.agents.startupSources(legacy);
    const pointed = this.orchestrator.lastActiveAgent();
    let pointedSettled!: () => void;
    const pointedConnect = new Promise<void>((resolve) => (pointedSettled = resolve));
    const all = Promise.allSettled(
      sources.map((source) =>
        this.orchestrator.connectFrom(source).then((patchbayAgentId) => {
          if (patchbayAgentId !== undefined && patchbayAgentId === pointed) pointedSettled();
        }),
      ),
    );
    await Promise.race([pointedConnect, all]);
    await this.orchestrator.restoreLastActiveSession();
  }

  /** Mirrors the detachWindows preference into a when-clause context key —
   * package.json gates the view-title button and the palette command on it
   * (native surfaces can't read the store; this is their one bridge). */
  private syncDetachContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "acpPatchbay.detachEnabled",
      this.orchestrator.preferences.get().detachWindows,
    );
  }

  /** Active session · agent health · usage when reported —
   * click jumps to the Agent View, which already shows that same session. */
  private refreshStatusBar(): void {
    const { text, tooltip } = statusBarContent(this.orchestrator.agentView.current);
    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = tooltip;
  }

  /** Command palette: "new session" — every configured
   * agent with its readiness inline, single agent skips the pick, and a
   * not-running choice connects on demand (the same startChat path as
   * the view's "+"). */
  async newSessionCommand(): Promise<void> {
    const agents = this.orchestrator.agents.rows();
    if (agents.length === 0) {
      void vscode.window.showInformationMessage("Add an agent first — Patchbay Settings › Agents.");
      this.handleAction({ kind: "openSettings", section: "agents" });
      return;
    }
    let patchbayAgentId = agents[0]!.id;
    if (agents.length > 1) {
      const picked = await vscode.window.showQuickPick(
        agents.map((a) => ({
          label: a.name,
          description: a.detail ?? (a.status === "running" ? "ready" : a.status === "untested" ? "never connected" : a.status),
          patchbayAgentId: a.id,
        })),
        { placeHolder: "New session with…" },
      );
      if (picked === undefined) return;
      patchbayAgentId = picked.patchbayAgentId;
    }
    await this.orchestrator.startChat(patchbayAgentId);
    await this.focusComposer();
  }

  /** "Switch session." The pick is a read of the list — the same re-read
   * as the drawer opening — and, like the drawer, it opens on what is known
   * now and re-fills when the re-read lands: a running agent that never
   * answers must not hold the palette hostage (pool requests carry no
   * deadline). */
  async switchSessionCommand(): Promise<void> {
    type Item = vscode.QuickPickItem & { patchbaySessionId: PatchbaySessionId };
    const items = (): Item[] =>
      this.orchestrator.agentView.current.sessions.map((s) => ({
        label: s.title,
        description: this.orchestrator.agents.name(s.patchbayAgentId) ?? s.patchbayAgentId,
        patchbaySessionId: s.id,
      }));
    const pick = vscode.window.createQuickPick<Item>();
    pick.placeholder = "Switch to session…";
    pick.items = items();
    pick.busy = true;
    const picked = await new Promise<Item | undefined>((resolve) => {
      let open = true;
      pick.onDidAccept(() => resolve(pick.selectedItems[0]));
      pick.onDidHide(() => {
        open = false;
        resolve(undefined);
      });
      void this.orchestrator.sessions.syncRunningAgents().finally(() => {
        if (!open) return;
        pick.items = items();
        pick.busy = false;
        if (pick.items.length === 0) {
          void vscode.window.showInformationMessage("No sessions yet.");
          pick.hide();
        }
      });
      pick.show();
    });
    pick.dispose();
    if (picked === undefined) return;
    await this.orchestrator.revealSession(picked.patchbaySessionId);
  }

  /** "Connect agent" — the palette shortcut, through the same `connectFrom`
   * Settings uses: a saved agent connects as it stands; a registry entry or
   * a command line adds an agent first — so an entry added before adds a
   * second one, as in Settings. */
  async connectAgentCommand(): Promise<void> {
    const items: (vscode.QuickPickItem & { source?: ConnectAgentSource })[] = [
      ...this.orchestrator.agents.rows().map((row) => ({ label: row.name, description: row.status, source: { patchbayAgentId: row.id } })),
      ...this.orchestrator.acpRegistry.current().agents
        .filter((a) => !("error" in resolveDistribution(a)))
        .map((a) => ({ label: a.name, description: "add from the ACP registry", source: { registryId: a.id } })),
      { label: "Custom command…", description: "add" },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Connect agent…" });
    if (picked === undefined) return;
    if (picked.source === undefined) {
      const command = await vscode.window.showInputBox({ placeHolder: "command that speaks ACP…" });
      if (command === undefined || command.trim() === "") return;
      await this.orchestrator.connectFrom({ command });
    } else {
      await this.orchestrator.connectFrom(picked.source);
    }
    await this.focusComposer();
  }

  /** Editor right-click ("add to context / ask the agent
   * about it") — reuses the composer's own add-selection action so there's
   * one path for "a selection became context," native gesture or button
   * alike; focusing the Agent View afterward is what lets the user ask
   * about it, the same composer flow either way. */
  async addSelectionToContextCommand(): Promise<void> {
    const patchbaySessionId = this.orchestrator.agentView.current.activePatchbaySessionId;
    if (patchbaySessionId === null) {
      void vscode.window.showInformationMessage("Start a Patchbay session first, then add a selection.");
      return;
    }
    this.handleAction({ kind: "addSelectionContext", patchbaySessionId });
    await this.focusComposer();
  }

  /** Opens a file in the editor its type calls for (text, image preview,
   * …). A location line puts the cursor on that line's first non-blank
   * character, scrolled into view; a file with no text to land in (binary)
   * opens without one. A directory — some agents report a shell command's
   * working directory as its location — is revealed in the Explorer, never
   * opened as a folder. */
  private async openFileAt(path: string, line: number | undefined): Promise<void> {
    const uri = vscode.Uri.file(path);
    if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) {
      await vscode.commands.executeCommand("revealInExplorer", uri);
      return;
    }
    let selection: vscode.Range | undefined;
    if (line !== undefined) {
      const doc = await vscode.workspace.openTextDocument(uri).then(
        (d) => d,
        () => null,
      );
      if (doc !== null) {
        const at = doc.lineAt(editorLineOf(line, doc.lineCount));
        const pos = new vscode.Position(at.lineNumber, at.firstNonWhitespaceCharacterIndex);
        selection = new vscode.Range(pos, pos);
      }
    }
    await vscode.commands.executeCommand("vscode.open", uri, selection === undefined ? undefined : { selection });
  }

  /** Live-buffer read: an open, possibly-unsaved editor wins over disk
   * ("the agent sees what the user sees"). Falls back to disk for files
   * with no open editor. */
  private async readTextFileLive(path: string): Promise<string> {
    const uri = vscode.Uri.file(path);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path);
    if (open !== undefined) return open.getText();
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  }

  /** Live-buffer write — the mirror of readTextFileLive: when the file is
   * open in an editor the write lands in that
   * buffer via WorkspaceEdit, then saves — the user sees the change, it joins
   * the undo stack, and disk matches the buffer at once. This closes the
   * divergence window both ways: no more agent write silently lost to a stale
   * dirty buffer's next save, no more terminal reading a disk the buffer
   * contradicts. Falls back to a plain disk write when no editor holds the
   * file. A failed apply throws — the agent must know the write didn't land;
   * a silent disk fallback would recreate the divergence. */
  private async writeTextFileLive(path: string, content: string): Promise<void> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path);
    if (open === undefined) return applyFileWrite(path, content);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(open.uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), content);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error(`failed to apply write to the open editor for ${path}`);
    }
    // save() resolves false for a non-dirty doc (identical content → no-op
    // edit), which is success here, not failure — only save a dirty buffer.
    if (open.isDirty && !(await open.save())) {
      throw new Error(`failed to save ${path} after write`);
    }
  }

  /** A rendered mermaid SVG, opened as an editor-area panel — the agent
   * view's column is narrow (even the in-chat fullscreen stops at it); the
   * files area is where a diagram can breathe. Pan/zoom is hand-rolled
   * vanilla (wheel = zoom around cursor, drag = pan, double-click = reset):
   * CSP allows exactly one nonce'd inline script for it — a deliberate,
   * recorded widening of this panel's previous no-script posture, still
   * default-src 'none' and the SVG is mermaid's sanitized output. */
  private openDiagram(svg: string): void {
    const panel = vscode.window.createWebviewPanel(
      "acpPatchbay.diagram",
      "Diagram",
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    const n = nonce();
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}'; img-src data:;">
  <style>
    body { margin: 0; height: 100vh; overflow: hidden; cursor: grab; }
    body.dragging { cursor: grabbing; }
    #stage { height: 100%; display: grid; place-items: center; }
    #wrap { transform-origin: 0 0; }
    svg { max-width: 95vw; max-height: 95vh; height: auto; display: block; }
  </style>
</head>
<body>
  <div id="stage"><div id="wrap">${svg}</div></div>
  <script nonce="${n}">
    "use strict";
    const wrap = document.getElementById("wrap");
    let scale = 1, x = 0, y = 0, drag = null;
    const apply = () => { wrap.style.transform = \`translate(\${x}px, \${y}px) scale(\${scale})\`; };
    window.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const next = Math.min(10, Math.max(0.2, scale * factor));
      // keep the point under the cursor fixed while scaling
      x = e.clientX - (e.clientX - x) * (next / scale);
      y = e.clientY - (e.clientY - y) * (next / scale);
      scale = next;
      apply();
    }, { passive: false });
    window.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY };
      document.body.classList.add("dragging");
    });
    window.addEventListener("pointermove", (e) => {
      if (drag === null) return;
      x += e.clientX - drag.x;
      y += e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      apply();
    });
    const end = () => { drag = null; document.body.classList.remove("dragging"); };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("dblclick", () => { scale = 1; x = 0; y = 0; apply(); });
  </script>
</body>
</html>`;
  }

  /** One stash text → one temp file with a real URI, for vscode.diff — both
   * native-diff openers share this (diffs always open in VS Code's own diff
   * editor, never an inline webview diff). */
  private async diffTempFile(scope: string, fileName: string, content: string): Promise<vscode.Uri> {
    const dir = diffDir(scope);
    await mkdir(dir, { recursive: true });
    const file = join(dir, fileName);
    await writeFile(file, content, "utf8");
    return vscode.Uri.file(file);
  }

  /** What a pending ask would change, in full, one tab per file — the card
   * shows at most a preview, and the decision deserves the whole change.
   * Left: the file as it was when asked (a new file diffs against empty);
   * right: what the agent would write. Both are snapshots the asks store
   * holds only while the ask is open, so a stale click after it ended is a
   * no-op, like the other openers. */
  private async openProposedDiff(patchbayAskId: PatchbayAskId): Promise<void> {
    for (const [i, proposal] of this.orchestrator.asks.proposals(patchbayAskId).entries()) {
      // numbered: two files of one name in different folders keep their own texts
      const name = basename(proposal.path);
      await vscode.commands.executeCommand(
        "vscode.diff",
        await this.diffTempFile(patchbayAskId, `${i}-current-${name}`, proposal.oldText),
        await this.diffTempFile(patchbayAskId, `${i}-proposed-${name}`, proposal.newText),
        `${name} — proposed change (decide on the card)`,
      );
    }
  }

  /** An ask ended: the tabs its card opened show a change that is no
   * longer proposed, so they close, and their texts go. The open tabs are
   * read, not remembered — a tab the user already closed is simply not
   * there. */
  private async closeAskDiffs(patchbayAskId: PatchbayAskId): Promise<void> {
    const dir = diffDir(patchbayAskId);
    const inDir = (uri: vscode.Uri) => uri.scheme === "file" && dirname(uri.fsPath) === dir;
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && (inDir(tab.input.original) || inDir(tab.input.modified)));
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, true);
    await rm(dir, { recursive: true, force: true });
  }

  /** Agent-reported tool-call diffs — the texts come back from the
   * sessions store's stash; both sides are snapshots, so both ride temp files. */
  private async openToolCallDiff(patchbaySessionId: PatchbaySessionId, toolCallId: string, path: string): Promise<void> {
    const diff = this.orchestrator.sessions.toolCallDiff(patchbaySessionId, toolCallId, path);
    if (diff === null) return; // stale id after a close — nothing to show
    const name = basename(path);
    await vscode.commands.executeCommand(
      "vscode.diff",
      await this.diffTempFile(toolCallId, `before-${name}`, diff.oldText),
      await this.diffTempFile(toolCallId, `after-${name}`, diff.newText),
      `${name} — agent-proposed change`,
    );
  }

  /** Mirrors the inline card: its own answers where the line shows all the
   * card does (the same actions the card sends, so whichever surface the
   * user acts on first wins — a second answer is a no-op), and Open, which
   * brings the session up (askNotice decides which). */
  private notifyAsk(patchbaySessionId: PatchbaySessionId, title: string, ask: OpenAsk): void {
    const { line, answers } = askNotice(ask);
    const labels = [...answers.map((a) => a.label), "Open"];
    void vscode.window.showWarningMessage(`${title} — ${line}`, ...labels).then((picked) => {
      if (picked === "Open") void this.orchestrator.revealSession(patchbaySessionId);
      else {
        const answer = answers.find((a) => a.label === picked);
        if (answer !== undefined) this.handleAction(answer.action);
      }
    });
  }

  /** A chat opened for typing: the Agent View takes focus, then its
   * composer takes the keyboard. The view goes first — a view only focuses
   * its composer while it has focus itself, so it never pulls focus from
   * where the user is. */
  async focusComposer(): Promise<void> {
    await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
    this.orchestrator.agentView.emit({ kind: "composerFocusRequested" });
  }

  /** Enable goes through the disclosure prompt — every entry point (Audit
   * page toggle, status pill, palette command) shares this one consent
   * gate; the confirming state event fires only after the user says yes. */
  private async setWireLog(active: boolean): Promise<void> {
    if (!active) {
      this.orchestrator.wireLog.disable();
      return;
    }
    if (this.orchestrator.wireLog.active) return;
    const ENABLE = "Enable for 30 minutes";
    const pick = await vscode.window.showWarningMessage(
      "Enable the ACP wire log?",
      {
        modal: true,
        detail:
          "Every JSON-RPC frame on the agent wire goes to the Output panel — prompts, file contents, " +
          "and tool traffic will be readable there. Credentials patchbay injected are masked at the seam; " +
          "anything an agent echoes back on its own is not. Turns itself off in 30 minutes.",
      },
      ENABLE,
    );
    if (pick !== ENABLE) return;
    this.orchestrator.wireLog.enable();
    this.wireChannel?.show(true);
  }

  /** Status-pill click and the palette command land here: consent+enable
   * when off; a stop-first quick pick when on (at minute 25 the state
   * you're usually in is "not done yet" — extending must not require
   * re-toggling, but stop stays the fast path). */
  async wireLogCommand(): Promise<void> {
    if (!this.orchestrator.wireLog.active) {
      await this.setWireLog(true);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(debug-stop) Stop now", action: "stop" as const },
        { label: "$(watch) Extend 30 minutes", action: "extend" as const },
      ],
      {
        placeHolder: `Wire log is on — auto-off at ${new Date(this.orchestrator.wireLog.until ?? Date.now()).toLocaleTimeString()}`,
      },
    );
    if (pick?.action === "stop") this.orchestrator.wireLog.disable();
    else if (pick?.action === "extend") this.orchestrator.wireLog.extend();
  }

  private onWireLogStateChanged(active: boolean, until: string | null): void {
    this.orchestrator.settings.emit({ kind: "wireLogChanged", active, until });
    if (!active) {
      this.wireStatusItem?.dispose();
      this.wireStatusItem = null;
      if (this.wireStatusTimer !== null) clearInterval(this.wireStatusTimer);
      this.wireStatusTimer = null;
      return;
    }
    if (this.wireStatusItem === null) {
      // Transient pill, right side next to the main item — its existence IS
      // the state; warning background is the platform's own "temporarily
      // elevated" grammar.
      this.wireStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
      this.wireStatusItem.command = "acpPatchbay.wireLog";
      this.wireStatusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
    this.updateWireStatusText();
    this.wireStatusItem.show();
    if (this.wireStatusTimer === null) {
      this.wireStatusTimer = setInterval(() => this.updateWireStatusText(), 30_000);
      this.wireStatusTimer.unref?.();
    }
  }

  private updateWireStatusText(): void {
    if (this.wireStatusItem === null) return;
    const until = this.orchestrator.wireLog.until;
    const mins =
      until === null ? 0 : Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 60_000));
    this.wireStatusItem.text = `$(pulse) Wire log · ${mins}m`;
    this.wireStatusItem.tooltip =
      "ACP wire log is on — every frame goes to Output. Click to stop or extend.";
  }

  /** Tells the user about each newer agent version once per window, with
   * the upgrade one click away: a single update upgrades from the
   * notification; several open a pick of which to upgrade, all checked.
   * Every upgrade takes the one Upgrade path, its confirmation included —
   * and only while the update is still the fact: a notification answered
   * after the agent was upgraded elsewhere restarts nothing. */
  private async announceUpdates(): Promise<void> {
    const fresh = this.orchestrator.updatesToAnnounce();
    if (fresh.length === 0) return;
    if (fresh.length === 1) {
      const [patchbayAgentId, u] = fresh[0]!;
      const picked = await vscode.window.showInformationMessage(
        `${this.orchestrator.agentName(patchbayAgentId)} ${u.to} is available — you run ${u.from}.`,
        "Upgrade",
      );
      if (picked === "Upgrade" && this.orchestrator.agents.updates().has(patchbayAgentId)) {
        await this.orchestrator.gates.upgrade(patchbayAgentId).catch(this.orchestrator.logCatch(`upgrade ${patchbayAgentId}`));
      }
      return;
    }
    const picked = await vscode.window.showInformationMessage(
      `Updates are available for ${fresh.length} agents.`,
      "Upgrade…",
    );
    if (picked !== "Upgrade…") return;
    const chosen = await vscode.window.showQuickPick(
      fresh.map(([patchbayAgentId, u]) => ({ label: this.orchestrator.agentName(patchbayAgentId), description: `${u.from} → ${u.to}`, picked: true, patchbayAgentId })),
      { canPickMany: true, placeHolder: "Upgrade which agents?" },
    );
    for (const item of chosen ?? []) {
      if (this.orchestrator.agents.updates().has(item.patchbayAgentId)) {
        await this.orchestrator.gates.upgrade(item.patchbayAgentId).catch(this.orchestrator.logCatch(`upgrade ${item.patchbayAgentId}`));
      }
    }
  }

  private handleAction(action: Action): void {
    switch (action.kind) {
      case "openSettings":
        // Navigate after the reveal settles: an already-open panel keeps its
        // section, so without this a deep-linking caller ("Add or manage
        // agents") reads as a dead click.
        void vscode.commands
          .executeCommand("acpPatchbay.openSettings")
          .then(() => {
            if (action.section !== undefined) this.orchestrator.showSettingsSection(action.section);
          }, this.orchestrator.logCatch("openSettings"));
        break;
      case "setSettingsSection":
        this.orchestrator.showSettingsSection(action.section);
        break;
      case "connectAgent":
        void this.orchestrator.connectFrom(action.source);
        break;
      case "restartAgent":
        // failure surfaces as a crashed status patch — no reply channel by design
        void this.orchestrator.gates.restart(action.patchbayAgentId).catch(this.orchestrator.logCatch(`restart ${action.patchbayAgentId}`));
        break;
      case "stopAgent":
        void this.orchestrator.gates.stop(action.patchbayAgentId).catch(this.orchestrator.logCatch(`stop ${action.patchbayAgentId}`));
        break;
      case "startChat":
        void this.orchestrator.startChat(action.patchbayAgentId);
        break;
      case "dismissChatConnect":
        this.orchestrator.agentView.emit({ kind: "chatConnectResolved" });
        break;
      case "eraseAllData":
        void this.orchestrator.eraseEverything().catch(this.orchestrator.logCatch("eraseAllData"));
        break;
      case "exportConfiguration":
        void this.exportToFile(action.parts);
        break;
      case "readConfigImport":
        void this.orchestrator.readConfigImport(action.fileName, action.text).catch(this.orchestrator.logCatch("import: read"));
        break;
      case "applyConfigImport":
        void this.orchestrator.applyConfigImport(action.importId, action.take).catch(this.orchestrator.logCatch("import: apply"));
        break;
      case "dismissConfigImport":
        if (this.orchestrator.configImport?.id === action.importId) this.orchestrator.configImport = null;
        if (this.orchestrator.settings.current.configImport?.id === action.importId) {
          this.orchestrator.settings.emit({ kind: "configImportChanged", configImport: null });
        }
        break;
      case "setWireLog":
        void this.setWireLog(action.active);
        break;
      case "refreshDataInventory":
        void this.orchestrator.publishDataInventory();
        break;
      case "syncSessions":
        void this.orchestrator.sessions.syncRunningAgents();
        break;
      case "switchSession":
        // Switching NEVER closes the session being left — open sessions
        // stay attached until the idle reaper's full predicate says
        // otherwise (sessions-store `idle`).
        this.orchestrator.sessionGates.open(action.patchbaySessionId);
        break;
      case "forkSession":
        void this.orchestrator.forkSession(action.patchbaySessionId);
        break;
      case "deleteSession":
        void this.orchestrator.deleteSession(action.patchbaySessionId);
        break;
      case "closeSession":
        void this.orchestrator.sessionGates.close(action.patchbaySessionId).catch(this.orchestrator.logCatch(`close ${action.patchbaySessionId}`));
        break;
      case "copySessionId": {
        const sessionId = this.orchestrator.sessions.sessionIdOf(action.patchbaySessionId);
        if (sessionId !== undefined) void vscode.env.clipboard.writeText(sessionId);
        break;
      }
      case "reloadSession":
        void this.orchestrator.sessionGates.reload(action.patchbaySessionId).catch(this.orchestrator.logCatch(`reload ${action.patchbaySessionId}`));
        break;
      // A rejected set leaves authoritative state unchanged — republish it
      // (fresh identity) so the pill's pending spinner settles back to truth.
      case "setSessionKnob":
        void this.orchestrator.sessionGates
          .setKnob(action.patchbaySessionId, action.knobId, action.value)
          .catch((err) => {
            this.warnCatch(`setKnob ${action.patchbaySessionId}`, "The agent didn't take the change")(err);
            const knobs = this.orchestrator.agentView.current.sessionKnobs[action.patchbaySessionId];
            if (knobs !== undefined) {
              this.orchestrator.agentView.emit({ kind: "sessionKnobsSet", patchbaySessionId: action.patchbaySessionId, knobs: [...knobs] });
            }
          });
        break;
      case "sendPrompt":
        // Pure dispatch: the turn-start door is the session gates', where
        // every prompt passes — a guard here would cover only this entrance.
        // A failure leaves the turn's end, or the words held, with no reply
        // channel by design.
        void this.orchestrator.sessionGates
          .prompt(action.patchbaySessionId, {
            text: action.text,
            ...(action.parts !== undefined ? { parts: action.parts } : {}),
            ...(action.draft !== undefined ? { draft: action.draft } : {}),
          })
          .catch(this.orchestrator.logCatch(`sendPrompt ${action.patchbaySessionId}`));
        break;
      case "detachSession":
        // Preference-gated at the source of truth, not only in the menu
        // that hid itself (render-only webviews don't get to be the gate).
        if (!this.orchestrator.preferences.get().detachWindows) break;
        // The panel host lives in extension.ts (like Settings) — reach it by
        // command. Then the one open ceremony, pinned: the panel renders
        // this session by id, so the active pointer stays where it is.
        void vscode.commands.executeCommand("acpPatchbay.detachSession", action.patchbaySessionId);
        this.orchestrator.sessionGates.open(action.patchbaySessionId, { pin: true });
        break;
      case "sendHeldPrompt":
        this.orchestrator.sessionGates.sendHeld(action.patchbaySessionId, action.promptId);
        break;
      case "removeQueuedPrompt":
        this.orchestrator.sessionGates.removeHeld(action.patchbaySessionId, action.promptId);
        break;
      case "reclaimQueuedPrompt":
        this.orchestrator.sessions.takeBack(action.patchbaySessionId, action.promptId);
        break;
      case "restagePromptFiles":
        void this.orchestrator.sessions.restagePromptFiles(action.patchbaySessionId, action.blockId).then((missed) => {
          if (missed.length > 0) void vscode.window.showWarningMessage(`Reused without ${missed.join("; ")}.`);
        }, this.orchestrator.logCatch(`restage prompt files ${action.patchbaySessionId}`));
        break;
      case "setSessionDraft":
        // The composer's debounced durable save.
        this.orchestrator.sessions.saveDraft(action.patchbaySessionId, action.draft);
        break;
      case "stopTurn":
        void this.orchestrator.sessionGates.stop(action.patchbaySessionId).catch(this.orchestrator.logCatch(`stop turn ${action.patchbaySessionId}`));
        break;
      case "editAgentDefaults":
        void (action.open ? this.orchestrator.defaultsEditor.open(action.patchbayAgentId) : this.orchestrator.defaultsEditor.close(action.patchbayAgentId));
        break;
      case "resolvePermission":
        this.orchestrator.asks.answerOption(action.patchbayAskId, action.optionId);
        break;
      case "resolveDiff":
        this.orchestrator.asks.answerWrite(action.patchbayAskId, action.accept);
        break;
      case "authenticateAgent":
        // a failure leaves needsAuth set, and says why where the user is
        void this.orchestrator.gates
          .login(action.patchbayAgentId, action.methodId)
          .catch(this.warnCatch(`login ${action.patchbayAgentId}`, `Log in to ${this.orchestrator.agentName(action.patchbayAgentId)} failed`));
        break;
      case "logoutAgent":
        // the UI only offers this on a declared auth.logout; a successful
        // logout raises needsAuth directly (capability-tracker.logout)
        void this.orchestrator.gates
          .logout(action.patchbayAgentId)
          .catch(this.warnCatch(`logout ${action.patchbayAgentId}`, `Log out of ${this.orchestrator.agentName(action.patchbayAgentId)} failed`));
        break;
      case "upgradeAgent":
        void this.orchestrator.gates.upgrade(action.patchbayAgentId).catch(this.orchestrator.logCatch(`upgrade ${action.patchbayAgentId}`));
        break;
      case "resetAgent":
        void this.orchestrator.gates.reset(action.patchbayAgentId).catch(this.orchestrator.logCatch(`reset ${action.patchbayAgentId}`));
        break;
      case "goBackAgent":
        void this.orchestrator.gates.goBack(action.patchbayAgentId).catch(this.orchestrator.logCatch(`go back ${action.patchbayAgentId}`));
        break;
      case "refreshRegistry":
        void this.orchestrator.acpRegistry.read("manual");
        break;
      case "browseRegistry":
        void this.orchestrator.acpRegistry.read("browse");
        break;
      case "addCommandRule":
        void this.orchestrator.setCommandRules(action.layer, (rules) => withRule(rules, action.rule));
        break;
      case "removeCommandRule":
        void this.orchestrator.setCommandRules(action.layer, (rules) => rules.filter((r) => !sameRule(r, action.rule)));
        break;
      case "testCommand":
        void this.orchestrator.testCommand(action.line, action.shell, action.draft).catch(this.orchestrator.logCatch("testCommand"));
        break;
      case "setWriteLocation":
        void this.orchestrator.setWriteLocation(action.location, action.layer, action.on).then(() => this.orchestrator.publishRules());
        break;
      case "pickWriteFolder":
        void this.pickWriteFolder(action.layer).catch(this.orchestrator.logCatch("pickWriteFolder"));
        break;
      case "setPreferences":
        void this.orchestrator.preferences.set(action.patch).then((preferences) => {
          // One truth, both channels: the Preferences page and the agent
          // view (composer stats) render the same stored object.
          this.orchestrator.settings.emit({ kind: "preferencesChanged", preferences });
          this.orchestrator.agentView.emit({ kind: "preferencesChanged", preferences });
          this.syncDetachContext();
        });
        break;
      case "surfaceActivation":
        this.orchestrator.noteSurfaceActivation(action.surface, action.activated);
        break;
      case "resolveElicitation":
        this.orchestrator.asks.answerQuestion(action.patchbayAskId, action.answer);
        break;
      case "reopenElicitationLink":
        this.orchestrator.asks.reopenLink(action.patchbayAskId);
        break;
      case "addSelectionContext": {
        const selection = this.editorStateHost.getSelection();
        if (selection === null) {
          void vscode.window.showInformationMessage("No selection — select text in a visible editor first.");
          break;
        }
        void this.orchestrator.sessions
          .addContext(action.patchbaySessionId, {
            id: chipId(),
            kind: "selection",
            label: `Selection: ${selection.file}:${selection.startLine}-${selection.endLine}`,
            content: selection.text,
            sourceUri: `${vscode.Uri.file(selection.file)}#L${selection.startLine}-${selection.endLine}`,
          })
          .catch(this.orchestrator.logCatch(`add context ${action.patchbaySessionId}`));
        break;
      }
      case "addFileContext": {
        const file = this.editorStateHost.getCurrentFile();
        if (file === null) {
          void vscode.window.showInformationMessage("No current file — open a file in an editor first.");
          break;
        }
        void this.orchestrator.sessions
          .addContext(action.patchbaySessionId, {
            id: chipId(),
            kind: "file",
            label: `File: ${file.file}`,
            content: file.content,
            sourceUri: vscode.Uri.file(file.file).toString(),
          })
          .catch(this.orchestrator.logCatch(`add context ${action.patchbaySessionId}`));
        break;
      }
      case "addDiagnosticsContext": {
        const diagnostics = this.editorStateHost.getDiagnostics();
        if (diagnostics.length === 0) break;
        void this.orchestrator.sessions
          .addContext(action.patchbaySessionId, {
            id: chipId(),
            kind: "diagnostics",
            label: `Problems (${diagnostics.length})`,
            content: diagnostics.map((d) => `${d.file}:${d.line} [${d.severity}] ${d.message}`).join("\n"),
          })
          .catch(this.orchestrator.logCatch(`add context ${action.patchbaySessionId}`));
        break;
      }
      case "removeContextChip":
        this.orchestrator.sessions.removeContext(action.patchbaySessionId, action.chipId);
        break;
      // A connect's failure is the store's to hold and show; the log has it
      // already.
      case "connectCatalogKey":
        void this.orchestrator.mcpServerGates.connectWithKey(action.catalogId, action.name, action.token, action.url).catch(() => {});
        break;
      case "connectCatalogOAuth":
        void this.orchestrator.mcpServerGates.connectOAuth(action.catalogId, action.name, action.url).catch(() => {});
        break;
      case "addCustomMcpServer":
        void this.orchestrator.mcpServerGates.addCustom(action.name, action.source, action.routing).catch(() => {});
        break;
      case "importMcpServersJson":
        void this.orchestrator.mcpServerGates.importJson(action.json).catch(this.orchestrator.logCatch("import MCP servers"));
        break;
      case "addImportedMcpServers":
        void this.orchestrator.mcpServerGates.addImported(action.importId, action.names).catch(this.orchestrator.logCatch("add imported MCP servers"));
        break;
      case "cancelMcpServersImport":
        void this.orchestrator.mcpServers.cancelImport(action.importId);
        break;
      case "updateMcpServerJson":
        void this.orchestrator.mcpServers.updateFromJson(action.patchbayMcpServerId, action.json);
        break;
      case "cancelMcpServerConnect":
        void this.orchestrator.mcpServerGates.cancel(action.key).catch(this.orchestrator.logCatch(`cancel ${action.key}`));
        break;
      case "setMcpServerActive":
        // Switched on, it is probed at once: the user just acted on it.
        void this.orchestrator.mcpServers
          .setActive(action.patchbayMcpServerId, action.active)
          .then(() => (action.active ? this.orchestrator.mcpServerGates.probe(action.patchbayMcpServerId) : undefined))
          .catch(this.orchestrator.logCatch(`switch ${action.patchbayMcpServerId}`));
        break;
      case "removeMcpServer":
        void this.orchestrator.mcpServerGates.remove(action.patchbayMcpServerId).catch(this.orchestrator.logCatch(`remove ${action.patchbayMcpServerId}`));
        break;
      case "setMcpServerRouting":
        void this.orchestrator.mcpServers.setRouting(action.patchbayMcpServerId, action.routing);
        break;
      case "setMcpServerTransport":
        void this.orchestrator.mcpServers.setTransport(action.patchbayMcpServerId, action.transport);
        break;
      case "probeMcpServer":
        void this.orchestrator.mcpServerGates.probe(action.patchbayMcpServerId).catch(this.orchestrator.logCatch(`probe ${action.patchbayMcpServerId}`));
        break;
      case "copyMcpServerJson":
        void this.copyMcpServerJson(action.patchbayMcpServerId);
        break;
      case "openProposedDiff":
        void this.openProposedDiff(action.patchbayAskId).catch(this.orchestrator.logCatch(`openProposedDiff ${action.patchbayAskId}`));
        break;
      case "openToolCallDiff":
        void this.openToolCallDiff(action.patchbaySessionId, action.toolCallId, action.path).catch(
          this.orchestrator.logCatch(`openToolCallDiff ${action.path}`),
        );
        break;
      case "openDiagram":
        this.openDiagram(action.svg);
        break;
      case "reportWebviewError":
        // the webviews' own runtime errors — surfaced here so the Output
        // channel is the durable record behind the in-view errors chip
        this.log.error(`webview ${action.view}: ${action.message}`);
        break;
      case "openFile":
        // files panel rows and tool-call locations — absolute paths
        void this.openFileAt(action.path, action.line).catch(this.orchestrator.logCatch(`openFile ${action.path}`));
        break;
      case "addOrUpdateAgentConfig":
        void this.orchestrator.agents.save(action.config, action.commandLine);
        break;
      case "removeAgentConfig":
        void this.orchestrator.gates.remove(action.patchbayAgentId).catch(this.orchestrator.logCatch(`remove ${action.patchbayAgentId}`));
        break;
      case "reorderAgentConfigs":
        void this.orchestrator.agents.reorder(action.patchbayAgentIds).catch(this.orchestrator.logCatch("reorderAgentConfigs"));
        break;
      case "reorderMcpServers":
        void this.orchestrator.mcpServers.reorder(action.patchbayMcpServerIds);
        break;
      case "addContextRoot":
        void this.addContextRoot(action.patchbaySessionId);
        break;
      case "saveRoot":
        void this.saveRoot(action.scope, action.path).catch(this.orchestrator.logCatch("saveRoot"));
        break;
      case "pickSavedRoot":
        void this.pickSavedRoot(action.scope, action.replacing).catch(this.orchestrator.logCatch("pickSavedRoot"));
        break;
      case "unsaveRoot":
        void this.orchestrator.savedRootsIn(action.scope)
          .remove(action.path)
          .then(() => this.orchestrator.publishSavedRoots(), this.orchestrator.logCatch("unsaveRoot"));
        break;
      case "removeContextRoot":
        void this.orchestrator.sessionGates
          .removeRoot(action.patchbaySessionId, action.path)
          .catch(this.orchestrator.logCatch(`removeRoot ${action.patchbaySessionId}`));
        break;
      case "addImageContext":
        void this.orchestrator.sessions
          .addContext(action.patchbaySessionId, {
            id: chipId(),
            kind: "image",
            label: action.label,
            content: action.base64,
            mimeType: action.mimeType,
          })
          .catch(this.orchestrator.logCatch(`add context ${action.patchbaySessionId}`));
        break;
      case "addDroppedFileContext":
        void this.orchestrator.sessions
          .addDroppedFile(action.patchbaySessionId, { chipId: chipId(), name: action.name, mimeType: action.mimeType, base64: action.base64 })
          .catch(this.orchestrator.logCatch(`addDroppedFileContext ${action.name}`));
        break;
      case "addFilePickerContext":
        void this.addFilePickerContext(action.patchbaySessionId);
        break;
      case "queryWorkspaceFiles":
        void this.queryWorkspaceFiles(action.query).catch(
          this.orchestrator.logCatch(`queryWorkspaceFiles "${action.query}"`),
        );
        break;
      default:
        // Every action the views can send has its handler here: a new kind
        // doesn't build until it does.
        action satisfies never;
    }
  }

  /** The `@` mention picker's workspace tier (the
   * webview asks, never reads the filesystem). One findFiles sweep per
   * query, ranked host-side — basename prefix, then basename substring,
   * then path substring — and cut to a menu-sized answer. Directories come
   * from the same sweep (every matched file's ancestors up to its workspace
   * folder) — no second walk. `files.exclude` applies through findFiles
   * itself; node_modules is excluded explicitly since only `search.exclude`
   * covers it by default. */
  private async queryWorkspaceFiles(query: string): Promise<void> {
    const uris = await vscode.workspace.findFiles("**/*", "**/node_modules/**", 2000);
    const q = query.toLowerCase();
    const rankOf = (path: string): number => {
      const name = basename(path).toLowerCase();
      return name.startsWith(q) ? 0 : name.includes(q) ? 1 : path.toLowerCase().includes(q) ? 2 : 3;
    };
    const rank = (paths: Iterable<string>) =>
      [...paths]
        .map((path) => ({ path, rank: rankOf(path) }))
        .filter((e) => e.rank < 3)
        .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length);
    const dirSet = new Set<string>();
    for (const uri of uris) {
      const stop = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
      let dir = uri.fsPath;
      for (;;) {
        const cut = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
        const parent = cut > 0 ? dir.slice(0, cut) : "";
        if (parent === "" || parent === stop || parent === dir) break;
        dirSet.add(parent);
        dir = parent;
      }
    }
    this.orchestrator.agentView.emit({
      kind: "workspaceFilesListed",
      query,
      files: rank(uris.map((u) => u.fsPath)).slice(0, 20).map((e) => e.path),
      dirs: rank(dirSet).slice(0, 8).map((e) => e.path),
    });
  }

  /** "Add workspace folders as session context roots" —
   * a native folder picker, since only the extension host can browse the
   * real filesystem; the result is just another context-root path,
   * patchbay never indexes what's inside it. */
  private async addContextRoot(patchbaySessionId: PatchbaySessionId): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Add as context root",
    });
    const uri = picked?.[0];
    if (uri === undefined) return;
    await this.orchestrator.sessionGates.addRoot(patchbaySessionId, uri.fsPath);
  }


  /** The one writer of a saved root, from the chip or from Settings.
   * Saving shapes the sessions born from now on — never a live one. What
   * is stored is an absolute path to a folder that exists: a relative one
   * resolves against the workspace here, once, so every later session
   * reads the same folder; anything that isn't a folder is refused, said. */
  private async saveRoot(scope: SavedRootScope, path: string, replacing?: string): Promise<void> {
    if (scope === "workspace" && this.orchestrator.savedRootsView().workspace === null) return;
    const absolute = normalizeRootPath(isAbsolute(path) ? path : resolve(this.orchestrator.workspaceCwd, path));
    if (!isFolder(absolute)) {
      void vscode.window.showWarningMessage(`Not saved: ${absolute} is not a folder on this machine.`);
      return;
    }
    const store = this.orchestrator.savedRootsIn(scope);
    await (replacing === undefined ? store.add(absolute) : store.replace(replacing, absolute));
    this.orchestrator.publishSavedRoots();
  }

  /** Settings' add, or its edit of one entry: the picker opens where that
   * entry points while the folder still exists — a gone one opens at the
   * picker's default, the user is finding its new home. */
  private async pickSavedRoot(scope: SavedRootScope, replacing?: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: replacing === undefined ? "Save as root" : "Use this folder",
      ...(replacing !== undefined && isFolder(replacing) ? { defaultUri: vscode.Uri.file(replacing) } : {}),
    });
    const uri = picked?.[0];
    if (uri === undefined) return;
    await this.saveRoot(scope, uri.fsPath, replacing);
  }

  /** "Attach file" picker — the host-side byte producer: the file already
   * has a host path, so no bytes cross the webview. Images in the wire set
   * ride as image chips (bytes read here); everything else — including
   * images too big or too exotic for the wire — becomes an attachment chip
   * at its real path, whose resource_link the agent reads itself. That
   * fallback is strictly honest, so nothing picked is ever refused. A
   * picked file is at rest on disk, hence a link, not a text snapshot: the
   * inline `file` chip is for the editor buffer, which may be dirty. */
  private async addFilePickerContext(patchbaySessionId: PatchbaySessionId): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: false,
      canSelectFiles: true,
      canSelectMany: false,
      openLabel: "Attach to context",
    });
    const uri = picked?.[0];
    if (uri === undefined) return;
    const name = basename(uri.fsPath);
    const { size } = await vscode.workspace.fs.stat(uri);
    const form = pickedFileForm(name, size, this.orchestrator.preferences.get().attachmentMaxMB * 1024 * 1024);
    if (form.kind === "image") {
      const bytes = await vscode.workspace.fs.readFile(uri);
      await this.orchestrator.sessions.addContext(patchbaySessionId, {
        id: chipId(),
        kind: "image",
        label: `Image: ${name}`,
        content: Buffer.from(bytes).toString("base64"),
        mimeType: form.mimeType,
      });
    } else {
      await this.orchestrator.sessions.addContext(patchbaySessionId, {
        id: chipId(),
        kind: "attachment",
        label: fileChipLabel(name),
        name,
        path: uri.fsPath,
      });
    }
  }

  /** Copy config: the server as an `mcpServers` document (the shape Import
   * reads back) goes to the clipboard, carrying what its owner typed — env
   * values, a header key — and never an OAuth token. Copy and paste are
   * the owner's explicit acts; configs never ride a repo, so nothing can
   * follow a user between workspaces on its own. */
  private async copyMcpServerJson(patchbayMcpServerId: PatchbayMcpServerId): Promise<void> {
    const name = this.orchestrator.mcpServers.name(patchbayMcpServerId);
    const json = await this.orchestrator.mcpServers.exportJson(patchbayMcpServerId);
    if (name === undefined || json === undefined) return;
    await vscode.env.clipboard.writeText(json);
    void vscode.window.showInformationMessage(`Copied "${name}" as an mcpServers entry.`);
  }

  /** File writes' add: a folder the user picks lands switched on, at the
   * layer it was added at. */
  private async pickWriteFolder(layer: "workspace" | "machine"): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Approve writes here",
    });
    const uri = picked?.[0];
    if (uri === undefined) return;
    await this.orchestrator.setWriteLocation({ kind: "path", path: uri.fsPath }, layer, true);
    this.orchestrator.publishRules();
  }

  /** logCatch for what the user asked for themselves: the failure is also
   * said where they are — what didn't happen, and the reason. */
  private warnCatch(context: string, what: string): (err: unknown) => void {
    return (err) => {
      this.orchestrator.logCatch(context)(err);
      if (!(err instanceof Cancelled)) void vscode.window.showWarningMessage(`${what} — ${agentErrorText(err)}`);
    };
  }
  dispose(): void {
    for (const d of this.editorSubscriptions) d.dispose();
    this.editorStateHost.stop();
    this.orchestrator.dispose();
    this.statusBarItem.dispose();
    this.wireChannel?.dispose();
    this.wireStatusItem?.dispose();
    if (this.wireStatusTimer !== null) clearInterval(this.wireStatusTimer);
  }
}
