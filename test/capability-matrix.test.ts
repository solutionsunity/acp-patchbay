// Pure-function coverage: capabilityState, computeFidelity, matrixFromDeclared,
// and the reducer's capability handling — the parts of P5 that don't need a
// live agent at all.
import { describe, expect, it } from "vitest";
import { matrixFromDeclared } from "../src/orchestrator/capabilities";
import {
  capabilityState,
  computeFidelity,
  initialAgentViewState,
  reduceAgentView,
  type AgentViewEvent,
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
    expect(capabilityState({ declared: false, verified: false })).toBe("not-declared");
  });
  it("is declared when claimed but unverified", () => {
    expect(capabilityState({ declared: true, verified: false })).toBe("declared");
  });
  it("is verified once exercised", () => {
    expect(capabilityState({ declared: true, verified: true })).toBe("verified");
  });
});

describe("matrixFromDeclared", () => {
  it("always declares fs and terminal — patchbay's own offer, not the agent's", () => {
    const matrix = matrixFromDeclared(noDeclared);
    expect(matrix["fs.readTextFile"]).toEqual({ declared: true, verified: false });
    expect(matrix["fs.writeTextFile"]).toEqual({ declared: true, verified: false });
    expect(matrix.terminal).toEqual({ declared: true, verified: false });
  });

  it("elicitation and MCP-level rows are not declared until later phases", () => {
    const matrix = matrixFromDeclared(noDeclared);
    expect(matrix.elicitation).toEqual({ declared: false, verified: false });
    expect(matrix["roots.listChanged"]).toEqual({ declared: false, verified: false });
    expect(matrix["resources.subscribe"]).toEqual({ declared: false, verified: false });
  });

  it("usage and concurrentSessions have no initialize-time claim", () => {
    const matrix = matrixFromDeclared(noDeclared);
    expect(matrix.usage).toEqual({ declared: false, verified: false });
    expect(matrix.concurrentSessions).toEqual({ declared: false, verified: false });
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

  it("every cell starts unverified — verification is a separate, later event", () => {
    const matrix = matrixFromDeclared({ ...noDeclared, sessionFork: true, loadSession: true });
    for (const cell of Object.values(matrix)) expect(cell.verified).toBe(false);
  });
});

describe("computeFidelity", () => {
  const full: CapabilityMatrix = matrixFromDeclared({ ...noDeclared });
  const brokered = (m: CapabilityMatrix, ...rows: Array<keyof CapabilityMatrix>) => {
    const copy = { ...m };
    for (const r of rows) copy[r] = { declared: true, verified: true };
    return copy;
  };

  it("fully brokered only when fs.read, fs.write, and terminal are all verified", () => {
    const matrix = brokered(full, "fs.readTextFile", "fs.writeTextFile", "terminal");
    expect(computeFidelity(matrix, false)).toBe("fully-brokered");
  });

  it("partially brokered when only a subset verifies", () => {
    const matrix = brokered(full, "terminal");
    expect(computeFidelity(matrix, false)).toBe("partially-brokered");
  });

  it("acts outside when none of fs/terminal verify", () => {
    expect(computeFidelity(full, false)).toBe("acts-outside");
  });

  it("a known-bypass bridge always reads acts outside, even fully verified", () => {
    const matrix = brokered(full, "fs.readTextFile", "fs.writeTextFile", "terminal");
    expect(computeFidelity(matrix, true)).toBe("acts-outside");
  });
});

describe("reducer: capabilitiesDeclared / capabilityVerified", () => {
  const declared: AgentViewEvent = {
    kind: "capabilitiesDeclared",
    agentId: "a1",
    matrix: matrixFromDeclared({ ...noDeclared, sessionFork: true }),
    at: "2026-01-01T00:00:00.000Z",
  };

  it("stores the fresh matrix and reset timestamp", () => {
    const state = reduceAgentView(initialAgentViewState, declared);
    expect(state.capabilities.a1!["session.fork"]).toEqual({ declared: true, verified: false });
    expect(state.capabilitiesResetAt.a1).toBe("2026-01-01T00:00:00.000Z");
  });

  it("capabilityVerified flips a declared row to verified", () => {
    let state = reduceAgentView(initialAgentViewState, declared);
    state = reduceAgentView(state, { kind: "capabilityVerified", agentId: "a1", row: "session.fork" });
    expect(state.capabilities.a1!["session.fork"]).toEqual({ declared: true, verified: true });
  });

  it("verified implies declared even for rows with no initialize-time claim", () => {
    let state = reduceAgentView(initialAgentViewState, declared);
    state = reduceAgentView(state, { kind: "capabilityVerified", agentId: "a1", row: "usage" });
    expect(state.capabilities.a1!.usage).toEqual({ declared: true, verified: true });
  });

  it("reconnect (a second capabilitiesDeclared) drops verified — replaces, never merges", () => {
    let state = reduceAgentView(initialAgentViewState, declared);
    state = reduceAgentView(state, { kind: "capabilityVerified", agentId: "a1", row: "session.fork" });
    expect(state.capabilities.a1!["session.fork"].verified).toBe(true);

    state = reduceAgentView(state, {
      kind: "capabilitiesDeclared",
      agentId: "a1",
      matrix: matrixFromDeclared({ ...noDeclared, sessionFork: true }),
      at: "2026-01-01T01:00:00.000Z",
    });
    expect(state.capabilities.a1!["session.fork"]).toEqual({ declared: true, verified: false });
    expect(state.capabilitiesResetAt.a1).toBe("2026-01-01T01:00:00.000Z");
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
