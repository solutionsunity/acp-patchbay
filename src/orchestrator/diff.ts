// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Line-level diff via the classic LCS (longest common subsequence) table —
// correct for reordering-free edits, which covers the overwhelming majority
// of agent file writes. No dependency: this is ~30 lines by hand and the
// alternative (a diff library) buys nothing a pre-gated preview needs.
import type { DiffLineKind, DiffStat } from "../shared/protocol";

export interface DiffResult extends DiffStat {
  lines: readonly { kind: DiffLineKind; text: string }[];
}

export function computeLineDiff(oldText: string, newText: string): DiffResult {
  // One line-ending vocabulary before comparing: the two sides routinely
  // come from different producers (agent-normalized LF content vs a CRLF
  // file on disk, or vice versa), and comparing raw marked every line
  // changed — while VS Code's own diff editor, which ignores trailing
  // whitespace by default, showed the same change clean. \r\n and \n are
  // the same line boundary here; all other whitespace is content.
  // A newline ends a line rather than opening one (the count wc -l, git
  // and VS Code give): one trailing "\n" is the last line's terminator,
  // not an empty line after it — else a new n-line file counts n+1.
  const linesOf = (text: string) => {
    const norm = text.replace(/\r\n/g, "\n");
    return norm.length === 0 ? [] : (norm.endsWith("\n") ? norm.slice(0, -1) : norm).split("\n");
  };
  const oldLines = linesOf(oldText);
  const newLines = linesOf(newText);

  // Lines both sides share at the start and at the end are context in
  // every longest common subsequence, so they're matched up front and only
  // the span between them runs the quadratic table: a one-line edit in a
  // 10,000-line file costs a scan, not 100M cells and ~800 MB on the
  // extension host's thread.
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail++;
  }
  const a = oldLines.slice(head, oldLines.length - tail);
  const b = newLines.slice(head, newLines.length - tail);
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of the LCS of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: { kind: DiffLineKind; text: string }[] = oldLines
    .slice(0, head)
    .map((text) => ({ kind: "context", text }));
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: "context", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ kind: "del", text: a[i]! });
      deletions++;
      i++;
    } else {
      lines.push({ kind: "add", text: b[j]! });
      additions++;
      j++;
    }
  }
  while (i < n) {
    lines.push({ kind: "del", text: a[i]! });
    deletions++;
    i++;
  }
  while (j < m) {
    lines.push({ kind: "add", text: b[j]! });
    additions++;
    j++;
  }
  for (const text of oldLines.slice(oldLines.length - tail)) lines.push({ kind: "context", text });

  return { additions, deletions, lines };
}
