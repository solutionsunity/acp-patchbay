// Pure-function coverage: capabilityState, matrixFromDeclared, and the
// tracker's marks over a stand-in pool — the parts of P5 that don't need a
// live agent at all.
import { describe, expect, it } from "vitest";
import {
  clientCapabilitiesWire,
  matrixFromDeclared,
  rowsProvenBy,
  terminalAuthOf,
} from "../src/orchestrator/capabilities";
import { CapabilityTracker } from "../src/orchestrator/capability-tracker";
import type { AgentPool } from "../src/orchestrator/pool";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { UsedCapabilityStore } from "../src/orchestrator/stores/used-capabilities";
import {
  capabilityState,
  initialAgentViewState,
  reduceAgentView,
  type DeclaredCapabilities,
} from "../src/shared/protocol";
import type { PatchbayAgentId, PatchbaySessionId } from "../src/shared/ids";

const noDeclared: DeclaredCapabilities = {
  loadSession: false,
  sessionFork: false,
  sessionResume: false,
  sessionList: false,
  sessionDelete: false,
  sessionClose: false,
  promptImage: false,
  promptAudio: false,
  promptEmbeddedContext: false,
  mcpHttp: false,
  mcpSse: false,
  authMethods: [],
  authLogout: false,
  sessionAdditionalDirectories: false,
};

describe("capabilityState", () => {
  it("is not-declared when the cell is missing or undeclared", () => {
    expect(capabilityState(undefined)).toBe("not-declared");
    expect(capabilityState({ declared: false, used: false })).toBe("not-declared");
  });
  it("is declared when claimed but not used", () => {
    expect(capabilityState({ declared: true, used: false })).toBe("declared");
  });
  it("is used once exercised", () => {
    expect(capabilityState({ declared: true, used: true })).toBe("used");
  });
  it("is suspect when declared, not used, and implicated in a failed request", () => {
    expect(capabilityState({ declared: true, used: false, suspect: true })).toBe("suspect");
  });
  it("proof outranks suspicion — a used cell never reads suspect", () => {
    expect(capabilityState({ declared: true, used: true, suspect: true })).toBe("used");
  });
});

describe("matrixFromDeclared", () => {
  it("always declares fs and terminal — patchbay's own offer, not the agent's", () => {
    const matrix = matrixFromDeclared(noDeclared);
    expect(matrix["fs.readTextFile"]).toEqual({ declared: true, used: false });
    expect(matrix["fs.writeTextFile"]).toEqual({ declared: true, used: false });
    expect(matrix.terminal).toEqual({ declared: true, used: false });
  });

  it("client-side rows carry patchbay's own claim, whatever the agent declared", () => {
    const matrix = matrixFromDeclared(noDeclared);
    // Elicitation is a client capability: the agent declares nothing, so
    // this row is patchbay's claim in every agent's column — used is what
    // varies per agent, once one actually asks.
    expect(matrix.elicitation).toEqual({ declared: true, used: false });
    // MCP-level, not ACP: observable only in the local server's handshake
    // with the agent's own MCP client.
    expect(matrix["resources.subscribe"]).toEqual({ declared: false, used: false });
  });

  it("usage and concurrentSessions have no initialize-time claim", () => {
    const matrix = matrixFromDeclared(noDeclared);
    expect(matrix.usage).toEqual({ declared: false, used: false });
    expect(matrix.concurrentSessions).toEqual({ declared: false, used: false });
  });

  it("auth.logout mirrors the agent's declared auth.logout capability", () => {
    expect(matrixFromDeclared(noDeclared)["auth.logout"]).toEqual({ declared: false, used: false });
    const declared = matrixFromDeclared({ ...noDeclared, authLogout: true });
    expect(declared["auth.logout"]).toEqual({ declared: true, used: false });
  });

  it("mirrors the agent's declared session/prompt/mcp capabilities", () => {
    const matrix = matrixFromDeclared({
      ...noDeclared,
      sessionFork: true,
      loadSession: true,
      promptImage: true,
      mcpHttp: true,
    });
    expect(matrix["session.fork"].declared).toBe(true);
    expect(matrix["session.load"].declared).toBe(true);
    expect(matrix["prompt.image"].declared).toBe(true);
    expect(matrix["mcp.http"].declared).toBe(true);
    expect(matrix["mcp.sse"].declared).toBe(false);
  });

  it("every cell starts unused — being used is a separate, later event", () => {
    const matrix = matrixFromDeclared({ ...noDeclared, sessionFork: true, loadSession: true });
    for (const cell of Object.values(matrix)) expect(cell.used).toBe(false);
  });
});

