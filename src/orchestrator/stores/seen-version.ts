// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The newest Patchbay version a window on this machine has run — what tells
// a start after an update from a start like any other. Machine store: every
// window runs the same installed copy, so one window's record is every
// window's.
import type { KV } from "./kv";
import { STORAGE_KEYS } from "./storage-keys";

const KEY = STORAGE_KEYS.seenVersion;

export class SeenVersionStore {
  constructor(private readonly kv: KV) {}

  /** As stored — read by whoever weighs it. */
  get(): unknown {
    return this.kv.get<unknown>(KEY);
  }

  async record(version: string): Promise<void> {
    await this.kv.update(KEY, version);
  }

  /** "Disconnect & erase all data". */
  async wipe(): Promise<void> {
    await this.kv.update(KEY, undefined);
  }
}
