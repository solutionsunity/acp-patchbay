// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The transcript view-model — the ONE derivation between reducer state and
// chat components, and the one place stream/end semantics live. Components
// consume the result and stay dumb.
//
// Vocabulary contract: a block is `live` while it is the one receiving
// deltas — the caret, the thought auto-collapse, and Streamdown's animation
// all key off `liveBlockId`, under that one name. ("streaming"/"active"/
// "isAnimating" drift was how the RTL regression hid.)
//
// One forward pass over the flat block timeline (ordering principle,
// ui-rendering-strategy.md § Summary): grouping and per-turn rollups are
// render arrangements derived here, never separate traversals with separate
// boundary rules.
import type { ChatBlock, ToolCallBlock, ToolCallKind } from "../../../shared/protocol";

export type TranscriptItem =
  | { kind: "single"; block: ChatBlock }
  | { kind: "toolRun"; id: string; calls: readonly ToolCallBlock[] };

export interface TurnRollup {
  /** Total tool_call blocks in the turn — raw event count. */
  toolCalls: number;
  /** Distinct file paths across edit/delete/move calls, deduped — editing
   * one file three times is 1 file, not 3. */
  filesTouched: number;
  /** Tool calls per ACP kind, for the expanded breakdown. */
  byKind: Partial<Record<ToolCallKind, number>>;
}

/** Whole-session counters (composer stats strip) — accumulated in the same
 * forward pass as the per-turn rollups, never a second traversal. */
export interface SessionTotals {
  /** User prompts in the transcript — what the wire replayed or streamed;
   * an externally-continued session honestly shows only what came back. */
  prompts: number;
  /** Total tool_call blocks across the session. */
  toolCalls: number;
  /** Distinct file paths across edit/delete/move calls, deduped across the
   * whole session (the same file edited in three turns appears once), in
   * first-touch order — the read-out strip's files panel renders this list. */
  files: readonly string[];
}

export interface TranscriptView {
  items: readonly TranscriptItem[];
  /** Per-turn rollup, keyed by the turnEnd block that closes the turn. */
  rollups: ReadonlyMap<string, TurnRollup>;
  /** The trailing open segment's rollup — the same accumulator the next
   * turnEnd would snapshot, exposed so the live ticker can show counts as
   * they happen. Meaningful only while a turn is in flight; one derivation,
   * never a second traversal. */
  liveRollup: TurnRollup;
  /** Whole-session counters — live blocks tick these as they land. */
  totals: SessionTotals;
  /** Paths whose diff texts the orchestrator can answer for — agent-reported
   * tool_call diffs (diffFiles) plus the fs/write gate's own diff cards. The
   * files panel renders its ± exactly for these: presence here ⟺ a baseline
   * exists orchestrator-side, by construction (both derive from the same
   * wire/gate events), so the button is never a dead click. */
  diffableFiles: ReadonlySet<string>;
  /** The one live block (last block, text/thought, turn in flight) — null
   * when nothing is receiving deltas. */
  liveBlockId: string | null;
}

/** The no-transcript view — one shared instance so an empty session never
 * re-derives (and consumers can rely on reference equality). */
export const EMPTY_TRANSCRIPT: TranscriptView = {
  items: [],
  rollups: new Map(),
  liveRollup: { toolCalls: 0, filesTouched: 0, byKind: {} },
  totals: { prompts: 0, toolCalls: 0, files: [] },
  diffableFiles: new Set(),
  liveBlockId: null,
};

/** "Several" starts at 3 — two cards aren't the wall the grouping exists to
 * prevent, and hiding a pair costs more clicks than it saves reading.
 * Deliberate threshold, not a tunable. */
export const TOOL_RUN_MIN = 3;

const FILE_TOUCHING: ReadonlySet<ToolCallKind> = new Set(["edit", "delete", "move"]);

export function deriveTranscript(blocks: readonly ChatBlock[], live: boolean): TranscriptView {
  const items: TranscriptItem[] = [];
  const rollups = new Map<string, TurnRollup>();

  // current run of back-to-back tool calls (render arrangement)
  let run: ToolCallBlock[] = [];
  const flushRun = () => {
    if (run.length >= TOOL_RUN_MIN) {
      items.push({ kind: "toolRun", id: `run-${run[0]!.id}`, calls: run });
    } else {
      for (const block of run) items.push({ kind: "single", block });
    }
    run = [];
  };

  // current turn segment (rollup source) — a turn spans from the previous
  // boundary (user prompt or an earlier turnEnd) to its turnEnd block
  let toolCalls = 0;
  let byKind: Partial<Record<ToolCallKind, number>> = {};
  let files = new Set<string>();
  const resetTurn = () => {
    toolCalls = 0;
    byKind = {};
    files = new Set();
  };

  // whole-session counters — never reset at turn boundaries
  let prompts = 0;
  let totalCalls = 0;
  const allFiles = new Set<string>();
  const diffableFiles = new Set<string>();

  for (const block of blocks) {
    if (block.kind === "toolCall") {
      run.push(block);
      toolCalls++;
      totalCalls++;
      byKind[block.toolKind] = (byKind[block.toolKind] ?? 0) + 1;
      if (FILE_TOUCHING.has(block.toolKind)) {
        for (const path of block.locations) {
          files.add(path);
          allFiles.add(path);
        }
      }
      for (const path of block.diffFiles) diffableFiles.add(path);
      continue;
    }
    flushRun();
    items.push({ kind: "single", block });
    if (block.kind === "diff") {
      // the fs/write gate's own card: an agent file write even when no
      // tool_call named the path — counted only once actually written
      // (accepted); ± regardless, its baseline was noted at card time
      diffableFiles.add(block.file);
      if (block.resolution?.accepted === true) {
        files.add(block.file);
        allFiles.add(block.file);
      }
    }
    if (block.kind === "user") {
      // A harness-injected envelope started a real turn (the agent answered
      // it), so it still resets the segment — but it isn't a human prompt.
      if (block.injected !== true) prompts++;
      resetTurn();
    }
    if (block.kind === "turnEnd") {
      rollups.set(block.id, { toolCalls, filesTouched: files.size, byKind });
      resetTurn();
    }
  }
  flushRun();

  const last = blocks[blocks.length - 1];
  const liveBlockId =
    live && last !== undefined && (last.kind === "text" || last.kind === "thought") ? last.id : null;

  return {
    items,
    rollups,
    liveRollup: { toolCalls, filesTouched: files.size, byKind },
    totals: { prompts, toolCalls: totalCalls, files: [...allFiles] },
    diffableFiles,
    liveBlockId,
  };
}

/** "1 tool call" / "3 tool calls" — the one pluralizer for count read-outs
 * (turn line, composer stats). Naive s-suffix, which every counted noun
 * here satisfies. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "1m 29s" (or "12s", "1h 02m") — duration between two ISO timestamps. */
export function formatDuration(startedAt: string, endedAt: string): string {
  const ms = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
