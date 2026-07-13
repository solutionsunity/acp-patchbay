// The z ladder (agent-view/style.css § Z LADDER): app-authored z-index
// stays strictly below 50 — the 50+ band belongs to portaled Radix/shadcn
// content (components/ui), which mounts at document.body with z-50. An app
// layer at ≥ 50 paints over an open menu while Radix's modal lock still
// routes every pointer event to it: the menu is invisible, clicks fire
// blind, and the rest of the UI plays dead. This scan is the chokepoint.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEBVIEW_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "webview");
const PORTAL_BAND = 50;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(css|tsx|ts)$/.test(entry.name) ? [path] : [];
  });
}

/** z values a file authors: CSS `z-index: N` plus Tailwind `z-N` / `z-[N]`. */
function authoredZ(source: string): number[] {
  const values: number[] = [];
  for (const m of source.matchAll(/z-index:\s*(\d+)/g)) values.push(Number(m[1]));
  for (const m of source.matchAll(/\bz-(\d+)\b/g)) values.push(Number(m[1]));
  for (const m of source.matchAll(/\bz-\[(\d+)\]/g)) values.push(Number(m[1]));
  return values;
}

describe("z ladder", () => {
  it(`app-authored z-index stays below the portal band (${PORTAL_BAND})`, () => {
    const violations = walk(WEBVIEW_ROOT)
      .filter((path) => !relative(WEBVIEW_ROOT, path).split(sep).slice(0, 2).join("/").startsWith("components/ui"))
      .flatMap((path) =>
        authoredZ(readFileSync(path, "utf8"))
          .filter((z) => z >= PORTAL_BAND)
          .map((z) => `${relative(WEBVIEW_ROOT, path)}: z ${z}`),
      );
    expect(violations, "see the Z LADDER comment in agent-view/style.css").toEqual([]);
  });
});
