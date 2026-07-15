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
// workspaceState: sessions are cwd-bound, machine-local, non-sensitive.
import type { KV } from "./kv";

const KEY = "acpPatchbay.lastActiveSession";

export class LastActiveSessionStore {
  constructor(private readonly kv: KV) {}

  get(): string | undefined {
    return this.kv.get<string>(KEY);
  }

  async set(sessionId: string): Promise<void> {
    if (this.kv.get<string>(KEY) === sessionId) return;
    await this.kv.update(KEY, sessionId);
  }

  /** Clear only while it still points at `sessionId` — closing a session
   * the user already switched away from must not erase the newer pointer. */
  async clearIf(sessionId: string): Promise<void> {
    if (this.kv.get<string>(KEY) === sessionId) await this.kv.update(KEY, undefined);
  }

  /** "Disconnect & erase all data". */
  async wipe(): Promise<void> {
    await this.kv.update(KEY, undefined);
  }
}
