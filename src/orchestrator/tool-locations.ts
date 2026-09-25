// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A tool call's file locations: what patchbay keeps from the wire, and where
// in the file opening one lands. ACP gives each location an absolute path
// and an optional line but never says what the line counts from. The agents
// that send one count from 1 — a whole-file read reports line 1, the top —
// so a line here is 1-based, and 0 is taken as the first line rather than
// dropped. The reading lives here and nowhere else.
import type { ToolCallLocation } from "@agentclientprotocol/sdk";
import type { ToolLocation } from "../shared/protocol";

export function toolLocationsOf(wire: readonly ToolCallLocation[]): ToolLocation[] {
  return wire.map((l) => ({ path: l.path, line: l.line == null ? null : Math.max(1, l.line) }));
}

/** The 0-based editor line a 1-based location line lands on, clamped into a
 * document of `lineCount` lines — a line past the end opens at the last one
 * rather than failing. */
export function editorLineOf(line: number, lineCount: number): number {
  return Math.min(Math.max(line, 1), Math.max(lineCount, 1)) - 1;
}
