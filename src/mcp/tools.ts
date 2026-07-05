// Tool definitions for patchbay's local MCP server. One uniform mechanism
// per capability (architecture.md's "every agent sees just another local
// MCP server") — tools only, no MCP resources: every agent's MCP client
// supports basic tool calling, whereas resources/subscribe support is
// uneven, so a tools-only design sidesteps needing a second path at all
// (get_workspace_state *is* the resources.subscribe fallback, staying the
// only path rather than one of two).
import type { IpcClient } from "./ipc-client";
import type { ElicitationPropertyView } from "./ipc-protocol";

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
    name: "request_user_input",
    description:
      "Ask the user a question with a small structured form (elicitation fallback — works with every agent regardless of native ACP elicitation support).",
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
    case "request_user_input": {
      const message = typeof args.message === "string" ? args.message : "";
      const properties = Array.isArray(args.properties)
        ? (args.properties as ElicitationPropertyView[]).map((p) => ({
            name: p.name,
            type: p.type,
            title: p.title,
            description: p.description,
            required: p.required ?? false,
          }))
        : [];
      const answer = await ipc.request("requestUserInput", { message, properties });
      if (answer === null) return { content: [{ type: "text", text: "cancelled" }], isError: true };
      return textResult(answer);
    }
    default:
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
}
