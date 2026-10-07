// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Where in a file opening a tool call's location lands. A location's line is
// 1-based as read from the wire (the tool-call reader says why); the editor
// counts from 0.

/** The 0-based editor line a 1-based location line lands on, clamped into a
 * document of `lineCount` lines — a line past the end opens at the last one
 * rather than failing. */
export function editorLineOf(line: number, lineCount: number): number {
  return Math.min(Math.max(line, 1), Math.max(lineCount, 1)) - 1;
}
