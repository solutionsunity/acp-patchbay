// Normalizes an agent's initialize response into the declared table.
// Declared ≠ verified: this is what the agent claims, refreshed every connect.
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type { CapabilityMatrix, DeclaredCapabilities } from "../shared/protocol";

export function declaredFromInitialize(
  init: InitializeResponse,
): DeclaredCapabilities {
  const caps = init.agentCapabilities ?? {};
  const session = caps.sessionCapabilities ?? {};
  const prompt = caps.promptCapabilities ?? {};
  const mcp = caps.mcpCapabilities ?? {};
  return {
    loadSession: caps.loadSession === true,
    sessionFork: session.fork != null,
    sessionResume: session.resume != null,
    sessionList: session.list != null,
    sessionClose: session.close != null,
    promptImage: prompt.image === true,
    promptAudio: prompt.audio === true,
    promptEmbeddedContext: prompt.embeddedContext === true,
    mcpHttp: mcp.http === true,
    mcpSse: mcp.sse === true,
    authMethods: (init.authMethods ?? []).map((m) => m.id),
  };
}

/**
 * What patchbay itself currently declares to every agent via
 * `clientCapabilities` (pool.ts's `connect()`). `elicitation` stays false
 * until P7 wires the adapter — declaring it earlier would be the exact lie
 * bet #2 exists to prevent.
 */
const CLIENT_DECLARES = {
  fs: true,
  terminal: true,
  elicitation: false,
} as const;

function cell(declared: boolean): { declared: boolean; verified: boolean } {
  return { declared, verified: false };
}

/**
 * Builds the full capability matrix (architecture.md's row list) from the
 * agent's declared table. Fired fresh on every connect, so every cell starts
 * at verified=false — reset-on-reconnect falls out of always replacing the
 * whole matrix, never patching it in place.
 */
export function matrixFromDeclared(declared: DeclaredCapabilities): CapabilityMatrix {
  return {
    "fs.readTextFile": cell(CLIENT_DECLARES.fs),
    "fs.writeTextFile": cell(CLIENT_DECLARES.fs),
    terminal: cell(CLIENT_DECLARES.terminal),
    elicitation: cell(CLIENT_DECLARES.elicitation),
    // MCP-level (not ACP) capabilities of the agent's own MCP client, only
    // observable once the local MCP server exists to capture that handshake.
    "roots.listChanged": cell(false),
    "resources.subscribe": cell(false),
    "prompt.image": cell(declared.promptImage),
    "prompt.audio": cell(declared.promptAudio),
    "prompt.embeddedContext": cell(declared.promptEmbeddedContext),
    "session.fork": cell(declared.sessionFork),
    "session.load": cell(declared.loadSession),
    "session.resume": cell(declared.sessionResume),
    "mcp.http": cell(declared.mcpHttp),
    "mcp.sse": cell(declared.mcpSse),
    // No initialize-time claim exists for these — only ever observed directly.
    usage: cell(false),
    concurrentSessions: cell(false),
  };
}
