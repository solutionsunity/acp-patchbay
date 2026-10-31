// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The UI gate renders the views from hand-built state (scripts/ui-gate) —
// plain JavaScript the compiler never reads. What that state must hold in
// full is held here against the source: every capability row a matrix
// carries, every preference a snapshot carries.
import { describe, expect, it } from "vitest";
import { CAPABILITY_ROWS, preferences } from "../scripts/ui-gate/fixtures.mjs";
import { DEFAULT_PREFERENCES, type DeclaredCapabilities } from "../src/shared/protocol";
import { matrixFromDeclared } from "../src/orchestrator/capabilities";

/** Nothing declared — typed, so a new declared fact must be named here. */
const nothing: DeclaredCapabilities = {
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

describe("the UI gate's fixtures", () => {
  it("carry every capability row a matrix holds, and every preference", () => {
    expect([...CAPABILITY_ROWS].sort()).toEqual(Object.keys(matrixFromDeclared(nothing)).sort());
    expect(Object.keys(preferences).sort()).toEqual(Object.keys(DEFAULT_PREFERENCES).sort());
  });
});
