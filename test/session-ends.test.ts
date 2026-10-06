// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// How a session can end is what its agent declares: Delete where it
// declares session/delete, Close where it declares session/close — whatever
// the capability check found, which only informs the matrix — and nothing
// patchbay stands in for.
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

function matrix(declared: Partial<typeof NOTHING>): CapabilityMatrix {
  return matrixFromDeclared({ ...NOTHING, ...declared });
}

describe("sessionEnds", () => {
  it("an agent not heard from offers no end", () => {
    expect(sessionEnds(undefined)).toEqual({ delete: false, close: false });
  });

  it("delete where the agent declares it — the check's findings decide nothing", () => {
    const m = matrix({ sessionList: true, sessionDelete: true });
    expect(sessionEnds(m).delete).toBe(true);
    const failedCheck = { ...m, "session.delete": { declared: true, used: false, suspect: true } };
    expect(sessionEnds(failedCheck).delete).toBe(true);
    expect(sessionEnds(matrix({ sessionList: true })).delete).toBe(false);
  });

  it("close where the agent declares it — whether or not it lists its sessions", () => {
    expect(sessionEnds(matrix({ sessionList: true, sessionClose: true })).close).toBe(true);
    expect(sessionEnds(matrix({ sessionClose: true })).close).toBe(true);
    expect(sessionEnds(matrix({ sessionList: true })).close).toBe(false);
    expect(sessionEnds(matrix({})).close).toBe(false);
  });
});
