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
          // the bridge also subscribes to root changes at start — only
          // token fetches walk the queue
          if (req.method !== "getIntegrationToken") {
            socket.write(encodeLine({ id: req.id, result: {} } satisfies IpcResponse));
            continue;
          }
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

/** Stands in for the orchestrator's IPC host for the roots path (issue
 * #34): answers `getRoots` with a mutable list, remembers `watchRoots`
 * subscribers, and pushes `rootsChanged` to them on demand. */
class FakeSessionHost {
  server: NetServer;
  socketPath: string;
  roots: string[];
  requests: IpcRequest[] = [];
  watchers: Socket[] = [];

  constructor(id: string, roots: string[]) {
    this.socketPath = join(tmpdir(), `patchbay-bridge-roots-${id}.sock`);
    this.roots = roots;
    this.server = createNetServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const { messages, rest } = parseLines(buffer);
        buffer = rest;
        for (const message of messages) {
          const req = message as IpcRequest;
          this.requests.push(req);
          if (req.method === "watchRoots") this.watchers.push(socket);
          const result = req.method === "getRoots" ? { roots: this.roots } : {};
          const response: IpcResponse = { id: req.id, result };
          socket.write(encodeLine(response));
        }
      });
    });
  }

  push(): void {
    for (const socket of this.watchers) socket.write(encodeLine({ method: "rootsChanged" }));
  }
  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socketPath, resolve));
  }
  close(): void {
    this.server.close();
  }
}

/** A remote MCP server that uses the client's roots — the Streamable HTTP
 * shape a spec-compliant provider takes: a `tools/call` answered as an SSE
 * stream in which the server first asks `roots/list`, then completes the
 * tool result once the answer is POSTed back. Records what the client
 * declared at initialize and every notification it sent. */
class FakeRootsUsingRemote {
  server: HttpServer;
  url = "";
  clientCapabilities: unknown = null;
  notifications: string[] = [];
  private pending: { res: import("node:http").ServerResponse; id: unknown } | null = null;

  constructor() {
    this.server = createServer((req, res) => {
      if (req.method === "GET") {
        res.statusCode = 405; // no standalone stream — the SDK treats this as "not offered"
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id?: unknown;
          method?: string;
          params?: { capabilities?: unknown; name?: string };
          result?: unknown;
        };
        if (message.method === undefined) {
          // the client's answer to our roots/list — complete the tool call with it
          const pending = this.pending;
          this.pending = null;
          if (pending !== null) {
            pending.res.write(
              `data: ${JSON.stringify({
                jsonrpc: "2.0",
                id: pending.id,
                result: { content: [{ type: "text", text: JSON.stringify(message.result) }] },
              })}\n\n`,
            );
            pending.res.end();
          }
          res.statusCode = 202;
          res.end();
          return;
        }
        if (message.id === undefined) {
          this.notifications.push(message.method);
          res.statusCode = 202;
          res.end();
          return;
        }
        if (message.method === "initialize") this.clientCapabilities = message.params?.capabilities ?? null;
        if (message.method === "tools/call" && message.params?.name === "list_roots") {
          res.setHeader("content-type", "text/event-stream");
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: "srv-roots", method: "roots/list" })}\n\n`);
          this.pending = { res, id: message.id };
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result:
              message.method === "initialize"
                ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } }
                : {},
          }),
        );
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

  // Issue #34: the session's roots reach the remote server through the
  // bridge. MCP roots are a client capability, and the client on this wire
  // is the agent, which declares none and holds no list — so the bridge
  // declares it on the agent's initialize and answers `roots/list` from
  // the orchestrator, in the spec's shape (file:// URIs). The agent never
  // sees the exchange.
  it("the bridge declares roots on the agent's initialize and answers roots/list from the session's list (issue #34)", async () => {
    const remote = new FakeRootsUsingRemote();
    await remote.listen();
    const host = new FakeSessionHost(`${process.pid}-r`, ["/repo/frontend", "/repo/backend"]);
    await host.listen();

    const bridgeEntry: McpServer = {
      name: "fs-aware",
      command: process.execPath,
      args: [BRIDGE],
      env: [
        { name: "ACP_PATCHBAY_IPC", value: host.socketPath },
        { name: "ACP_PATCHBAY_SESSION_ID", value: "ctx-1" },
        { name: "ACP_PATCHBAY_INTEGRATION_ID", value: "fs-aware" },
        { name: "ACP_PATCHBAY_INTEGRATION_URL", value: remote.url },
      ],
    };
    const h = harness([bridgeEntry]);
    await h.pool.connect(spec({ turn: [{ type: "callMcpTool", tool: "list_roots" }] }, "e3"));
    const sessionId = await h.sessionManager.createSession("e3", "Fake Agent", dir);
    await h.sessionManager.sendPrompt(sessionId, "what can you see?");

    const text = h.state().transcripts[sessionId]!.find((b) => b.kind === "text");
    expect(text?.kind === "text" && JSON.parse(text.text)).toEqual({
      roots: [
        { uri: "file:///repo/frontend", name: "frontend" },
        { uri: "file:///repo/backend", name: "backend" },
      ],
    });
    // declared on top of the agent's own (empty) capabilities
    expect(remote.clientCapabilities).toEqual({ roots: { listChanged: true } });
    // read for the session the bridge was spawned with, and subscribed
    expect(host.requests.some((r) => r.method === "getRoots" && r.sessionId === "ctx-1")).toBe(true);
    expect(host.requests.some((r) => r.method === "watchRoots" && r.sessionId === "ctx-1")).toBe(true);

    await h.pool.stop("e3");
    host.close();
    remote.close();
  });

  it("a root change pushed by the orchestrator reaches the remote server as notifications/roots/list_changed (issue #34)", async () => {
    const remote = new FakeRootsUsingRemote();
    await remote.listen();
    const host = new FakeSessionHost(`${process.pid}-p`, ["/repo/frontend"]);
    await host.listen();
    const bridge = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        ACP_PATCHBAY_IPC: host.socketPath,
        ACP_PATCHBAY_SESSION_ID: "ctx-2",
        ACP_PATCHBAY_INTEGRATION_ID: "fs-aware",
        ACP_PATCHBAY_INTEGRATION_URL: remote.url,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutLines: string[] = [];
    bridge.stdout.setEncoding("utf8");
    bridge.stdout.on("data", (chunk: string) => stdoutLines.push(...chunk.split("\n").filter((l) => l.trim() !== "")));
    const until = async (done: () => boolean, what: string) => {
      for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
      if (!done()) throw new Error(`timed out waiting for ${what}`);
    };
    // the agent's handshake, hand-rolled: initialize, then initialized
    bridge.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "agent", version: "0" } } }) + "\n",
    );
    await until(() => stdoutLines.some((l) => (JSON.parse(l) as { id?: number }).id === 1), "initialize response");
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await until(() => host.watchers.length > 0, "the bridge's watchRoots");
    await until(() => remote.notifications.includes("notifications/initialized"), "initialized at the remote");

    host.roots.push("/repo/backend");
    host.push();
    await until(() => remote.notifications.includes("notifications/roots/list_changed"), "list_changed at the remote");
    expect(remote.notifications).toEqual(["notifications/initialized", "notifications/roots/list_changed"]);

    bridge.stdin.end();
    host.close();
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
