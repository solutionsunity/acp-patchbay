// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The vscode-touching side of the IPC bridge: listens on a local socket,
// answers the tool calls of the subprocesses an agent spawns from a
// session's mcpServers entries with real editor state and session facts.
// This is the only place that needs vscode.window/workspace/languages for
// MCP purposes — the subprocesses themselves (src/mcp/server-main.ts,
// src/integrations/bridge-main.ts) are plain Node, spawned by the agent,
// and never touch vscode directly.
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  encodeLine,
  parseLines,
  type CurrentFileInfo,
  type DiagnosticInfo,
  type IntegrationTokenParams,
  type IntegrationTokenResult,
  type IpcNotification,
  type IpcRequest,
  type IpcResponse,
  type OpenEditorInfo,
  type RequestUserInputParams,
  type RootsResult,
  type SelectionInfo,
  type WorkspaceStateSnapshot,
} from "../mcp/ipc-protocol";
import type { ElicitationAnswer } from "../shared/protocol";

export interface EditorStateHostHooks {
  /** Renders an elicitation form card in the given session's transcript and
   * resolves with what the user did: answered, declined, or cancelled. */
  requestUserInput(
    sessionId: string,
    params: RequestUserInputParams,
  ): Promise<ElicitationAnswer>;
  /** The session's complete root list, cwd first — what the session
   * manager composes for the wire, read fresh per call so a subprocess
   * never holds a copy the user has since changed. Empty for a session
   * that is gone (tokens are minted at attach and retired at close). */
  sessionRoots(sessionId: string): readonly string[];
  /** The one other thing spawned subprocesses need from the extension host
   * that isn't editor state: a currently-valid token for a connected
   * integration, refreshed transparently server-side if needed. This host is
   * the same "subprocess ↔ orchestrator" trust boundary either way — one
   * socket, one bridge, two kinds of callers. */
  getIntegrationToken(integrationId: string): Promise<IntegrationTokenResult | null>;
}

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

export class EditorStateHost {
  private server: Server | null = null;
  readonly socketPath: string;
  /** The text editor the user was last in. `window.activeTextEditor` goes
   * undefined the moment a webview becomes the active editor — a detached
   * Patchbay panel, Settings, a preview — which is exactly when the
   * composer's adders and the MCP tools ask "which file?". Remembered from
   * the change event, validated on every read (see currentEditor). */
  private lastTextEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
  private subscription: vscode.Disposable | null = null;
  /** Sockets that asked to hear about their session's root changes, by
   * the session they serve. A socket leaves when it closes — the agent
   * that spawned the subprocess ended it. */
  private readonly rootWatchers = new Map<Socket, string>();

  constructor(
    workspaceId: string,
    private readonly hooks: EditorStateHostHooks,
  ) {
    this.socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\acp-patchbay-${workspaceId}`
        : join(tmpdir(), `acp-patchbay-${workspaceId}.sock`);
  }

  start(): void {
    if (this.server !== null) return;
    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.listen(this.socketPath);
    this.subscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor !== undefined) this.lastTextEditor = editor;
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
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

  private handleConnection(socket: Socket): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const { messages, rest } = parseLines(buffer);
      buffer = rest;
      for (const message of messages) void this.handleRequest(socket, message as IpcRequest);
    });
    socket.on("error", () => {});
    socket.on("close", () => this.rootWatchers.delete(socket));
  }

  /** The session's root list changed: every subprocess of that session
   * that asked to hear it is told, and re-reads the list itself. */
  notifyRootsChanged(sessionId: string): void {
    const notification: IpcNotification = { method: "rootsChanged" };
    for (const [socket, watched] of this.rootWatchers) {
      if (watched === sessionId) socket.write(encodeLine(notification));
    }
  }

  private async handleRequest(socket: Socket, request: IpcRequest): Promise<void> {
    try {
      const result = await this.dispatch(socket, request);
      const response: IpcResponse = { id: request.id, result };
      socket.write(encodeLine(response));
    } catch (err) {
      const response: IpcResponse = { id: request.id, error: (err as Error).message };
      socket.write(encodeLine(response));
    }
  }

  private async dispatch(socket: Socket, request: IpcRequest): Promise<unknown> {
    switch (request.method) {
      case "getSelection":
        return this.getSelection();
      case "getCurrentFile":
        return this.getCurrentFile();
      case "getDiagnostics":
        return this.getDiagnostics();
      case "getOpenEditors":
        return this.getOpenEditors();
      case "getWorkspaceState":
        return this.getWorkspaceState();
      case "getRoots": {
        const result: RootsResult = { roots: [...this.hooks.sessionRoots(request.sessionId)] };
        return result;
      }
      case "watchRoots":
        this.rootWatchers.set(socket, request.sessionId);
        return {};
      case "requestUserInput":
        return this.hooks.requestUserInput(
          request.sessionId,
          request.params as RequestUserInputParams,
        );
      case "getIntegrationToken":
        return this.hooks.getIntegrationToken((request.params as IntegrationTokenParams).integrationId);
    }
  }

  getSelection(): SelectionInfo | null {
    // A selection is read only from an editor still on screen: an editor
    // whose tab is hidden reports the selection it had when it was last
    // shown, which the user can neither see nor is pointing at.
    const editor = this.currentEditor();
    if (editor === undefined || editor.selection.isEmpty) return null;
    if (!vscode.window.visibleTextEditors.includes(editor)) return null;
    return {
      file: editor.document.uri.fsPath,
      startLine: editor.selection.start.line + 1,
      endLine: editor.selection.end.line + 1,
      text: editor.document.getText(editor.selection),
    };
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

  private getWorkspaceState(): WorkspaceStateSnapshot {
    return {
      openEditors: this.getOpenEditors(),
      diagnostics: this.getDiagnostics(),
      selection: this.getSelection(),
    };
  }
}
