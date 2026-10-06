// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// How a session can be ended for good — what its agent offers, and nothing
// patchbay stands in for. One reading for the session menu, which offers
// these, and for the sessions store, which refuses anything else.
import type { CapabilityMatrix } from "./protocol";

export interface SessionEnds {
  /** ACP's `session/delete`: the agent removes the session from its
   * history. Only where the agent proved it — features gate on used. */
  delete: boolean;
  /** The session leaves patchbay, with ACP's `session/close` where
   * declared. Only where nothing lists sessions again: an agent with
   * `session/list` would hand the session straight back, and its list is
   * the agent's to keep, not ours to hide from. */
  close: boolean;
}

/** An agent not yet heard from offers neither. */
export function sessionEnds(matrix: CapabilityMatrix | undefined): SessionEnds {
  if (matrix === undefined) return { delete: false, close: false };
  return { delete: matrix["session.delete"].used, close: !matrix["session.list"].declared };
}
