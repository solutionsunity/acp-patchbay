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
}

export const TOOL_DEFS: McpToolDef[] = [
  {
    name: "get_selection",
    description: "The user's current editor selection: file, line range, and text. Empty if nothing is selected.",
    inputSchema: { type: "object" },
  },
  {
    name: "get_current_file",
    description: "The active editor's file path and live content (including unsaved changes).",
    inputSchema: { type: "object" },
  },
  {
    name: "get_diagnostics",
    description: "Current problems (errors, warnings) across the workspace.",
    inputSchema: { type: "object" },
  },
  {
    name: "get_open_editors",
    description: "Paths of all currently open editor tabs, with unsaved-changes status.",
    inputSchema: { type: "object" },
  },
  {
    name: "get_workspace_state",
    description: "A combined snapshot: open editors, diagnostics, and current selection.",
    inputSchema: { type: "object" },
  },
  {
    name: "get_roots",
    description:
      "The folders this session works in, as absolute paths: the workspace folders and any extra roots the user added to the session.",
    inputSchema: { type: "object" },
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
