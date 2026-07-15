// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The vscode-touching side of the IPC bridge: listens on a local socket,
// answers the local MCP server's tool calls with real editor state. This is
// the only place that needs vscode.window/workspace/languages for MCP
// purposes — the MCP server subprocess itself (src/mcp/server-main.ts) is
// plain Node, spawned by the agent, and never touches vscode directly.
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  encodeLine,
  parseLines,
  type CurrentFileInfo,
  type DiagnosticInfo,
  type IntegrationTokenResult,
  type IpcRequest,
  type IpcResponse,
  type OpenEditorInfo,
  type RequestUserInputParams,
  type SelectionInfo,
  type WorkspaceStateSnapshot,
} from "../mcp/ipc-protocol";

export interface EditorStateHostHooks {
  /** Renders an elicitation form card in the given session's transcript and
   * resolves with the user's answers, or null if cancelled. */
  requestUserInput(
    sessionId: string,
    params: RequestUserInputParams,
  ): Promise<Record<string, unknown> | null>;
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
  }

  stop(): void {
    this.server?.close();
    this.server = null;
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
  }

  private async handleRequest(socket: Socket, request: IpcRequest): Promise<void> {
    try {
      const result = await this.dispatch(request);
      const response: IpcResponse = { id: request.id, result };
      socket.write(encodeLine(response));
    } catch (err) {
      const response: IpcResponse = { id: request.id, error: (err as Error).message };
      socket.write(encodeLine(response));
    }
  }

  private async dispatch(request: IpcRequest): Promise<unknown> {
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
      case "requestUserInput":
        return this.hooks.requestUserInput(
          request.sessionId,
          request.params as RequestUserInputParams,
        );
      case "getIntegrationToken":
        return this.hooks.getIntegrationToken(request.sessionId);
    }
  }

  getSelection(): SelectionInfo | null {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || editor.selection.isEmpty) return null;
    return {
      file: editor.document.uri.fsPath,
      startLine: editor.selection.start.line + 1,
      endLine: editor.selection.end.line + 1,
      text: editor.document.getText(editor.selection),
    };
  }

  getCurrentFile(): CurrentFileInfo | null {
    const editor = vscode.window.activeTextEditor;
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
