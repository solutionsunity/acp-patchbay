// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What a staged attachment reads as inside the prompt box: one short word,
// the way a mention spells a file — the file's own name, never its whole
// path, with the lines where it is a selection. The token's hover says
// what stands behind the word: where a file or folder is, what a snapshot
// is of — and for an image nothing, since its hover shows the image.
import type { ContextChip } from "../../../shared/protocol";
import { basename, filePathOf } from "../../shared/path";

export function chipToken(chip: ContextChip): string {
  switch (chip.kind) {
    case "attachment":
      return `@${chip.name}`;
    case "diagnostics":
      return "@problems";
    case "image": {
      const named = /^Image: (.+)$/.exec(chip.label);
      return `@${named?.[1] ?? "image"}`;
    }
    case "file":
    case "selection": {
      const [address = "", fragment] = (chip.sourceUri ?? "").split("#");
      const path = filePathOf(address);
      if (path === null) return `@${chip.kind}`;
      const lines = /^L(\d+)-(\d+)$/.exec(fragment ?? "");
      if (lines === null) return `@${basename(path)}`;
      return `@${basename(path)}:${lines[1] === lines[2] ? lines[1] : `${lines[1]}-${lines[2]}`}`;
    }
  }
}

/** The token's hover text. */
export function chipTitle(chip: ContextChip): string {
  if (chip.kind === "attachment") return chip.path;
  return chip.kind === "image" ? "" : chip.label;
}
