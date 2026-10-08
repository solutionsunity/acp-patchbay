// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The names a person tells records apart by — read on both sides of the
// webview boundary: a store's add picks a name here, and a form previews the
// name that add will pick.

/** `name` itself when free, else the first `${name}${separator}${n}` from 2
 * up that is. */
export function freeName(name: string, taken: ReadonlySet<string>, separator: string): string {
  let free = name;
  for (let n = 2; taken.has(free); n++) free = `${name}${separator}${n}`;
  return free;
}

/** The name patchbay's own editor server goes to agents under — no stored
 * server takes it. */
export const EDITOR_SERVER_NAME = "patchbay";

/** An MCP server's name is the key it goes to an agent under: agents build
 * its tool ids from it and keep "always allow" rules under it, so it never
 * changes once added. Agents keep only `[a-zA-Z0-9_-]` there — the
 * function-name alphabet of the model APIs they call — and rewrite every
 * other character to `_` themselves; the name is cut the same way here, so
 * the name a person sees is the one every agent uses. */
export function mcpServerName(typed: string): string {
  return typed.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** The name an MCP server added as `typed` takes beside the `taken` ones.
 * The taken check runs after the cut: two names an agent would merge are
 * two names here. */
export function addedMcpServerName(typed: string, taken: Iterable<string>): string {
  return freeName(mcpServerName(typed), new Set([EDITOR_SERVER_NAME, ...taken]), "-");
}
