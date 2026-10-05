// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// File-backed KV: one JSON file this extension owns. Exists because
// globalState rides the editor-owned state.vscdb — one SQLite file shared
// by every extension, observed arriving truncated to zero bytes after an
// unclean shutdown and taking every machine-scoped record with it. A file
// of our own, written atomically (temp + rename), can never be half-written
// by us and can be lost only with its whole directory.
//
// Semantics match Memento where it matters: get() is synchronous and
// update() merges over the freshest disk truth at key granularity. Two
// windows (two extension hosts) share this one file, so get() reads the
// file, not a copy loaded at open: a store that keeps all its rows under
// one key builds each write from what the file holds now, and one window's
// save can no longer erase rows another window saved, or bring back rows
// it removed. There is no cross-process lock; two writes to one key landing
// at the same instant are last-rename-wins.
//
// First load (no file yet) drains the old Memento home into the file and
// deletes the keys there — one truth; a stale shadow left in state.vscdb
// would resurrect on downgrade and diverge forever after.
//
// Only a missing file is absence. One that is there but can't be read — a
// permission error, a lock — stops the store at open and is never written
// over after: read as empty, the next write would replace it.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KV } from "./kv";

/** Structural subset of vscode.Memento that can enumerate itself — the
 * migration source. */
export interface EnumerableKV extends KV {
  keys(): readonly string[];
}

export class FileKV implements KV {
  private map: Record<string, unknown>;
  /** The file `map` was parsed from (fileStamp) — null when there was no
   * file, undefined when unknown, so the next read goes to disk. */
  private parsedFrom: string | null | undefined;

  constructor(
    private readonly filePath: string,
    migrateFrom?: EnumerableKV,
    private readonly log: (message: string) => void = () => {},
  ) {
    const stamp = this.fileStamp();
    const loaded = this.readDisk();
    if (loaded !== null) {
      this.map = loaded;
      this.parsedFrom = stamp;
      return;
    }
    this.map = {};
    const keys = migrateFrom?.keys() ?? [];
    for (const key of keys) {
      const value = migrateFrom?.get(key);
      if (value !== undefined) this.map[key] = value;
    }
    // No file until there is something to hold — created here only when the
    // migration actually carried keys, else lazily by the first update().
    // An eagerly written empty file would latch as the one truth and mask a
    // migration source that was merely unreadable this launch (the 0.82.6
    // publisher-casing flip turned exactly that into apparent data loss);
    // absence keeps every later launch's migration door open.
    if (keys.length > 0) {
      this.writeDisk(this.map);
      this.log(`created ${this.filePath} — migrated ${keys.length} entries out of globalState`);
      for (const key of keys) void migrateFrom?.update(key, undefined);
    }
  }

  get<T>(key: string): T | undefined {
    this.readIfChanged();
    return this.map[key] as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    // Merge over the freshest disk truth so another window's keys survive;
    // only this key is ours to win. A corrupt or missing file at this point
    // falls back to the in-memory map — the best remaining truth. One that
    // can't be read fails the write: nothing is written over it.
    let disk: Record<string, unknown> | null;
    try {
      disk = this.readDisk();
    } catch (error) {
      this.log(`write refused: ${(error as Error).message}`);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const next = { ...(disk ?? this.map) };
    if (value === undefined) delete next[key];
    else next[key] = value;
    this.map = next;
    // Whatever lands on disk — this write, a failed one, or another
    // window's right after — the next read goes to the file.
    this.parsedFrom = undefined;
    try {
      this.writeDisk(next);
    } catch (error) {
      this.log(`write failed for ${this.filePath}: ${String(error)}`);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve();
  }

  /** Re-parses the file whenever it is no longer the one `map` came from.
   * Every write renames a new file into place, so another window's save
   * changes the stamp. The stamp is taken before the read: a write landing
   * in between leaves an older stamp, and the next read goes to disk again.
   * A missing or corrupt file keeps the last good map, as update() does;
   * so does one that can't be read for now, and the next read tries again. */
  private readIfChanged(): void {
    const stamp = this.fileStamp();
    if (stamp === this.parsedFrom) return;
    let disk: Record<string, unknown> | null;
    try {
      disk = this.readDisk();
    } catch {
      return;
    }
    if (disk !== null) this.map = disk;
    this.parsedFrom = stamp;
  }

  /** Identity of the file now on disk — inode, size, modification time —
   * or null when there is none. */
  private fileStamp(): string | null {
    try {
      const s = statSync(this.filePath, { bigint: true });
      return `${s.ino}:${s.size}:${s.mtimeNs}`;
    } catch {
      return null;
    }
  }

  /** null = nothing usable on disk (absent, or quarantined as corrupt).
   * Throws when the file is there but can't be read. */
  private readDisk(): Record<string, unknown> | null {
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw new Error(`${this.filePath} can't be read (${code ?? String(error)})`);
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
