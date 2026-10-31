// P9 gate (automated half): "GitHub connect → routed agent lists issues via
// MCP." The fake agent plays a real ACP agent AND a real MCP client (as in
// P7's mcp-end-to-end.test.ts), spawning the *actual bundled*
// out/mcp-bridge.js as its own subprocess from the mcpServers entry
// session/new gave it. The bridge forwards to a fake remote HTTP MCP server
// standing in for a real registry/custom-http endpoint, fetching its token
// over IPC from the window's orchestrator. Only the remote provider is
// stood in for (no network access here) — the orchestrator, its secret
// store, the wire protocol and the bridge process itself are real.
import { spawn } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@agentclientprotocol/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { echoed } from "./support/transcript";
import { fakeAgent } from "./support/fake-agent";
import { atTestEnd, tempDir } from "./support/teardown";
import { orchestratorHarness } from "./support/orchestrator-harness";
import { bridgeServer } from "../src/orchestrator/mcp-servers-store";
import { mkdir } from "node:fs/promises";
import { SETTLE } from "./support/wait-for";
import { IpcClient } from "../src/mcp/ipc-client";
import { ipcAddress } from "../src/mcp/ipc-protocol";
import { type LaunchSpec } from "../src/orchestrator/pool";
import type { FakeAgentScript } from "./fake-agent/main";
import type { PatchbayAgentId } from "../src/shared/ids";

/** Folders on disk for a session's roots — a root is a folder that exists. */
async function folders<N extends string[]>(...names: N): Promise<{ [K in keyof N]: string }> {
  const paths = names.map((name) => join(dir, name));
  for (const path of paths) await mkdir(path, { recursive: true });
  return paths as { [K in keyof N]: string };
}

const BRIDGE = join(process.cwd(), "out", "mcp-bridge.js");

/** Fake remote MCP HTTP server — the plain request/response flavor the
 * bridge speaks (v1 scope, see bridge-main.ts). A tool call carrying one of
 * `rejectTokens` is refused with 401 — after `onReject` has run, so the
 * bridge's retry-once path is genuinely exercised. */
class FakeRemoteMcpServer {
  server: HttpServer;
  url = "";
  authHeadersSeen: string[] = [];
  onReject: () => Promise<void> = async () => {};
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
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method?: string };
        if (message.method === "tools/call" && this.rejectTokens.has(token)) {
          void this.onReject().then(() => {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: "unauthorized" }));
          });
          return;
        }
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
  dir = await tempDir("patchbay-bridge-cwd-");
});

const spec = (script: FakeAgentScript, patchbayAgentId: string): LaunchSpec => fakeAgent(script, patchbayAgentId, dir);

/** The window's orchestrator, working in `workspace` with `roots` open,
 * with a remote MCP server added the way the user adds one — probed on the
 * way in, as every add is. */
async function withRemote(
  remote: { url: string },
  server: { name: string; header?: { headerName: string; valuePrefix: string; token: string } },
  place: { workspace?: string; roots?: string[] } = {},
) {
  const h = orchestratorHarness(dir, { workspace: place.workspace, workspaceRoots: place.roots });
  const o = h.orchestrator;
  const { header } = server;
  const id = await o.mcpServerGates.addCustom(
    server.name,
    header === undefined ? { kind: "custom-http", url: remote.url, authType: "none" } : { kind: "custom-http", url: remote.url, authType: "header", ...header },
    "auto",
  );
  return { orchestrator: o, id, pool: o.pool, sessions: o.sessions, gates: o.sessionGates, state: h.agentView.state };
}

/** A bridge spawned the way an agent spawns it from its mcpServers entry,
 * the agent's side of the wire played by the test. */
