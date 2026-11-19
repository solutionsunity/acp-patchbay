// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The editor's own state, read where only VS Code can read it: the
// selection, the current file, the diagnostics, the open documents — what
// the orchestrator's IPC host (ipc-host.ts) answers the subprocesses an
// agent spawns with, and what the composer's adders show.
import * as vscode from "vscode";
import type { EditorReads } from "./ipc-host";
import {
  type CurrentFileInfo,
  type DiagnosticInfo,
  type OpenEditorInfo,
  type SelectionInfo,
} from "../mcp/ipc-protocol";


function severityName(sev: vscode.DiagnosticSeverity): DiagnosticInfo["severity"] {
  switch (sev) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    default:
      return "hint";
  }
}

export class EditorStateHost implements EditorReads {
  /** The text editor the user was last in. `window.activeTextEditor` goes
   * undefined the moment a webview becomes the active editor — a detached
   * Patchbay panel, Settings, a preview — which is exactly when the
   * composer's adders and the MCP tools ask "which file?". Remembered from
   * the change event, validated on every read (see currentEditor). */
  private lastTextEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
  private subscription: vscode.Disposable | null = null;

  start(): void {
    if (this.subscription !== null) return;
    this.subscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor !== undefined) this.lastTextEditor = editor;
    });
  }

  stop(): void {
    this.subscription?.dispose();
    this.subscription = null;
  }

  /** The editor "current" means: the active text editor when there is one,
   * else the last one the user was in, as long as its document is still
   * open. A closed tab is nobody's current file. */
  private currentEditor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active !== undefined) return active;
    const last = this.lastTextEditor;
    return last !== undefined && !last.document.isClosed ? last : undefined;
  }


  getSelection(): SelectionInfo | null {
    // A selection is read only from an editor still on screen: an editor
    // whose tab is hidden reports the selection it had when it was last
    // shown, which the user can neither see nor is pointing at.
    const editor = this.currentEditor();
    if (editor === undefined || !vscode.window.visibleTextEditors.includes(editor)) return null;
    // Every selection of that one editor that holds text — several cursors
    // make several, and the first made may be a bare cursor among them —
    // read down the file: the order they were made in says nothing to a
    // reader. Another editor's selection is what was last selected there,
    // not what the user is pointing at.
    const selections = editor.selections
      .filter((selection) => !selection.isEmpty)
      .sort((a, b) => a.start.compareTo(b.start))
      .map((selection) => ({
        startLine: selection.start.line + 1,
        endLine: selection.end.line + 1,
        text: editor.document.getText(selection),
      }));
    return selections.length === 0 ? null : { file: editor.document.uri.fsPath, selections };
  }

  getCurrentFile(): CurrentFileInfo | null {
    const editor = this.currentEditor();
    if (editor === undefined) return null;
    return { file: editor.document.uri.fsPath, content: editor.document.getText() };
  }

  getDiagnostics(): DiagnosticInfo[] {
    const out: DiagnosticInfo[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      for (const d of diagnostics) {
        out.push({
          file: uri.fsPath,
          line: d.range.start.line + 1,
          severity: severityName(d.severity),
          message: d.message,
        });
      }
    }
    return out;
  }

  getOpenEditors(): OpenEditorInfo[] {
    return vscode.workspace.textDocuments
      .filter((d) => d.uri.scheme === "file")
      .map((d) => ({ file: d.uri.fsPath, dirty: d.isDirty }));
  }
}
