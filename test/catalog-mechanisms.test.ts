// What a curated entry offers (catalog-mechanisms.ts) — the picker's tags.
import { describe, expect, it } from "vitest";
import { mechanismsOf } from "../src/webview/settings/catalog-mechanisms";
import type { CatalogEntryView } from "../src/shared/protocol";

function entry(over: Partial<CatalogEntryView> & { id: string }): CatalogEntryView {
  return {
    name: over.id, description: over.id, brandIcon: { viewBox: "0 0 24 24", path: "M4 4h16v16H4z" }, connectable: true, note: "",
    docsUrl: "", userUrl: false, headerAuth: null, oauth: false, local: null, ...over,
  };
}

describe("catalog mechanisms", () => {
  it("reads the three offers off the entry, in one order", () => {
    const stdio = { kind: "stdio" as const, command: "npx", args: [], envKeys: [], note: "" };
    expect([...mechanismsOf(entry({ id: "stripe", headerAuth: { hint: "", keyUrl: "" }, oauth: true, local: stdio }))]).toEqual(["key", "oauth", "local"]);
    expect([...mechanismsOf(entry({ id: "figma", local: { kind: "http", url: "http://127.0.0.1:3845/mcp", note: "" } }))]).toEqual(["local"]);
    expect([...mechanismsOf(entry({ id: "none" }))]).toEqual([]);
  });
});
