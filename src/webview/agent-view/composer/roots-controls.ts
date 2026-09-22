// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The roots chip's gate as a pure function — the roots sibling of
// composer-controls.ts, extracted for the same reason: every reachable
// state of the facts it reads is named in a test, never an inline render
// expression. A UX courtesy, not the invariant: the pool never sends
// `additionalDirectories` to an agent that does not advertise it, and the
// session manager refuses an add that could not land. This derives the
// same verdict for display, from the same two declared facts and the
// session's turn count, so the chip tells the truth the writers hold.

export interface RootsControls {
  /** Whether the roots the chip shows actually reach the agent — false
   * for an agent that does not advertise the field, where every row is
   * labelled as not delivered. */
  delivered: boolean;
  /** Whether "Add folder…" is live. */
  canAdd: boolean;
  /** The one-line reason when it is not, or null. */
  note: string | null;
}

export function rootsControls(facts: {
  /** The agent advertises `sessionCapabilities.additionalDirectories`. */
  advertised: boolean;
  /** The agent declares `session/resume` — the one re-apply rung after a turn. */
  resumeDeclared: boolean;
  /** The session has at least one turn (a zero-turn session re-mints itself for free). */
  hasTurns: boolean;
}): RootsControls {
  if (!facts.advertised) {
    return {
      delivered: false,
      canAdd: false,
      note: "this agent doesn't support extra roots — reference paths with @ instead",
    };
  }
  if (facts.hasTurns && !facts.resumeDeclared) {
    return {
      delivered: true,
      canAdd: false,
      note: "add roots before the first prompt — this agent can't re-apply them mid-session",
    };
  }
  return { delivered: true, canAdd: true, note: null };
}
