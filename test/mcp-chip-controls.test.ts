// The MCP chip's rows (mcp-chip-controls.ts): what the session's last open
// gave, what the next one changes, and what the Save and Add menus offer.
import { describe, expect, it } from "vitest";
import { mcpChipControls } from "../src/webview/agent-view/composer/mcp-chip-controls";
import type { PatchbayMcpServerId } from "../src/shared/ids";
import type { WorkspaceId } from "../src/shared/workspace";

const HERE = "file:///ws/here" as WorkspaceId;
const id = (s: string) => s as PatchbayMcpServerId;
const servers = [
  { id: id("files"), name: "files", workspaces: [HERE] },
  { id: id("deploy"), name: "deploy", workspaces: [] },
  { id: id("docs"), name: "docs", workspaces: "auto" as const },
  { id: id("spare"), name: "spare", workspaces: [] },
];

describe("mcpChipControls", () => {
  it("names what the last open gave — built in, saved where — and offers the rest", () => {
    const c = mcpChipControls({ mcp: { given: [id("patchbay:editor"), id("files"), id("docs")], added: [] }, servers, here: HERE, canReopen: true });
    expect(c.rows.map((r) => [r.name, r.label, r.own, r.next])).toEqual([
      ["patchbay", "built-in", false, null],
      ["files", "saved · this workspace", false, null],
      ["docs", "saved · every workspace", false, null],
    ]);
    expect(c.addable.map((s) => s.name)).toEqual(["deploy", "spare"]);
    expect(c.note).toBeNull();
  });

  it("a server added for this session waits for the next open, which the note offers where the agent can reopen", () => {
    const facts = { mcp: { given: [id("patchbay:editor")], added: [id("deploy")] }, servers, here: HERE };
    const c = mcpChipControls({ ...facts, canReopen: true });
    expect(c.rows.at(-1)).toMatchObject({ name: "deploy", label: "this session · at next open", own: true, next: "add", save: { kind: "unsaved", workspaceOpen: true } });
    expect(c.addable.map((s) => s.name)).toEqual(["files", "docs", "spare"]);
    expect([c.note, c.reopen]).toEqual([expect.stringMatching(/next open/), true]);
    const stuck = mcpChipControls({ ...facts, canReopen: false });
    expect([stuck.note, stuck.reopen]).toEqual([expect.stringMatching(/can't reopen this one — a new session gets them/), false]);
  });

  it("given and its own: this session's; saved for this workspace once Save made it so", () => {
    const own = mcpChipControls({ mcp: { given: [id("deploy")], added: [id("deploy")] }, servers, here: HERE, canReopen: true });
    expect(own.rows[0]).toMatchObject({ label: "this session", own: true, next: null, save: { kind: "unsaved" } });
    const saved = mcpChipControls({
      mcp: { given: [id("deploy")], added: [id("deploy")] },
      servers: servers.map((s) => (s.id === "deploy" ? { ...s, workspaces: [HERE] } : s)),
      here: HERE,
      canReopen: true,
    });
    expect(saved.rows[0]?.save).toEqual({ kind: "saved" });
  });

  it("taken back, a server stays until the next open; one removed from Settings since is gone", () => {
    const c = mcpChipControls({ mcp: { given: [id("deploy"), id("removed")], added: [] }, servers, here: HERE, canReopen: true });
    expect(c.rows.map((r) => [r.name, r.label, r.next])).toEqual([["deploy", "until next open", "remove"]]);
    expect(c.note).toMatch(/next open/);
  });

  it("before its first open here, a session shows its own servers waiting; with no workspace, Save for this workspace is not offered", () => {
    const c = mcpChipControls({ mcp: { given: null, added: [id("deploy")] }, servers, here: null, canReopen: false });
    expect(c.rows).toEqual([expect.objectContaining({ name: "deploy", next: "add", save: { kind: "unsaved", workspaceOpen: false } })]);
    expect(mcpChipControls({ mcp: undefined, servers, here: HERE, canReopen: true })).toMatchObject({ rows: [], note: null });
  });
});
