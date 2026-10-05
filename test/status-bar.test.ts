// P11 gate: status bar reflects active session, agent health, and usage
// when reported — pure formatting logic, no real extension host needed.
import { describe, expect, it } from "vitest";
import { initialAgentViewState, type AgentViewState } from "../src/shared/protocol";
import { statusBarContent } from "../src/orchestrator/status-bar";
import type { PatchbayAgentId } from "../src/shared/ids";

function state(overrides: Partial<AgentViewState>): AgentViewState {
  return { ...initialAgentViewState, ...overrides };
}

describe("statusBarContent", () => {
  it("no active session — the honest idle state, not a stale label", () => {
    const content = statusBarContent(state({}));
    expect(content.text).toBe("$(plug) Patchbay");
  });

  it("shows the active session's title under the Patchbay mark — running adds no glyph", () => {
    const content = statusBarContent(
      state({
        sessions: [{ id: "s1", patchbayAgentId: "a1" as PatchbayAgentId, title: "Fix the bug", busy: [], updatedAt: "2026-07-09T00:00:00Z" }],
        activeSessionId: "s1",
        agents: [{ id: "a1" as PatchbayAgentId, name: "Claude Code", status: "running", needsAuth: false, authMethods: [], busy: [] }],
      }),
    );
    expect(content.text).toBe("$(plug) Fix the bug");
    expect(content.tooltip).toBe("Claude Code — running");
  });

  it("a crashed agent shows an error glyph, not the running one", () => {
    const content = statusBarContent(
      state({
        sessions: [{ id: "s1", patchbayAgentId: "a1" as PatchbayAgentId, title: "T", busy: [], updatedAt: "2026-07-09T00:00:00Z" }],
        activeSessionId: "s1",
        agents: [{ id: "a1" as PatchbayAgentId, name: "Claude Code", status: "crashed", needsAuth: false, authMethods: [], busy: [] }],
      }),
    );
    expect(content.text).toBe("$(plug) $(error) T");
  });

  it("appends usage only once reported — absent, never a fake 0%", () => {
    const base = state({
      sessions: [{ id: "s1", patchbayAgentId: "a1" as PatchbayAgentId, title: "T", busy: [], updatedAt: "2026-07-09T00:00:00Z" }],
      activeSessionId: "s1",
      agents: [{ id: "a1" as PatchbayAgentId, name: "Claude Code", status: "running", needsAuth: false, authMethods: [], busy: [] }],
    });
    expect(statusBarContent(base).text).toBe("$(plug) T");

    const withUsage = state({ ...base, sessionUsage: { s1: { used: 50, size: 200 } } });
    expect(statusBarContent(withUsage).text).toBe("$(plug) T · 25%");
  });
});
