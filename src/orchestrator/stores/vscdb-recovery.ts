// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// One-shot recovery of machine-store data orphaned by the 0.82.6 publisher
// casing flip (solutionsunity → SolutionsUnity): VS Code namespaces an
// extension's globalState Memento by the *cased* extension id, so the flip
// left every pre-0.82.6 record unreachable through the API — intact in
// state.vscdb under the old-cased row, invisible to the new identity. The
// editor-owned db is read directly (SQLite, `ItemTable` key/value), from a
// byte-copy so the editor's own open handle is never contended, and never
// written: the old row stays where it is, inert.
//
// Merge is per key and the file wins — a record the user re-added after the
// loss is never clobbered. The attempt is recorded under a marker key in
// the machine store itself and never repeated once marked; the marker is
// deliberately not part of any wipeable store, so Erase All Data cannot
// un-mark it and resurrect what the user just erased. The one unmarked
// retry is a host whose Node lacks `node:sqlite` (pre-22.5): nothing was
// read, so a later editor upgrade still gets its chance.
//
// Retire condition: delete this module (plus its orchestrator call and the
// marker constant) once the 0.82.6-upgrader population is gone — the old
// row only decays, it never grows.
import { copyFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KV } from "./kv";

/** The pre-0.82.6 extension id — the Memento row the data lives under. */
export const LEGACY_EXTENSION_ID = "solutionsunity.acp-patchbay";
export const RECOVERY_MARKER_KEY = "acpPatchbay.legacyStateRecovery";

/** Only this namespace crosses over — the row is ours alone, but a prefix
 * gate keeps a malformed row from planting foreign keys in the store. */
const KEY_PREFIX = "acpPatchbay.";

interface SqliteStatement {
  get(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteModule = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

/** `node:sqlite` is Node ≥22.5; the oldest supported VS Code hosts run
 * Node 20. Resolution base is irrelevant for builtins — `process.execPath`
 * exists under both the CJS bundle and the ESM test runner. */
function loadSqlite(): SqliteModule | null {
  try {
    return createRequire(process.execPath)("node:sqlite") as SqliteModule;
  } catch {
    return null;
  }
}

export interface RecoveryOutcome {
  /** "recovered" also covers the found-but-all-present no-op merge. */
  outcome: "already-attempted" | "no-sqlite" | "unreadable" | "no-row" | "recovered";
  recoveredKeys: number;
}

export async function recoverLegacyGlobalState(opts: {
  kv: KV;
  vscdbPath: string;
  log?: (message: string) => void;
}): Promise<RecoveryOutcome> {
  const log = opts.log ?? (() => {});
  if (opts.kv.get(RECOVERY_MARKER_KEY) !== undefined) {
    return { outcome: "already-attempted", recoveredKeys: 0 };
  }
  const mark = async (outcome: RecoveryOutcome["outcome"], recoveredKeys: number): Promise<RecoveryOutcome> => {
    await opts.kv.update(RECOVERY_MARKER_KEY, { at: new Date().toISOString(), outcome, recoveredKeys });
    return { outcome, recoveredKeys };
  };

  const sqlite = loadSqlite();
  if (sqlite === null) {
    // Unmarked on purpose — nothing was read; a newer editor retries.
    log("node:sqlite unavailable on this host — recovery deferred");
    return { outcome: "no-sqlite", recoveredKeys: 0 };
  }

  let memento: Record<string, unknown>;
  const copy = join(tmpdir(), `acp-patchbay-recovery-${process.pid}.vscdb`);
  try {
    copyFileSync(opts.vscdbPath, copy);
    const db = new sqlite.DatabaseSync(copy, { readOnly: true });
    let value: unknown;
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(LEGACY_EXTENSION_ID);
      value = (row as { value?: unknown } | undefined)?.value;
    } finally {
      db.close();
    }
    if (value === undefined || value === null) {
      log(`no ${LEGACY_EXTENSION_ID} row in ${opts.vscdbPath} — nothing to recover`);
      return await mark("no-row", 0);
    }
    const text = typeof value === "string" ? value : Buffer.from(value as Uint8Array).toString("utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("row is not an object");
    memento = parsed as Record<string, unknown>;
  } catch (error) {
    // Absent db, zero-byte truncation, or a malformed row — all the same
    // honest answer: nothing readable to recover, said once, never retried.
    log(`could not read ${opts.vscdbPath}: ${String(error)}`);
    return await mark("unreadable", 0);
  } finally {
    rmSync(copy, { force: true });
  }

  let recovered = 0;
  for (const [key, value] of Object.entries(memento)) {
    if (!key.startsWith(KEY_PREFIX) || value === undefined) continue;
    // The file wins: a record re-added since the loss is current truth;
    // only never-written keys are filled. Recovered values still cross the
    // stores' own zod boundary on first read — bad shapes drop there.
    if (opts.kv.get(key) !== undefined) continue;
    await opts.kv.update(key, value);
    recovered++;
  }
  log(
    recovered > 0
      ? `recovered ${recovered} pre-0.82.6 entries from the old-cased globalState row`
      : "old-cased globalState row found, but every key is already present — nothing to fill",
  );
  return await mark("recovered", recovered);
}
