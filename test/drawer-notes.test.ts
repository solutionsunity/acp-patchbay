// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

import { describe, expect, it } from "vitest";
import { matrixFromDeclared } from "../src/orchestrator/capabilities";
import type { AgentSummary, DeclaredCapabilities } from "../src/shared/protocol";
import { unlistedAgents } from "../src/webview/agent-view/drawer-notes";

const DECLARED: DeclaredCapabilities = {
  loadSession: true,
  sessionFork: false,
  sessionResume: false,
  sessionList: false,
  sessionDelete: false,
  sessionClose: false,
  sessionAdditionalDirectories: false,
  promptImage: false,
  promptAudio: false,
  promptEmbeddedContext: false,
  mcpHttp: false,
  mcpSse: false,
  authMethods: [],
  authLogout: false,
};

function agent(id: string, status: AgentSummary["status"] = "running"): AgentSummary {
  return { id, name: id, status, needsAuth: false };
}

describe("sessions drawer — agents whose history cannot be shown", () => {
  it("names each agent with a handshake on record that declared no session/list; a never-connected agent is unknown, not unlisted", () => {
    const capabilities = {
      lists: matrixFromDeclared({ ...DECLARED, sessionList: true }),
      silent: matrixFromDeclared(DECLARED),
      stopped: matrixFromDeclared(DECLARED),
    };
    const agents = [agent("lists"), agent("silent"), agent("stopped", "stopped"), agent("fresh", "untested")];
    expect(unlistedAgents(agents, capabilities).map((a) => a.id)).toEqual(["silent", "stopped"]);
  });
});
