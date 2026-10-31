// The real bundled MCP server subprocess (out/mcp-server.js) speaks MCP
// JSON-RPC over stdio and forwards every tool call over the IPC bridge to
// the window's orchestrator. It is spawned from the very entry an attach
// hands the agent, under that attach's token; only the editor's reads —
// what VS Code alone can answer — are stood in for, with canned data.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeEnv } from "../src/orchestrator/spawn-resolve";
import type { EditorReads } from "../src/orchestrator/ipc-host";
import type { Orchestrator } from "../src/orchestrator/orchestrator";
import type { ChatBlock, ElicitationAnswer } from "../src/shared/protocol";
import type { PatchbayAgentId, PatchbaySessionId } from "../src/shared/ids";
import { version as packageVersion } from "../package.json";
import { fakeAgent } from "./support/fake-agent";
import { orchestratorHarness, type OrchestratorHarness } from "./support/orchestrator-harness";
import { atTestEnd, tempDir } from "./support/teardown";
import { waitFor } from "./support/wait-for";

/** The editor as the server's tools read it. */
const editor = {
  getSelection: vi.fn(() => ({ file: "/ws/a.ts", startLine: 1, endLine: 2, text: "const x = 1;" })),
  getCurrentFile: vi.fn(() => ({ file: "/ws/a.ts", content: "const x = 1;\n" })),
  getDiagnostics: vi.fn(() => [{ file: "/ws/a.ts", line: 1, severity: "error" as const, message: "boom" }]),
  getOpenEditors: vi.fn(() => [{ file: "/ws/a.ts", dirty: false }]),
} satisfies EditorReads;

/** Minimal MCP JSON-RPC client — mirrors what a real agent's MCP client does. */
class McpTestClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private waiters = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();

  /** Spawns `entry` as an agent does: its command, args, and env over the
   * agent's own. */
  constructor(entry: McpServerStdio) {
    const env = mergeEnv(process.env, Object.fromEntries(entry.env.map((v) => [v.name, v.value])));
    this.child = spawn(entry.command, entry.args, { env, stdio: ["pipe", "pipe", "pipe"] });
    atTestEnd(() => void this.child.kill());
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

}

interface ToolCallResult {
  content: { text: string }[];
  isError?: boolean;
}

async function toolText(client: McpTestClient, name: string, args?: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool(name, args)) as ToolCallResult;
  return result.content[0]!.text;
}

let dir: string;
let h: OrchestratorHarness;
let o: Orchestrator;
let patchbaySessionId: PatchbaySessionId;
/** The editor server as the session's attach handed it to the agent. */
let entry: McpServerStdio;
let client: McpTestClient;
beforeEach(async () => {
  dir = await tempDir("patchbay-mcp-wire-");
  const backend = join(dir, "backend");
  await mkdir(backend);
  h = orchestratorHarness(dir, { workspaceRoots: [dir, backend], ports: { editor } });
  o = h.orchestrator;
  const composed = vi.spyOn(o.mcpServers, "mcpServersFor");
  await o.pool.connect(fakeAgent({}, "wire", dir));
  patchbaySessionId = await o.sessionGates.create("wire" as PatchbayAgentId, "Fake Agent", dir);
  entry = (await composed.mock.results.at(-1)!.value).servers[0] as McpServerStdio;
  client = new McpTestClient(entry);
});

/** The user answers the next form a tool puts in the session. */
async function answerForm(answer: ElicitationAnswer): Promise<void> {
  const card = await waitFor(() =>
    h.agentView.state().transcripts[patchbaySessionId]?.find(
      (b): b is Extract<ChatBlock, { kind: "elicitation" }> => b.kind === "elicitation" && b.resolution === null,
    ),
  );
  o.asks.answerQuestion(card.id, answer);
}

