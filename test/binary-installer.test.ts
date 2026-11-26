// The installer holds a download to its published SHA-256 before anything
// touches disk (issue #54): a real HTTP download from a local server, so
// the bytes checked are the bytes fetched.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileTempDir } from "./support/teardown";
import { zipOf } from "./support/zip";
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
/** Archives the server answers by path; anything else is the raw BYTES. */
const served = new Map<string, Buffer>();
beforeAll(async () => {
  root = await fileTempDir("patchbay-installer-");
  server = createServer((req, res) => res.end(served.get(req.url ?? "") ?? BYTES));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent`;
});
afterAll(async () => {
  server.close();
});

const spec = (distribution: string, sha256: string | null, archive?: { path: string; cmd: string }): BinaryInstallSpec => ({
  distribution,
  version: "1.0.0",
  archiveUrl: archive === undefined ? url : `${new URL(url).origin}${archive.path}`,
  cmd: archive?.cmd ?? "agent",
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
  // resolve failed`, exit 128.
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
    "what this host resolves really is bsdtar — the tar that takes Windows paths",
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

describe("installBinary — a .zip, on every platform (#182)", () => {
  // The registry serves some Linux builds as .zip (Antigravity, Junie,
  // Kiro's musl builds), which GNU tar cannot read; and such a zip carries
  // more executables than its cmd — Junie's bundles the Java runtime it
  // starts — so each entry keeps the mode it was archived with.
  const serve = (name: string, archive: Buffer) => {
    served.set(`/${name}.zip`, archive);
    return `/${name}.zip`;
  };

  const nested = () =>
    serve("nested", zipOf([
      { name: "app/" },
      { name: "app/bin/agent", data: BYTES, mode: 0o100755, deflate: true },
      { name: "app/lib/runtime/bin/java", data: Buffer.from("runtime"), mode: 0o100755 },
      { name: "app/README", data: Buffer.from("read me"), deflate: true },
    ]));

  it("extracts nested entries, deflated or stored", async () => {
    const installed = await installBinary(root, spec("zip-nested", null, { path: nested(), cmd: "app/bin/agent" }));
    expect(await readFile(installed.command)).toEqual(BYTES);
    expect(await readFile(`${installed.cwd}/app/README`, "utf8")).toBe("read me");
  });

  it.runIf(process.platform !== "win32")("each file keeps the mode it was archived with", async () => {
    const installed = await installBinary(root, spec("zip-modes", null, { path: nested(), cmd: "app/bin/agent" }));
    expect((await stat(`${installed.cwd}/app/lib/runtime/bin/java`)).mode & 0o111).toBe(0o111);
    expect((await stat(`${installed.cwd}/app/README`)).mode & 0o111).toBe(0);
  });

  it("a name written with backslashes, as some Windows zips store them, is a path all the same", async () => {
    const path = serve("backslash", zipOf([
      { name: "bundle\\app\\agent.cfg", data: Buffer.from("cfg") },
      { name: "bundle\\agent", data: BYTES },
    ]));
    const installed = await installBinary(root, spec("zip-backslash", null, { path, cmd: "bundle/agent" }));
    expect(await readFile(installed.command)).toEqual(BYTES);
    expect(await readFile(`${installed.cwd}/bundle/app/agent.cfg`, "utf8")).toBe("cfg");
  });

  it("an entry naming a place outside the install is refused, and nothing is left", async () => {
    const path = serve("escape", zipOf([
      { name: "agent", data: BYTES, mode: 0o100755 },
      { name: "../escaped", data: Buffer.from("out") },
    ]));
    await expect(installBinary(root, spec("zip-escape", null, { path, cmd: "agent" }))).rejects.toThrow(/relative path/);
    expect(await readdir(root)).not.toContain("escaped");
    expect(await readdir(`${root}/zip-escape`).catch(() => [])).toEqual([]);
  });

  it("a symlink entry is refused, and nothing is left", async () => {
    const path = serve("link", zipOf([
      { name: "agent", data: BYTES, mode: 0o100755 },
      { name: "elsewhere", data: Buffer.from("/etc/passwd"), mode: 0o120777 },
    ]));
    await expect(installBinary(root, spec("zip-link", null, { path, cmd: "agent" }))).rejects.toThrow(/symlink/);
    expect(await readdir(`${root}/zip-link`).catch(() => [])).toEqual([]);
  });
});
