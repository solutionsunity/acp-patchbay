// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// How a root added to a session reaches its agent — one reading for the
// sessions store, which re-applies by it, and for the roots chip, which
// tells the user what that does. The agent takes roots only on a lifecycle
// request, and only when it advertises the field, so the answer is a rung
// of the protocol's ladder, read from what the agent declared and from
// whether the session has had a turn.
export type RootDelivery =
  /** The session has no turn: re-minted with the new list, for free. */
  | "remint"
  /** Re-applied in place on the same connection: `session/resume`. */
  | "resume"
  /** No re-apply mid-session; the next `session/load` carries it. */
  | "nextOpen"
  /** The field isn't advertised, or the session has turns and the agent
   * offers no way to reopen. */
  | "never";

export function rootDelivery(facts: {
  /** The agent advertises `sessionCapabilities.additionalDirectories`. */
  advertised: boolean;
  /** The agent declares `session/resume`. */
  resumeDeclared: boolean;
  /** The agent declares `session/load`. */
  loadDeclared: boolean;
  /** The session has had at least one turn — its store's fact. */
  hasTurns: boolean;
}): RootDelivery {
  if (!facts.advertised) return "never";
  if (!facts.hasTurns) return "remint";
  if (facts.resumeDeclared) return "resume";
  return facts.loadDeclared ? "nextOpen" : "never";
}
