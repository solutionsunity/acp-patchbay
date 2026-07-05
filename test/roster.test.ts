// Roster is shipped data — validated, with v1 asset mappings exactly as
// documented: Claude Code and Augment mapped, everything else honestly not.
import { describe, expect, it } from "vitest";
import { loadRoster } from "../src/orchestrator/stores/roster";

describe("roster data", () => {
  const roster = loadRoster();

  it("parses and covers the vscode-acp roster", () => {
    const ids = roster.map((a) => a.id);
    for (const id of [
      "claude-code",
      "copilot",
      "gemini",
      "qwen",
      "auggie",
      "qoder",
      "codex",
      "opencode",
      "openclaw",
      "kiro",
      "hermes",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("maps rules/skills/commands locations for Claude Code and Augment only", () => {
    const mapped = roster.filter((a) => a.assets !== null).map((a) => a.id);
    expect(mapped.sort()).toEqual(["auggie", "claude-code"]);

    const claude = roster.find((a) => a.id === "claude-code")!;
    expect(claude.assets?.rules).toContain("CLAUDE.md");
    expect(claude.assets?.commands).toContain(".claude/commands");
    expect(claude.assets?.skills).toContain(".claude/skills");

    const auggie = roster.find((a) => a.id === "auggie")!;
    expect(auggie.assets?.rules).toContain(".augment/rules");
    expect(auggie.assets?.skills).toBeNull();
  });

  it("records observed _meta conventions for claude and codex", () => {
    const claude = roster.find((a) => a.id === "claude-code")!;
    expect(claude.metaExtensions).toContain("_claude/sdkMessage");
    const codex = roster.find((a) => a.id === "codex")!;
    expect(codex.metaExtensions.some((m) => m.includes("terminal-output"))).toBe(true);
  });
});
