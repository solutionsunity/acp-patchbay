// Wire format between the local MCP server (spawned as the *agent's* own
// subprocess — ACP's stdio transport model) and the orchestrator that
// actually holds live VS Code state. The MCP server can't reach vscode APIs
// itself (it's not running in the extension host), so every tool call
// forwards over this newline-delimited JSON channel to whoever does.
// One socket for the orchestrator's whole lifetime; sessionId disambiguates
// which session's editor context / elicitation card a call belongs to.
export interface IpcRequest {
  id: number;
  sessionId: string;
  method:
    | "getSelection"
    | "getCurrentFile"
    | "getDiagnostics"
    | "getOpenEditors"
    | "getWorkspaceState"
    | "requestUserInput";
  params?: unknown;
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
