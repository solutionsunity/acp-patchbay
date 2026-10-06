// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What the session menu offers on a session — what its agent declares in
// its handshake, and nothing patchbay stands in for. One reading for the
// menu, which offers these, and for the sessions store, which refuses
// anything else. The capability matrix shows what was collected about an
// agent; it decides nothing, so only the declared column is read here.
import type { CapabilityMatrix } from "./protocol";

export interface SessionOffers {
  /** ACP's `session/fork`: a new session the agent seeds with this one's
   * context; this one stays as it is. */
  fork: boolean;
  /** ACP's `session/delete`: the agent removes the session from its
   * history, and patchbay forgets what it kept for it. */
  delete: boolean;
  /** ACP's `session/close`: the agent stops the session's work and frees
   * what it holds for it. The session leaves the list — an agent that lists
   * its sessions lists it again at the next read — and patchbay keeps what
   * it saved for it. */
  close: boolean;
}

/** An agent not yet heard from offers nothing. */
export function sessionOffers(matrix: CapabilityMatrix | undefined): SessionOffers {
  if (matrix === undefined) return { fork: false, delete: false, close: false };
  return {
    fork: matrix["session.fork"].declared,
    delete: matrix["session.delete"].declared,
    close: matrix["session.close"].declared,
  };
}
