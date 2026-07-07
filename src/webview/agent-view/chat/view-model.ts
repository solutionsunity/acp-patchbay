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

export interface TranscriptView {
  items: readonly TranscriptItem[];
  /** Per-turn rollup, keyed by the turnEnd block that closes the turn. */
  rollups: ReadonlyMap<string, TurnRollup>;
  /** The one live block (last block, text/thought, turn in flight) — null
   * when nothing is receiving deltas. */
  liveBlockId: string | null;
}

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

  for (const block of blocks) {
    if (block.kind === "toolCall") {
      run.push(block);
      toolCalls++;
      byKind[block.toolKind] = (byKind[block.toolKind] ?? 0) + 1;
      if (FILE_TOUCHING.has(block.toolKind)) for (const path of block.locations) files.add(path);
      continue;
    }
    flushRun();
    items.push({ kind: "single", block });
    if (block.kind === "user") resetTurn();
    if (block.kind === "turnEnd") {
      rollups.set(block.id, { toolCalls, filesTouched: files.size, byKind });
      resetTurn();
    }
  }
  flushRun();

  const last = blocks[blocks.length - 1];
  const liveBlockId =
    live && last !== undefined && (last.kind === "text" || last.kind === "thought") ? last.id : null;

  return { items, rollups, liveBlockId };
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
