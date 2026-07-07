// P9 gate (automated half): "GitHub connect → routed agent lists issues via
// MCP." The fake agent plays a real ACP agent AND a real MCP client (as in
// P7's mcp-end-to-end.test.ts), spawning the *actual bundled*
// out/integration-bridge.js as its own subprocess from the mcpServers entry
// session/new gave it. The bridge forwards to a fake remote HTTP MCP server
// standing in for a real registry/custom-http endpoint, fetching its token
// from a fake IPC host standing in for the orchestrator's real
// EditorStateHost. Only two things are stood in for: the remote provider
// (no network access here) and the token source (needs real vscode
// SecretStorage) — the wire protocol and the bridge process itself are real.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IpcClient } from "../src/mcp/ipc-client";
import { encodeLine, parseLines, type IpcRequest, type IpcResponse } from "../src/mcp/ipc-protocol";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import { SessionManager } from "../src/orchestrator/session-manager";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { SessionIndexStore } from "../src/orchestrator/stores/session-index";
import { initialAgentViewState, reduceAgentView, type AgentViewEvent } from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { stubFsTerminalHooks } from "./support/stub-hooks";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");
const BRIDGE = join(process.cwd(), "out", "integration-bridge.js");

/** Stands in for the orchestrator's IPC host, serving only
 * `getIntegrationToken` — everything else P7 already covers. `tokens` is a
 * queue: each call to `currentToken()` in the bridge pops the next one,
 * letting a test script an expired-then-fresh sequence. */
class FakeIntegrationTokenHost {
  server: NetServer;
  socketPath: string;
  tokens: string[];
  requests = 0;

  constructor(id: string, tokens: string[]) {
    this.socketPath = join(tmpdir(), `patchbay-bridge-test-${id}.sock`);
    this.tokens = tokens;
    this.server = createNetServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const { messages, rest } = parseLines(buffer);
        buffer = rest;
        for (const message of messages) {
          const req = message as IpcRequest;
          this.requests++;
          const accessToken = this.tokens[Math.min(this.requests - 1, this.tokens.length - 1)];
          const response: IpcResponse = { id: req.id, result: { accessToken } };
          socket.write(encodeLine(response));
        }
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socketPath, resolve));
  }
  close(): void {
    this.server.close();
  }
}

/** Fake remote MCP HTTP server — the plain request/response flavor the
 * bridge speaks (v1 scope, see bridge-main.ts). Rejects a configurable set
 * of tokens with 401 so the bridge's retry-once path is genuinely exercised. */
class FakeRemoteMcpServer {
  server: HttpServer;
  url = "";
  authHeadersSeen: string[] = [];
  private readonly rejectTokens: Set<string>;