function spawnBridge(entry: McpServer) {
  if (!("command" in entry)) throw new Error("the bridge is a stdio server");
  const bridge = spawn(entry.command, entry.args, {
    env: { ...process.env, ...Object.fromEntries(entry.env.map((e) => [e.name, e.value])) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: Array<{ id?: unknown; result?: unknown }> = [];
  let buffer = "";
  bridge.stdout.setEncoding("utf8");
  bridge.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) if (line.trim() !== "") lines.push(JSON.parse(line) as { id?: unknown; result?: unknown });
  });
  atTestEnd(() => void bridge.stdin.end());
  let nextId = 0;
  return {
    bridge,
    send: (message: Record<string, unknown>) => bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"),
    async request(method: string, params: unknown): Promise<unknown> {
      const id = ++nextId;
      bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return vi.waitFor(() => {
        const answer = lines.find((l) => l.id === id);
        if (answer === undefined) throw new Error(`no answer to ${method}`);
        return answer.result;
      }, SETTLE);
    },
  };
}

const INITIALIZE = { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "agent", version: "0" } };

describe("MCP bridge — real agent, real bridge subprocess, fake remote MCP server", () => {
  it("a routed agent lists issues via MCP through the bridge (P9 gate, automated half)", async () => {
    const remote = new FakeRemoteMcpServer();
    await remote.listen();
    atTestEnd(() => remote.close());
    const h = await withRemote(remote, { name: "github", header: { headerName: "Authorization", valuePrefix: "Bearer ", token: "gh-token-1" } });
    await h.pool.connect(spec({ turn: [{ type: "callMcpTool", tool: "list_issues", server: "github" }] }, "e1" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("e1" as PatchbayAgentId, "Fake Agent", dir);
    await h.gates.prompt(patchbaySessionId, { text: "any open issues?" });

    const text = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "text");
    expect(text?.kind === "text" && text.text).toBe("issue #1: fix the thing");
    // the bridge's credential: the one the user gave, asked of the orchestrator per request
    expect(remote.authHeadersSeen).toContain("Bearer gh-token-1");
    await h.pool.stop("e1" as PatchbayAgentId);
  });

  // The bridge's own retry: a 401 asks the orchestrator once more for the
  // credential. What it exists for: the stored key replaced while a request
  // was out — the user reconnecting the server in another window, which
  // writes the same secret storage.
  it("retries once with a fresh token when the remote endpoint returns 401", async () => {
    const remote = new FakeRemoteMcpServer(["stale-token"]);
    await remote.listen();
    atTestEnd(() => remote.close());
    const h = await withRemote(remote, { name: "github", header: { headerName: "Authorization", valuePrefix: "Bearer ", token: "stale-token" } });
    remote.onReject = () => h.orchestrator.mcpServerTokens.set(h.id, { accessToken: "fresh-token" });
    await h.pool.connect(spec({ turn: [{ type: "callMcpTool", tool: "list_issues", server: "github" }] }, "e2" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("e2" as PatchbayAgentId, "Fake Agent", dir);
    await h.gates.prompt(patchbaySessionId, { text: "any open issues?" });

    const text = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "text");
    expect(text?.kind === "text" && text.text).toBe("issue #1: fix the thing");
    // the stale token was tried and rejected at least once, and every
    // request eventually got through on the fresh one
    expect(remote.authHeadersSeen).toContain("Bearer stale-token");
    expect(remote.authHeadersSeen.at(-1)).toBe("Bearer fresh-token");
  });

  // Issue #34: the session's roots reach the remote server through the
  // bridge. MCP roots are a client capability, and the client on this wire
  // is the agent, which declares none and holds no list — so the bridge
  // declares it on the agent's initialize and answers `roots/list` from
  // the orchestrator, in the spec's shape (file:// URIs). The agent never
  // sees the exchange.
  it("the bridge declares roots on the agent's initialize and answers roots/list from the session's list (issue #34)", async () => {
    const [frontend, backend] = await folders("frontend", "backend");
    const remote = new FakeRootsUsingRemote();
    await remote.listen();
    atTestEnd(() => remote.close());
    const h = await withRemote(remote, { name: "fs-aware" }, { workspace: frontend, roots: [frontend, backend] });
    remote.clientCapabilities = null; // what the add's own probe declared is not the bridge's
    await h.pool.connect(spec({ turn: [{ type: "callMcpTool", tool: "list_roots", server: "fs-aware" }] }, "e3" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("e3" as PatchbayAgentId, "Fake Agent", frontend);
    await h.gates.prompt(patchbaySessionId, { text: "what can you see?" });

    expect(echoed(h.state(), patchbaySessionId)).toEqual({
      roots: [
        { uri: pathToFileURL(frontend).toString(), name: "frontend" },
        { uri: pathToFileURL(backend).toString(), name: "backend" },
      ],
    });
    // declared on top of the agent's own (empty) capabilities
    expect(remote.clientCapabilities).toEqual({ roots: { listChanged: true } });
    await h.pool.stop("e3" as PatchbayAgentId);
  });

  it("a root change pushed by the orchestrator reaches the remote server as notifications/roots/list_changed (issue #34)", async () => {
    const [frontend, backend] = await folders("frontend", "backend");
    const remote = new FakeRootsUsingRemote();
    await remote.listen();
    atTestEnd(() => remote.close());
    const h = await withRemote(remote, { name: "fs-aware" }, { workspace: frontend, roots: [frontend] });
    await h.pool.connect(spec({ declare: { sessionCapabilities: { additionalDirectories: {}, resume: {} } } }, "e4" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("e4" as PatchbayAgentId, "Fake Agent", frontend);
    // the bridge as the agent spawns it for this session: the orchestrator's
    // own entry, under the session's own token
    const [token] = h.sessions.tokensOf(patchbaySessionId);
    const { servers } = await h.orchestrator.mcpServers.mcpServersFor("e4" as PatchbayAgentId, token!, false);
    const peer = spawnBridge(servers.find((s) => s.name === "fs-aware")!);
    await peer.request("initialize", INITIALIZE);
    peer.send({ method: "notifications/initialized" });
    await vi.waitFor(() => expect(remote.notifications).toContain("notifications/initialized"), SETTLE);

    await h.gates.addRoot(patchbaySessionId, backend);
    await vi.waitFor(() => expect(remote.notifications).toContain("notifications/roots/list_changed"), SETTLE);
    // after the bridge's initialize. Never-prompted, the session is minted
    // again with its new list, and that tells its servers once more — and a
    // probe of the server's own may say initialized again on its own
    // connection — so neither is counted.
    expect(remote.notifications.indexOf("notifications/roots/list_changed")).toBeGreaterThan(remote.notifications.indexOf("notifications/initialized"));
    await h.pool.stop("e4" as PatchbayAgentId);
  });

  // P15a: the agent that spawned the bridge owns its lifetime — stdin EOF
  // (agent exited or was killed) must end the bridge, never leave an orphan.
  it("bridge exits on stdin EOF", async () => {
    const { bridge } = spawnBridge(
      bridgeServer({ bridgeScript: BRIDGE, socketPath: () => ipcAddress("patchbay-bridge-eof-none") }, "ctx-eof", {
        id: "github",
        name: "github",
        url: "http://127.0.0.1:9/never",
        header: null,
      }),
    );
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
    const socketPath = ipcAddress(`patchbay-ipc-dies-${process.pid}`);
    const sockets: Socket[] = [];
    const server = createNetServer((socket) => sockets.push(socket)); // accepts, never replies
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new IpcClient(socketPath, "github");
    const inFlight = client.request("getMcpServerToken");
    // Wait until the server has the connection, then drop it mid-request.
    await vi.waitFor(() => expect(sockets).toHaveLength(1), SETTLE);
    for (const socket of sockets) socket.destroy();

    await expect(inFlight).rejects.toThrow("ipc socket closed");
    server.close();
  });
});
