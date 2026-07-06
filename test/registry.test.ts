// Registry data validates at the trust boundary (architecture.md §
// Integrations — "the registry is shipped data from day one"). The curated
// eight and their auth shapes come from docs/reference-mcp-oauth.md —
// endpoints and mechanisms verified against each vendor's docs, never
// guessed. These tests pin the honest states: Figma not connectable,
// per-account entries needing a user URL, Stitch's custom header name.
import { describe, expect, it } from "vitest";
import { isConnectable, loadRegistry } from "../src/orchestrator/stores/registry";

describe("registry", () => {
  it("ships the curated eight, all validating against the schema", () => {
    const ids = loadRegistry().map((e) => e.id);
    expect(ids).toEqual([
      "github",
      "figma",
      "stitch",
      "stripe",
      "sentry",
      "postman",
      "supabase",
      "augment-context-engine",
    ]);
  });

  it("GitHub is key-only (PAT) with its documented endpoint — no OAuth claimed where DCR isn't open", () => {
    const github = loadRegistry().find((e) => e.id === "github")!;
    expect(github.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(github.auth.header).not.toBeNull();
    expect(github.auth.oauth).toBe(false);
    expect(isConnectable(github)).toBe(true);
  });

  it("Figma remote is honestly not connectable: no key mode, allowlist-gated DCR", () => {
    const figma = loadRegistry().find((e) => e.id === "figma")!;
    expect(figma.auth.header).toBeNull();
    expect(figma.auth.oauth).toBe(false);
    expect(isConnectable(figma)).toBe(false);
    expect(figma.note).toMatch(/custom stdio/i); // the Desktop-MCP alternative is named, not buried
  });

  it("Stitch carries the custom header name that forced headerName into the schema", () => {
    const stitch = loadRegistry().find((e) => e.id === "stitch")!;
    expect(stitch.auth.header).toMatchObject({ headerName: "X-Goog-Api-Key", valuePrefix: "" });
    expect(stitch.auth.oauth).toBe(false);
  });

  it("open-DCR vendors offer OAuth; per-account vendors require a user URL yet stay connectable", () => {
    const byId = new Map(loadRegistry().map((e) => [e.id, e]));
    for (const id of ["stripe", "sentry", "postman", "supabase", "augment-context-engine"]) {
      expect(byId.get(id)!.auth.oauth, id).toBe(true);
    }
    for (const id of ["supabase", "augment-context-engine"]) {
      const e = byId.get(id)!;
      expect(e.userUrl, id).toBe(true);
      expect(e.url, id).toBe("");
      expect(isConnectable(e), id).toBe(true);
    }
  });

  it("every entry has vendor docs to point at", () => {
    for (const e of loadRegistry()) expect(e.docsUrl, e.id).toMatch(/^https:\/\//);
  });
});
