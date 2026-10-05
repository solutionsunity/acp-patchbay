// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Patchbay's own ids, one type per store. A row's own id is its `id`;
// anywhere else one travels as `patchbay<Store>Id` — a field on another
// row, a message, a parameter — so a name says whose id it holds. The brand
// keeps one store's id from standing in for another's, and keeps a string
// from elsewhere — a registry id, an agent's own id for a session — from
// standing in for ours: an id becomes one of ours only where its store
// mints it or reads it back. The agents' own ids keep the SDK's types;
// they are the agents', not ours.
declare const store: unique symbol;
type Id<Store extends string> = string & { readonly [store]: Store };

export type PatchbayAgentId = Id<"agent">;
