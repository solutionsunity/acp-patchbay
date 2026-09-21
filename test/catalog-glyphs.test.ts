// The build-time glyph fold (scripts/catalog-glyphs.mjs): the gate that
// decides what data/icons/<id>.svg may contain, and the shipped directory
// passing it against the shipped catalog — so `npm test` catches a bad
// icon before the build does.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS script, no declaration; vitest transforms it.
import { foldCatalog, loadGlyphs, parseGlyph } from "../scripts/catalog-glyphs.mjs";

const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h2v2H1z"/></svg>';

describe("catalog glyph gate", () => {
  it("accepts one path in a viewBox'd svg, with comments and a title around it, either quote style", () => {
    expect(parseGlyph(ok, "a.svg")).toEqual({ viewBox: "0 0 24 24", path: "M1 1h2v2H1z" });
    const decorated = `<!-- source: https://example.test/brand (CC0) -->\n<?xml version="1.0"?>\n<svg role="img" viewBox="0 0 16 16"><title>Acme</title><path d="M0 0h16v16z"/></svg>`;
    expect(parseGlyph(decorated, "b.svg")).toEqual({ viewBox: "0 0 16 16", path: "M0 0h16v16z" });
    expect(parseGlyph("<svg viewBox='0 0 8 8'><path d='M0 0h8v8z'/></svg>", "c.svg")).toEqual({ viewBox: "0 0 8 8", path: "M0 0h8v8z" });
  });

  it("rejects what the renderer cannot honor, naming the violation", () => {
    const cases: [string, RegExp][] = [
      ['<svg viewBox="0 0 24 24"><path d="M0 0"/><path d="M1 1"/></svg>', /exactly one <path>, found 2/],
      ['<svg viewBox="0 0 24 24"><g><path d="M0 0"/></g></svg>', /found <g>/],
      ['<svg viewBox="0 0 24 24"><path d="M0 0" fill="#f00"/></svg>', /carries fill/],
      ['<svg viewBox="0 0 24 24"><path d="M0 0" fill-rule="evenodd"/></svg>', /carries fill-rule/],
      ['<svg><path d="M0 0"/></svg>', /needs a viewBox/],
      ['<svg viewBox="0 0 24 24"><path/></svg>', /needs a d attribute/],
      ['<svg viewBox="0 0 24 24"><script>1</script><path d="M0 0"/></svg>', /found <script>/],
      ['<svg viewBox="0 0 24 24"><image href="x"/></svg>', /found <image>/],
    ];
    for (const [svg, why] of cases) expect(() => parseGlyph(svg, "x.svg"), svg).toThrow(why);
  });

  it("OS noise is skipped, a real stray file is not", () => {
    const dir = mkdtempSync(join(tmpdir(), "glyphs-"));
    writeFileSync(join(dir, "acme.svg"), ok);
    writeFileSync(join(dir, ".DS_Store"), "\0");
    expect(Object.keys(loadGlyphs(dir, ["acme"]))).toEqual(["acme"]);
    writeFileSync(join(dir, "readme.txt"), "x");
    expect(() => loadGlyphs(dir, ["acme"])).toThrow(/only \.svg files live in/);
  });

  it("files and entries match one to one: an orphan file fails, a missing file fails", () => {
    expect(() => loadGlyphs("data/icons", ["nobody"])).toThrow(/no catalog entry has id "augment-context-engine"/);
    const shipped = JSON.parse(readFileSync("data/mcp-catalog.json", "utf8")).servers.map((e: { id: string }) => e.id);
    expect(() => loadGlyphs("data/icons", [...shipped, "newcomer"])).toThrow(/no glyph for newcomer/);
  });

  it("the shipped icons pass the gate against the shipped catalog, one mark per entry", () => {
    const { json, files } = foldCatalog("data/mcp-catalog.json");
    const folded = JSON.parse(json);
    expect(folded.servers).toHaveLength(8);
    for (const e of folded.servers as { id: string; brandIcon: { viewBox: string; path: string } }[]) {
      expect(e.brandIcon.viewBox, e.id).toMatch(/^0 0 \d+ \d+$/);
      expect(e.brandIcon.path, e.id).toMatch(/^M/);
    }
    // watch inputs = the catalog plus every icon, so an icon edit rebuilds
    expect(files).toHaveLength(1 + 8);
  });
});
