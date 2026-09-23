#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Standalone stdio-to-HTTP bridge (capability-conditional transport — the
// guaranteed floor for agents that
// don't declare mcp.http, and the pinnable escape hatch for ones whose
// declared support is broken). Spawned by the *agent* as an mcpServers
// entry, exactly like
// src/mcp/server-main.ts — plain Node, no vscode import, reaches the
// orchestrator only through the same IPC socket for a fresh token and the
// session's roots.
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
//
// The pipe carries two things of its own on top of the agent's traffic,
// both about what the agent cannot supply: the credential (above), and the
// session's roots. MCP roots are a *client* capability — the server asks
// `roots/list`, the client answers — and the client on this wire is the
// agent, which declares no roots and holds no list. Patchbay holds the
// list, so the bridge declares the capability on the agent's initialize,
// answers `roots/list` from the orchestrator, and sends `list_changed`
// when the orchestrator says the list moved. The agent never sees those
// messages; everything else passes through untouched.
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { IpcClient } from "../mcp/ipc-client";
import type { IntegrationTokenParams, RootsResult } from "../mcp/ipc-protocol";

const socketPath = process.env.ACP_PATCHBAY_IPC ?? "";
const sessionId = process.env.ACP_PATCHBAY_SESSION_ID ?? "";
const integrationId = process.env.ACP_PATCHBAY_INTEGRATION_ID ?? "";
const url = process.env.ACP_PATCHBAY_INTEGRATION_URL ?? "";
// How the credential rides the request — per-integration data, since not
// every service takes `Authorization: Bearer` (Stitch wants a raw key in
// `X-Goog-Api-Key`). Absent header name =
// this integration sends no credential at all (authType "none").
const authHeader = process.env.ACP_PATCHBAY_AUTH_HEADER ?? "";
const authPrefix = process.env.ACP_PATCHBAY_AUTH_PREFIX ?? "";

let onRootsChanged: () => void = () => {};
const ipc = new IpcClient(socketPath, sessionId, () => onRootsChanged());

async function currentToken(): Promise<string | null> {
  if (authHeader === "") return null;
  const params: IntegrationTokenParams = { integrationId };
  const result = (await ipc.request("getIntegrationToken", params)) as { accessToken: string } | null;
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

function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number; method: string } {
  return "id" in message && "method" in message;
}

/** The agent's `initialize`, with the roots capability declared on top of
 * whatever the agent declared itself — the provider learns it may ask. */
function withRootsCapability(message: JSONRPCMessage): JSONRPCMessage {
  if (!isRequest(message) || message.method !== "initialize") return message;
  const params = ((message as { params?: unknown }).params ?? {}) as { capabilities?: Record<string, unknown> };
  return {
    ...message,
    params: { ...params, capabilities: { ...(params.capabilities ?? {}), roots: { listChanged: true } } },
  } as JSONRPCMessage;
}

/** The session's roots in MCP's shape: `file://` URIs (the spec's MUST),
 * named by their last path segment for display. */
async function rootsForProvider(): Promise<{ roots: Array<{ uri: string; name: string }> }> {
  const { roots } = (await ipc.request("getRoots")) as RootsResult;
  return { roots: roots.map((path) => ({ uri: pathToFileURL(path).href, name: basename(path) })) };
}

async function main(): Promise<void> {
  const agentSide = new StdioServerTransport();
  const providerSide = new StreamableHTTPClientTransport(new URL(url), { fetch: authedFetch });

  // A change notification is only meaningful on an initialized connection
  // — before the agent's `notifications/initialized` has passed, the
  // provider has not been told it may ask for roots.
  let initialized = false;
  onRootsChanged = () => {
    if (!initialized) return;
    void providerSide.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" }).catch(() => {});
  };

  agentSide.onmessage = (message) => {
    if ("method" in message && message.method === "notifications/initialized") initialized = true;
    void providerSide.send(withRootsCapability(message)).catch((err: unknown) => {
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
    if (isRequest(message) && message.method === "roots/list") {
      // Answered here, never forwarded: the agent has no list to answer
      // from. A failed read is the provider's error to handle, in the
      // shape the spec names for it.
      void rootsForProvider()
        .then((result) => providerSide.send({ jsonrpc: "2.0", id: message.id, result }))
        .catch((err: unknown) =>
          providerSide.send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: `bridge: ${(err as Error).message}` },
          }),
        )
        .catch(() => {});
      return;
    }
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
  // Subscribe to root changes for the session's lifetime. An orchestrator
  // that cannot be reached is the same condition as a token that cannot
  // be fetched: the provider's requests surface it, this must not.
  void ipc.request("watchRoots").catch(() => {});
}

void main().catch((err: unknown) => {
  process.stderr.write(`bridge failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
