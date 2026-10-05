// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Record stores over the machine-scoped KV (file-kv.ts): a list of records
// under one key, read whole and rewritten whole. Agents, MCP servers, auth
// locks and the used-capability cache are keyed by their own id — list,
// upsert-by-id, remove-by-id; the records a person names (agents, MCP
// servers) add under a name no other holds. A session's continuity row has
// no id of its own and is found by its pair. Same trust-boundary treatment
// as acp-registry.ts/registry.ts: zod-validated on read, a malformed stored
// record is dropped rather than trusted blind.
import type { z } from "zod";
import type { KV } from "./kv";

export class RecordStore<T> {
  constructor(
    private readonly kv: KV,
    private readonly key: string,
    private readonly schema: z.ZodType<T>,
  ) {}

  list(): T[] {
    const raw = this.kv.get<unknown[]>(this.key) ?? [];
    const out: T[] = [];
    for (const item of raw) {
      const parsed = this.schema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  /** "Disconnect & erase all data": every record goes, one that no longer
   * reads as a record included. */
  async wipe(): Promise<void> {
    await this.kv.update(this.key, undefined);
  }

  /** The one write: every mutation is a transform of the whole list
   * followed by a single KV update, so a multi-row change (a reconcile,
   * a per-agent drop) costs one file rewrite, never one per row. */
  protected async rewrite(transform: (current: T[]) => T[]): Promise<void> {
    await this.kv.update(this.key, transform(this.list()));
  }
}

/** Records keyed by their own id. */
export class GlobalRecordStore<T extends { id: string }> extends RecordStore<T> {
  get(id: T["id"]): T | undefined {
    return this.list().find((v) => v.id === id);
  }

  async upsert(value: T): Promise<void> {
    await this.rewrite((current) => {
      const index = current.findIndex((v) => v.id === value.id);
      if (index === -1) current.push(value);
      else current[index] = value;
      return current;
    });
  }

  async remove(id: T["id"]): Promise<void> {
    await this.rewrite((current) => current.filter((v) => v.id !== id));
  }

  /** Persist a new array order. `ids` is a view's picture of the order at
   * drop time — records it doesn't name (added since, or never shown there)
   * keep their relative order at the tail rather than being dropped, so a
   * stale picture can never lose data. */
  async reorder(ids: readonly T["id"][]): Promise<void> {
    const rank = new Map(ids.map((id, i) => [id, i]));
    await this.rewrite((current) => {
      const named = current.filter((v) => rank.has(v.id));
      named.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
      return [...named, ...current.filter((v) => !rank.has(v.id))];
    });
  }
}

/** Records a person tells apart by name — no two hold one. */
export class NamedRecordStore<T extends { id: string; name: string }> extends GlobalRecordStore<T> {
  /** Adds a record under a name no other record holds — picked in the same
   * write, so two adds can't both take it. A taken name, or a `reserved`
   * one, gets a number ("GitHub 2"). Returns the name it got. */
  async add(value: T, reserved: readonly string[] = []): Promise<string> {
    let name = value.name;
    await this.rewrite((current) => {
      const taken = new Set([...reserved, ...current.map((v) => v.name)]);
      for (let n = 2; taken.has(name); n++) name = `${value.name} ${n}`;
      current.push({ ...value, name });
      return current;
    });
    return name;
  }
}
