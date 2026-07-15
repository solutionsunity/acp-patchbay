// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

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
import { clientMetaWire, terminalAuthRecipeOf } from "./meta";

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
    sessionAdditionalDirectories: session.additionalDirectories != null,
    promptImage: prompt.image === true,
    promptAudio: prompt.audio === true,
    promptEmbeddedContext: prompt.embeddedContext === true,
    mcpHttp: mcp.http === true,
    mcpSse: mcp.sse === true,
    authMethods: (init.authMethods ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? null,
      // A parseable `_meta["terminal-auth"]` recipe wins over the `type`
      // field: Auggie ships its recipe on a type-less method (schema-default
      // "agent") whose `authenticate` is a no-op, so type-first would wire a
      // button to nothing. Otherwise the wire's `type`: absent is the stable
      // default ("agent" handles it itself via `authenticate`);
      // "env_var"/"terminal" without a recipe stay declared-but-unwired
      // (protocol.ts's AuthMethodView docstring).
      kind:
        terminalAuthRecipeOf(m._meta) !== null
          ? "terminal-recipe"
          : ((m as { type?: "env_var" | "terminal" }).type ?? "agent"),
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
const CLIENT_DECLARES: {
  fs: boolean;
  terminal: boolean;
  elicitation: boolean;
  sessionConfigOptions: boolean;
} = {
  fs: true,
  terminal: true,
  elicitation: false,
  // Stabilized in SDK 1.2.1 (compliance G14): patchbay consumes config
  // options end to end — knobs.ts normalizes select AND boolean types — so
  // not declaring was the honesty gap in reverse: an agent honoring
  // "omitted = unsupported" would have withheld the whole knob surface. No
  // matrix row: the row list is hand-picked (capability-verification.md),
  // and this claim's visible proof is the composer knob strip itself.
  sessionConfigOptions: true,
};

/** CLIENT_DECLARES in its wire form. Elicitation is UNSTABLE and
 * object-shaped on the wire — omitted entirely while false (absent is how
 * ACP says "unsupported"); flipping CLIENT_DECLARES.elicitation is the only
 * change P7 needs here. */
export function clientCapabilitiesWire(): ClientCapabilities {
  const meta = clientMetaWire();
  return {
    fs: { readTextFile: CLIENT_DECLARES.fs, writeTextFile: CLIENT_DECLARES.fs },
    terminal: CLIENT_DECLARES.terminal,
    ...(CLIENT_DECLARES.elicitation ? { elicitation: {} } : {}),
    // `{ boolean: {} }` = "agents may include type:'boolean' entries" —
    // knobs.ts supports them, so the claim is the truth.
    ...(CLIENT_DECLARES.sessionConfigOptions
      ? { session: { configOptions: { boolean: {} } } }
      : {}),
    // Adopted _meta extensions (meta.ts — the declare flags there are the
    // single source; nothing here names a key).
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
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
    "session.additionalDirectories": cell(declared.sessionAdditionalDirectories),
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
       * carried an image block). `prior` is the connection as it stood when
       * the call was made — session count, and the declared table for rows
       * whose wire field rides requests unconditionally (a success must not
       * upgrade a claim the agent never made). Omitted = the method
       * resolving is enough. */
      when?: (
        params: unknown,
        prior: { sessionCount: number; declared: DeclaredCapabilities | null },
      ) => boolean;
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

/** The capability is about the *field*, not any one method — proven the
 * moment any lifecycle request actually carried extra roots. */
const carriesAdditionalDirectories = (params: unknown): boolean => {
  const dirs = (params as { additionalDirectories?: readonly string[] }).additionalDirectories;
  return Array.isArray(dirs) && dirs.length > 0;
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
  // Pool sends the field on every lifecycle request regardless of the claim
  // (best-effort roots), so the declared check lives in the proof: a
  // non-declaring agent resolving a request that happened to carry dirs
  // proves nothing — it may have silently ignored the field (the exact
  // bridge behavior this table exists to catch).
  "session.additionalDirectories": (
    [
      methods.agent.session.new,
      methods.agent.session.load,
      methods.agent.session.resume,
      methods.agent.session.fork,
    ] as const
  ).map((method) => ({
    via: "agentRequest" as const,
    method,
    when: (params: unknown, prior: { declared: DeclaredCapabilities | null }) =>
      prior.declared?.sessionAdditionalDirectories === true &&
      carriesAdditionalDirectories(params),
  })),
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
  | {
      via: "agentRequest";
      method: string;
      params: unknown;
      priorSessionCount: number;
      declared: DeclaredCapabilities | null;
    }
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
            (proof.when?.(f.params, {
              sessionCount: f.priorSessionCount,
              declared: f.declared,
            }) ?? true)
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
