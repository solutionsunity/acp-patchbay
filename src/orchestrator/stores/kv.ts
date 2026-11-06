// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Structural subset of vscode.Memento — stores depend on this, tests fake it.
export interface KV {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** A store's entry in a KV — the key it is stored under and the value as
 * stored there — read whole by whatever carries the store's contents
 * elsewhere. */
export interface StoredEntry {
  readonly key: string;
  stored(): unknown;
}

/** A store's rewrite of what it found as it opened, which nothing waits on.
 * A write that fails moves nothing: what is stored keeps its old shape, and
 * the next open rewrites it again. */
export function rewriteAtOpen(write: Thenable<unknown>): void {
  write.then(undefined, () => {});
}

export class MemoryKV implements KV {
  private map = new Map<string, unknown>();

  set(key: string, value: unknown): void {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
  }

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.set(key, value);
    return Promise.resolve();
  }
}
