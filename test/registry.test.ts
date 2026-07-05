// Registry data validates at the trust boundary (architecture.md §
// Integrations — "the registry is shipped data from day one"). The GitHub
// entry's clientId/url are deliberately empty pending the P9 owner
// touchpoint (creating the OAuth App) — isConnectable() must say so honestly.
import { describe, expect, it } from "vitest";
import { isConnectable, loadRegistry } from "../src/orchestrator/stores/registry";

describe("registry", () => {
  it("loads and validates the shipped data/registry.json", () => {
    const entries = loadRegistry();
    expect(entries.length).toBeGreaterThan(0);
    const github = entries.find((e) => e.id === "github");
    expect(github).toBeDefined();
    expect(github!.transport).toBe("http");
    expect(github!.auth.type).toBe("oauth-device");
    expect(github!.auth.scopes.length).toBeGreaterThan(0);
    // GitHub's own stable, public Device Flow endpoints — same for every OAuth App
    expect(github!.auth.deviceCodeUrl).toBe("https://github.com/login/device/code");
    expect(github!.auth.tokenUrl).toBe("https://github.com/login/oauth/access_token");
  });

  it("the GitHub entry is not connectable until the owner touchpoint fills in clientId/url", () => {
    const github = loadRegistry().find((e) => e.id === "github")!;
    expect(github.auth.clientId).toBe("");
    expect(github.url).toBe("");
    expect(isConnectable(github)).toBe(false);
  });

  it("a hypothetical fully-configured entry is connectable", () => {
    const entries = loadRegistry();
    const fake = { ...entries[0]!, url: "https://example.test/mcp", auth: { ...entries[0]!.auth, clientId: "abc" } };
    expect(isConnectable(fake)).toBe(true);
  });
});
