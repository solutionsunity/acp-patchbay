// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The orchestrator's side of the IPC bridge: listens on a local socket and
// answers the subprocesses an agent spawns from a session's mcpServers
// entries — admitted by the context token each was spawned with, answered
// with session facts the orchestrator holds and, for editor state, with
// what its host reads from the editor (EditorReads). The subprocesses
// themselves (src/mcp/server-main.ts, src/mcp/bridge-main.ts) are plain
// Node, spawned by the agent.
import { createServer, type Server, type Socket } from "node:net";
import {
  encodeLine,
  ipcAddress,
  parseLines,
  type CurrentFileInfo,
  type DiagnosticInfo,
  type McpServerTokenParams,
  type McpServerTokenResult,
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
import type { PatchbayMcpServerId } from "../shared/ids";
import { agentErrorText } from "./readers/agent-error";

/** The editor's own state, as a subprocess may read it — read from the
 * editor by the host, the one side that can. */
export interface EditorReads {
  getSelection(): SelectionInfo | null;
  getCurrentFile(): CurrentFileInfo | null;
  getDiagnostics(): DiagnosticInfo[];
  getOpenEditors(): OpenEditorInfo[];
}

/** Every hook takes the context token the calling subprocess was spawned
 * with — the one thing that says which attach it serves. */
export interface IpcHostHooks {
  /** Whether the token was minted for one of this window's attaches, on a
   * connection still up. A request with any other token gets nothing: the
   * socket is reachable by every process of the user, and only the
   * subprocesses an agent spawned from a session's mcpServers hold one. */
  admits(contextToken: string): boolean;
  /** Renders an elicitation form card in the token's session's transcript
   * and resolves with what the user did: answered, declined, or
   * cancelled. */
  requestUserInput(
    contextToken: string,
    params: RequestUserInputParams,
  ): Promise<ElicitationAnswer>;
  /** The token's session's complete root list, cwd first — what the
   * sessions store composes for the wire, read fresh per call so a
   * subprocess never holds a copy the user has since changed. Empty for a
   * session that is gone. */
  sessionRoots(contextToken: string): readonly string[];
  /** The one other thing spawned subprocesses need from the extension host
   * that isn't editor state: a currently-valid credential for an MCP
   * server — only for a bridge the server was given to under this token,
   * refreshed transparently if needed. */
  getMcpServerToken(contextToken: string, patchbayMcpServerId: PatchbayMcpServerId): Promise<McpServerTokenResult | null>;
}

export class IpcHost {
  private server: Server | null = null;
  readonly socketPath: string;
  /** Sockets that asked to hear about their session's root changes, by
   * the token they were spawned with. A socket leaves when it closes — the
   * agent that spawned the subprocess ended it. */
  private readonly rootWatchers = new Map<Socket, string>();

  constructor(
    name: string,
    private readonly hooks: IpcHostHooks,
    private readonly editor: EditorReads,
  ) {
    this.socketPath = ipcAddress(name);
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
    socket.on("error", () => {});
    socket.on("close", () => this.rootWatchers.delete(socket));
  }

  /** A token's session's root list changed: every subprocess spawned with
   * it that asked to hear it is told, and re-reads the list itself. */
  notifyRootsChanged(contextToken: string): void {
    const notification: IpcNotification = { method: "rootsChanged" };
    for (const [socket, watched] of this.rootWatchers) {
      if (watched === contextToken) socket.write(encodeLine(notification));
    }
  }

  private async handleRequest(socket: Socket, request: IpcRequest): Promise<void> {
    try {
      const result = await this.dispatch(socket, request);
      const response: IpcResponse = { id: request.id, result };
      socket.write(encodeLine(response));
    } catch (err) {
      const response: IpcResponse = { id: request.id, error: agentErrorText(err) };
      socket.write(encodeLine(response));
    }
  }

  private async dispatch(socket: Socket, request: IpcRequest): Promise<unknown> {
    if (!this.hooks.admits(request.contextToken)) throw new Error("unknown session token");
    switch (request.method) {
      case "getSelection":
        return this.editor.getSelection();
      case "getCurrentFile":
        return this.editor.getCurrentFile();
      case "getDiagnostics":
        return this.editor.getDiagnostics();
      case "getOpenEditors":
        return this.editor.getOpenEditors();
      case "getWorkspaceState":
        return this.getWorkspaceState();
      case "getRoots": {
        const result: RootsResult = { roots: [...this.hooks.sessionRoots(request.contextToken)] };
        return result;
      }
      case "watchRoots":
        this.rootWatchers.set(socket, request.contextToken);
        return {};
      case "requestUserInput":
        return this.hooks.requestUserInput(
          request.contextToken,
          request.params as RequestUserInputParams,
        );
      case "getMcpServerToken":
        return this.hooks.getMcpServerToken(
          request.contextToken,
          (request.params as McpServerTokenParams).patchbayMcpServerId,
        );
    }
  }

  private getWorkspaceState(): WorkspaceStateSnapshot {
    return {
      openEditors: this.editor.getOpenEditors(),
      diagnostics: this.editor.getDiagnostics(),
      selection: this.editor.getSelection(),
    };
  }
}
