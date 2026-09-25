// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Path labels for display. Actions always carry the full absolute path; these
// only decide what the user reads.

/** The last segment of a path, either separator — a label, never a lookup. */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Absolute path → { base, dir }, dir relative to the longest workspace root
 * that contains it (whole segments only: `/ws/app` never claims
 * `/ws/application`). Outside every root, dir stays absolute. */
export function splitPath(path: string, roots: readonly string[]): { base: string; dir: string } {
  const root = roots.filter((r) => contains(r, path)).sort((a, b) => b.length - a.length)[0];
  const rel = root !== undefined ? path.slice(root.length).replace(/^[/\\]/, "") : path;
  const parts = rel.split(/[/\\]/);
  return { base: parts.pop() ?? rel, dir: parts.join("/") };
}

function contains(root: string, path: string): boolean {
  if (!path.startsWith(root)) return false;
  const rest = path.slice(root.length);
  return rest === "" || /[/\\]$/.test(root) || /^[/\\]/.test(rest);
}
