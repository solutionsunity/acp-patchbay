// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Patchbay's own MCP-client handshake with a configured MCP server —
// initialize + tools/list, no agent, no LLM turn (the same "free read"
// class as session/list). Provider-side truth only: a passing probe means
// "reachable, these tools exist", never "working in an agent's session".
// vscode-free; McpServersStore injects credentials and caches results.
// HTTP rides the MCP SDK's transport — the one dependency that also backs
// the stdio-to-HTTP bridge, so probe and bridge can't drift on transport
// behavior. A stdio server is started through the process door like every
// child, and the SDK's client talks over its streams with the SDK's own
// line framing: the SDK's stdio transport would spawn the command itself,
// past the Windows-safe lookup, and end only its top process.
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { prepareLauncher } from "./launcher-health";
import { nullLogger, type Logger } from "./logger";
import { killTree, startChild } from "./process-tree";
import { mergeEnv } from "./spawn-resolve";
import { PRODUCT } from "../shared/product";

type StdioTarget = { kind: "stdio"; command: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd: string };

export type ProbeTarget =
  | { kind: "http"; url: string; header: { name: string; value: string } | null }
  /** Probing stdio means *executing* the configured command — only ever on
   * the user's explicit act (connect, power-on, refresh), never on a sweep.
   * `cwd` is required, never defaulted: the probe is only truthful if it
   * runs the server where the real run will — the agent's cwd, inherited by
   * the servers it spawns — and an omitted cwd would silently mean the
   * extension host's, a directory no agent ever runs in. */
  | StdioTarget;

export interface ProbeOutcome {
  serverName: string;
  serverVersion: string;
  tools: { name: string; description: string }[];
}

export type ProbeFn = (target: ProbeTarget, signal?: AbortSignal, log?: Logger) => Promise<ProbeOutcome>;

/** No limit of ours on the handshake: it ends when the server answers, its
 * process ends, the network fails it, or the user stops it. The SDK sets a
 * 60 s limit on every request unless given one, and has no way to say
 * "none" — `Infinity` would become 1 ms in Node's timers — so the largest
 * delay a timer can hold (2³¹−1 ms, about 24.8 days) says it. */
const NO_LIMIT_MS = 2 ** 31 - 1;
/** Pagination guard — a server misbehaving on cursors must not loop us. */
const MAX_TOOL_PAGES = 20;
/** How long each rung of MCP's stdio shutdown waits for the server to go. */
const SHUTDOWN_GRACE_MS = 2_000;

/** A stdio MCP server as the client's transport: started through the door
 * at `start`, its stdout read as newline-framed JSON-RPC, its stderr left
 * unread (nothing renders it, and an unread pipe would fill and stall the
 * server). Closed as MCP's stdio shutdown says — its input closed, then
 * SIGTERM, then SIGKILL, each after a grace for the server to exit — but
 * to the whole tree, so a launcher's server goes with its launcher. */
class ChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child: ChildProcess | null = null;
  private readonly buffer = new ReadBuffer();

  constructor(private readonly target: StdioTarget) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = startChild(this.target.command, this.target.args, {
        env: mergeEnv(process.env, this.target.env),
        cwd: this.target.cwd,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      if ("error" in started) return reject(new Error(started.error));
      const { child } = started;
      this.child = child;
      child.once("spawn", () => resolve());
      child.on("error", (err) => {
        reject(err);
        this.onerror?.(err);
      });
      child.on("close", () => {
        this.child = null;
        this.onclose?.();
      });
      child.stdin!.on("error", (err) => this.onerror?.(err));
      child.stdout!.on("data", (chunk: Buffer) => this.read(chunk));
    });
  }

  private read(chunk: Buffer): void {
    try {
      this.buffer.append(chunk);
    } catch (err) {
      // Past the framing's size cap: the stream can't be read on.
      this.onerror?.(err as Error);
      void this.close();
      return;
    }
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.buffer.readMessage();
      } catch (err) {
        this.onerror?.(err as Error); // one bad line, not the stream
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (stdin == null) return Promise.reject(new Error("Not connected"));
    return new Promise((resolve) => {
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.buffer.clear();
    if (child === null) return;
    this.child = null;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const gone = () => child.exitCode !== null || child.signalCode !== null;
    const grace = () => Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref())]);
    child.stdin?.end();
    await grace();
    if (!gone()) {
      killTree(child, "SIGTERM");
      await grace();
    }
    // Whatever of the tree is left — nothing, once it has all gone.
    killTree(child, "SIGKILL");
  }
}

/** Told to stop, the handshake ends where it waits, and the client's close
 * ends a stdio server it started. A stdio server run by a launcher (npx/uvx)
 * has its package made ready first, as an agent's is (launcher-health.ts):
 * a first download is the install's, never the handshake's. */
export async function probeMcpServer(target: ProbeTarget, signal?: AbortSignal, log: Logger = nullLogger): Promise<ProbeOutcome> {
  if (target.kind === "stdio") {
    await prepareLauncher(target, mergeEnv(process.env, target.env), { signal, log, who: "MCP probe" });
  }
  const transport =
    target.kind === "http"
      ? new StreamableHTTPClientTransport(new URL(target.url), {
          requestInit:
            target.header !== null
              ? { headers: { [target.header.name]: target.header.value } }
              : undefined,
        })
      : new ChildTransport(target);
  const client = new Client(PRODUCT);
  try {
    await client.connect(transport, { timeout: NO_LIMIT_MS, signal });
    const serverInfo = client.getServerVersion();
    const tools: ProbeOutcome["tools"] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await client.listTools({ cursor }, { timeout: NO_LIMIT_MS, signal });
      for (const tool of result.tools) {
        tools.push({ name: tool.name, description: tool.description ?? "" });
      }
      if (result.nextCursor === undefined) break;
      cursor = result.nextCursor;
    }
    return {
      serverName: serverInfo?.name ?? "unknown",
      serverVersion: serverInfo?.version ?? "",
      tools,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
