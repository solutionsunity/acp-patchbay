// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Where the user was reading a session the chat left, and how much of the
// transcript the chat must mount to find it again. The chat records a
// position once, as it leaves a session, and lands on it when it comes back.

/** A reading place: the transcript item at the top edge of the chat's
 * viewport, and how far into the item that edge sits. An item, not a scroll
 * offset — pixels drift with the view's width and with late rendering
 * (diagrams, formulas); the item stays where it is. */
export interface ReadingPosition {
  item: string;
  offset: number;
}

/** A transcript row as laid out, its edges in the viewport's coordinates. */
export interface RowBox {
  item: string;
  top: number;
  bottom: number;
}

/** Where a session is left. Following its end is no position: the session
 * comes back at its end, still following. A row that takes no space (its
 * item rendered nothing) is no place to read. */
export function readingPosition(pinned: boolean, rows: readonly RowBox[], viewportTop: number): ReadingPosition | null {
  if (pinned) return null;
  const row = rows.find((r) => r.bottom > r.top && r.bottom > viewportTop);
  return row === undefined ? null : { item: row.item, offset: viewportTop - row.top };
}

/** How many of the newest items the chat must mount to hold `item`; null
 * when the transcript no longer has it. */
export function windowHolding(items: readonly string[], item: string): number | null {
  const index = items.indexOf(item);
  return index < 0 ? null : items.length - index;
}
