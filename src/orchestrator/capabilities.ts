// Normalizes an agent's initialize response into the declared table, and
// owns the used-proof table — the one place that knows how each row gets
// marked used. Declared ≠ used: declared is what the agent claims, refreshed
// every connect; used is proven by CAPABILITY_PROOFS below, consulted at
// pool.ts's wire chokepoints.
import {
  methods,
  type ClientCapabilities,
  type InitializeResponse,
  type PromptRequest,
} from "@agentclientprotocol/sdk";
import type { CapabilityMatrix, CapabilityRowId, DeclaredCapabilities } from "../shared/protocol";

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
    sessionDelete: session.delete != null,
    sessionClose: session.close != null,
    promptImage: prompt.image === true,
    promptAudio: prompt.audio === true,
    promptEmbeddedContext: prompt.embeddedContext === true,
    mcpHttp: mcp.http === true,
    mcpSse: mcp.sse === true,
    authMethods: (init.authMethods ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? null,
      // The wire's `type` field is absent for the stable default ("agent"
      // handles it itself via `authenticate`); "env_var"/"terminal" are both
      // UNSTABLE ACP capabilities — declared here, never wired to a Log-in
      // action (protocol.ts's AuthMethodView docstring).
      kind: (m as { type?: "env_var" | "terminal" }).type ?? "agent",
    })),
    authLogout: caps.auth?.logout != null,
  };
}

/**
 * What patchbay itself declares to every agent — the single source for both
 * the wire claim (`clientCapabilitiesWire`, sent at initialize) and the
 * matrix's client-side cells (`matrixFromDeclared`), so the two can never
 * drift. `elicitation` stays false until P7 wires the adapter — declaring it
 * earlier would be the exact lie bet #2 exists to prevent.
 */
const CLIENT_DECLARES: { fs: boolean; terminal: boolean; elicitation: boolean } = {
  fs: true,
  terminal: true,
  elicitation: false,
};

/** CLIENT_DECLARES in its wire form. Elicitation is UNSTABLE and
 * object-shaped on the wire — omitted entirely while false (absent is how
 * ACP says "unsupported"); flipping CLIENT_DECLARES.elicitation is the only
 * change P7 needs here. */
export function clientCapabilitiesWire(): ClientCapabilities {
  return {
    fs: { readTextFile: CLIENT_DECLARES.fs, writeTextFile: CLIENT_DECLARES.fs },
    terminal: CLIENT_DECLARES.terminal,
    ...(CLIENT_DECLARES.elicitation ? { elicitation: {} } : {}),
  };
}

function cell(declared: boolean): { declared: boolean; used: boolean } {
  return { declared, used: false };
}

/**
 * Builds the full capability matrix (architecture.md's row list) from the
 * agent's declared table. Fired fresh on every connect, so every cell starts
 * at used=false — reset-on-reconnect falls out of always replacing the
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
    "session.list": cell(declared.sessionList),
    "session.delete": cell(declared.sessionDelete),
    "session.close": cell(declared.sessionClose),
    "mcp.http": cell(declared.mcpHttp),
    "mcp.sse": cell(declared.mcpSse),
    // No initialize-time claim exists for these — only ever observed directly.
    usage: cell(false),
    concurrentSessions: cell(false),
    // Declared the moment authMethods is non-empty; used only once a
    // session has actually opened (with or without an authenticate round
    // trip in between — see capability-tracker.ts / pool.ts).
    auth: cell(declared.authMethods.length > 0),
    "auth.logout": cell(declared.authLogout),
  };
}

// ── used-proof table ─────────────────────────────────────────────────────────
// Marking a row used is centralized (capability-verification.md): pool.ts
// observes wire facts at three chokepoints — an agent RPC resolving, an
// incoming client request handled, a session/update kind tag arriving — and
// asks `rowsProvenBy` which rows each fact proves. No row name ever appears
// at a call site: adding a CapabilityRowId forces an entry here (the Record
// is exhaustive) and nowhere else. An empty entry means no wire path pool.ts
// can observe yet — the comment beside it says why.

/** One way a row is proven used on the wire. */
export type CapabilityProof =
  | {
      /** An outgoing agent RPC resolved without error. */
      via: "agentRequest";
      method: string;
      /** Extra condition on the successful call (e.g. the prompt actually
       * carried an image block). Omitted = the method resolving is enough. */
      when?: (params: unknown, prior: { sessionCount: number }) => boolean;
    }
  | {
      /** The agent called one of patchbay's client methods and the handler
       * resolved. A rejected fs write still resolves — the gate working *is*
       * the brokered path firing; a rejected terminal create throws, so it
       * never marks. */
      via: "clientRequest";
      method: string;
    }
  | {
      /** A session/update notification arrived with this kind tag. */
      via: "sessionUpdate";
      updateKind: string;
    };

