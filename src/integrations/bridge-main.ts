#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Standalone stdio-to-HTTP bridge (capability-conditional transport — the
// guaranteed floor for agents that
// don't declare mcp.http, and the pinnable escape hatch for ones whose
// declared support is broken). Spawned by the *agent* as an mcpServers
// entry, exactly like
// src/mcp/server-main.ts — plain Node, no vscode import, reaches the
// orchestrator only through the same IPC socket for a fresh token.
//
// A pipe between two MCP SDK transports, not a protocol implementation:
// StdioServerTransport faces the agent, StreamableHTTPClientTransport faces
// the provider. The SDK owns the transport contract patchbay must not
// hand-roll — accept-header negotiation, SSE-framed responses,
// Mcp-Session-Id echo, reconnects (the naive JSON-POST v1 crashed on the
// first spec-compliant server: GitHub 400s without `text/event-stream` in
// accept, then answers in SSE frames). The credential still never rides
// agent-visible config: it's injected here, per request, via the custom
// fetch below. This bridge is the guaranteed-floor path for agents that
// don't declare mcp.http — declaring agents get the URL passed through and
// connect themselves (integrations.mcpServersFor).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { IpcClient } from "../mcp/ipc-client";

const socketPath = process.env.ACP_PATCHBAY_IPC ?? "";
const integrationId = process.env.ACP_PATCHBAY_INTEGRATION_ID ?? "";
const url = process.env.ACP_PATCHBAY_INTEGRATION_URL ?? "";
// How the credential rides the request — per-integration data, since not
// every service takes `Authorization: Bearer` (Stitch wants a raw key in
// `X-Goog-Api-Key`). Absent header name =
// this integration sends no credential at all (authType "none").
const authHeader = process.env.ACP_PATCHBAY_AUTH_HEADER ?? "";
const authPrefix = process.env.ACP_PATCHBAY_AUTH_PREFIX ?? "";

const ipc = new IpcClient(socketPath, integrationId);

async function currentToken(): Promise<string | null> {
  if (authHeader === "") return null;
  const result = (await ipc.request("getIntegrationToken")) as { accessToken: string } | null;
  return result?.accessToken ?? null;
}

/** The SDK transport's fetch, with the credential injected fresh per request
 * — the token never sits in a header object that outlives one call. On 401
 * the orchestrator refreshes transparently inside getIntegrationToken, so
 * one immediate retry distinguishes "patchbay held a stale token" from "the
 * integration rejected a fresh one". */
async function authedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const attempt = async (token: string | null) =>
    fetch(input, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers).entries()),
        ...(token !== null ? { [authHeader]: `${authPrefix}${token}` } : {}),
      },
    });
  let response = await attempt(await currentToken());
  if (response.status === 401 && authHeader !== "") {
    response = await attempt(await currentToken());
  }
  return response;
}

function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number } {
  return "id" in message && "method" in message;
}

async function main(): Promise<void> {
  const agentSide = new StdioServerTransport();
  const providerSide = new StreamableHTTPClientTransport(new URL(url), { fetch: authedFetch });

  agentSide.onmessage = (message) => {
    void providerSide.send(message).catch((err: unknown) => {
      // A failed round trip answers the agent's request as a JSON-RPC error
      // — never kills the bridge (v1 died by unhandled rejection here, and
      // the agent saw only a silently absent server).
      if (isRequest(message)) {
        void agentSide.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: `bridge: ${(err as Error).message}` },
        });
      }
    });
  };
  providerSide.onmessage = (message) => {
    void agentSide.send(message).catch(() => {});
  };
  providerSide.onerror = () => {
    // Transport-level noise (e.g. a provider without the optional GET SSE
    // stream) — per-request failures already answer through the catch above.
  };

  // The agent that spawned this bridge owns its lifetime: stdin EOF means
  // that agent is gone (clean exit or kill), so exit instead of lingering as
  // an orphan — same rule as server-main.ts, and the defense that still
  // works when patchbay itself died without running any cleanup.
  // close() aborts in-flight provider requests; their responses have no
  // reader anymore. The SDK's stdio transport only fires onclose from its
  // own close() — the EOF event needs wiring by hand.
  const shutdown = () => void providerSide.close().finally(() => process.exit(0));
  agentSide.onclose = shutdown;
  process.stdin.on("end", shutdown);

  await providerSide.start();
  await agentSide.start();
}

void main().catch((err: unknown) => {
  process.stderr.write(`bridge failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
