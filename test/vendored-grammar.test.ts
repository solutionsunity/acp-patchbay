// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The zsh grammar is a file its author publishes, kept in this repository
// as published: the record beside it names the package, the version and
// the file's digest, and the file is that file — a grammar swapped or
// rebuilt without its record changing fails here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "data", "grammars");

describe("the zsh grammar kept in the repository", () => {
  const record = JSON.parse(readFileSync(join(DIR, "tree-sitter-zsh.json"), "utf8")) as { file: string; version: string; sha256: string; license: string };

  it("is the file its record names, byte for byte", () => {
    expect(createHash("sha256").update(readFileSync(join(DIR, record.file))).digest("hex")).toBe(record.sha256);
  });

  it("has its license beside it, and the notice names the version kept", () => {
    expect(readFileSync(join(DIR, "tree-sitter-zsh.LICENSE"), "utf8")).toContain("MIT License");
    expect(record.license).toBe("MIT");
    expect(readFileSync(join(process.cwd(), "NOTICE"), "utf8")).toContain(`tree-sitter-zsh), version ${record.version}`);
  });
});
