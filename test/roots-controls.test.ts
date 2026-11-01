// The roots chip's delivery verdict (composer/roots-controls.ts) — the
// roots sibling of composer-controls.ts: every reachable state of the
// three declared facts and the session's turn count, named. Adding is
// never gated (the session's MCP servers take a root regardless); what the
// gate states is whether and when the *agent* gets it, from the same facts
// the sessions store's re-apply reads. This pins that the chip tells the
// same truth the writer holds.
import { describe, expect, it } from "vitest";
import { rootHolders, rootSaving, rootsControls } from "../src/webview/agent-view/composer/roots-controls";
import type { WorkspaceId } from "../src/shared/workspace";

describe("rootsControls", () => {
  it("not advertised: the agent never gets a root, the servers do — the note points at @", () => {
    for (const hasTurns of [false, true]) {
      const c = rootsControls({ advertised: false, resumeDeclared: true, loadDeclared: true, hasTurns });
      expect(c.agent).toBe("never");
      expect(c.note).toContain("MCP servers have them");
      expect(c.note).toContain("@");
    }
  });

  it("advertised, no turns yet: live (recreation) whatever the rungs — no note", () => {
    for (const resumeDeclared of [false, true]) {
      for (const loadDeclared of [false, true]) {
        expect(rootsControls({ advertised: true, resumeDeclared, loadDeclared, hasTurns: false })).toEqual({
          agent: "live",
          note: null,
        });
      }
    }
  });

  it("advertised, after a turn: live with session/resume; without it, the next open if load exists, else never", () => {
    expect(rootsControls({ advertised: true, resumeDeclared: true, loadDeclared: false, hasTurns: true })).toEqual({
      agent: "live",
      note: null,
    });
    const nextOpen = rootsControls({ advertised: true, resumeDeclared: false, loadDeclared: true, hasTurns: true });
    expect(nextOpen.agent).toBe("nextOpen");
    expect(nextOpen.note).toContain("next open");
    const never = rootsControls({ advertised: true, resumeDeclared: false, loadDeclared: false, hasTurns: true });
    expect(never.agent).toBe("never");
    expect(never.note).toContain("after the first prompt");
  });

  it("row label: the cwd is always the agent's; every other row names who holds it", () => {
    for (const agent of ["live", "nextOpen", "never"] as const) {
      expect(rootHolders(agent, true)).toBe("agent + MCP");
    }
    expect(rootHolders("live", false)).toBe("agent + MCP");
    expect(rootHolders("nextOpen", false)).toBe("MCP · agent at next open");
    expect(rootHolders("never", false)).toBe("MCP only");
  });
});

// Saved roots (#32, #70): a user-added row saved for this workspace names
// where it is saved — managed in Settings, no control here — or offers the
// save; "this workspace" exists only where one is open, and saving a folder
// saved only elsewhere adds this workspace.
describe("rootSaving", () => {
  const HERE = "file:///ws/here" as WorkspaceId;
  const OTHER = "file:///ws/other" as WorkspaceId;
  const saved = {
    entries: [
      { path: "/src/lib", workspaces: [HERE] },
      { path: "/src/odoo", workspaces: "auto" as const },
      { path: "/src/two", workspaces: [HERE, OTHER] },
      { path: "/src/not-here", workspaces: { except: [HERE] } },
      { path: "/src/there", workspaces: [OTHER] },
    ],
    missing: [],
  };

  it("a root saved for this workspace says where it is saved", () => {
    expect(rootSaving("/src/lib", saved, HERE)).toEqual({ kind: "saved", label: "saved · this workspace" });
    expect(rootSaving("/src/odoo", saved, HERE)).toEqual({ kind: "saved", label: "saved · every workspace" });
    expect(rootSaving("/src/two", saved, HERE)).toEqual({ kind: "saved", label: "saved · this and 1 other workspace" });
  });

  it("an unsaved root offers the save — as does one saved only elsewhere; this workspace only where one is open", () => {
    expect(rootSaving("/elsewhere", saved, HERE)).toEqual({ kind: "unsaved", workspaceOpen: true });
    expect(rootSaving("/src/not-here", saved, HERE)).toEqual({ kind: "unsaved", workspaceOpen: true });
    expect(rootSaving("/src/there", saved, HERE)).toEqual({ kind: "unsaved", workspaceOpen: true });
    expect(rootSaving("/elsewhere", saved, null)).toEqual({ kind: "unsaved", workspaceOpen: false });
    expect(rootSaving("/src/odoo", saved, null)).toEqual({ kind: "saved", label: "saved · every workspace" });
    expect(rootSaving("/src/not-here", saved, null)).toEqual({ kind: "saved", label: "saved · every workspace but 1 other" });
  });
});