  constructor(rejectTokens: string[] = []) {
    this.rejectTokens = new Set(rejectTokens);
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const auth = req.headers.authorization ?? "";
        this.authHeadersSeen.push(auth);
        const token = auth.replace(/^Bearer /, "");
        if (this.rejectTokens.has(token)) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method?: string };
        res.setHeader("content-type", "application/json");
        if (message.method === "tools/call") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { content: [{ type: "text", text: "issue #1: fix the thing" }] },
            }),
          );
          return;
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, () => {
        this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/mcp`;
        resolve();
      });
    });
  }
  close(): void {
    this.server.close();
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "patchbay-bridge-cwd-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function spec(script: FakeAgentScript, agentId: string): LaunchSpec {
  return {
    agentId,
    name: "Fake Agent",
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    cwd: dir,
  };
}

function harness(mcpServers: McpServer[]) {
  const events: AgentViewEvent[] = [];
  const pool = new AgentPool({
    onStatusChanged: () => {},
    onDeclaredCaptured: () => {},
    onSessionUpdate: (agentId, notification) => sessionManager.handleUpdate(agentId, notification),
    ...stubFsTerminalHooks(),
  });
  const sessionManager = new SessionManager(
    pool,
    new SessionIndexStore(new MemoryKV()),
    { emit: (...evs) => events.push(...evs) },
    () => dir,
    async () => mcpServers,
  );
  return { pool, sessionManager, state: () => events.reduce(reduceAgentView, initialAgentViewState) };
}

describe("integration bridge — real agent, real bridge subprocess, fake remote MCP server", () => {
  it("a routed agent lists issues via MCP through the bridge (P9 gate, automated half)", async () => {
    const remote = new FakeRemoteMcpServer();
    await remote.listen();
    const tokenHost = new FakeIntegrationTokenHost(`${process.pid}-a`, ["gh-token-1"]);
    await tokenHost.listen();

    const bridgeEntry: McpServer = {
      name: "github",
      command: process.execPath,
      args: [BRIDGE],
      env: [
        { name: "ACP_PATCHBAY_IPC", value: tokenHost.socketPath },
        { name: "ACP_PATCHBAY_INTEGRATION_ID", value: "github" },
        { name: "ACP_PATCHBAY_INTEGRATION_URL", value: remote.url },
        { name: "ACP_PATCHBAY_AUTH_HEADER", value: "Authorization" },
        { name: "ACP_PATCHBAY_AUTH_PREFIX", value: "Bearer " },
      ],
    };
    const h = harness([bridgeEntry]);
    await h.pool.connect(spec({ turn: [{ type: "callMcpTool", tool: "list_issues" }] }, "e1"));
    const sessionId = await h.sessionManager.createSession("e1", "Fake Agent", dir);
    await h.sessionManager.sendPrompt(sessionId, "any open issues?");

    const text = h.state().transcripts[sessionId]!.find((b) => b.kind === "text");
    expect(text?.kind === "text" && text.text).toBe("issue #1: fix the thing");
    expect(remote.authHeadersSeen).toContain("Bearer gh-token-1");

    await h.pool.stop("e1");
    tokenHost.close();
    remote.close();
  });

  it("retries once with a fresh token when the remote endpoint returns 401", async () => {
    const remote = new FakeRemoteMcpServer(["stale-token"]);
    await remote.listen();
    const tokenHost = new FakeIntegrationTokenHost(`${process.pid}-b`, ["stale-token", "fresh-token"]);
    await tokenHost.listen();

    const bridgeEntry: McpServer = {
      name: "github",
      command: process.execPath,
      args: [BRIDGE],
      env: [
        { name: "ACP_PATCHBAY_IPC", value: tokenHost.socketPath },
        { name: "ACP_PATCHBAY_INTEGRATION_ID", value: "github" },
        { name: "ACP_PATCHBAY_INTEGRATION_URL", value: remote.url },
        { name: "ACP_PATCHBAY_AUTH_HEADER", value: "Authorization" },
        { name: "ACP_PATCHBAY_AUTH_PREFIX", value: "Bearer " },
      ],
    };
    const h = harness([bridgeEntry]);
    await h.pool.connect(spec({ turn: [{ type: "callMcpTool", tool: "list_issues" }] }, "e2"));
    const sessionId = await h.sessionManager.createSession("e2", "Fake Agent", dir);
    await h.sessionManager.sendPrompt(sessionId, "any open issues?");

    const text = h.state().transcripts[sessionId]!.find((b) => b.kind === "text");
    expect(text?.kind === "text" && text.text).toBe("issue #1: fix the thing");
    // the stale token was tried and rejected at least once, and every
    // request eventually got through on the fresh one — including the
    // tool call whose result the assertion above already confirms
    expect(remote.authHeadersSeen).toContain("Bearer stale-token");
    expect(remote.authHeadersSeen.at(-1)).toBe("Bearer fresh-token");

    await h.pool.stop("e2");
    tokenHost.close();
    remote.close();
  });

  // P15a: the agent that spawned the bridge owns its lifetime — stdin EOF
  // (agent exited or was killed) must end the bridge, never leave an orphan.
  it("bridge exits on stdin EOF", async () => {
    const bridge = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        ACP_PATCHBAY_IPC: join(tmpdir(), "patchbay-bridge-eof-none.sock"),
        ACP_PATCHBAY_INTEGRATION_ID: "github",
        ACP_PATCHBAY_INTEGRATION_URL: "http://127.0.0.1:9/never",
        ACP_PATCHBAY_AUTH_HEADER: "",
        ACP_PATCHBAY_AUTH_PREFIX: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => bridge.once("exit", (code) => resolve(code)));
    bridge.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("bridge outlived stdin EOF")), 5000)),
    ]);
    expect(code).toBe(0);
  });

  // P15a: a dead IPC socket rejects every in-flight request instead of
  // hanging the caller (and, through it, the agent's tool call) forever.
  it("IpcClient rejects in-flight requests when the socket dies", async () => {
    const socketPath = join(tmpdir(), `patchbay-ipc-dies-${process.pid}.sock`);
    const sockets: Socket[] = [];
    const server = createNetServer((socket) => sockets.push(socket)); // accepts, never replies
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new IpcClient(socketPath, "github");
    const inFlight = client.request("getIntegrationToken");
    // Wait until the server has the connection, then drop it mid-request.
    for (let i = 0; sockets.length === 0 && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
    for (const socket of sockets) socket.destroy();

    await expect(inFlight).rejects.toThrow("ipc socket closed");
    server.close();
  });
});
