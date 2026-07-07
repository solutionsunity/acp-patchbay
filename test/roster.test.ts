// Roster overlay is shipped data — validated, with v1 asset mappings exactly
// as documented: Claude Code and Augment mapped, everything else honestly
// not. mergeRoster is the registry × overlay join — tested against a fixture
// registry payload (network-free, same fixture philosophy as the fake agent).
import { describe, expect, it } from "vitest";
import { mergeRoster, loadOverlay } from "../src/orchestrator/stores/roster";
import type { RegistryAgent } from "../src/orchestrator/stores/acp-registry";

describe("roster overlay data", () => {
  const overlay = loadOverlay();

  it("parses and covers the pre-registry roster's ids", () => {
    const ids = overlay.map((a) => a.id);
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
    const mapped = overlay.filter((a) => a.assets !== null).map((a) => a.id);
    expect(mapped.sort()).toEqual(["auggie", "claude-code"]);

    const claude = overlay.find((a) => a.id === "claude-code")!;
    expect(claude.assets?.rules).toContain("CLAUDE.md");
    expect(claude.assets?.commands).toContain(".claude/commands");
    expect(claude.assets?.skills).toContain(".claude/skills");

    const auggie = overlay.find((a) => a.id === "auggie")!;
    expect(auggie.assets?.rules).toContain(".augment/rules");
    expect(auggie.assets?.skills).toBeNull();
  });

  it("records observed _meta conventions for claude and codex", () => {
    const claude = overlay.find((a) => a.id === "claude-code")!;
    expect(claude.metaExtensions).toContain("_claude/sdkMessage");
    const codex = overlay.find((a) => a.id === "codex")!;
    expect(codex.metaExtensions.some((m) => m.includes("terminal-output"))).toBe(true);
  });

  it("local-only entries (not in the official registry) carry their own launch command", () => {
    const kiro = overlay.find((a) => a.id === "kiro")!;
    expect(kiro.registryId).toBeUndefined();
    expect(kiro.local?.command).toBe("kiro-cli");
  });

  it("registry-backed entries carry no launch command of their own — resolved live instead", () => {
    const claude = overlay.find((a) => a.id === "claude-code")!;
    expect(claude.registryId).toBe("claude-acp");
    expect(claude.local).toBeUndefined();
  });
});

function registryAgent(overrides: Partial<RegistryAgent> = {}): RegistryAgent {
  return {
    id: "claude-acp",
    name: "Claude Agent",
    version: "0.56.0",
    description: "ACP wrapper for Anthropic's Claude",
    authors: [],
    license: "proprietary",
    distribution: { npx: { package: "@agentclientprotocol/claude-agent-acp@0.56.0", args: [], env: {} } },
    ...overrides,
  };
}

describe("mergeRoster", () => {
  it("resolves a registry-backed overlay entry to its npx distribution, keeping our own id", () => {
    const merged = mergeRoster(loadOverlay(), [registryAgent()]);
    const claude = merged.find((a) => a.id === "claude-code")!;
    expect(claude.name).toBe("Claude Agent");
    expect(claude.launch).toMatchObject({ kind: "npx", command: "npx", registryId: "claude-acp", version: "0.56.0" });
    expect(claude.assets?.rules).toContain("CLAUDE.md"); // overlay knowledge survives the merge
  });

  it("a registry agent we haven't curated gets its own registry id and empty overlay knowledge", () => {
    const merged = mergeRoster(loadOverlay(), [registryAgent({ id: "brand-new-agent", name: "Brand New" })]);
    const entry = merged.find((a) => a.id === "brand-new-agent")!;
    expect(entry.name).toBe("Brand New");
    expect(entry.assets).toBeNull();
    expect(entry.knownBypassBridge).toBe(false);
  });

  it("no usable distribution for this platform shows unavailable, never guessed", () => {
    const merged = mergeRoster(loadOverlay(), [registryAgent({ distribution: {} })]);
    const claude = merged.find((a) => a.id === "claude-code")!;
    expect(claude.launch.kind).toBe("unavailable");
  });

  it("an overlay entry whose registryId the registry snapshot doesn't have is still listed, honestly unavailable", () => {
    const merged = mergeRoster(loadOverlay(), []); // empty snapshot — cold start / offline
    const claude = merged.find((a) => a.id === "claude-code")!;
    expect(claude.launch).toMatchObject({ kind: "unavailable", reason: "registry not loaded yet" });
  });

  it("local-only entries (kiro, hermes, openclaw) always resolve regardless of registry data", () => {
    const merged = mergeRoster(loadOverlay(), []);
    const kiro = merged.find((a) => a.id === "kiro")!;
    expect(kiro.launch).toMatchObject({ kind: "local", command: "kiro-cli" });
  });
});
