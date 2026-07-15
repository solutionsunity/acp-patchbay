// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Wire format between the local MCP server (spawned as the *agent's* own
// subprocess — ACP's stdio transport model) and the orchestrator that
// actually holds live VS Code state. The MCP server can't reach vscode APIs
// itself (it's not running in the extension host), so every tool call
// forwards over this newline-delimited JSON channel to whoever does.
// One socket for the orchestrator's whole lifetime; sessionId disambiguates
// which session's editor context / elicitation card a call belongs to.
export interface IpcRequest {
  id: number;
  /** Disambiguates which session an editor-state/elicitation call belongs
   * to; for the integration-bridge methods (P9) there is no session, so the
   * bridge passes its integrationId here instead — same field, same "which
   * caller" role, just a different kind of caller. */
  sessionId: string;
  method:
    | "getSelection"
    | "getCurrentFile"
    | "getDiagnostics"
    | "getOpenEditors"
    | "getWorkspaceState"
    | "requestUserInput"
    | "getIntegrationToken";
  params?: unknown;
}

/** Result of `getIntegrationToken` — null when the integration isn't
 * connected in this workspace (never silently substitutes another one's
 * credential, never partially connects). */
export interface IntegrationTokenResult {
  accessToken: string;
}

export interface IpcResponse {
  id: number;
  result?: unknown;
  error?: string;
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

export interface ElicitationPropertyView {
  name: string;
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  required: boolean;
}

export interface RequestUserInputParams {
  message: string;
  properties: ElicitationPropertyView[];
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
