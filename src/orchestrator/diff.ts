// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Line-level diff via the classic LCS (longest common subsequence) table —
// correct for reordering-free edits, which covers the overwhelming majority
// of agent file writes. No dependency: this is ~30 lines by hand and the
// alternative (a diff library) buys nothing a pre-gated preview needs.
import type { DiffLineKind } from "../shared/protocol";

export interface DiffResult {
  additions: number;
  deletions: number;
  lines: readonly { kind: DiffLineKind; text: string }[];
}

export function computeLineDiff(oldText: string, newText: string): DiffResult {
  // One line-ending vocabulary before comparing: the two sides routinely
  // come from different producers (agent-normalized LF content vs a CRLF
  // file on disk, or vice versa), and comparing raw marked every line
  // changed — while VS Code's own diff editor, which ignores trailing
  // whitespace by default, showed the same change clean. \r\n and \n are
  // the same line boundary here; all other whitespace is content.
  const normalize = (text: string) => text.replace(/\r\n/g, "\n");
  const oldNorm = normalize(oldText);
  const newNorm = normalize(newText);
  const oldLines = oldNorm.length === 0 ? [] : oldNorm.split("\n");
  const newLines = newNorm.length === 0 ? [] : newNorm.split("\n");
  const n = oldLines.length;
  const m = newLines.length;

  // lcs[i][j] = length of the LCS of oldLines[i:] and newLines[j:]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        oldLines[i] === newLines[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: { kind: DiffLineKind; text: string }[] = [];
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ kind: "context", text: oldLines[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ kind: "del", text: oldLines[i]! });
      deletions++;
      i++;
    } else {
      lines.push({ kind: "add", text: newLines[j]! });
      additions++;
      j++;
    }
  }
  while (i < n) {
    lines.push({ kind: "del", text: oldLines[i]! });
    deletions++;
    i++;
  }
  while (j < m) {
    lines.push({ kind: "add", text: newLines[j]! });
    additions++;
    j++;
  }

  return { additions, deletions, lines };
}
