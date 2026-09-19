// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The curated catalog's narrowing gate — which rows show, derived as a
// pure function over the registry views so it is tested as logic, never
// read off an inline render expression. Two narrowers, AND-combined:
// free text over what the row shows — name and description, never the
// caveat note (a hit in text the row doesn't display reads as a false
// positive) — and the mechanism chips the rows already wear, turned into
// toggles. The catalog is shipped data meant to grow; at eight rows a
// plain list reads, at fifty it needs this.
import type { RegistryEntryView } from "../../shared/protocol";

/** The three ways a curated entry can be connected — one home for "what
 * this entry offers", read by the row chips and the filter toggles alike. */
export type Mechanism = "key" | "oauth" | "local";
export const MECHANISMS: readonly Mechanism[] = ["key", "oauth", "local"];

export function mechanismsOf(entry: RegistryEntryView): ReadonlySet<Mechanism> {
  const has = new Set<Mechanism>();
  if (entry.headerAuth !== null) has.add("key");
  if (entry.oauth) has.add("oauth");
  if (entry.local !== null) has.add("local");
  return has;
}

/** Rows matching the text (case-insensitive substring of name or
 * description; blank = all) and offering EVERY selected mechanism (none
 * selected = all). Order is the registry's — the filter narrows, never
 * re-sorts. */
export function filterCatalog(
  entries: readonly RegistryEntryView[],
  query: string,
  mechanisms: ReadonlySet<Mechanism>,
): RegistryEntryView[] {
  const text = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (
      text !== "" &&
      !entry.name.toLowerCase().includes(text) &&
      !entry.description.toLowerCase().includes(text)
    ) {
      return false;
    }
    const offered = mechanismsOf(entry);
    for (const mechanism of mechanisms) if (!offered.has(mechanism)) return false;
    return true;
  });
}
