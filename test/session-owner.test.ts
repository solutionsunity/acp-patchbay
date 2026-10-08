// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Whose session an agent names: one reading of an id against every holder,
// shared by a session's updates, its permission requests and its questions.
import { describe, expect, it } from "vitest";
import { sessionOwner, type SessionHolders } from "../src/orchestrator/session-owner";
import type { PatchbayAgentId, PatchbaySessionId } from "../src/shared/ids";

const A1 = "a1" as PatchbayAgentId;
const A2 = "a2" as PatchbayAgentId;

/** Agent a1 holds a probe "p", an editing session "d", and the user's "u". */
const holders: SessionHolders = {
  probe: { isProbeSession: (agent, id) => agent === A1 && id === "p" },
  defaultsEditor: { owns: (agent, id) => agent === A1 && id === "d" },
  sessions: { rowFor: (agent, id) => (agent === A1 && id === "u" ? ("row-u" as PatchbaySessionId) : undefined) },
};

describe("sessionOwner — whose session an agent names", () => {
  it("reads an id against each holder", () => {
    expect(sessionOwner(holders, A1, "p")).toEqual({ kind: "probe" });
    expect(sessionOwner(holders, A1, "d")).toEqual({ kind: "defaultsEditor" });
    expect(sessionOwner(holders, A1, "u")).toEqual({ kind: "user", patchbaySessionId: "row-u" });
    expect(sessionOwner(holders, A1, "gone")).toEqual({ kind: "none" });
  });

  it("is agent-scoped: another agent's same id is not this agent's session", () => {
    expect(sessionOwner(holders, A2, "p")).toEqual({ kind: "none" });
    expect(sessionOwner(holders, A2, "u")).toEqual({ kind: "none" });
  });

  it("a throwaway session is never the user's, even if a row claims the id", () => {
    const claimed: SessionHolders = { ...holders, sessions: { rowFor: () => "row-x" as PatchbaySessionId } };
    expect(sessionOwner(claimed, A1, "p")).toEqual({ kind: "probe" });
    expect(sessionOwner(claimed, A1, "d")).toEqual({ kind: "defaultsEditor" });
  });
});
