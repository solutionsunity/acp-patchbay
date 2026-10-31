// The z ladder (agent-view/style.css § Z LADDER): app-authored z-index
// stays strictly below 50 — the 50+ band belongs to portaled Radix/shadcn
// content (components/ui), which mounts at document.body with z-50. An app
// layer at ≥ 50 paints over an open menu while Radix's modal lock still
// routes every pointer event to it: the menu is invisible, clicks fire
// blind, and the rest of the UI plays dead. This scan is the chokepoint.
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./support/source-files";

// The whole source tree, not the webviews alone: a page built anywhere
// paints in a webview.
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const PORTAL_BAND = 50;

/** The ladder's rungs below the band — a closed set. Anything that floats
 * over the content is a shared-layer primitive in the band; an app layer is
 * one of these, and a new one is added here and in the ladder together, as
 * a decision. A hand-made overlay needs a layer of its own, so it fails
 * here before it ships. */
const RUNGS = new Map([
  [10, "controls floating inside the content they belong to"],
  [30, "the composer's autocomplete, and Settings' card while it is dragged"],
  [46, "the toast"],
]);


/** z values a file authors: CSS `z-index: N` plus Tailwind `z-N` / `z-[N]`. */
function authoredZ(source: string): number[] {
  const values: number[] = [];
  for (const m of source.matchAll(/z-index:\s*(\d+)/g)) values.push(Number(m[1]));
  for (const m of source.matchAll(/\bz-(\d+)\b/g)) values.push(Number(m[1]));
  for (const m of source.matchAll(/\bz-\[(\d+)\]/g)) values.push(Number(m[1]));
  return values;
}

/** App files with the z values each authors. */
const appLayers = () =>
  filesUnder(SRC_ROOT, /\.(css|tsx|ts)$/)
    .filter((path) => relative(SRC_ROOT, path).split(sep).slice(0, 3).join("/") !== "webview/components/ui")
    .flatMap((path) => authoredZ(readFileSync(path, "utf8")).map((z) => ({ where: relative(SRC_ROOT, path), z })));

describe("z ladder", () => {
  it(`app-authored z-index stays below the portal band (${PORTAL_BAND})`, () => {
    const violations = appLayers()
      .filter(({ z }) => z >= PORTAL_BAND)
      .map(({ where, z }) => `${where}: z ${z}`);
    expect(violations, "see the Z LADDER comment in agent-view/style.css").toEqual([]);
  });

  it("every app layer stands on a recorded rung", () => {
    const off = appLayers()
      .filter(({ z }) => z < PORTAL_BAND && !RUNGS.has(z))
      .map(({ where, z }) => `${where}: z ${z}`);
    expect(off, "an overlay belongs in the shared layer; a new rung is a decision — see the Z LADDER comment").toEqual([]);
  });
});
