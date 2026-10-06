// Every anchored overlay is bounded by the space it opens into: the shared
// Radix content primitives (components/ui) cap their size with the
// available-space variables Radix measures, and no call site gives one a
// minimum width that could outgrow that space — CSS lets a min-width beat
// a max-width, so a wider minimum would push the overlay past the panel's
// edge again, its last controls with it. The ui-gate's narrow sweep proves
// the surfaces it opens; this scan holds every call site, opened or not.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEBVIEW_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "webview");
const UI = join(WEBVIEW_ROOT, "components", "ui");

/** Anchored Radix primitives — the file in components/ui, the content
 * part call sites render, and the name Radix gives its variables. */
const ANCHORED = [
  { file: "popover.tsx", content: "PopoverContent", radix: "popover" },
  { file: "dropdown-menu.tsx", content: "DropdownMenuContent", radix: "dropdown-menu" },
  { file: "select.tsx", content: "SelectContent", radix: "select" },
  { file: "tooltip.tsx", content: "TooltipContent", radix: "tooltip" },
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("overlay bounds", () => {
  it("each anchored overlay is capped by the width Radix measures for it", () => {
    const unbounded = ANCHORED.filter(({ file, radix }) => {
      const cap = new RegExp(`max-w-\\[(?:var\\(|min\\([^,\\]]+,var\\()--radix-${radix}-content-available-width\\)`);
      return !cap.test(readFileSync(join(UI, file), "utf8"));
    }).map(({ file }) => file);
    expect(unbounded).toEqual([]);
  });

  it("no call site gives an overlay a minimum width that could outgrow its space", () => {
    const tag = new RegExp(`<(${ANCHORED.map((a) => a.content).join("|")})\\b[^>]*?className=(?:"([^"]*)"|\\{\`([^\`]*)\`\\})`, "gs");
    const violations = walk(WEBVIEW_ROOT)
      .filter((path) => !path.startsWith(UI))
      .flatMap((path) =>
        [...readFileSync(path, "utf8").matchAll(tag)].flatMap((m) => {
          const classes = (m[2] ?? m[3] ?? "").split(/\s+/);
          return classes
            .filter((c) => c.startsWith("min-w-") && c !== "min-w-0" && !c.startsWith("min-w-[min("))
            .map((c) => `${relative(WEBVIEW_ROOT, path)}: <${m[1]}> ${c}`);
        }),
      );
    expect(violations, "clamp it: min-w-[min(<size>,var(--radix-…-content-available-width))]").toEqual([]);
  });
});
