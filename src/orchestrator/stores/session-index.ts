// Session index: patchbay's registry of session IDs, titles, timestamps, agent.
// Two jobs since ACP grew `session/list`: the only list for agents that don't
// declare it, and the overlay everywhere — facts the wire can't carry
// (emulated, branchOf, renamedByUser, lastConfirmed). For list-capable agents
// the wire is the truth for *who exists*; SessionManager.syncAgentSessions
// reconciles this index against it on every connect.
// Placement: workspaceState — small, machine-local, non-sensitive.
import type { KV } from "./kv";

export interface SessionIndexEntry {
  id: string;
  agentId: string;
  title: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  /** Continuation seeded by patchbay, not replayed natively — persisted so
   * the label survives a restart (a rehydrated list must not launder an
   * emulated session into a native-looking one). Optional: entries written
   * before this field existed default to false on read. */
  emulated?: boolean;
  /** Parent session id when this is a branch — same restart-survival
   * rationale as `emulated`. */
  branchOf?: string | null;
  /** True once the user explicitly renamed this session. The one title
   * authority rule (architecture.md § Session model): the agent's own title
   * (session/list, session_info_update) wins over patchbay's auto-derived
   * one, but never over an explicit rename — which has no wire request, so
   * it lives only here. */
  renamedByUser?: boolean;
  /** The session's last agent-confirmed knob combination — recorded from the
   * agent's own responses/notifications, never from what patchbay requested
   * (architecture.md § Session model). Seeds emulated continuations, the one
   * session birth with no reality left to read; never re-imposed on native
   * load/fork, where the agent's restored state is the truth.
   * `options` is knob-id-keyed (knobs.ts); `modeId` is legacy-read-only,
   * folded on read (foldSeed) and never written again. */
  lastConfirmed?: {
    modeId?: string;
    options?: Readonly<Record<string, string | boolean>>;
  };
}

const KEY = "acpPatchbay.sessionIndex";

export class SessionIndexStore {
  constructor(private readonly kv: KV) {}

  list(): SessionIndexEntry[] {
    return this.kv.get<SessionIndexEntry[]>(KEY) ?? [];
  }

  get(id: string): SessionIndexEntry | undefined {
    return this.list().find((e) => e.id === id);
  }

  async upsert(entry: SessionIndexEntry): Promise<void> {
    const entries = this.list();
    const i = entries.findIndex((e) => e.id === entry.id);
    if (i === -1) entries.push(entry);
    else entries[i] = entry;
    await this.kv.update(KEY, entries);
  }

  /** Merges a confirmed-knob observation into the entry (knob-id-keyed —
   * the legacy modeId field is read-only history, never written here).
   * No entry (a session the index never saw) is a no-op, not an error. */
  async recordConfirmed(
    id: string,
    patch: { options: Readonly<Record<string, string | boolean>> },
  ): Promise<void> {
    const entries = this.list();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    entry.lastConfirmed = {
      ...entry.lastConfirmed,
      options: { ...entry.lastConfirmed?.options, ...patch.options },
    };
    await this.kv.update(KEY, entries);
  }

  /** `byUser` marks an explicit rename (see `renamedByUser`) — auto-titling
   * and agent-title merges leave it unset so the agent can keep winning. */
  async rename(id: string, title: string, byUser = false): Promise<void> {
    const entries = this.list();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    entry.title = title;
    entry.updatedAt = new Date().toISOString();
    if (byUser) entry.renamedByUser = true;
    await this.kv.update(KEY, entries);
  }

  /** Bumps the activity stamp — the drawer's sort key ("latest" = last
   * activity). Called at prompt send so ordering survives a restart. */
  async touch(id: string, at: string): Promise<void> {
    const entries = this.list();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    entry.updatedAt = at;
    await this.kv.update(KEY, entries);
  }

  async remove(id: string): Promise<void> {
    await this.kv.update(
      KEY,
      this.list().filter((e) => e.id !== id),
    );
  }
}
