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
  const oldLines = oldText.length === 0 ? [] : oldText.split("\n");
  const newLines = newText.length === 0 ? [] : newText.split("\n");
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
