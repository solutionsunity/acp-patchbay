#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Standalone entry point — bundled separately (esbuild.mjs) and spawned by
// the *agent*, not by patchbay, per ACP's stdio mcpServers model. Plain
// Node, no vscode: real editor state comes from the orchestrator over the
// IPC bridge (ipc-protocol.ts) via env vars this process is launched with.
import { IPC_ENV } from "./ipc-protocol";
import { IpcClient } from "./ipc-client";
import { callTool, TOOL_DEFS } from "./tools";
import { PRODUCT } from "../shared/product";

const socketPath = process.env[IPC_ENV.socket];
const contextToken = process.env[IPC_ENV.contextToken];
if (socketPath === undefined || contextToken === undefined) {
  process.stderr.write(`acp-patchbay MCP server: missing ${IPC_ENV.socket}/${IPC_ENV.contextToken}\n`);
  process.exit(1);
}

const ipc = new IpcClient(socketPath, contextToken);

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

async function handleMessage(msg: JsonRpcMessage): Promise<void> {
  switch (msg.method) {
    case "initialize":
      send({
        id: msg.id,
        result: {
          // MCP is date-versioned; bump when the ecosystem moves on, to
          // adapt when the compatibility moment happens.
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: PRODUCT,
        },
      });
      return;
    case "notifications/initialized":
      return; // notification — no response
    case "tools/list":
      send({ id: msg.id, result: { tools: TOOL_DEFS } });
      return;
    case "tools/call": {
      const params = msg.params as { name: string; arguments?: Record<string, unknown> };
      try {
        const result = await callTool(ipc, params.name, params.arguments ?? {});
        send({ id: msg.id, result });
      } catch (err) {
        send({ id: msg.id, error: { code: -32000, message: (err as Error).message } });
      }
      return;
    }
    default:
      if (msg.id !== undefined) {
        send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
      }
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    void handleMessage(JSON.parse(line) as JsonRpcMessage);
  }
});
process.stdin.on("end", () => process.exit(0));
