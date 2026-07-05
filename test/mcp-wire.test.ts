// P7 gate: the real bundled MCP server subprocess (out/mcp-server.js) speaks
// correct MCP JSON-RPC over stdio and correctly forwards every tool call
// over the IPC bridge. Stands in a plain net server for EditorStateHost
// (which needs real vscode data — that half is covered by manual/test-
// electron smoke) so this proves the wire protocol and routing without it.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeLine,
  parseLines,
  type IpcRequest,
  type IpcResponse,
} from "../src/mcp/ipc-protocol";

const MCP_SERVER = join(process.cwd(), "out", "mcp-server.js");

/** A minimal stand-in for EditorStateHost: same wire protocol, canned data. */
class FakeIpcHost {
  server: Server;
  socketPath: string;
  requests: IpcRequest[] = [];
  elicitationAnswer: Record<string, unknown> | null = { confirmed: true };

  constructor(id: string) {
    this.socketPath = join(tmpdir(), `patchbay-test-ipc-${id}.sock`);
    this.server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const { messages, rest } = parseLines(buffer);
        buffer = rest;
        for (const message of messages) {
          const req = message as IpcRequest;
          this.requests.push(req);
          const response: IpcResponse = { id: req.id, result: this.answer(req) };
          socket.write(encodeLine(response));
        }
      });
    });
  }

  private answer(req: IpcRequest): unknown {
    switch (req.method) {
      case "getSelection":
        return { file: "/ws/a.ts", startLine: 1, endLine: 2, text: "const x = 1;" };
      case "getCurrentFile":
        return { file: "/ws/a.ts", content: "const x = 1;\n" };
      case "getDiagnostics":
        return [{ file: "/ws/a.ts", line: 1, severity: "error", message: "boom" }];
      case "getOpenEditors":
        return [{ file: "/ws/a.ts", dirty: false }];
      case "getWorkspaceState":
        return { openEditors: [], diagnostics: [], selection: null };
      case "requestUserInput":
        return this.elicitationAnswer;
    }
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socketPath, resolve));
  }

  close(): void {
    this.server.close();
  }
}

/** Minimal MCP JSON-RPC client — mirrors what a real agent's MCP client does. */
class McpTestClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private waiters = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();

  constructor(socketPath: string, sessionId: string) {
    this.child = spawn(process.execPath, [MCP_SERVER], {
      env: { ...process.env, ACP_PATCHBAY_IPC: socketPath, ACP_PATCHBAY_SESSION_ID: sessionId },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        if (msg.id !== undefined) this.waiters.get(msg.id)?.(msg);
      }
    });
  }

  private send(method: string, params?: unknown): Promise<{ result?: unknown; error?: { message: string } }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async initialize(): Promise<unknown> {
    const resp = await this.send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return resp.result;
  }

  async listTools(): Promise<{ name: string }[]> {
    const resp = await this.send("tools/list");
    return (resp.result as { tools: { name: string }[] }).tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const resp = await this.send("tools/call", { name, arguments: args });
    if (resp.error !== undefined) throw new Error(resp.error.message);
    return resp.result;
  }

  kill(): void {
    this.child.kill();
  }
}

interface ToolCallResult {
  content: { text: string }[];
  isError?: boolean;
}

async function toolText(client: McpTestClient, name: string, args?: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool(name, args)) as ToolCallResult;
  return result.content[0]!.text;
}

let host: FakeIpcHost;
let client: McpTestClient;
beforeEach(async () => {
  host = new FakeIpcHost(`${process.pid}-${Date.now()}`);
  await host.listen();
  client = new McpTestClient(host.socketPath, "session-1");
});
afterEach(() => {
  client.kill();
  host.close();
});

describe("local MCP server (real bundled subprocess)", () => {
  it("initializes with tools capability", async () => {
    const result = (await client.initialize()) as { capabilities: { tools: unknown } };
    expect(result.capabilities.tools).toBeDefined();
  });

  it("lists all six tools", async () => {
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "get_current_file",
        "get_diagnostics",
        "get_open_editors",
        "get_selection",
        "get_workspace_state",
        "request_user_input",
      ].sort(),
    );
  });

  it("get_selection forwards over IPC and returns real-shaped data", async () => {
    await client.initialize();
    const parsed = JSON.parse(await toolText(client, "get_selection"));
    expect(parsed).toEqual({ file: "/ws/a.ts", startLine: 1, endLine: 2, text: "const x = 1;" });
    expect(host.requests.some((r) => r.method === "getSelection" && r.sessionId === "session-1")).toBe(true);
  });

  it("get_current_file, get_diagnostics, get_open_editors, get_workspace_state all round-trip", async () => {
    await client.initialize();
    const file = JSON.parse(await toolText(client, "get_current_file"));
    expect(file.content).toBe("const x = 1;\n");

    const diags = JSON.parse(await toolText(client, "get_diagnostics"));
    expect(diags).toHaveLength(1);

    const editors = JSON.parse(await toolText(client, "get_open_editors"));
    expect(editors).toEqual([{ file: "/ws/a.ts", dirty: false }]);

    const snapshot = JSON.parse(await toolText(client, "get_workspace_state"));
    expect(snapshot).toHaveProperty("openEditors");
  });

  it("request_user_input returns the answer when not cancelled", async () => {
    await client.initialize();
    const result = (await client.callTool("request_user_input", {
      message: "Confirm?",
      properties: [{ name: "confirmed", type: "boolean", required: true }],
    })) as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ confirmed: true });
  });

  it("request_user_input reports cancellation as an error result, not a thrown exception", async () => {
    host.elicitationAnswer = null; // simulates the user cancelling
    await client.initialize();
    const result = (await client.callTool("request_user_input", { message: "Confirm?" })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("cancelled");
  });

  it("an unknown tool name reports an error result", async () => {
    await client.initialize();
    const result = (await client.callTool("nonexistent_tool")) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
  });
});