describe("rowsProvenBy — the one used-proof table", () => {
  const prompt = (blocks: Array<{ type: string }>) =>
    rowsProvenBy({
      via: "agentRequest",
      method: "session/prompt",
      params: { sessionId: "s1", prompt: blocks },
      priorSessionCount: 1,
      declared: null,
    });

  it("session/new proves nothing auth-wise — lazy-auth agents pass it logged out; concurrentSessions only with a prior session", () => {
    const first = rowsProvenBy({
      via: "agentRequest",
      method: "session/new",
      params: { cwd: "/" },
      priorSessionCount: 0,
      declared: null,
    });
    expect(first).toEqual([]);
    const second = rowsProvenBy({
      via: "agentRequest",
      method: "session/new",
      params: { cwd: "/" },
      priorSessionCount: 1,
      declared: null,
    });
    expect(second).toEqual(["concurrentSessions"]);
  });

  it("authenticate proves auth only on an agent that declares methods", () => {
    const declared = {
      loadSession: false, sessionFork: false, sessionResume: false, sessionList: false,
      sessionDelete: false, sessionClose: false, sessionAdditionalDirectories: false,
      promptImage: false, promptAudio: false, promptEmbeddedContext: false,
      mcpHttp: false, mcpSse: false, authLogout: false,
      authMethods: [{ id: "m", name: "M", description: null, kind: "agent" as const }],
    };
    const withMethods = rowsProvenBy({
      via: "agentRequest", method: "authenticate", params: { methodId: "m" },
      priorSessionCount: 0, declared,
    });
    expect(withMethods).toEqual(["auth"]);
    const withoutMethods = rowsProvenBy({
      via: "agentRequest", method: "authenticate", params: { methodId: "m" },
      priorSessionCount: 0, declared: { ...declared, authMethods: [] },
    });
    expect(withoutMethods).toEqual([]);
  });

  it("a logout round trip proves auth.logout and nothing else", () => {
    const rows = rowsProvenBy({
      via: "agentRequest",
      method: "logout",
      params: {},
      priorSessionCount: 0,
      declared: null,
    });
    expect(rows).toEqual(["auth.logout"]);
  });

  it("session/fork proves fork and concurrentSessions — the parent already rides the connection", () => {
    const rows = rowsProvenBy({
      via: "agentRequest",
      method: "session/fork",
      params: { sessionId: "s1", cwd: "/" },
      priorSessionCount: 1,
      declared: null,
    });
    expect(rows.sort()).toEqual(["concurrentSessions", "session.fork"]);
  });

  it("session/prompt proves prompt rows only for block types actually carried", () => {
    expect(prompt([{ type: "text" }])).toEqual([]);
    expect(prompt([{ type: "image" }, { type: "text" }])).toEqual(["prompt.image"]);
    expect(prompt([{ type: "audio" }])).toEqual(["prompt.audio"]);
    expect(prompt([{ type: "resource" }])).toEqual(["prompt.embeddedContext"]);
    // resource_link is the baseline every agent must accept — proves nothing.
    expect(prompt([{ type: "resource_link" }])).toEqual([]);
  });

  it("incoming client requests prove fs/terminal by method; output/kill do not", () => {
    expect(rowsProvenBy({ via: "clientRequest", method: "fs/read_text_file" })).toEqual([
      "fs.readTextFile",
    ]);
    expect(rowsProvenBy({ via: "clientRequest", method: "fs/write_text_file" })).toEqual([
      "fs.writeTextFile",
    ]);
    expect(rowsProvenBy({ via: "clientRequest", method: "terminal/create" })).toEqual(["terminal"]);
    expect(rowsProvenBy({ via: "clientRequest", method: "terminal/output" })).toEqual([]);
    expect(rowsProvenBy({ via: "clientRequest", method: "session/request_permission" })).toEqual([]);
  });

  it("usage_update is the only session/update kind that proves a row", () => {
    expect(rowsProvenBy({ via: "sessionUpdate", updateKind: "usage_update" })).toEqual(["usage"]);
    expect(rowsProvenBy({ via: "sessionUpdate", updateKind: "agent_message_chunk" })).toEqual([]);
  });
});

/** The tracker over a pool that only answers `get` — one connection whose
 * declaration and version the test moves; the probe a reconnect starts
 * finds no wire and ends quietly. */
