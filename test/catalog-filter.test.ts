// The curated catalog's narrowing gate (catalog-filter.ts): text over
// name + description (never the caveat note), mechanism toggles
// AND-combined, registry order kept.
import { describe, expect, it } from "vitest";
import { filterCatalog, mechanismsOf, type Mechanism } from "../src/webview/settings/catalog-filter";
import type { RegistryEntryView } from "../src/shared/protocol";

function entry(over: Partial<RegistryEntryView> & { id: string }): RegistryEntryView {
  return {
    name: over.id, description: over.id, brandIcon: { viewBox: "0 0 24 24", path: "M4 4h16v16H4z" }, connectable: true, note: "",
    docsUrl: "", userUrl: false, headerAuth: null, oauth: false, local: null, ...over,
  };
}

const key = { hint: "", keyUrl: "" };
const stdio = { kind: "stdio" as const, command: "npx", args: [], envKeys: [], note: "" };

const CATALOG: readonly RegistryEntryView[] = [
  // Augment-shaped: the caveat note names GitHub, the description doesn't
  entry({ id: "github", name: "GitHub", description: "repositories, issues, pull requests", headerAuth: key, local: stdio }),
  entry({ id: "figma", name: "Figma", description: "Design context from your files", note: "remote gated, desktop server open", connectable: false, local: { kind: "http", url: "http://127.0.0.1:3845/mcp", note: "" } }),
  entry({ id: "stitch", name: "Stitch", description: "generates UI designs from prompts", note: "key-only", headerAuth: key }),
  entry({ id: "stripe", name: "Stripe", description: "payments", headerAuth: key, oauth: true, local: stdio }),
  entry({ id: "augment", name: "Augment", description: "semantic retrieval over your codebase", note: "remote indexing needs Augment's GitHub App", headerAuth: key, oauth: true }),
];

const ids = (rows: readonly RegistryEntryView[]) => rows.map((r) => r.id);
const set = (...m: Mechanism[]) => new Set<Mechanism>(m);

describe("catalog filter", () => {
  it("mechanismsOf reads the three offers off the entry", () => {
    expect([...mechanismsOf(CATALOG[3]!)]).toEqual(["key", "oauth", "local"]);
    expect([...mechanismsOf(CATALOG[1]!)]).toEqual(["local"]);
  });

  it("blank text and no toggles = every row, registry order", () => {
    expect(ids(filterCatalog(CATALOG, "", set()))).toEqual(["github", "figma", "stitch", "stripe", "augment"]);
    expect(ids(filterCatalog(CATALOG, "   ", set()))).toEqual(ids(CATALOG));
  });

  it("text matches name or description, case-insensitive", () => {
    expect(ids(filterCatalog(CATALOG, "str", set()))).toEqual(["stripe"]);
    expect(ids(filterCatalog(CATALOG, "design", set()))).toEqual(["figma", "stitch"]);
    expect(ids(filterCatalog(CATALOG, "nothing-here", set()))).toEqual([]);
  });

  it("the caveat note is never searched — a hit the row can't show is a false positive", () => {
    expect(ids(filterCatalog(CATALOG, "git", set()))).toEqual(["github"]); // not augment
    expect(ids(filterCatalog(CATALOG, "gated", set()))).toEqual([]);
  });

  it("toggles AND-combine: every selected mechanism must be offered", () => {
    expect(ids(filterCatalog(CATALOG, "", set("oauth")))).toEqual(["stripe", "augment"]);
    expect(ids(filterCatalog(CATALOG, "", set("oauth", "local")))).toEqual(["stripe"]);
    expect(ids(filterCatalog(CATALOG, "", set("local")))).toEqual(["github", "figma", "stripe"]);
  });

  it("text and toggles combine", () => {
    expect(ids(filterCatalog(CATALOG, "s", set("key", "oauth")))).toEqual(["stripe", "augment"]);
    expect(ids(filterCatalog(CATALOG, "figma", set("key")))).toEqual([]);
  });
});