describe("local MCP server (real bundled subprocess)", () => {
  it("initializes with tools capability", async () => {
    const result = (await client.initialize()) as { capabilities: { tools: unknown } };
    expect(result.capabilities.tools).toBeDefined();
  });

  // The server ships inside the extension: the version it names is the
  // extension's, which Settings shows on the built-in server's card.
  it("names itself by the extension's own version", async () => {
    const result = (await client.initialize()) as { serverInfo: { name: string; version: string } };
    expect(result.serverInfo).toEqual({ name: "acp-patchbay", version: packageVersion });
  });

  it("lists all seven tools", async () => {
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "get_current_file",
        "get_diagnostics",
        "get_open_editors",
        "get_roots",
        "get_selection",
        "get_workspace_state",
        "request_user_input",
      ].sort(),
    );
  });

  // Issue #34: the session's roots reach the local server too — read from
  // the orchestrator for the session the server was spawned with, never
  // asked of the agent (whose MCP client holds no list).
  it("get_roots reads the session's root list over IPC, for its own session", async () => {
    await client.initialize();
    const roots = JSON.parse(await toolText(client, "get_roots"));
    expect(roots).toEqual([dir, join(dir, "backend")]);
    // a token no attach was given reaches nothing
    const forged = new McpTestClient({
      ...entry,
      env: entry.env.map((v) => (v.name === "ACP_PATCHBAY_CONTEXT_TOKEN" ? { ...v, value: "forged" } : v)),
    });
    await forged.initialize();
    await expect(forged.callTool("get_roots")).rejects.toThrow("unknown session token");
  });

  it("get_selection forwards over IPC and returns real-shaped data", async () => {
    await client.initialize();
    const parsed = JSON.parse(await toolText(client, "get_selection"));
    expect(parsed).toEqual({ file: "/ws/a.ts", startLine: 1, endLine: 2, text: "const x = 1;" });
    expect(editor.getSelection).toHaveBeenCalled();
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
    const [result] = (await Promise.all([
      client.callTool("request_user_input", {
        message: "Confirm?",
        properties: [{ name: "confirmed", type: "boolean", required: true }],
      }),
      answerForm({ action: "accept", content: { confirmed: true } }),
    ])) as [{ content: { text: string }[]; isError?: boolean }, void];
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ confirmed: true });
  });

  it("request_user_input forwards its fields as the elicitation schema, defaults included", async () => {
    await client.initialize();
    const forwarded = vi.spyOn(o, "requestUserInput");
    const asked = client.callTool("request_user_input", {
      message: "Setup?",
      properties: [
        { name: "who", type: "string", title: "Name", required: true, default: "hello" },
        { name: "n", type: "number", default: 42 },
        { name: "on", type: "boolean", default: true },
      ],
    });
    await answerForm({ action: "cancel" });
    await asked;
    expect(forwarded.mock.calls[0]?.[1]).toEqual({
      message: "Setup?",
      requestedSchema: {
        type: "object",
        properties: {
          who: { type: "string", title: "Name", default: "hello" },
          n: { type: "number", default: 42 },
          on: { type: "boolean", default: true },
        },
        required: ["who"],
      },
    });
  });

  it("request_user_input with no fields forwards no schema", async () => {
    await client.initialize();
    const forwarded = vi.spyOn(o, "requestUserInput");
    await Promise.all([client.callTool("request_user_input", { message: "Confirm?" }), answerForm({ action: "cancel" })]);
    expect(forwarded.mock.calls[0]?.[1]).toEqual({ message: "Confirm?" });
  });

  it.each([
    ["decline", "declined"],
    ["cancel", "cancelled"],
  ] as const)("request_user_input reports a %s by name, as an error result rather than a thrown exception", async (action, text) => {
    await client.initialize();
    const [result] = (await Promise.all([client.callTool("request_user_input", { message: "Confirm?" }), answerForm({ action })])) as [
      { content: { text: string }[]; isError?: boolean },
      void,
    ];
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(text);
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
