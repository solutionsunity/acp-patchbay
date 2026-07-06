#!/usr/bin/env node
// Standalone stdio-to-HTTP bridge (architecture.md § Integrations — "the
// orchestrator always hands agents a local stdio server; for remote OAuth
// services it owns a small stdio-to-HTTP bridge process that handles token
// refresh"). Spawned by the *agent* as an mcpServers entry, exactly like
// src/mcp/server-main.ts — plain Node, no vscode import, reaches the
// orchestrator only through the same IPC socket for a fresh token.
//
// Transparent proxy: every JSON-RPC message the agent sends over stdio is
// POSTed as-is to the integration's HTTP endpoint; the response (if the
// message was a request, not a notification) is written back as-is. v1
// speaks the plain request/response flavor of streamable-HTTP MCP transport
// — no SSE upgrade — sufficient for tool listing/calling, which is what
// every registry/custom-http integration needs (scoped in plan.md P9).
import { encodeLine, parseLines } from "../mcp/ipc-protocol";
import { IpcClient } from "../mcp/ipc-client";

const socketPath = process.env.ACP_PATCHBAY_IPC ?? "";
const integrationId = process.env.ACP_PATCHBAY_INTEGRATION_ID ?? "";
const url = process.env.ACP_PATCHBAY_INTEGRATION_URL ?? "";
// How the credential rides the request — per-integration data, since not
// every service takes `Authorization: Bearer` (Stitch wants a raw key in
// `X-Goog-Api-Key`; see docs/reference-mcp-oauth.md). Absent header name =
// this integration sends no credential at all (authType "none").
const authHeader = process.env.ACP_PATCHBAY_AUTH_HEADER ?? "";
const authPrefix = process.env.ACP_PATCHBAY_AUTH_PREFIX ?? "";

const ipc = new IpcClient(socketPath, integrationId);

async function currentToken(): Promise<string | null> {
  if (authHeader === "") return null;
  const result = (await ipc.request("getIntegrationToken")) as { accessToken: string } | null;
  return result?.accessToken ?? null;
}

async function postJson(body: unknown, token: string | null): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token !== null ? { [authHeader]: `${authPrefix}${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function hasId(message: unknown): boolean {
  return typeof message === "object" && message !== null && "id" in message;
}

async function forward(message: unknown): Promise<void> {
  const token = await currentToken();
  let response = await postJson(message, token);
  if (response.status === 401 && authHeader !== "") {
    // The orchestrator refreshes transparently on every getIntegrationToken
    // call — a second 401 right after a fresh token means the integration
    // itself rejected it, not that patchbay was holding a stale one.
    response = await postJson(message, await currentToken());
  }
  if (!hasId(message)) return; // a notification — no response is ever sent back
  const body: unknown = await response.json();
  process.stdout.write(encodeLine(body));
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  const { messages, rest } = parseLines(buffer);
  buffer = rest;
  for (const message of messages) void forward(message);
});
