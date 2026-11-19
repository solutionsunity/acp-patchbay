// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What a staged attachment reads as inside the prompt box: one short word,
// the way a mention spells a file — the file's own name, never its whole
// path, with the lines where it is a selection. The token's hover says
// what stands behind the word: where a file or folder is, what a snapshot
// is of — and for an image nothing, since its hover shows the image.
import { count } from "../../../shared/count";
import type { ContextChip, LiveSelectionView } from "../../../shared/protocol";
import { basename, filePathOf } from "../../shared/path";

/** Lines as a token spells them: one line as one number. */
const linesOf = (startLine: number, endLine: number): string => (startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`);

/** What the editor's live selection is offered as, before it is added: the
 * file and the first selection's lines — and, with several selections, how
 * many more a click adds beside it. */
export function selectionOffer(live: LiveSelectionView): { label: string; title: string } {
  const [first, ...rest] = live.ranges;
  const label = `${basename(live.file)}${first === undefined ? "" : `:${linesOf(first.startLine, first.endLine)}`}`;
  return rest.length === 0
    ? { label, title: "Live IDE selection — click to add it to context" }
    : { label: `${label} +${rest.length}`, title: `${count(live.ranges.length, "selection")} in the editor — click to add each to context` };
}

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
      return `@${basename(path)}:${linesOf(Number(lines[1]), Number(lines[2]))}`;
    }
  }
}

/** The token's hover text. */
export function chipTitle(chip: ContextChip): string {
  if (chip.kind === "attachment") return chip.path;
  return chip.kind === "image" ? "" : chip.label;
}
