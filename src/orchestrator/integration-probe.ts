// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Patchbay's own MCP-client handshake with an integration server —
// initialize + tools/list, no agent, no LLM turn (the same "free read"
// class as session/list). Provider-side truth only: a passing probe means
// "reachable, these tools exist", never "working in an agent's session".
// vscode-free; IntegrationsManager injects credentials and caches results.
// Both transports come from the MCP SDK — the one dependency that also
// backs the stdio-to-HTTP bridge, so probe and bridge can't drift on
// transport behavior.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type ProbeTarget =
  | { kind: "http"; url: string; header: { name: string; value: string } | null }
  /** Probing stdio means *executing* the configured command — only ever on
   * the user's explicit act (connect, power-on, refresh), never on a sweep. */
  | { kind: "stdio"; command: string; args: readonly string[]; env: Readonly<Record<string, string>> };

export interface ProbeOutcome {
  serverName: string;
  serverVersion: string;
  tools: { name: string; description: string }[];
}

export type ProbeFn = (target: ProbeTarget) => Promise<ProbeOutcome>;

const PROBE_TIMEOUT_MS = 20_000;
/** Pagination guard — a server misbehaving on cursors must not loop us. */
const MAX_TOOL_PAGES = 20;

export async function probeMcpServer(target: ProbeTarget): Promise<ProbeOutcome> {
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
          stderr: "ignore",
        });
  const client = new Client({ name: "acp-patchbay", version: "0" });
  try {
    await client.connect(transport, { timeout: PROBE_TIMEOUT_MS });
    const serverInfo = client.getServerVersion();
    const tools: ProbeOutcome["tools"] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await client.listTools({ cursor }, { timeout: PROBE_TIMEOUT_MS });
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
