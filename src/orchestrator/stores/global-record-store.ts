// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Generic id-keyed record store over the machine-scoped KV (file-kv.ts) —
// agents,
// integrations, and the used-capability cache are all "developer env,
// not code env" (never repo-committed) and all need the same shape: list,
// upsert-by-id, remove-by-id. One implementation, three instantiations.
// Same trust-boundary treatment as acp-registry.ts/registry.ts: zod-validated
// on read, a malformed stored record is dropped rather than trusted blind.
import type { z } from "zod";
import type { KV } from "./kv";

export class GlobalRecordStore<T extends { id: string }> {
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

  get(id: string): T | undefined {
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

  async remove(id: string): Promise<void> {
    await this.rewrite((current) => current.filter((v) => v.id !== id));
  }

  /** Persist a new array order. `ids` is a view's picture of the order at
   * drop time — records it doesn't name (added since, or never shown there)
   * keep their relative order at the tail rather than being dropped, so a
   * stale picture can never lose data. */
  async reorder(ids: readonly string[]): Promise<void> {
    const rank = new Map(ids.map((id, i) => [id, i]));
    await this.rewrite((current) => {
      const named = current.filter((v) => rank.has(v.id));
      named.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
      return [...named, ...current.filter((v) => !rank.has(v.id))];
    });
  }

  /** The one write: every mutation is a transform of the whole list
   * followed by a single KV update, so a multi-row change (a reconcile,
   * a per-agent drop) costs one file rewrite, never one per row. */
  protected async rewrite(transform: (current: T[]) => T[]): Promise<void> {
    await this.kv.update(this.key, transform(this.list()));
  }
}
