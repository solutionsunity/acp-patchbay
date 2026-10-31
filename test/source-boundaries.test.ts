// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Boundaries no type can hold, held by reading the source: an error the
// extension host catches is read by its one reader (agentErrorText), never
// by its bare message, which drops what an agent puts in `data`; and a code
// comment explains its code, never pointing at a document — doc names,
// sections and planning ids rot as the documents move.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LATCHED_AGENTS } from "../src/orchestrator/extensions/first-session-mcp-latch";
import { PATH_SIBLINGS } from "../src/orchestrator/launcher-health";
import { filesUnder } from "./support/source-files";

const SRC = new URL("../src/", import.meta.url).pathname;

/** Every line of `files` matching `pattern`, as "file:line: text". */
const hits = (files: readonly string[], pattern: RegExp): string[] =>
  files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) => (pattern.test(line) ? [`${relative(SRC, file)}:${i + 1}: ${line.trim()}`] : [])),
  );

describe("source boundaries", () => {
  it("the extension host reads a caught error through agentErrorText, never its bare message", () => {
    const files = [...filesUnder(join(SRC, "orchestrator"), /\.tsx?$/), join(SRC, "extension.ts")];
    expect(hits(files, /instanceof Error \? \w+\.message|\(\w+ as Error\)\.message/)).toEqual([]);
  });

  it("no comment names a document, a section or a planning id", () => {
    const files = filesUnder(SRC, /\.tsx?$/);
    expect(hits(files, /\/\/.*(\.md\b|§|docs\/|compliance [A-Z]\d+|\(P\d+[a-z]?\))|^\s*\*.*(\.md\b|§|docs\/|compliance [A-Z]\d+|\(P\d+[a-z]?\))/)).toEqual([]);
  });

  // A vendor's behavior is kept where it is curated — an extension module,
  // the _meta table, the PATH-sibling table — and gating elsewhere reads a
  // shape, never a vendor. The ids those tables name are the vendors known
  // here; none appears as a string anywhere else.
  it("no vendor is named outside the tables that curate vendors", () => {
    const vendors = [...LATCHED_AGENTS, ...Object.keys(PATH_SIBLINGS)];
    const curated = [join(SRC, "orchestrator", "extensions"), join(SRC, "orchestrator", "readers"), join(SRC, "orchestrator", "meta.ts"), join(SRC, "orchestrator", "launcher-health.ts")];
    const files = filesUnder(SRC, /\.tsx?$/).filter((file) => !curated.some((home) => file.startsWith(home)));
    // code, not comments: an observation may name the vendor it was made on
    expect(hits(files, new RegExp(`^(?!\\s*(//|\\*)).*["'\`](${vendors.join("|")})["'\`]`))).toEqual([]);
  });

  // Secrets live in SecretStorage alone. VS Code's two other stores sync or
  // persist in plain sight — settings.json syncs, global and workspace state
  // are plain files — so they are reached only where patchbay's storage is
  // built, settings are never written, and no log line carries a secret's
  // value.
  it("secrets rest in SecretStorage alone, and no log line carries one", () => {
    const code = (pattern: RegExp) => new RegExp(`^(?!\\s*(//|\\*)).*${pattern.source}`);
    const host = join(SRC, "orchestrator", "orchestrator-host.ts");
    const files = filesUnder(SRC, /\.tsx?$/);
    expect(hits(files.filter((file) => file !== host), code(/\.(globalState|workspaceState)\b/))).toEqual([]);
    expect(hits(files, code(/getConfiguration\([^)]*\)\.update\(/))).toEqual([]);
    expect(hits(files, code(/log(\.\w+)?\(.*\$\{[^}]*(accessToken|refreshToken|apiKey|\.env\b)/))).toEqual([]);
  });
});
