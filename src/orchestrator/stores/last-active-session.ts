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
// The bare id 0.84.1 stored is folded into that pair by `resolve`; a value
// of any other shape is no pointer.
// workspaceState: sessions are cwd-bound, machine-local, non-sensitive.
import type { KV } from "./kv";
import type { PatchbayAgentId } from "../../shared/ids";

const KEY = "acpPatchbay.lastActiveSession";

export interface SessionPointer {
  patchbayAgentId: PatchbayAgentId;
  /** The agent's own id for the session. */
  sessionId: string;
}

function isPointer(value: unknown): value is SessionPointer {
  if (value === null || typeof value !== "object") return false;
  const { patchbayAgentId, sessionId } = value as Record<string, unknown>;
  return typeof patchbayAgentId === "string" && typeof sessionId === "string";
}

export class LastActiveSessionStore {
  constructor(private readonly kv: KV) {
    // Once, at construction: a pointer written before agent ids were named
    // for their store holds the agent as `agentId` — rewritten under the
    // name it has now, so the window that installs this version still
    // returns to the session it left.
    const stored = kv.get<unknown>(KEY);
    if (typeof stored === "object" && stored !== null && "agentId" in stored) {
      const { agentId, ...rest } = stored;
      void kv.update(KEY, { ...rest, patchbayAgentId: agentId });
    }
  }

  get(): SessionPointer | undefined {
    const value = this.kv.get<unknown>(KEY);
    return isPointer(value) ? value : undefined;
  }

  /** Whether there is anything to return to — a pointer, or a bare id
   * still to fold. */
  stored(): boolean {
    return this.get() !== undefined || typeof this.kv.get<unknown>(KEY) === "string";
  }

  /** The pointer as the pair it names. 0.84.1 stored a bare id: the agent's
   * own id for a session, with no agent. Once the startup lists are in,
   * `named` gives the sessions answering to it — one becomes the pointer;
   * several are ambiguous for good, so the pointer goes; none may be an
   * agent that hasn't connected yet, so the id stays for a later window. */
  async resolve(named: (sessionId: string) => readonly SessionPointer[]): Promise<SessionPointer | undefined> {
    const pointer = this.get();
    if (pointer !== undefined) return pointer;
    const bare = this.kv.get<unknown>(KEY);
    if (typeof bare !== "string") return undefined;
    const matches = named(bare);
    if (matches.length > 1) await this.wipe();
    if (matches.length !== 1) return undefined;
    await this.set(matches[0]!);
    return matches[0];
  }

  async set(pointer: SessionPointer): Promise<void> {
    const current = this.get();
    if (current?.patchbayAgentId === pointer.patchbayAgentId && current.sessionId === pointer.sessionId) return;
    await this.kv.update(KEY, { patchbayAgentId: pointer.patchbayAgentId, sessionId: pointer.sessionId });
  }

  /** The session it points at closed, or "Disconnect & erase all data". */
  async wipe(): Promise<void> {
    await this.kv.update(KEY, undefined);
  }
}
