// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Structural subset of vscode.Memento — stores depend on this, tests fake it.
export interface KV {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export class MemoryKV implements KV {
  private map = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}
