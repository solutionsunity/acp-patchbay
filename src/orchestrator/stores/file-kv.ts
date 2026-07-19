// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// File-backed KV: one JSON file this extension owns. Exists because
// globalState rides the editor-owned state.vscdb — one SQLite file shared
// by every extension, observed arriving truncated to zero bytes after an
// unclean shutdown and taking every machine-scoped record with it. A file
// of our own, written atomically (temp + rename), can never be half-written
// by us and can be lost only with its whole directory.
//
// Semantics match Memento where it matters: get() is synchronous from an
// in-memory map loaded once at construction; update() is read-modify-write
// at key granularity, so two windows (two extension hosts, one file) merge
// per key — last write per key wins, the same contract Memento gives.
// There is no cross-process lock; a simultaneous same-key write from two
// windows is last-rename-wins, accepted for config-sized, human-paced data.
//
// First load (no file yet) drains the old Memento home into the file and
// deletes the keys there — one truth; a stale shadow left in state.vscdb
// would resurrect on downgrade and diverge forever after.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KV } from "./kv";

/** Structural subset of vscode.Memento that can enumerate itself — the
 * migration source. */
export interface EnumerableKV extends KV {
  keys(): readonly string[];
}

export class FileKV implements KV {
  private map: Record<string, unknown>;

  constructor(
    private readonly filePath: string,
    migrateFrom?: EnumerableKV,
    private readonly log: (message: string) => void = () => {},
  ) {
    const loaded = this.readDisk();
    if (loaded !== null) {
      this.map = loaded;
      return;
    }
    this.map = {};
    const keys = migrateFrom?.keys() ?? [];
    for (const key of keys) {
      const value = migrateFrom?.get(key);
      if (value !== undefined) this.map[key] = value;
    }
    this.writeDisk(this.map);
    if (keys.length > 0) {
      this.log(`created ${this.filePath} — migrated ${keys.length} entries out of globalState`);
      for (const key of keys) void migrateFrom?.update(key, undefined);
    }
  }

  get<T>(key: string): T | undefined {
    return this.map[key] as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    // Merge over the freshest disk truth so another window's keys survive;
    // only this key is ours to win. A corrupt or missing file at this point
    // falls back to the in-memory map — the best remaining truth.
    const disk = this.readDisk() ?? this.map;
    const next = { ...disk };
    if (value === undefined) delete next[key];
    else next[key] = value;
    this.map = next;
    try {
      this.writeDisk(next);
    } catch (error) {
      this.log(`write failed for ${this.filePath}: ${String(error)}`);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve();
  }

  /** null = nothing usable on disk (absent, or quarantined as corrupt). */
  private readDisk(): Record<string, unknown> | null {
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      return parsed as Record<string, unknown>;
    } catch {
      // Same trust-boundary treatment our own file gets as any agent data:
      // quarantine, never trust, never crash — the bytes stay recoverable.
      const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        renameSync(this.filePath, quarantine);
        this.log(`unreadable ${this.filePath} moved to ${quarantine} — starting fresh`);
      } catch {
        this.log(`unreadable ${this.filePath} could not be moved aside — starting fresh`);
      }
      return null;
    }
  }

  private writeDisk(map: Record<string, unknown>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    // Per-process temp name: two windows renaming over the same target is
    // fine (atomic, whole-file), two windows sharing one temp file is not.
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2));
    renameSync(tmp, this.filePath);
  }
}
