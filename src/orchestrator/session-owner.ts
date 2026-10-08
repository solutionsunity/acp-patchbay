// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Whose session an agent names. An agent speaks of its sessions by its own
// ids, and an id can belong to one of three holders: the capability
// check's throwaway probe, the defaults editor's throwaway session, or a
// session the user has — or to none patchbay holds (one closed meanwhile).
// The id is read against them here, once, in one order, for every message
// that names one: what the session's updates feed, whether what the agent
// asks on it can be shown to anyone, and whether its file and terminal
// requests are served. A throwaway session is never
// shown — no surface renders one — and neither is a session patchbay
// doesn't hold: there is no transcript to show it in.
import type { PatchbayAgentId, PatchbaySessionId } from "../shared/ids";

export type SessionOwner =
  | { kind: "probe" }
  | { kind: "defaultsEditor" }
  | { kind: "user"; patchbaySessionId: PatchbaySessionId }
  | { kind: "none" };

/** The holders an id is read against. Each is agent-scoped: session ids
 * are unique only within one agent's connection. */
export interface SessionHolders {
  probe: { isProbeSession(patchbayAgentId: PatchbayAgentId, sessionId: string): boolean };
  defaultsEditor: { owns(patchbayAgentId: PatchbayAgentId, sessionId: string): boolean };
  sessions: { rowFor(patchbayAgentId: PatchbayAgentId, sessionId: string): PatchbaySessionId | undefined };
}

export function sessionOwner(holders: SessionHolders, patchbayAgentId: PatchbayAgentId, sessionId: string): SessionOwner {
  if (holders.probe.isProbeSession(patchbayAgentId, sessionId)) return { kind: "probe" };
  if (holders.defaultsEditor.owns(patchbayAgentId, sessionId)) return { kind: "defaultsEditor" };
  const patchbaySessionId = holders.sessions.rowFor(patchbayAgentId, sessionId);
  return patchbaySessionId === undefined ? { kind: "none" } : { kind: "user", patchbaySessionId };
}
