// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A transcript block's id. Every block patchbay makes — the stream's runs,
// parts and turn lines, the sessions store's notices, the broker's cards —
// draws on this one counter, so no two of them share an id.
let counter = 0;

/** A transcript block's id, unique for the window. */
export function newBlockId(prefix: string): string {
  return `${prefix}-${++counter}`;
}
