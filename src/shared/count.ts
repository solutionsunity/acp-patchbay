// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

/** "1 tool call" / "3 tool calls" — the one pluralizer for counts in text
 * a person reads, on either side of the webview boundary. Naive s-suffix,
 * which every counted noun here satisfies. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
