// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Tool definitions for patchbay's local MCP server. One uniform mechanism
// per capability — every agent sees just another local
// MCP server — tools only, no MCP resources: every agent's MCP client
// supports basic tool calling, whereas resources/subscribe support is
// uneven, so a tools-only design sidesteps needing a second path at all
// (get_workspace_state *is* the resources.subscribe fallback, staying the
// only path rather than one of two). Roots are a tool for the same
// reason in reverse: MCP's own roots flow has the *server* ask the client,
// and the client here is the agent, which holds no root list of its own —
// the orchestrator does, so the server reads it there and hands it over.
import type { IpcClient } from "./ipc-client";
import type { ElicitationAnswer } from "../shared/protocol";
import type { RequestUserInputParams, RootsResult } from "./ipc-protocol";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  /** What the tool does to the world, stated rather than left to MCP's
   * defaults — an unannotated tool reads as one that may write, destroy and
   * reach outside, and an agent in a read-only mode refuses it unasked.
   * Required, so a new tool states its own. */
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
}

/** Changes nothing and reaches nothing beyond the editor: the tool reads
 * editor state, or asks the user and hands back the answer. */
const READS_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** Sent once at connect, for the clients that pass a server's instructions
 * to the model: what this server knows that the agent can't see from where
 * it runs. It names no tool — the list above is the one place they are. */
export const SERVER_INSTRUCTIONS =
  "This server reads the user's editor live: the folders this session works in, the open editors, the active file with its unsaved changes, the current selection, and the problems the editor reports. Read these from its tools rather than inferring them from a shell command's current directory or from files on disk. A session may work in several folders, and a shell command's current directory is only one directory.";

export const TOOL_DEFS: McpToolDef[] = [
  {
    name: "get_selection",
    description: "The user's current editor selection: file, line range, and text. Empty if nothing is selected.",
    inputSchema: { type: "object" },
    annotations: READS_ONLY,
  },
  {
    name: "get_current_file",
    description: "The active editor's file path and live content (including unsaved changes).",
    inputSchema: { type: "object" },
    annotations: READS_ONLY,
  },
  {
    name: "get_diagnostics",
    description: "Current problems (errors, warnings) across the workspace.",
    inputSchema: { type: "object" },
    annotations: READS_ONLY,
  },
  {
    name: "get_open_editors",
    description: "Paths of all currently open editor tabs, with unsaved-changes status.",
    inputSchema: { type: "object" },
    annotations: READS_ONLY,
  },
  {
    name: "get_workspace_state",
    description:
      "A combined snapshot: the folders this session works in (the list get_roots returns), open editors, diagnostics, and current selection.",
    inputSchema: { type: "object" },
    annotations: READS_ONLY,
  },
  {
    name: "get_roots",
    // Says when to call it, not only what it returns: an agent that isn't
    // handed the folders at session open learns them here or not at all,
    // and one that answers from its shell's directory names a single folder
    // of a workspace that has several.
    description:
      "The folders this session works in, as a JSON array of absolute paths: the session's working directory first, then the workspace's other folders and any extra roots the user added (one that no longer exists on disk is left out). Read fresh on every call. Call this when the user asks about roots, workspace folders, project directories or the working directory, and before treating the project as a single folder. Do not infer the list from a shell command's current directory: that is one directory, which may not even be the session's, and never the whole list.",
    inputSchema: { type: "object" },
    annotations: READS_ONLY,
  },
  {
    name: "request_user_input",
    description:
      "Ask the user a question with a small structured form (elicitation fallback — works with every agent regardless of native ACP elicitation support). Returns the answers as JSON, or an error result: \"declined\" means the user refused — do not ask again; \"cancelled\" means the form was dismissed without an answer.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to ask the user." },
        properties: {
          type: "array",
          description: "Form fields to collect.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["string", "number", "integer", "boolean"] },
              title: { type: "string" },
              description: { type: "string" },
              required: { type: "boolean" },
              default: {
                type: ["string", "number", "boolean"],
                description: "Pre-filled value; ignored unless it matches the field's type.",
              },
            },
            required: ["name", "type"],
          },
        },
      },
      required: ["message"],
    },
    annotations: READS_ONLY,
  },
];

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export async function callTool(
  ipc: IpcClient,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "get_selection":
      return textResult(await ipc.request("getSelection"));
    case "get_current_file":
      return textResult(await ipc.request("getCurrentFile"));
    case "get_diagnostics":
      return textResult(await ipc.request("getDiagnostics"));
    case "get_open_editors":
      return textResult(await ipc.request("getOpenEditors"));
    case "get_workspace_state":
      return textResult(await ipc.request("getWorkspaceState"));
    case "get_roots":
      return textResult(((await ipc.request("getRoots")) as RootsResult).roots);
    case "request_user_input": {
      const message = typeof args.message === "string" ? args.message : "";
      // The tool's field list is only a flatter spelling of the schema an
      // agent's own elicitation request carries, so it is re-spelled here
      // and the host reads both with one parser — types, defaults, limits.
      // Validation stays there: nothing in this list is trusted yet.
      const params: RequestUserInputParams = { message };
      if (Array.isArray(args.properties) && args.properties.length > 0) {
        const properties: Record<string, unknown> = {};
        const required: unknown[] = [];
        for (const item of args.properties as Array<Record<string, unknown>>) {
          const { name, required: isRequired, ...schema } = item ?? {};
          properties[String(name)] = schema;
          if (isRequired === true) required.push(name);
        }
        params.requestedSchema = { type: "object", properties, required };
      }
      const answer = (await ipc.request("requestUserInput", params)) as ElicitationAnswer;
      if (answer.action === "accept") return textResult(answer.content);
      return { content: [{ type: "text", text: answer.action === "decline" ? "declined" : "cancelled" }], isError: true };
    }
    default:
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
}