function trackerOver(declared: DeclaredCapabilities, version: string | undefined) {
  let live = { declared, initialize: { protocolVersion: 1, agentInfo: version === undefined ? undefined : { name: "a", version } } };
  const pool = {
    get: () => live,
    newSession: () => Promise.reject(new Error("no wire here")),
    forgetSession: () => {},
  } as unknown as AgentPool;
  const changed: string[] = [];
  const tracker = new CapabilityTracker(pool, new UsedCapabilityStore(new MemoryKV()), {
    registryIdOf: () => null,
    changed: (patchbayAgentId) => changed.push(patchbayAgentId),
    probeRoot: async () => "/nowhere",
  });
  /** A fresh connection — the same agent, at `nextVersion`. */
  const reconnect = (nextVersion: string | undefined) => {
    live = { declared, initialize: { protocolVersion: 1, agentInfo: nextVersion === undefined ? undefined : { name: "a", version: nextVersion } } };
    tracker.onDeclared("a1" as PatchbayAgentId);
  };
  return { tracker, changed, reconnect };
}

describe("tracker marks — the matrix as it is read", () => {
  const declared = { ...noDeclared, sessionFork: true };

  it("reads the connection's declaration, unmarked", () => {
    const { tracker } = trackerOver(declared, "1.0.0");
    expect(tracker.matrix("a1" as PatchbayAgentId)!["session.fork"]).toEqual({ declared: true, used: false });
  });

  it("a used mark flips a declared row to used", () => {
    const { tracker } = trackerOver(declared, "1.0.0");
    tracker.noteEvidence("a1" as PatchbayAgentId, "session.fork", "used");
    expect(tracker.matrix("a1" as PatchbayAgentId)!["session.fork"]).toEqual({ declared: true, used: true });
  });

  it("used implies declared even for rows with no initialize-time claim", () => {
    const { tracker } = trackerOver(declared, "1.0.0");
    tracker.noteEvidence("a1" as PatchbayAgentId, "usage", "used");
    expect(tracker.matrix("a1" as PatchbayAgentId)!.usage).toEqual({ declared: true, used: true });
  });

  it("a reconnect at the same version keeps what was proven; a version change starts fresh", () => {
    const { tracker, reconnect } = trackerOver(declared, "1.0.0");
    tracker.noteEvidence("a1" as PatchbayAgentId, "session.fork", "used");
    reconnect("1.0.0");
    expect(tracker.matrix("a1" as PatchbayAgentId)!["session.fork"].used).toBe(true);
    reconnect("1.1.0");
    expect(tracker.matrix("a1" as PatchbayAgentId)!["session.fork"]).toEqual({ declared: true, used: false });
  });

  it("an agent reporting no version keeps its marks for the connection only", () => {
    const { tracker, reconnect } = trackerOver(declared, undefined);
    tracker.noteEvidence("a1" as PatchbayAgentId, "session.fork", "used");
    expect(tracker.matrix("a1" as PatchbayAgentId)!["session.fork"].used).toBe(true);
    reconnect(undefined);
    expect(tracker.matrix("a1" as PatchbayAgentId)!["session.fork"]).toEqual({ declared: true, used: false });
  });

  it("suspect flags a declared row — suspicion implies declared, like used does", () => {
    const { tracker } = trackerOver(declared, "1.0.0");
    tracker.noteEvidence("a1" as PatchbayAgentId, "prompt.image", "suspect");
    expect(tracker.matrix("a1" as PatchbayAgentId)!["prompt.image"]).toEqual({ declared: true, used: false, suspect: true });
    expect(capabilityState(tracker.matrix("a1" as PatchbayAgentId)!["prompt.image"])).toBe("suspect");
  });

  it("suspicion never speaks over proof — suspect on a used row is a no-op", () => {
    const { tracker } = trackerOver(declared, "1.0.0");
    tracker.noteEvidence("a1" as PatchbayAgentId, "session.fork", "used");
    tracker.noteEvidence("a1" as PatchbayAgentId, "session.fork", "suspect");
    expect(tracker.matrix("a1" as PatchbayAgentId)!["session.fork"]).toEqual({ declared: true, used: true });
  });

  it("first success acquits — a used mark drops the suspect flag", () => {
    const { tracker } = trackerOver(declared, "1.0.0");
    tracker.noteEvidence("a1" as PatchbayAgentId, "session.fork", "suspect");
    tracker.noteEvidence("a1" as PatchbayAgentId, "session.fork", "used");
    expect(tracker.matrix("a1" as PatchbayAgentId)!["session.fork"]).toEqual({ declared: true, used: true });
  });

  // Features gate on used: a mark on a row the connection no longer claims
  // (and whose proof can't outrun a claim) lights nothing — the rule a
  // restart already applied, now the only one.
  it("a used mark on a row the connection doesn't declare stays dark", () => {
    const { tracker } = trackerOver(declared, "1.0.0");
    tracker.noteEvidence("a1" as PatchbayAgentId, "prompt.image", "used");
    expect(capabilityState(tracker.matrix("a1" as PatchbayAgentId)!["prompt.image"])).toBe("not-declared");
  });

  it("a repeat of a standing mark writes nothing and moves nothing", () => {
    const { tracker, changed } = trackerOver(declared, "1.0.0");
    tracker.noteEvidence("a1" as PatchbayAgentId, "session.fork", "used");
    tracker.noteEvidence("a1" as PatchbayAgentId, "session.fork", "used");
    tracker.noteEvidence("a1" as PatchbayAgentId, "prompt.image", "suspect");
    tracker.noteEvidence("a1" as PatchbayAgentId, "prompt.image", "suspect");
    expect(changed).toEqual(["a1", "a1"]);
  });
});

