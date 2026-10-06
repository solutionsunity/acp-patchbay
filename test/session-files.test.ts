// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A session's files live in its own folder on patchbay's disk, and leave
// with the session: forgotten, its agent removed, judged against what still
// names it, or moved when the session is minted again. Names on disk encode
// ids — no id an agent mints can steer a path.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { SessionContinuityStore } from "../src/orchestrator/stores/session-continuity";
import { adoptStashedChips, SessionFilesStore } from "../src/orchestrator/stores/session-files";
import type { PatchbayAgentId } from "../src/shared/ids";

const A = "agent-a" as PatchbayAgentId;
const B = "agent-b" as PatchbayAgentId;
const PNG = Buffer.from("png-bytes").toString("base64");

let dir: string;
let files: SessionFilesStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "patchbay-session-files-"));
  files = new SessionFilesStore(join(dir, "root"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SessionFilesStore", () => {
  it("keeps each session's files in a folder of its own — no id an agent mints steers or stretches a path", async () => {
    const path = await files.put(A, "../../escape", "/ws", "chip-1.png", PNG);
    expect(relative(join(dir, "root"), path).startsWith("..")).toBe(false);
    expect(await readFile(path, "utf8")).toBe("png-bytes");
    // agent, workspace and session each make a folder of their own
    const one = files.dirOf(A, "s1", "/ws");
    expect(new Set([one, files.dirOf(B, "s1", "/ws"), files.dirOf(A, "s1", "/other"), files.dirOf(A, "s2", "/ws")]).size).toBe(4);
    expect(files.dirOf(A, `a${sep}b`, "/ws").split(sep).length).toBe(one.split(sep).length);
    expect(files.dirOf(A, "x".repeat(400), "/ws").length).toBe(one.length);
  });

  it("forget takes one session's folder and nothing else", async () => {
    const gone = await files.put(A, "s1", "/ws", "a.txt", PNG);
    const kept = await files.put(A, "s2", "/ws", "b.txt", PNG);
    await files.forget(A, "s1", "/ws");
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it("forgetAgent takes the agent's folders in every workspace, and no other agent's", async () => {
    const here = await files.put(A, "s1", "/ws", "a.txt", PNG);
    const there = await files.put(A, "s9", "/other", "a.txt", PNG);
    const other = await files.put(B, "s1", "/ws", "a.txt", PNG);
    await files.forgetAgent(A);
    expect(existsSync(here)).toBe(false);
    expect(existsSync(there)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("reconcile drops the folders of this workspace's sessions nothing names — other workspaces are not its to judge", async () => {
    const named = await files.put(A, "s1", "/ws", "a.txt", PNG);
    const unnamed = await files.put(A, "s2", "/ws", "b.txt", PNG);
    const elsewhere = await files.put(A, "s2", "/other", "b.txt", PNG);
    await files.reconcile(A, "/ws", new Set(["s1"]));
    expect(existsSync(named)).toBe(true);
    expect(existsSync(unnamed)).toBe(false);
    expect(existsSync(elsewhere)).toBe(true);
    await files.reconcile(B, "/ws", new Set()); // an agent with no folders: nothing to judge
  });

  it("move carries a session's folder to its new id; a session with none moves nothing", async () => {
    const before = await files.put(A, "old", "/ws", "a.txt", PNG);
    expect(files.move(A, "old", "new", "/ws")).toBe(true);
    expect(existsSync(before)).toBe(false);
    expect(existsSync(join(files.dirOf(A, "new", "/ws"), "a.txt"))).toBe(true);
    expect(files.move(A, "never-had-one", "fresh", "/ws")).toBe(false);
  });

  it("adopt copies a file in under its own name and removes it where it was; a file already gone is null", async () => {
    const source = join(dir, "stash-file.png");
    writeFileSync(source, "png-bytes");
    const path = await files.adopt(A, "s1", "/ws", source);
    expect(path).toBe(join(files.dirOf(A, "s1", "/ws"), "stash-file.png"));
    expect(existsSync(source)).toBe(false);
    expect(await files.adopt(A, "s1", "/ws", source)).toBeNull();
  });

  it("wipe takes everything", async () => {
    await files.put(A, "s1", "/ws", "a.txt", PNG);
    await files.wipe();
    expect(existsSync(join(dir, "root"))).toBe(false);
  });
});

describe("adoptStashedChips — chips staged before sessions kept their own files", () => {
  it("moves each stashed file into its session's folder and names it there; a file already gone drops its chip", async () => {
    const stash = join(dir, "stash");
    mkdirSync(stash, { recursive: true });
    writeFileSync(join(stash, "chip-1.png"), "png-bytes");
    writeFileSync(join(stash, "chip-2-notes.txt"), "notes");
    const continuity = new SessionContinuityStore(new MemoryKV());
    await continuity.patch(A, "s1", "/ws", {
      chips: [
        { kind: "image", id: "chip-1", label: "Image", mimeType: "image/png", path: join(stash, "chip-1.png") },
        { kind: "attachment", id: "chip-2", label: "File: notes.txt", path: join(stash, "chip-2-notes.txt") },
        { kind: "image", id: "chip-3", label: "Gone", mimeType: "image/png", path: join(stash, "chip-3.png") },
        { kind: "attachment", id: "chip-4", label: "Picked", path: "/home/user/report.pdf" },
        { kind: "selection", id: "chip-5", label: "Selection", content: "x" },
      ],
    });

    await adoptStashedChips(continuity, files, stash);

    const folder = files.dirOf(A, "s1", "/ws");
    expect(continuity.read(A, "s1")?.chips).toEqual([
      { kind: "image", id: "chip-1", label: "Image", mimeType: "image/png", path: join(folder, "chip-1.png") },
      { kind: "attachment", id: "chip-2", label: "File: notes.txt", path: join(folder, "chip-2-notes.txt") },
      { kind: "attachment", id: "chip-4", label: "Picked", path: "/home/user/report.pdf" },
      { kind: "selection", id: "chip-5", label: "Selection", content: "x" },
    ]);
    expect(await readFile(join(folder, "chip-1.png"), "utf8")).toBe("png-bytes");
    expect(existsSync(join(stash, "chip-1.png"))).toBe(false);
  });
});
