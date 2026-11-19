// The MCP chip's rows (mcp-chip-controls.ts): what the session's last open
// gave, what the next one changes, and what the Save and Add menus offer.
import { describe, expect, it } from "vitest";
import { failureSaid, mcpChipControls } from "../src/webview/agent-view/composer/mcp-chip-controls";
import type { PatchbayMcpServerId } from "../src/shared/ids";
import type { WorkspaceId } from "../src/shared/workspace";

const HERE = "file:///ws/here" as WorkspaceId;
const id = (s: string) => s as PatchbayMcpServerId;
/** A session's servers as its last open gave them, none through the bridge
 * and none failing unless a case says so. */
const mcp = (given: PatchbayMcpServerId[] | null, added: PatchbayMcpServerId[], bridged: PatchbayMcpServerId[] = [], failing: Record<string, { at: string; reason: string }> = {}) => ({
  given,
  added,
  bridged,
  failing,
});
const servers = [
  { id: id("files"), name: "files", workspaces: [HERE] },
  { id: id("deploy"), name: "deploy", workspaces: [] },
  { id: id("docs"), name: "docs", workspaces: "auto" as const },
  { id: id("spare"), name: "spare", workspaces: [] },
];

describe("mcpChipControls", () => {
  it("names what the last open gave — built in, saved where — and offers the rest", () => {
    const c = mcpChipControls({ mcp: mcp([id("patchbay:editor"), id("files"), id("docs")], []), servers, here: HERE, canReopen: true });
    expect(c.rows.map((r) => [r.name, r.label, r.own, r.next])).toEqual([
      ["patchbay", "built-in", false, null],
      ["files", "saved · this workspace", false, null],
      ["docs", "saved · every workspace", false, null],
    ]);
    expect(c.addable.map((s) => s.name)).toEqual(["deploy", "spare"]);
    expect(c.note).toBeNull();
  });

  it("a server added for this session waits for the next open, which the note offers where the agent can reopen", () => {
    const facts = { mcp: mcp([id("patchbay:editor")], [id("deploy")]), servers, here: HERE };
    const c = mcpChipControls({ ...facts, canReopen: true });
    expect(c.rows.at(-1)).toMatchObject({ name: "deploy", label: "this session · at next open", own: true, next: "add", save: { kind: "unsaved", workspaceOpen: true } });
    expect(c.addable.map((s) => s.name)).toEqual(["files", "docs", "spare"]);
    expect([c.note, c.reopen]).toEqual([expect.stringMatching(/next open/), true]);
    const stuck = mcpChipControls({ ...facts, canReopen: false });
    expect([stuck.note, stuck.reopen]).toEqual([expect.stringMatching(/can't reopen this one — a new session gets them/), false]);
  });

  it("given and its own: this session's; saved for this workspace once Save made it so", () => {
    const own = mcpChipControls({ mcp: mcp([id("deploy")], [id("deploy")]), servers, here: HERE, canReopen: true });
    expect(own.rows[0]).toMatchObject({ label: "this session", own: true, next: null, save: { kind: "unsaved" } });
    const saved = mcpChipControls({
      mcp: mcp([id("deploy")], [id("deploy")]),
      servers: servers.map((s) => (s.id === "deploy" ? { ...s, workspaces: [HERE] } : s)),
      here: HERE,
      canReopen: true,
    });
    expect(saved.rows[0]?.save).toEqual({ kind: "saved" });
  });

  it("taken back, a server stays until the next open; one removed from Settings since is gone", () => {
    const c = mcpChipControls({ mcp: mcp([id("deploy"), id("removed")], []), servers, here: HERE, canReopen: true });
    expect(c.rows.map((r) => [r.name, r.label, r.next])).toEqual([["deploy", "until next open", "remove"]]);
    expect(c.note).toMatch(/next open/);
  });

  it("before its first open here, a session shows its own servers waiting; with no workspace, Save for this workspace is not offered", () => {
    const c = mcpChipControls({ mcp: mcp(null, [id("deploy")]), servers, here: null, canReopen: false });
    expect(c.rows).toEqual([expect.objectContaining({ name: "deploy", next: "add", save: { kind: "unsaved", workspaceOpen: false } })]);
    expect(mcpChipControls({ mcp: undefined, servers, here: HERE, canReopen: true })).toMatchObject({ rows: [], note: null });
  });

  it("a server failing for this session says so; patchbay's own last check says so where the session knows nothing nearer (#175)", () => {
    const at = "2026-11-19T10:00:00.000Z";
    const checked = servers.map((s) => (s.id === "docs" || s.id === "files" ? { ...s, unreachable: { at, reason: "ECONNREFUSED" } } : s));
    const c = mcpChipControls({
      mcp: mcp([id("patchbay:editor"), id("files"), id("docs"), id("deploy")], [id("deploy")], [id("files"), id("docs")], { files: { at, reason: "bridge: HTTP 401" } }),
      servers: checked,
      here: HERE,
      canReopen: true,
    });
    expect(c.rows.map((r) => [r.name, r.failure?.seen ?? null, r.failure?.reason ?? null])).toEqual([
      ["patchbay", null, null],
      ["files", "session", "bridge: HTTP 401"],
      ["docs", "check", "ECONNREFUSED"],
      ["deploy", null, null],
    ]);
    expect(failureSaid(c.rows[1]!.failure!)).toBe("failing for this session: bridge: HTTP 401");
    expect(failureSaid(c.rows[2]!.failure!)).toBe("unreachable at Patchbay's last check: ECONNREFUSED");
  });

  it("a server the agent connects to itself is marked unseen — no failure there is no claim that it works", () => {
    const c = mcpChipControls({ mcp: mcp([id("patchbay:editor"), id("files"), id("docs")], [id("deploy")], [id("files")]), servers, here: HERE, canReopen: true });
    expect(c.rows.map((r) => [r.name, r.unseen])).toEqual([
      ["patchbay", false], // patchbay's own
      ["files", false], // through the bridge: its traffic is seen
      ["docs", true], // the agent's own connection
      ["deploy", false], // not given yet
    ]);
    // a failure said by the session of a server not given to it is nobody's: only the check's stands
    const stale = mcpChipControls({ mcp: mcp([id("patchbay:editor")], [id("deploy")], [], { deploy: { at: "t", reason: "old" } }), servers, here: HERE, canReopen: true });
    expect(stale.rows.at(-1)?.failure).toBeNull();
  });
});
