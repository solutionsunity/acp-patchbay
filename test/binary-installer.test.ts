// The installer holds a download to its published SHA-256 before anything
// touches disk (issue #54): a real HTTP download from a local server, so
// the bytes checked are the bytes fetched.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileTempDir } from "./support/teardown";
import {
  ChecksumMismatch,
  installBinary,
  parseSha256,
  tarCommand,
  type BinaryInstallSpec,
} from "../src/orchestrator/stores/binary-installer";
import { runToExit } from "../src/orchestrator/process-tree";

const BYTES = Buffer.from("#!/bin/sh\necho agent\n");
const DIGEST = createHash("sha256").update(BYTES).digest("hex");

let server: Server;
let url: string;
let root: string;
beforeAll(async () => {
  root = await fileTempDir("patchbay-installer-");
  server = createServer((_req, res) => res.end(BYTES));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent`;
});
afterAll(async () => {
  server.close();
});

const spec = (distribution: string, sha256: string | null): BinaryInstallSpec => ({
  distribution,
  version: "1.0.0",
  archiveUrl: url,
  cmd: "agent",
  args: [],
  env: {},
  sha256,
});

describe("parseSha256", () => {
  it("takes 64 hex characters in either case, lowercased", () => {
    expect(parseSha256(DIGEST.toUpperCase())).toBe(DIGEST);
  });

  it("anything else is null — never a partial or padded match", () => {
    for (const raw of ["", "abc", DIGEST.slice(1), `${DIGEST}0`, `${DIGEST.slice(1)}g`, ` ${DIGEST.slice(1)}`]) {
      expect(parseSha256(raw)).toBeNull();
    }
  });
});

describe("tarCommand — which tar the extract runs", () => {
  // What this pins: an editor started from a shell that put its own GNU tar
  // (Git Bash) ahead of System32 extracted nothing at all. GNU tar reads a
  // Windows path's drive letter as a remote host — `Cannot connect to C:
  // resolve failed`, exit 128 — and cannot open the .zip a Windows runtime
  // archive is served as.
  it("on Windows it is System32's tar, named outright so PATH cannot beat it", () => {
    expect(tarCommand("win32", { SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("it follows the Windows root the environment names, never a hardcoded C:", () => {
    expect(tarCommand("win32", { SystemRoot: "D:\\win" })).toBe("D:\\win\\System32\\tar.exe");
    expect(tarCommand("win32", { SystemDrive: "E:" })).toBe("E:\\Windows\\System32\\tar.exe");
    expect(tarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("a root that already ends in a separator does not double it", () => {
    expect(tarCommand("win32", { SystemRoot: "C:\\Windows\\" })).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("elsewhere the bare name is enough — there is one tar per platform", () => {
    for (const platform of ["linux", "darwin", "freebsd"] as const) {
      expect(tarCommand(platform, {})).toBe("tar");
    }
  });

  it.runIf(process.platform === "win32")(
    "what this host resolves really is bsdtar — the tool that reads .zip",
    async () => {
      const answer = await runToExit(tarCommand(), ["--version"], { env: process.env });
      expect(answer?.stdout).toMatch(/bsdtar/);
    },
  );
});

describe("installBinary — the published digest", () => {
  it("a download matching its digest installs", async () => {
    const installed = await installBinary(root, spec("match", DIGEST));
    expect(await readFile(installed.command)).toEqual(BYTES);
  });

  it("a mismatch throws with both digests and leaves nothing on disk", async () => {
    const wrong = "0".repeat(64);
    const err = await installBinary(root, spec("mismatch", wrong)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChecksumMismatch);
    expect(err).toMatchObject({ expected: wrong, actual: DIGEST });
    expect(await readdir(root)).not.toContain("mismatch"); // no staging, no install
  });

  it("with no digest published, the download is taken as served", async () => {
    const installed = await installBinary(root, spec("unchecked", null));
    expect(await readFile(installed.command)).toEqual(BYTES);
  });
});
