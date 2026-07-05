// Session index: patchbay's registry of session IDs, titles, timestamps, agent.
// Exists because ACP has no session enumeration (architecture.md § State).
// Placement: workspaceState — small, machine-local, non-sensitive.
import type { KV } from "./kv";

export interface SessionIndexEntry {
  id: string;
  agentId: string;
  title: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
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

  async rename(id: string, title: string): Promise<void> {
    const entries = this.list();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    entry.title = title;
    entry.updatedAt = new Date().toISOString();
    await this.kv.update(KEY, entries);
  }

  async remove(id: string): Promise<void> {
    await this.kv.update(
      KEY,
      this.list().filter((e) => e.id !== id),
    );
  }
}
