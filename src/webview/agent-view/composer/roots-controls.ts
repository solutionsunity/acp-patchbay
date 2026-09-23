// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The roots chip's delivery verdict as a pure function — the roots sibling
// of composer-controls.ts, extracted for the same reason: every reachable
// state of the facts it reads is named in a test, never an inline render
// expression. A session's root list has two readers. The MCP servers
// patchbay attaches always have it, live — telling them is patchbay's own
// act. The agent has it only through the protocol, and only on a lifecycle
// request, so whether and when the agent gets a root is what varies; this
// derives that from the same declared facts the session manager's
// re-apply reads, so the chip tells the truth the writer holds. Adding is
// never gated: a root reaches the servers regardless.
import type { SavedRootsView } from "../../../shared/protocol";

/** When the agent gets a root added now. */
export type AgentDelivery =
  /** With the next prompt: the session is fresh (re-minted for free) or
   * the agent re-applies in place through `session/resume`. */
  | "live"
  /** The agent cannot take it mid-session but can reopen: it rides the
   * next `session/load`. */
  | "nextOpen"
  /** The agent never gets it on this session: the field is not advertised,
   * or the session has turns and the agent offers no way to reopen. */
  | "never";

export interface RootsControls {
  agent: AgentDelivery;
  /** The one-line reason when the agent's delivery is not live, or null. */
  note: string | null;
}

export function rootsControls(facts: {
  /** The agent advertises `sessionCapabilities.additionalDirectories`. */
  advertised: boolean;
  /** The agent declares `session/resume` — the one re-apply rung after a turn. */
  resumeDeclared: boolean;
  /** The agent declares `session/load` — the rung a reopen takes. */
  loadDeclared: boolean;
  /** The session has at least one turn (a zero-turn session re-mints itself for free). */
  hasTurns: boolean;
}): RootsControls {
  if (!facts.advertised) {
    return {
      agent: "never",
      note: "this agent doesn't take extra roots — the MCP servers have them; reference paths with @ for the agent",
    };
  }
  if (!facts.hasTurns || facts.resumeDeclared) return { agent: "live", note: null };
  if (facts.loadDeclared) {
    return {
      agent: "nextOpen",
      note: "this agent takes new roots at its next open — the MCP servers have them now",
    };
  }
  return {
    agent: "never",
    note: "this agent can't take roots after the first prompt — the MCP servers have them",
  };
}

/** The row label: who holds this root. The cwd is the agent's working
 * directory, delivered by definition. */
export function rootHolders(agent: AgentDelivery, isCwd: boolean): string {
  if (isCwd || agent === "live") return "agent + MCP";
  return agent === "nextOpen" ? "MCP · agent at next open" : "MCP only";
}

/** A user-added row's save state: already saved — named by the list that
 * holds it, managed in Settings — or offered for saving, where "this
 * workspace" needs an open folder. */
export type RootSaving =
  | { kind: "saved"; label: string }
  | { kind: "unsaved"; workspaceOpen: boolean };

export function rootSaving(path: string, saved: SavedRootsView): RootSaving {
  if (saved.workspace?.includes(path) === true) return { kind: "saved", label: "saved · this workspace" };
  if (saved.machine.includes(path)) return { kind: "saved", label: "saved · every workspace" };
  return { kind: "unsaved", workspaceOpen: saved.workspace !== null };
}
