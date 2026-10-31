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
});