describe("reducer: usage", () => {
  it("usageReported populates sessionUsage", () => {
    const state = reduceAgentView(initialAgentViewState, {
      kind: "usageReported",
      patchbaySessionId: "s1" as PatchbaySessionId,
      used: 100,
      size: 200,
    });
    expect(state.sessionUsage.s1).toEqual({ used: 100, size: 200, cost: undefined, plan: undefined });
  });

  it("plan readings are sticky per window — parallel axes never clobber each other", () => {
    const opusWarning = { status: "warning" as const, window: "seven_day_opus", utilization: 0.79 };
    let state = reduceAgentView(initialAgentViewState, {
      kind: "usageReported",
      patchbaySessionId: "s1" as PatchbaySessionId,
      used: 100,
      size: 200,
      plan: opusWarning,
    });
    // A plain usage_update (no _meta reading) must not erase anything —
    // agents emit plan info only when it changes.
    state = reduceAgentView(state, { kind: "usageReported", patchbaySessionId: "s1" as PatchbaySessionId, used: 150, size: 200 });
    expect(state.sessionUsage.s1).toMatchObject({ used: 150, plan: { seven_day_opus: opusWarning } });
    // A calm reading for a DIFFERENT window lands beside the warning, not
    // over it (the wire-observed case: five_hour allowed arriving after a
    // seven_day_opus warning).
    const fiveHourOk = { status: "ok" as const, window: "five_hour" };
    state = reduceAgentView(state, { kind: "usageReported", patchbaySessionId: "s1" as PatchbaySessionId, used: 160, size: 200, plan: fiveHourOk });
    expect(state.sessionUsage.s1!.plan).toEqual({ seven_day_opus: opusWarning, five_hour: fiveHourOk });
    // A fresh reading for the SAME window replaces it.
    const opusLimited = { status: "limited" as const, window: "seven_day_opus" };
    state = reduceAgentView(state, { kind: "usageReported", patchbaySessionId: "s1" as PatchbaySessionId, used: 170, size: 200, plan: opusLimited });
    expect(state.sessionUsage.s1!.plan).toEqual({ seven_day_opus: opusLimited, five_hour: fiveHourOk });
  });
});

// Typed terminal login (ACP auth methods, stable in the 1.5.0 schema): the
// wire's `args`/`env` are what the login executor runs, so they are parsed
// at this one boundary — the SDK types them but validates no response.
describe("terminalAuthOf — the executable half of a typed terminal method", () => {
  it("parses args and env; a bare terminal method is legal and runs the agent's own command", () => {
    expect(terminalAuthOf({ id: "t", name: "T", type: "terminal", args: ["login"], env: { A: "1" } })).toEqual({
      args: ["login"],
      env: { A: "1" },
    });
    expect(terminalAuthOf({ id: "t", name: "T", type: "terminal" })).toEqual({ args: [], env: {} });
  });

  it("is null for anything it cannot run — no type, another type, malformed halves, junk", () => {
    expect(terminalAuthOf({ id: "a", name: "A" })).toBeNull();
    expect(terminalAuthOf({ id: "a", name: "A", type: "agent" })).toBeNull();
    expect(terminalAuthOf({ id: "e", name: "E", type: "env_var" })).toBeNull();
    expect(terminalAuthOf({ id: "t", name: "T", type: "terminal", args: "login" })).toBeNull();
    expect(terminalAuthOf({ id: "t", name: "T", type: "terminal", env: ["A"] })).toBeNull();
    expect(terminalAuthOf(null)).toBeNull();
    expect(terminalAuthOf("terminal")).toBeNull();
  });
});

describe("elicitation client claim", () => {
  it("names each presented mode explicitly — ACP reads an absent mode as unsupported", () => {
    expect(clientCapabilitiesWire().elicitation).toEqual({ form: {}, url: {} });
  });
});

describe("auth.terminal client opt-in", () => {
  it("rides initialize — an agent gating its terminal login offers on it sees the claim", () => {
    expect((clientCapabilitiesWire() as { auth?: unknown }).auth).toEqual({ terminal: true });
  });
});
