// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// FileKV against a file that is there but can't be read — a permission
// error, a lock. Only a missing file is absence: anything else must never
// read as an empty store, since the next write would replace the real file
// with it. The read failure is simulated per path; every other read is real.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileKV } from "../src/orchestrator/stores/file-kv";

const failing = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
    const code = failing.get(String(path));
    if (code !== undefined) throw Object.assign(new Error(`${code}: simulated`), { code });
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

describe("FileKV — a file it can't read", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "patchbay-filekv-read-"));
    file = join(dir, "state.json");
  });

  afterEach(async () => {
    failing.clear();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses to open over it, rather than starting empty", () => {
    writeFileSync(file, JSON.stringify({ "acpPatchbay.agents": [{ id: "a1" }] }));
    failing.set(file, "EACCES");
    expect(() => new FileKV(file)).toThrow(/can't be read.*EACCES/);
    failing.clear();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "acpPatchbay.agents": [{ id: "a1" }] });
  });

  it("refuses to open over a directory in its place", () => {
    mkdirSync(file);
    expect(() => new FileKV(file)).toThrow(/can't be read.*EISDIR/);
  });

  it("never writes over a file it can't read — the write fails and the file stays", async () => {
    writeFileSync(file, JSON.stringify({ a: 1, b: 2 }));
    const kv = new FileKV(file);
    failing.set(file, "EACCES");
    await expect(kv.update("c", 3)).rejects.toThrow(/can't be read.*EACCES/);
    failing.clear();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 1, b: 2 });
  });

  it("serves the last good read while the file can't be read, and reads again once it can", () => {
    writeFileSync(file, JSON.stringify({ a: 1 }));
    const kv = new FileKV(file);
    expect(kv.get("a")).toBe(1);
    // Another window's save lands, and this window can't read it yet.
    writeFileSync(file, JSON.stringify({ a: 2 }));
    failing.set(file, "EBUSY");
    expect(kv.get("a")).toBe(1);
    failing.clear();
    expect(kv.get("a")).toBe(2);
  });

  it("still takes a missing file as absence", async () => {
    const kv = new FileKV(file);
    expect(kv.get("a")).toBeUndefined();
    await kv.update("a", 1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 1 });
  });
});
