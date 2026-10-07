// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Patchbay's own MCP-client handshake with a configured MCP server —
// initialize + tools/list, no agent, no LLM turn (the same "free read"
// class as session/list). Provider-side truth only: a passing probe means
// "reachable, these tools exist", never "working in an agent's session".
// vscode-free; McpServersStore injects credentials and caches results.
// Both transports come from the MCP SDK — the one dependency that also
// backs the stdio-to-HTTP bridge, so probe and bridge can't drift on
// transport behavior.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prepareLauncher } from "./launcher-health";
import { nullLogger, type Logger } from "./logger";

export type ProbeTarget =
  | { kind: "http"; url: string; header: { name: string; value: string } | null }
  /** Probing stdio means *executing* the configured command — only ever on
   * the user's explicit act (connect, power-on, refresh), never on a sweep.
   * `cwd` is required, never defaulted: the probe is only truthful if it
   * runs the server where the real run will — the agent's cwd, inherited by
   * the servers it spawns — and an omitted cwd would silently mean the
   * extension host's, a directory no agent ever runs in. */
  | { kind: "stdio"; command: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd: string };

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

/** Told to stop, the handshake ends where it waits, and the client's close
 * ends a stdio server it started. A stdio server run by a launcher (npx/uvx)
 * has its package made ready first, as an agent's is (launcher-health.ts):
 * a first download is the install's, never the handshake's. */
export async function probeMcpServer(target: ProbeTarget, signal?: AbortSignal, log: Logger = nullLogger): Promise<ProbeOutcome> {
  if (target.kind === "stdio") {
    await prepareLauncher(target, { ...process.env, ...target.env }, { signal, log, who: "MCP probe" });
  }
  const transport =
    target.kind === "http"
      ? new StreamableHTTPClientTransport(new URL(target.url), {
          requestInit:
            target.header !== null
              ? { headers: { [target.header.name]: target.header.value } }
              : undefined,
        })
      : new StdioClientTransport({
          command: target.command,
          args: [...target.args],
          env: { ...(process.env as Record<string, string>), ...target.env },
          cwd: target.cwd,
          stderr: "ignore",
        });
  const client = new Client({ name: "acp-patchbay", version: "0" });
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
