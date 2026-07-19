// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileKV, type EnumerableKV } from "../src/orchestrator/stores/file-kv";
import { MemoryKV } from "../src/orchestrator/stores/kv";

class EnumerableMemoryKV extends MemoryKV implements EnumerableKV {
  private known = new Set<string>();

  override update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.known.delete(key);
    else this.known.add(key);
    return super.update(key, value);
  }

  keys(): readonly string[] {
    return [...this.known];
  }
}

describe("FileKV", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "patchbay-filekv-"));
    file = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts empty with no file and no migration source", () => {
    const kv = new FileKV(file);
    expect(kv.get("anything")).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  it("persists updates across instances", async () => {
    const kv = new FileKV(file);
    await kv.update("acpPatchbay.agents", [{ id: "a1" }]);
    const reloaded = new FileKV(file);
    expect(reloaded.get("acpPatchbay.agents")).toEqual([{ id: "a1" }]);
  });

  it("deletes a key on update(key, undefined)", async () => {
    const kv = new FileKV(file);
    await kv.update("k", "v");
    await kv.update("k", undefined);
    expect(kv.get("k")).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  it("migrates all keys out of the source on first load, and only then", async () => {
    const source = new EnumerableMemoryKV();
    await source.update("acpPatchbay.agents", [{ id: "a1" }]);
    await source.update("acpPatchbay.preferences", { soundOnDone: true });

    const kv = new FileKV(file, source);
    expect(kv.get("acpPatchbay.agents")).toEqual([{ id: "a1" }]);
    expect(kv.get("acpPatchbay.preferences")).toEqual({ soundOnDone: true });
    // Drained: the old home is empty afterwards — one truth.
    expect(source.keys()).toEqual([]);
    expect(source.get("acpPatchbay.agents")).toBeUndefined();

    // A repopulated source is ignored once the file exists.
    await source.update("acpPatchbay.agents", [{ id: "stale" }]);
    const reloaded = new FileKV(file, source);
    expect(reloaded.get("acpPatchbay.agents")).toEqual([{ id: "a1" }]);
    expect(source.keys()).toEqual(["acpPatchbay.agents"]);
  });

  it("quarantines a corrupt file and starts fresh", async () => {
    writeFileSync(file, ""); // the observed failure shape: zero bytes
    const messages: string[] = [];
    const kv = new FileKV(file, undefined, (m) => messages.push(m));
    expect(kv.get("k")).toBeUndefined();
    expect(readdirSync(dir).some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
    expect(messages.some((m) => m.includes("unreadable"))).toBe(true);
    await kv.update("k", 1);
    expect(new FileKV(file).get("k")).toBe(1);
  });

  it("merges at key granularity across instances on the same file", async () => {
    const a = new FileKV(file);
    const b = new FileKV(file); // loaded before a writes — a second window
    await a.update("a", 1);
    await b.update("b", 2);
    const reloaded = new FileKV(file);
    expect(reloaded.get("a")).toBe(1);
    expect(reloaded.get("b")).toBe(2);
  });
});
