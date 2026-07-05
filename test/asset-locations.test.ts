// P10 gate: mapped agents' file sets listed; an unmapped agent renders the
// honest empty state. Pure resolution logic against a fake in-memory
// filesystem — no real vscode.workspace.fs needed to prove the shape.
import { describe, expect, it } from "vitest";
import { resolveAgentAssets, type FsEntry, type FsLike } from "../src/orchestrator/asset-locations";

function fakeFs(tree: Record<string, string[] | null>): FsLike {
  // tree maps an absolute path to either its directory listing (string[]) or
  // null for "this is a file that exists"; an absent key means "doesn't exist".
  return {
    async stat(path) {
      if (!(path in tree)) return null;
      return { isDirectory: tree[path] !== null };
    },
    async readdir(path): Promise<FsEntry[]> {
      const names = tree[path] ?? [];
      return names.map((name) => ({ name, isDirectory: false }));
    },
  };
}

describe("resolveAgentAssets", () => {
  it("an unmapped agent (assets: null) renders unmapped for all three categories", async () => {
    const fs = fakeFs({});
    const view = await resolveAgentAssets(fs, "/ws", "unmapped-agent", null);
    expect(view).toEqual({
      agentId: "unmapped-agent",
      rules: { files: null },
      commands: { files: null },
      skills: { files: null },
    });
  });

  it("a mapped agent lists a single rules file and expands command/skill directories", async () => {
    const fs = fakeFs({
      "/ws/CLAUDE.md": null, // a file
      "/ws/.claude/commands": ["deploy.md", "review.md"],
      "/ws/.claude/skills": ["writer.md"],
    });
    const view = await resolveAgentAssets(fs, "/ws", "claude-code", {
      rules: ["CLAUDE.md"],
      commands: [".claude/commands"],
      skills: [".claude/skills"],
    });
    expect(view.rules.files).toEqual([{ path: "CLAUDE.md" }]);
    expect(view.commands.files).toEqual([
      { path: ".claude/commands/deploy.md" },
      { path: ".claude/commands/review.md" },
    ]);
    expect(view.skills.files).toEqual([{ path: ".claude/skills/writer.md" }]);
  });

  it("a mapped path that doesn't exist in this workspace yields an empty list, not an error", async () => {
    const fs = fakeFs({});
    const view = await resolveAgentAssets(fs, "/ws", "claude-code", {
      rules: ["CLAUDE.md"],
      commands: null,
      skills: [],
    });
    expect(view.rules.files).toEqual([]); // mapped, but nothing on disk here
    expect(view.commands.files).toBeNull(); // this specific category unmapped
    expect(view.skills.files).toEqual([]);
  });
});
