// Every transient overlay is a shared-layer primitive (components/ui, on
// Radix), never re-solved by hand: an overlay that closes itself on a
// document listener, mounts its own portal, or shows itself on a CSS hover
// has each answered dismissal, focus or placement partially — and drifts
// from the rest of the UI with every change made to the shared layer. Nor
// may the page around an overlay keep a click to itself: the open overlay
// reads a stopped click as handled by the page, and stays open. This
// scan is a tripwire for the shapes a hand-made overlay takes, not a proof
// that none exists; the z ladder's closed rung set (z-ladder.test.ts) is the
// other half, and the ui-gate drives the overlays themselves.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEBVIEW_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "webview");
const UI = join(WEBVIEW_ROOT, "components", "ui");

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, ext);
    return ext.test(entry.name) ? [path] : [];
  });
}

/** App files: everything outside the shared overlay layer. */
const appFiles = (ext: RegExp) => walk(WEBVIEW_ROOT, ext).filter((path) => !path.startsWith(UI));

const hits = (ext: RegExp, pattern: RegExp) =>
  appFiles(ext).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, i) => (pattern.test(line) ? [`${relative(WEBVIEW_ROOT, path)}:${i + 1}: ${line.trim()}`] : [])),
  );

describe("overlay surfaces", () => {
  it("nothing closes itself on a document or window pointer or key listener", () => {
    const dismissal = /\b(?:document|window)(?:\.body)?\.addEventListener\(\s*["'](?:mousedown|mouseup|pointerdown|pointerup|click|keydown|keyup|focusin|focusout)["']/;
    expect(hits(/\.tsx?$/, dismissal), "use a Radix primitive from components/ui").toEqual([]);
  });

  it("no click is kept from propagating", () => {
    // An open popover or dialog reads a click the page stopped as handled
    // by the page, and stays open: a container that must not act on its
    // controls' clicks asks where the click came from instead.
    expect(hits(/\.tsx?$/, /\.stop(?:Immediate)?Propagation\(/), "let the click travel; have the container ignore clicks from its controls").toEqual([]);
  });

  it("no portal is mounted by hand", () => {
    expect(hits(/\.tsx?$/, /\bcreatePortal\b/), "use a Radix primitive from components/ui").toEqual([]);
  });

  it("no CSS shows an element only while its parent is hovered", () => {
    const reveals = appFiles(/\.css$/).flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/([^{}]*:hover\s+[^{}]+)\{([^}]*)\}/g)]
        .filter((m) => /\b(?:display|visibility)\s*:/.test(m[2]!))
        .map((m) => `${relative(WEBVIEW_ROOT, path)}: ${m[1]!.trim()}`),
    );
    expect(reveals, "a hover-only reveal is a tooltip the keyboard can't reach: use Tooltip").toEqual([]);
  });
});
