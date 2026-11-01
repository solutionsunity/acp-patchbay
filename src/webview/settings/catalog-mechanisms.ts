// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The three ways a curated entry can be connected — one home for "what
// this entry offers", read by the picker's tags and the entry's details
// alike.
import type { CatalogEntryView } from "../../shared/protocol";

export type Mechanism = "key" | "oauth" | "local";

export function mechanismsOf(entry: CatalogEntryView): ReadonlySet<Mechanism> {
  const has = new Set<Mechanism>();
  if (entry.headerAuth !== null) has.add("key");
  if (entry.oauth) has.add("oauth");
  if (entry.local !== null) has.add("local");
  return has;
}
