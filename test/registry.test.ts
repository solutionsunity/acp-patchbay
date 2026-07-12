// Registry data validates at the trust boundary (architecture.md §
// Integrations — "the registry is shipped data from day one"). The curated
// entries and their auth shapes come from docs/reference-mcp-oauth.md —
// endpoints and mechanisms verified against each vendor's docs, never
// guessed. These tests pin the honest states: per-account entries needing
// a user URL, Stitch's custom header name, Figma's remote gated on its
// client catalog while the desktop Dev Mode server stays open.
import { describe, expect, it } from "vitest";
import { isConnectable, loadRegistry, type RegistryEntry } from "../src/orchestrator/stores/registry";

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

  it("Figma: remote honestly not connectable (catalog-gated), local Dev Mode server offered instead", () => {
    const figma = loadRegistry().find((e) => e.id === "figma")!;
    expect(figma.auth.header).toBeNull();
    expect(figma.auth.oauth).toBe(false); // allowlisted DCR — claiming OAuth would just 403
    expect(isConnectable(figma)).toBe(false); // *remotely*; the row still offers the local path
    expect(figma.local).toMatchObject({ url: "http://127.0.0.1:3845/mcp" });
    expect(figma.note).toMatch(/catalog|waitlist/i); // the gate is named, never buried
  });

  it("verified local stdio servers ship for exactly the vendors we confirmed", () => {
    const byId = new Map(loadRegistry().map((e) => [e.id, e]));
    for (const id of ["github", "stripe", "sentry", "supabase", "augment-context-engine"]) {
      const local = byId.get(id)!.local;
      expect(local, id).not.toBeNull();
      expect("command" in local!, id).toBe(true);
    }
    // no official local server verified — honestly absent, never guessed
    expect(byId.get("stitch")!.local).toBeNull();
    expect(byId.get("postman")!.local).toBeNull();
  });

  it("GitHub is key-only (PAT) with its documented endpoint — no OAuth claimed where DCR isn't open", () => {
    const github = loadRegistry().find((e) => e.id === "github")!;
    expect(github.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(github.auth.header).not.toBeNull();
    expect(github.auth.oauth).toBe(false);
    expect(isConnectable(github)).toBe(true);
  });

  it("an entry with no open mechanism is honestly not connectable — shown, never offered a dead form", () => {
    // Synthetic (the Figma case that shaped this rule, before it was dropped
    // from the registry): endpoint exists, but no key mode and gated DCR.
    const gated: RegistryEntry = {
      id: "gated",
      name: "Gated",
      icon: "server",
      brandIcon: null,
      url: "https://example.test/mcp",
      userUrl: false,
      docsUrl: "https://example.test/docs",
      note: "",
      auth: { header: null, oauth: false },
      local: null,
    };
    expect(isConnectable(gated)).toBe(false);
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
