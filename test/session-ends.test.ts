// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// How a session can end is what its agent offers: Delete where the agent
// proved session/delete, Close where nothing lists sessions again — and
// nothing patchbay stands in for.
import { describe, expect, it } from "vitest";
import { matrixFromDeclared } from "../src/orchestrator/capabilities";
import type { CapabilityMatrix } from "../src/shared/protocol";
import { sessionEnds } from "../src/shared/session-ends";

const NOTHING = {
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

function matrix(declared: Partial<typeof NOTHING>, deleteUsed = false): CapabilityMatrix {
  const m = matrixFromDeclared({ ...NOTHING, ...declared });
  return { ...m, "session.delete": { ...m["session.delete"], used: deleteUsed } };
}

describe("sessionEnds", () => {
  it("an agent not heard from offers no end", () => {
    expect(sessionEnds(undefined)).toEqual({ delete: false, close: false });
  });

  it("delete only once the agent proved it — declared is a claim", () => {
    expect(sessionEnds(matrix({ sessionList: true, sessionDelete: true })).delete).toBe(false);
    expect(sessionEnds(matrix({ sessionList: true, sessionDelete: true }, true)).delete).toBe(true);
  });

  it("close only where the agent lists no sessions — a listed one would come straight back", () => {
    expect(sessionEnds(matrix({ sessionList: true, sessionClose: true })).close).toBe(false);
    expect(sessionEnds(matrix({ sessionClose: true })).close).toBe(true);
    expect(sessionEnds(matrix({})).close).toBe(true);
  });

  it("an agent that lists its sessions but can't delete them offers neither", () => {
    expect(sessionEnds(matrix({ sessionList: true, sessionClose: true, loadSession: true }))).toEqual({
      delete: false,
      close: false,
    });
  });
});
