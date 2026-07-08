// Pure-function coverage: capabilityState, computeFidelity, matrixFromDeclared,
// and the reducer's capability handling — the parts of P5 that don't need a
// live agent at all.
import { describe, expect, it } from "vitest";
import { matrixFromDeclared, rowsProvenBy } from "../src/orchestrator/capabilities";
import {
  capabilityState,
  computeFidelity,
  hasUnusedProbe,
  initialAgentViewState,
  reduceAgentView,
  type AgentViewEvent,
  type AuthMethodView,
  type CapabilityMatrix,
  type DeclaredCapabilities,
} from "../src/shared/protocol";

const noDeclared: DeclaredCapabilities = {
  loadSession: false,
  sessionFork: false,
  sessionResume: false,
  sessionList: false,
  sessionClose: false,
  promptImage: false,
  promptAudio: false,
  promptEmbeddedContext: false,
  mcpHttp: false,
  mcpSse: false,
  authMethods: [],
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

  it("elicitation and MCP-level rows are not declared until later phases", () => {
    const matrix = matrixFromDeclared(noDeclared);
    expect(matrix.elicitation).toEqual({ declared: false, used: false });
    expect(matrix["roots.listChanged"]).toEqual({ declared: false, used: false });
    expect(matrix["resources.subscribe"]).toEqual({ declared: false, used: false });
  });

  it("usage and concurrentSessions have no initialize-time claim", () => {
    const matrix = matrixFromDeclared(noDeclared);
    expect(matrix.usage).toEqual({ declared: false, used: false });
    expect(matrix.concurrentSessions).toEqual({ declared: false, used: false });
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
    });

  it("session/new proves auth; concurrentSessions only with a prior session", () => {
    const first = rowsProvenBy({
      via: "agentRequest",
      method: "session/new",
      params: { cwd: "/" },
      priorSessionCount: 0,
    });
    expect(first).toEqual(["auth"]);
    const second = rowsProvenBy({
      via: "agentRequest",
      method: "session/new",
      params: { cwd: "/" },
      priorSessionCount: 1,
    });
    expect(second.sort()).toEqual(["auth", "concurrentSessions"]);
  });

  it("session/fork proves fork and concurrentSessions — the parent already rides the connection", () => {
    const rows = rowsProvenBy({
      via: "agentRequest",
      method: "session/fork",
      params: { sessionId: "s1", cwd: "/" },
      priorSessionCount: 1,
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

describe("computeFidelity", () => {
  const full: CapabilityMatrix = matrixFromDeclared({ ...noDeclared });
  const brokered = (m: CapabilityMatrix, ...rows: Array<keyof CapabilityMatrix>) => {
    const copy = { ...m };
    for (const r of rows) copy[r] = { declared: true, used: true };
    return copy;
  };

  it("fully brokered only when fs.read, fs.write, and terminal are all used", () => {
    const matrix = brokered(full, "fs.readTextFile", "fs.writeTextFile", "terminal");
    expect(computeFidelity(matrix, false)).toBe("fully-brokered");
  });

  it("partially brokered when only a subset is used", () => {
    const matrix = brokered(full, "terminal");
    expect(computeFidelity(matrix, false)).toBe("partially-brokered");
  });

  it("acts outside when none of fs/terminal are used", () => {
    expect(computeFidelity(full, false)).toBe("acts-outside");
  });

  it("a known-bypass bridge always reads acts outside, even fully used", () => {
    const matrix = brokered(full, "fs.readTextFile", "fs.writeTextFile", "terminal");
    expect(computeFidelity(matrix, true)).toBe("acts-outside");
  });
});

describe("hasUnusedProbe — the auto-retry and manual-Verify predicate", () => {
  const agentAuth: readonly AuthMethodView[] = [{ id: "login", name: "Log in", kind: "agent" }];

  it("false when nothing is declared — nothing for the free check to resolve", () => {
    const matrix = matrixFromDeclared(noDeclared);
    expect(hasUnusedProbe(matrix, [])).toBe(false);
  });

  it("true while a declared fork hasn't been used yet", () => {
    const matrix = matrixFromDeclared({ ...noDeclared, sessionFork: true });
    expect(hasUnusedProbe(matrix, [])).toBe(true);
  });

  it("false once the declared fork is used", () => {
    const matrix = matrixFromDeclared({ ...noDeclared, sessionFork: true });
    const used = { ...matrix, "session.fork": { declared: true, used: true } };
    expect(hasUnusedProbe(used, [])).toBe(false);
  });

  it("true while a stable (agent-kind) auth method hasn't been used yet", () => {
    const matrix = matrixFromDeclared({ ...noDeclared, authMethods: agentAuth });
    expect(hasUnusedProbe(matrix, agentAuth)).toBe(true);
  });

  it("env_var/terminal-kind auth methods never gate a retry — not actionable", () => {
    const unstable: readonly AuthMethodView[] = [{ id: "e", name: "Env", kind: "env_var" }];
    const matrix = matrixFromDeclared({ ...noDeclared, authMethods: unstable });
    expect(hasUnusedProbe(matrix, unstable)).toBe(false);
  });
});

describe("reducer: capabilitiesDeclared / capabilityUsed", () => {
  const declared: AgentViewEvent = {
    kind: "capabilitiesDeclared",
    agentId: "a1",
    matrix: matrixFromDeclared({ ...noDeclared, sessionFork: true }),
    authMethods: [],
    at: "2026-01-01T00:00:00.000Z",
  };

  it("stores the fresh matrix and reset timestamp", () => {
    const state = reduceAgentView(initialAgentViewState, declared);
    expect(state.capabilities.a1!["session.fork"]).toEqual({ declared: true, used: false });
    expect(state.capabilitiesResetAt.a1).toBe("2026-01-01T00:00:00.000Z");
  });

  it("capabilityUsed flips a declared row to used", () => {
    let state = reduceAgentView(initialAgentViewState, declared);
    state = reduceAgentView(state, { kind: "capabilityUsed", agentId: "a1", row: "session.fork" });
    expect(state.capabilities.a1!["session.fork"]).toEqual({ declared: true, used: true });
  });

  it("used implies declared even for rows with no initialize-time claim", () => {
    let state = reduceAgentView(initialAgentViewState, declared);
    state = reduceAgentView(state, { kind: "capabilityUsed", agentId: "a1", row: "usage" });
    expect(state.capabilities.a1!.usage).toEqual({ declared: true, used: true });
  });

  it("reconnect (a second capabilitiesDeclared) drops used — replaces, never merges", () => {
    let state = reduceAgentView(initialAgentViewState, declared);
    state = reduceAgentView(state, { kind: "capabilityUsed", agentId: "a1", row: "session.fork" });
    expect(state.capabilities.a1!["session.fork"].used).toBe(true);

    state = reduceAgentView(state, {
      kind: "capabilitiesDeclared",
      agentId: "a1",
      matrix: matrixFromDeclared({ ...noDeclared, sessionFork: true }),
      authMethods: [],
      at: "2026-01-01T01:00:00.000Z",
    });
    expect(state.capabilities.a1!["session.fork"]).toEqual({ declared: true, used: false });
    expect(state.capabilitiesResetAt.a1).toBe("2026-01-01T01:00:00.000Z");
  });

  it("capabilitySuspect flags a declared row — suspicion implies declared, like used does", () => {
    let state = reduceAgentView(initialAgentViewState, declared);
    state = reduceAgentView(state, { kind: "capabilitySuspect", agentId: "a1", row: "prompt.image" });
    expect(state.capabilities.a1!["prompt.image"]).toEqual({
      declared: true,
      used: false,
      suspect: true,
    });
    expect(capabilityState(state.capabilities.a1!["prompt.image"])).toBe("suspect");
  });

  it("suspicion never speaks over proof — suspect on a used row is a no-op", () => {
    let state = reduceAgentView(initialAgentViewState, declared);
    state = reduceAgentView(state, { kind: "capabilityUsed", agentId: "a1", row: "session.fork" });
    state = reduceAgentView(state, { kind: "capabilitySuspect", agentId: "a1", row: "session.fork" });
    expect(state.capabilities.a1!["session.fork"]).toEqual({ declared: true, used: true });
  });

  it("first success acquits — capabilityUsed drops the suspect flag", () => {
    let state = reduceAgentView(initialAgentViewState, declared);
    state = reduceAgentView(state, { kind: "capabilitySuspect", agentId: "a1", row: "prompt.image" });
    state = reduceAgentView(state, { kind: "capabilityUsed", agentId: "a1", row: "prompt.image" });
    expect(state.capabilities.a1!["prompt.image"]).toEqual({ declared: true, used: true });
    expect(capabilityState(state.capabilities.a1!["prompt.image"])).toBe("used");
  });

  it("usageReported populates sessionUsage", () => {
    const state = reduceAgentView(initialAgentViewState, {
      kind: "usageReported",
      sessionId: "s1",
      used: 100,
      size: 200,
    });
    expect(state.sessionUsage.s1).toEqual({ used: 100, size: 200, cost: undefined });
  });
});
