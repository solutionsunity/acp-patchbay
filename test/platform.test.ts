// The platform vocabulary: one table, each publisher's spelling a
// projection of it. Pinned per publisher against the names their own
// downloads carry, for every platform in the table, so a row added or a
// spelling changed shows here; and a scan holds the one home.
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./support/source-files";
import { nodeDistName, platformOf, registryTarget, rustTarget } from "../src/orchestrator/platform";

const ALL = [
  ["darwin", "arm64", "darwin-aarch64", "darwin-arm64", "aarch64-apple-darwin"],
  ["darwin", "x64", "darwin-x86_64", "darwin-x64", "x86_64-apple-darwin"],
  ["linux", "arm64", "linux-aarch64", "linux-arm64", "aarch64-unknown-linux-gnu"],
  ["linux", "x64", "linux-x86_64", "linux-x64", "x86_64-unknown-linux-gnu"],
  ["win32", "arm64", "windows-aarch64", "win-arm64", "aarch64-pc-windows-msvc"],
  ["win32", "x64", "windows-x86_64", "win-x64", "x86_64-pc-windows-msvc"],
] as const;

describe("platform vocabulary", () => {
  it.each(ALL)("%s-%s spells as each publisher names it", (os, arch, registry, node, rust) => {
    const platform = platformOf(os, arch)!;
    expect(platform).toEqual({ os, arch });
    expect(registryTarget(platform)).toBe(registry);
    expect(nodeDistName(platform)).toBe(node);
    expect(rustTarget(platform)).toBe(rust);
  });

  it("a machine no publisher builds for has no platform, never a guessed name", () => {
    expect(platformOf("linux", "ia32")).toBeNull();
    expect(platformOf("freebsd", "x64")).toBeNull();
    expect(platformOf("aix", "ppc64")).toBeNull();
    // An inherited key is not a row.
    expect(platformOf("linux", "constructor")).toBeNull();
  });

  it("reads the running machine by default", () => {
    expect(platformOf()).toEqual(platformOf(process.platform, process.arch));
  });
});

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const HOME = join(SRC, "orchestrator", "platform.ts");

/** A publisher's OS or CPU name — the spellings the table holds. Node's own
 * (`win32`, `x64`) are read directly anywhere and are not here. */
const SPELLING = /\b(?:x86_64|aarch64)\b|apple-darwin|unknown-linux-gnu|pc-windows-msvc|\bwin-(?:x64|arm64)\b|"windows"/;

/** A pinned digest names its publisher's archive whole: a fact copied from
 * the publisher's checksum list, held against the projections by the
 * catalog's own digest test — not a spelling of the platform. */
const DIGEST_ENTRY = /^\s*"[^"]+": "[0-9a-f]{64}",?$/;

describe("platform vocabulary boundary", () => {
  it("no publisher's platform spelling lives outside the platform module", () => {
    const strays = filesUnder(SRC, /\.tsx?$/)
      .filter((path) => path !== HOME)
      .flatMap((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .flatMap((line, i) => (SPELLING.test(line) && !DIGEST_ENTRY.test(line) ? [`${relative(SRC, path)}:${i + 1}: ${line.trim()}`] : [])),
      );
    expect(strays, "spell it as a projection in platform.ts").toEqual([]);
  });
});
