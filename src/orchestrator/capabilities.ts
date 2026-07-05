// Normalizes an agent's initialize response into the declared table.
// Declared ≠ verified: this is what the agent claims, refreshed every connect.
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type { DeclaredCapabilities } from "../shared/protocol";

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
