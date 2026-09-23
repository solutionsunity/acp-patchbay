// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Wire format between the subprocesses an agent spawns from a session's
// mcpServers entries — patchbay's local MCP server and its stdio-to-HTTP
// bridge — and the orchestrator that actually holds live VS Code state.
// Neither subprocess can reach vscode APIs (they don't run in the extension
// host), so everything forwards over this newline-delimited JSON channel to
// whoever does. One socket for the orchestrator's whole lifetime; every
// subprocess belongs to exactly one session and names it on every message.
export interface IpcRequest {
  id: number;
  /** The session the calling subprocess serves — the correlation token it
   * was spawned with, which the orchestrator maps back to the real ACP
   * session id. */
  sessionId: string;
  method:
    | "getSelection"
    | "getCurrentFile"
    | "getDiagnostics"
    | "getOpenEditors"
    | "getWorkspaceState"
    | "getRoots"
    | "watchRoots"
    | "requestUserInput"
    | "getIntegrationToken";
  params?: unknown;
}

/** Params of `getIntegrationToken`: which integration's credential the
 * bridge is presenting. */
export interface IntegrationTokenParams {
  integrationId: string;
}

/** Result of `getIntegrationToken` — null when the integration isn't
 * connected in this workspace (never silently substitutes another one's
 * credential, never partially connects). */
export interface IntegrationTokenResult {
  accessToken: string;
}

/** Result of `getRoots`: the session's complete root list — the cwd, the
 * workspace's other folders, the user-added external roots — as absolute
 * paths in that order. The same list the agent receives through ACP where
 * it takes the field; here it reaches the MCP servers regardless. */
export interface RootsResult {
  roots: string[];
}

export interface IpcResponse {
  id: number;
  result?: unknown;
  error?: string;
}

/** The one message the orchestrator pushes on its own: a subprocess that
 * sent `watchRoots` hears every change to its session's root list, and
 * re-reads the list with `getRoots` — the notification carries no data,
 * so a subscriber can never hold a stale copy of a list it was told about. */
export interface IpcNotification {
  method: "rootsChanged";
}

export function isIpcNotification(message: unknown): message is IpcNotification {
  return (
    typeof message === "object" &&
    message !== null &&
    !("id" in message) &&
    (message as { method?: unknown }).method === "rootsChanged"
  );
}

export interface SelectionInfo {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface CurrentFileInfo {
  file: string;
  content: string;
}

export interface DiagnosticInfo {
  file: string;
  line: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
}

export interface OpenEditorInfo {
  file: string;
  dirty: boolean;
}

export interface WorkspaceStateSnapshot {
  openEditors: OpenEditorInfo[];
  diagnostics: DiagnosticInfo[];
  selection: SelectionInfo | null;
}

export interface RequestUserInputParams {
  message: string;
  /** The form as a JSON Schema — the same shape an agent's own elicitation
   * request carries — unvalidated until the host parses it. Absent for a
   * message-only confirm. */
  requestedSchema?: unknown;
}

/** Reads newline-delimited JSON messages from a socket-like stream. */
export function parseLines(buffer: string): { messages: unknown[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const messages = parts.filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as unknown);
  return { messages, rest };
}

export function encodeLine(value: unknown): string {
  return JSON.stringify(value) + "\n";
}
