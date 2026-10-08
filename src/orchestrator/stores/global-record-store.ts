// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Record stores over the machine-scoped KV (file-kv.ts): a list of records
// under one key, read whole and rewritten whole. Agents, MCP servers, auth
// locks and the used-capability cache are keyed by their own id — list,
// upsert-by-id, remove-by-id; the records a person names (agents, MCP
// servers) never hold one name twice. A session's continuity row has
// no id of its own and is found by its pair. Same trust-boundary treatment
// as acp-registry.ts/registry.ts: zod-validated on read, a malformed stored
// record is dropped rather than trusted blind.
import type { z } from "zod";
import { freeName } from "../../shared/names";
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
      this.admit(value, current);
      const index = current.findIndex((v) => v.id === value.id);
      if (index === -1) current.push(value);
      else current[index] = value;
      return current;
    });
  }

  async remove(id: T["id"]): Promise<void> {
    await this.rewrite((current) => current.filter((v) => v.id !== id));
  }

  /** Throws when `value` may not be upserted beside `current` — checked in
   * the write itself. */
  protected admit(_value: T, _current: readonly T[]): void {}

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
  constructor(kv: KV, key: string, schema: z.ZodType<T>) {
    super(kv, key, schema);
    // Once, at construction: a name stored before the store's rule held it —
    // one two records share, or one an add would now change — is given the
    // name an add gives it, so every later write meets the rule. A name an
    // add would keep stays; the first of two that share it keeps it.
    const stored = kv.get<unknown>(key);
    if (!Array.isArray(stored)) return;
    const named = (r: unknown): r is { name: string } =>
      typeof r === "object" && r !== null && "name" in r && typeof r.name === "string";
    const kept: string[] = [];
    const keeps = stored.map((r: unknown) => {
      if (!named(r) || this.freeName(r.name, kept) !== r.name) return false;
      kept.push(r.name);
      return true;
    });
    if (stored.every((r: unknown, i) => keeps[i] || !named(r))) return;
    const taken = [...kept];
    void kv.update(
      key,
      stored.map((r: unknown, i) => {
        if (keeps[i] || !named(r)) return r;
        const name = this.freeName(r.name, taken);
        taken.push(name);
        return { ...r, name };
      }),
    );
  }

  /** Adds a record under a name no other record holds — picked in the same
   * write, so two adds can't both take it. Returns the name it got. */
  async add(value: T): Promise<string> {
    let name = value.name;
    await this.rewrite((current) => {
      name = this.freeName(value.name, current.map((v) => v.name));
      current.push({ ...value, name });
      return current;
    });
    return name;
  }

  /** The name an add of `name` takes beside the `taken` ones: a taken name
   * gets a number ("Claude 2"). */
  protected freeName(name: string, taken: readonly string[]): string {
    return freeName(name, new Set(taken), " ");
  }

  /** A write never takes a name another record holds — an add numbers the
   * name it was given, any other write is refused. */
  protected override admit(value: T, current: readonly T[]): void {
    if (current.some((v) => v.id !== value.id && v.name === value.name)) throw new Error(`"${value.name}" is taken`);
  }
}
