// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The 0.82.6 recovery path (vscdb-recovery.ts): reads the old-cased
// globalState row straight out of a state.vscdb copy and fills only
// never-written keys. Suite skips itself loudly where the running Node
// lacks node:sqlite — the module defers there by design.
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileKV } from "../src/orchestrator/stores/file-kv";
import {
  LEGACY_EXTENSION_ID,
  RECOVERY_MARKER_KEY,
  recoverLegacyGlobalState,
} from "../src/orchestrator/stores/vscdb-recovery";

let sqlite: {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): unknown };
    close(): void;
  };
} | null = null;
try {
  sqlite = createRequire(process.execPath)("node:sqlite");
} catch {
  sqlite = null;
}

/** VS Code's actual storage schema (ItemTable key/value). */
function writeVscdb(path: string, rows: Record<string, string>): void {
  const db = new sqlite!.DatabaseSync(path);
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const insert = db.prepare("INSERT INTO ItemTable VALUES (?, ?)");
  for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  db.close();
}

describe.skipIf(sqlite === null)("recoverLegacyGlobalState", () => {
  let dir: string;
  let vscdbPath: string;
  let kv: FileKV;

  const MEMENTO = {
    "acpPatchbay.agents": [{ id: "claude", name: "Claude Code" }],
    "acpPatchbay.integrations": [{ id: "github", name: "GitHub" }],
    "acpPatchbay.preferences": { soundOnDone: true },
    somethingForeign: { planted: true },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "patchbay-recovery-"));
    vscdbPath = join(dir, "state.vscdb");
    kv = new FileKV(join(dir, "state.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("recovers only acpPatchbay.* keys from the legacy row and stamps the marker", async () => {
    writeVscdb(vscdbPath, {
      [LEGACY_EXTENSION_ID]: JSON.stringify(MEMENTO),
      "other.extension": JSON.stringify({ "acpPatchbay.agents": [{ id: "impostor" }] }),
    });
    const result = await recoverLegacyGlobalState({ kv, vscdbPath });
    expect(result).toEqual({ outcome: "recovered", recoveredKeys: 3 });
    expect(kv.get("acpPatchbay.agents")).toEqual([{ id: "claude", name: "Claude Code" }]);
    expect(kv.get("acpPatchbay.integrations")).toEqual([{ id: "github", name: "GitHub" }]);
    expect(kv.get("acpPatchbay.preferences")).toEqual({ soundOnDone: true });
    expect(kv.get("somethingForeign")).toBeUndefined();
    expect(kv.get(RECOVERY_MARKER_KEY)).toMatchObject({ outcome: "recovered", recoveredKeys: 3 });
  });

  it("never clobbers a key the file already holds — the file wins", async () => {
    await kv.update("acpPatchbay.agents", [{ id: "readded-since" }]);
    writeVscdb(vscdbPath, { [LEGACY_EXTENSION_ID]: JSON.stringify(MEMENTO) });
    const result = await recoverLegacyGlobalState({ kv, vscdbPath });
    expect(result.recoveredKeys).toBe(2); // integrations + preferences only
    expect(kv.get("acpPatchbay.agents")).toEqual([{ id: "readded-since" }]);
  });

  it("attempts exactly once — the marker blocks a re-run even after keys are deleted", async () => {
    writeVscdb(vscdbPath, { [LEGACY_EXTENSION_ID]: JSON.stringify(MEMENTO) });
    await recoverLegacyGlobalState({ kv, vscdbPath });
    // The erase-all shape: records removed, marker (not a wipeable store) stays.
    await kv.update("acpPatchbay.agents", undefined);
    const second = await recoverLegacyGlobalState({ kv, vscdbPath });
    expect(second).toEqual({ outcome: "already-attempted", recoveredKeys: 0 });
    expect(kv.get("acpPatchbay.agents")).toBeUndefined(); // nothing resurrected
  });

  it("marks a row-less db as attempted", async () => {
    writeVscdb(vscdbPath, { "other.extension": "{}" });
    const result = await recoverLegacyGlobalState({ kv, vscdbPath });
    expect(result).toEqual({ outcome: "no-row", recoveredKeys: 0 });
    expect(kv.get(RECOVERY_MARKER_KEY)).toMatchObject({ outcome: "no-row" });
  });

  it("marks an absent or truncated db as attempted without throwing", async () => {
    const missing = await recoverLegacyGlobalState({ kv, vscdbPath });
    expect(missing.outcome).toBe("unreadable");

    const kv2 = new FileKV(join(dir, "state2.json"));
    writeFileSync(vscdbPath, ""); // the observed zero-byte truncation shape
    const truncated = await recoverLegacyGlobalState({ kv: kv2, vscdbPath });
    expect(truncated.outcome).toBe("unreadable");
    expect(kv2.get(RECOVERY_MARKER_KEY)).toMatchObject({ outcome: "unreadable" });
  });
});
