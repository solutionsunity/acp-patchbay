// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What an agent's own facts allow on it — one reading for the agents
// store, which refuses anything else, and for the Settings card, which
// offers these and adds only when they make sense to show (running, not
// logged out). Log out is what the agent declares — the protocol says
// clients must not call it otherwise; the version moves are what its link
// to the ACP registry allows.
import type { CapabilityMatrix, VersionMove } from "./protocol";

/** The facts the offers are read from. `link` and `previous` stand for
 * whether the agent has them — the store holds them whole, the Settings
 * view their pinned versions. */
export interface AgentOfferFacts {
  /** The handshake's claims; absent until the agent has been heard from. */
  matrix: CapabilityMatrix | undefined;
  origin: string | null;
  link: unknown;
  previous: unknown;
}

export type AgentOffers = { logout: boolean } & Record<VersionMove, boolean>;

/** Upgrade a linked agent, Reset an edited one to the registry it came
 * from, Back one that keeps the link its last Upgrade replaced. */
export function agentOffers(facts: AgentOfferFacts): AgentOffers {
  const fromRegistry = facts.origin !== null;
  return {
    logout: facts.matrix?.["auth.logout"].declared === true,
    upgrade: fromRegistry && facts.link !== null,
    reset: fromRegistry && facts.link === null,
    goBack: fromRegistry && facts.previous !== null,
  };
}
