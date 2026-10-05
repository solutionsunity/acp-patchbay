// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The "last open session" pointer: which session the Agent View returns to
// after an extension-host restart. Deliberately NOT freshness-bounded like
// last-connected.ts — reopening a chat's *view* is free and safe at any age
// (open never emulates, never spawns), while resurrecting *processes* is
// not; quit-and-reopen-days-later should still land on the same chat.
// Deliberately NOT a session-index column either: "last open" is a pointer
// into the set, not a fact about a session — exactly one may hold it, and a
// per-entry flag invites the two-entries-true drift bug.
// It names the session the way the next window can find it again: by its
// agent and the agent's own id for it — patchbay's ids live with a window.
// A value of any other shape is no pointer.
// workspaceState: sessions are cwd-bound, machine-local, non-sensitive.
import type { KV } from "./kv";
import type { PatchbayAgentId } from "../../shared/ids";

const KEY = "acpPatchbay.lastActiveSession";

export interface SessionPointer {
  agentId: PatchbayAgentId;
  /** The agent's own id for the session. */
  sessionId: string;
}

function isPointer(value: unknown): value is SessionPointer {
  if (value === null || typeof value !== "object") return false;
  const { agentId, sessionId } = value as Record<string, unknown>;
  return typeof agentId === "string" && typeof sessionId === "string";
}

export class LastActiveSessionStore {
  constructor(private readonly kv: KV) {}

  get(): SessionPointer | undefined {
    const value = this.kv.get<unknown>(KEY);
    return isPointer(value) ? value : undefined;
  }

  async set(pointer: SessionPointer): Promise<void> {
    const current = this.get();
    if (current?.agentId === pointer.agentId && current.sessionId === pointer.sessionId) return;
    await this.kv.update(KEY, { agentId: pointer.agentId, sessionId: pointer.sessionId });
  }

  /** The session it points at closed, or "Disconnect & erase all data". */
  async wipe(): Promise<void> {
    await this.kv.update(KEY, undefined);
  }
}