const promptCarries =
  (blockType: "image" | "audio" | "resource") =>
  (params: unknown): boolean =>
    (params as PromptRequest).prompt.some((block) => block.type === blockType);

export const CAPABILITY_PROOFS: Readonly<Record<CapabilityRowId, readonly CapabilityProof[]>> = {
  "fs.readTextFile": [{ via: "clientRequest", method: methods.client.fs.readTextFile }],
  "fs.writeTextFile": [{ via: "clientRequest", method: methods.client.fs.writeTextFile }],
  terminal: [{ via: "clientRequest", method: methods.client.terminal.create }],
  // Fires the moment P7 registers the handler — no table change needed then.
  elicitation: [{ via: "clientRequest", method: methods.client.elicitation.create }],
  // MCP-side: observable only in the local MCP server's handshake with the
  // agent's own MCP client, not on the ACP wire.
  "roots.listChanged": [],
  "resources.subscribe": [],
  // Session-manager only sends these block types where declared (the
  // resource-link fallback otherwise), so a mark can't outrun the claim.
  "prompt.image": [
    { via: "agentRequest", method: methods.agent.session.prompt, when: promptCarries("image") },
  ],
  "prompt.audio": [
    { via: "agentRequest", method: methods.agent.session.prompt, when: promptCarries("audio") },
  ],
  "prompt.embeddedContext": [
    { via: "agentRequest", method: methods.agent.session.prompt, when: promptCarries("resource") },
  ],
  "session.fork": [{ via: "agentRequest", method: methods.agent.session.fork }],
  "session.load": [{ via: "agentRequest", method: methods.agent.session.load }],
  "session.resume": [{ via: "agentRequest", method: methods.agent.session.resume }],
  "session.list": [{ via: "agentRequest", method: methods.agent.session.list }],
  "session.delete": [{ via: "agentRequest", method: methods.agent.session.delete }],
  "session.close": [{ via: "agentRequest", method: methods.agent.session.close }],
  // Proof would be the agent connecting to an attached http/sse server —
  // not visible on the ACP wire.
  "mcp.http": [],
  "mcp.sse": [],
  usage: [{ via: "sessionUpdate", updateKind: "usage_update" }],
  concurrentSessions: [
    // A second session opening on a connection already serving one…
    {
      via: "agentRequest",
      method: methods.agent.session.new,
      when: (_params, prior) => prior.sessionCount > 0,
    },
    // …and a fork always proves it — the parent already rides the connection.
    { via: "agentRequest", method: methods.agent.session.fork },
  ],
  // A working session/new is the proof: whoever called it (a real session or
  // capability-tracker.ts's throwaway probe) got a session out of it, so
  // auth — if this agent even declares any — actually works.
  auth: [{ via: "agentRequest", method: methods.agent.session.new }],
  "auth.logout": [{ via: "agentRequest", method: methods.agent.logout }],
};

/** One wire fact, as observed by a pool.ts chokepoint. */
export type WireFact =
  | { via: "agentRequest"; method: string; params: unknown; priorSessionCount: number }
  | { via: "clientRequest"; method: string }
  | { via: "sessionUpdate"; updateKind: string };

/** The rows this fact proves used — pure, so it's testable without a pool. */
export function rowsProvenBy(fact: WireFact): CapabilityRowId[] {
  const rows: CapabilityRowId[] = [];
  for (const row of Object.keys(CAPABILITY_PROOFS) as CapabilityRowId[]) {
    const proven = CAPABILITY_PROOFS[row].some((proof) => {
      if (proof.via !== fact.via) return false;
      switch (proof.via) {
        case "agentRequest": {
          const f = fact as Extract<WireFact, { via: "agentRequest" }>;
          return (
            proof.method === f.method &&
            (proof.when?.(f.params, { sessionCount: f.priorSessionCount }) ?? true)
          );
        }
        case "clientRequest":
          return proof.method === (fact as Extract<WireFact, { via: "clientRequest" }>).method;
        case "sessionUpdate":
          return (
            proof.updateKind === (fact as Extract<WireFact, { via: "sessionUpdate" }>).updateKind
          );
      }
    });
    if (proven) rows.push(row);
  }
  return rows;
}
