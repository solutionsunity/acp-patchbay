// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A file is named in the attachments stash by its own name there: the view
// asks to open an image by that name, and nothing it sends reaches out of
// the stash.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ATTACHMENTS_DIR, stashedFile } from "../src/orchestrator/attachments";

describe("a file named in the stash", () => {
  it("is found there by its own name", () => {
    expect(stashedFile("chip-1.png")).toBe(join(ATTACHMENTS_DIR, "chip-1.png"));
  });

  it("is no file for a name that reaches elsewhere, or names none", () => {
    for (const name of ["", ".", "..", "../secret", "sub/x.png", "/etc/passwd", "..\\x.png", "C:\\x.png"]) {
      expect(stashedFile(name), name).toBeNull();
    }
  });
});
