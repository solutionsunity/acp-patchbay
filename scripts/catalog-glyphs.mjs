// Brand glyphs for the curated MCP catalog: one file per entry under
// data/icons/<id>.svg, folded into the catalog wherever the JSON is
// loaded (the extension bundle in esbuild.mjs, the tests in
// vitest.config.ts) as `brandIcon: { viewBox, path }` — the shape the
// settings webview renders inline with fill=currentColor. The file is the
// reviewable form — a reviewer opens an SVG; nobody can judge a path
// string in a JSON diff — and carries its own provenance as a leading
// comment naming the source.
//
// The gate is the substance: a glyph is exactly one `<path d>` inside an
// `<svg viewBox>`, optionally a `<title>`, and nothing else. No second
// element, no fill/stroke/style on the path (color is the row's), no
// script, no external reference. What the renderer can't honor is
// rejected here rather than silently dropped. Files and entries match
// one to one: an entry without a file has no art and doesn't build, a
// file naming no entry is a typo and doesn't either.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The one file the fold applies to, as both bundlers see its path. */
export const CATALOG_JSON = /data[\\/]mcp-catalog\.json$/;

const ATTR = /\s([\w:-]+)=(?:"([^"]*)"|'([^']*)')/g;

/** `<svg viewBox="…"><path d="…"/></svg>` → { viewBox, path }; throws
 * naming the violation. */
export function parseGlyph(svg, name) {
  const fail = (why) => {
    throw new Error(`${name}: ${why}`);
  };
  const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(ATTR)].map((m) => [m[1], m[2] ?? m[3]]));
  const body = svg.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?xml[^>]*\?>/g, "");
  const tags = [...body.matchAll(/<\/?([A-Za-z][\w:-]*)([^>]*)>/g)];
  const opened = tags.filter((t) => !t[0].startsWith("</")).map((t) => t[1]);
  const foreign = opened.filter((t) => !["svg", "path", "title"].includes(t));
  if (foreign.length > 0) fail(`only svg, path and title are allowed — found <${foreign[0]}>`);
  if (opened.filter((t) => t === "svg").length !== 1) fail("exactly one <svg> root");
  const paths = tags.filter((t) => t[1] === "path" && !t[0].startsWith("</"));
  if (paths.length !== 1) fail(`exactly one <path>, found ${paths.length}`);

  const viewBox = attrsOf(tags.find((t) => t[1] === "svg")[2]).viewBox;
  if (viewBox === undefined) fail("<svg> needs a viewBox");

  const pathAttrs = attrsOf(paths[0][2]);
  const extra = Object.keys(pathAttrs).filter((a) => a !== "d");
  if (extra.length > 0) fail(`<path> carries ${extra.join(", ")} — only d is rendered`);
  if (pathAttrs.d === undefined || pathAttrs.d.trim() === "") fail("<path> needs a d attribute");

  return { viewBox, path: pathAttrs.d };
}

/** Every glyph under `iconsDir`, keyed by entry id — one file per id in
 * `ids`, no more, no fewer. */
export function loadGlyphs(iconsDir, ids) {
  const known = new Set(ids);
  const glyphs = {};
  for (const file of readdirSync(iconsDir).sort()) {
    // A dot-prefixed name is never an entry id, so it is the OS talking
    // (.DS_Store, .gitkeep) — skipped rather than failing a build over a
    // file nobody put there on purpose.
    if (file.startsWith(".")) continue;
    if (!file.endsWith(".svg")) throw new Error(`${file}: only .svg files live in ${iconsDir}`);
    const id = file.slice(0, -4);
    if (!known.has(id)) throw new Error(`${file}: no catalog entry has id "${id}"`);
    glyphs[id] = parseGlyph(readFileSync(join(iconsDir, file), "utf8"), file);
  }
  const missing = ids.filter((id) => !(id in glyphs));
  if (missing.length > 0) throw new Error(`no glyph for ${missing.join(", ")} — every entry needs ${iconsDir}/<id>.svg`);
  return glyphs;
}

/** The catalog at `catalogPath` with each entry's glyph attached, as JSON
 * text — what a loader gets in place of the raw file — plus what the
 * result depends on, for watch modes: every file, and the icons directory
 * itself (beside the catalog, `icons/`) so an added file is seen. */
export function foldCatalog(catalogPath) {
  const iconsDir = join(dirname(catalogPath), "icons");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const glyphs = loadGlyphs(iconsDir, catalog.servers.map((e) => e.id));
  return {
    json: JSON.stringify({
      ...catalog,
      servers: catalog.servers.map((e) => ({ ...e, brandIcon: glyphs[e.id] })),
    }),
    files: [catalogPath, ...Object.keys(glyphs).map((id) => join(iconsDir, `${id}.svg`))],
    iconsDir,
  };
}
