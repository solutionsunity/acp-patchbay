// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Where opening a location lands: in a file, the line — 1-based as read
// from the wire (the tool-call reader says why), where the editor counts
// from 0 — and for a folder, the place that can show it.

/** The 0-based editor line a 1-based location line lands on, clamped into a
 * document of `lineCount` lines — a line past the end opens at the last one
 * rather than failing. */
export function editorLineOf(line: number, lineCount: number): number {
  return Math.min(Math.max(line, 1), Math.max(lineCount, 1)) - 1;
}

/** Where a linked folder is shown. VS Code's Explorer reveals only what is
 * inside the workspace, and says nothing for anything else, so a folder
 * outside it opens in the system's file manager — in a local window, where
 * that manager sees the same disk. In a remote window the folder is on the
 * remote host, which no local file manager can open: the click says so,
 * naming the folder. */
export function folderShownIn(insideWorkspace: boolean, remote: boolean): "explorer" | "file-manager" | "message" {
  if (insideWorkspace) return "explorer";
  return remote ? "message" : "file-manager";
}
