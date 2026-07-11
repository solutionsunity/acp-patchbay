// Roster overlay is shipped data — validated, with v1 asset mappings exactly
// as documented: Claude Code and Augment mapped, everything else honestly
// not. mergeRoster is the registry × overlay join — tested against a fixture
// registry payload (network-free, same fixture philosophy as the fake agent).
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeRoster, loadOverlay } from "../src/orchestrator/stores/roster";
import { fetchIcons, type RegistryAgent } from "../src/orchestrator/stores/acp-registry";

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
    expect(auggie.assets?.skills).toContain(".augment/skills");
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

  it("registry icons ride the roster by registryId; everything else is honestly icon-less", () => {
    const merged = mergeRoster(loadOverlay(), [registryAgent()], {
      "claude-acp": "data:image/svg+xml;base64,QQ==",
    });
    // keyed by the registry's id even where the overlay renames to our own
    expect(merged.find((a) => a.id === "claude-code")!.icon).toBe("data:image/svg+xml;base64,QQ==");
    expect(merged.find((a) => a.id === "kiro")!.icon).toBeNull(); // local-only
  });
});

// fetchIcons is the one icon pass: version-keyed reuse (an unchanged agent
// version never refetches), stale-beats-none on failure (branding, not
// truth), size/type refusal. Network stubbed — same fixture philosophy.
describe("fetchIcons", () => {
  const iconAgent = (id: string, version: string): RegistryAgent =>
    registryAgent({ id, version, icon: `https://cdn.example/${id}.svg` });
  const svgResponse = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "image/svg+xml" } });

  afterEach(() => vi.unstubAllGlobals());

  it("fetches, encodes, and version-keys a new icon", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => svgResponse("<svg/>")));
    const out = await fetchIcons([iconAgent("a1", "1.0.0")], {});
    expect(out.a1).toEqual({
      version: "1.0.0",
      dataUri: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
    });
  });

  it("an unchanged version reuses the cache without a request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const prior = { a1: { version: "1.0.0", dataUri: "data:image/svg+xml;base64,QQ==" } };
    const out = await fetchIcons([iconAgent("a1", "1.0.0")], prior);
    expect(out.a1).toBe(prior.a1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a failed refetch keeps the stale icon; a failed first fetch stays absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const prior = { a1: { version: "1.0.0", dataUri: "data:image/svg+xml;base64,QQ==" } };
    const out = await fetchIcons([iconAgent("a1", "2.0.0"), iconAgent("a2", "1.0.0")], prior);
    expect(out.a1).toBe(prior.a1); // stale beats none
    expect(out.a2).toBeUndefined();
  });

  it("refuses an oversized body and a dropped agent falls out of the cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => svgResponse("x".repeat(129 * 1024))));
    const prior = { gone: { version: "1.0.0", dataUri: "data:image/svg+xml;base64,QQ==" } };
    const out = await fetchIcons([iconAgent("big", "1.0.0")], prior);
    expect(out.big).toBeUndefined();
    expect(out.gone).toBeUndefined();
  });
});
