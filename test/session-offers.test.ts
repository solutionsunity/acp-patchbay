// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What the session menu offers is what its agent declares: Fork where it
// declares session/fork, Delete where it declares session/delete, Close
// where it declares session/close — whatever the capability check found,
// which only informs the matrix — and nothing patchbay stands in for.
import { describe, expect, it } from "vitest";
import { matrixFromDeclared } from "../src/orchestrator/capabilities";
import type { CapabilityMatrix } from "../src/shared/protocol";
import { sessionOffers } from "../src/shared/session-offers";

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

describe("sessionOffers", () => {
  it("an agent not heard from offers nothing", () => {
    expect(sessionOffers(undefined)).toEqual({ fork: false, delete: false, close: false });
  });

  it("fork where the agent declares it — a fork that failed the check is still offered", () => {
    const m = matrix({ sessionFork: true });
    expect(sessionOffers(m).fork).toBe(true);
    expect(sessionOffers({ ...m, "session.fork": { declared: true, used: false, suspect: true } }).fork).toBe(true);
    expect(sessionOffers(matrix({})).fork).toBe(false);
  });

  it("delete where the agent declares it — the check's findings decide nothing", () => {
    const m = matrix({ sessionList: true, sessionDelete: true });
    expect(sessionOffers(m).delete).toBe(true);
    const failedCheck = { ...m, "session.delete": { declared: true, used: false, suspect: true } };
    expect(sessionOffers(failedCheck).delete).toBe(true);
    expect(sessionOffers(matrix({ sessionList: true })).delete).toBe(false);
  });

  it("close where the agent declares it — whether or not it lists its sessions", () => {
    expect(sessionOffers(matrix({ sessionList: true, sessionClose: true })).close).toBe(true);
    expect(sessionOffers(matrix({ sessionClose: true })).close).toBe(true);
    expect(sessionOffers(matrix({ sessionList: true })).close).toBe(false);
    expect(sessionOffers(matrix({})).close).toBe(false);
  });
});
