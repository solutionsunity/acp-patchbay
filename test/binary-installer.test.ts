// The installer holds a download to its published SHA-256 before anything
// touches disk (issue #54): a real HTTP download from a local server, so
// the bytes checked are the bytes fetched.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChecksumMismatch,
  installBinary,
  parseSha256,
  type BinaryInstallSpec,
} from "../src/orchestrator/stores/binary-installer";

const BYTES = Buffer.from("#!/bin/sh\necho agent\n");
const DIGEST = createHash("sha256").update(BYTES).digest("hex");

let server: Server;
let url: string;
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "patchbay-installer-"));
  server = createServer((_req, res) => res.end(BYTES));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent`;
});
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

const spec = (agentId: string, sha256: string | null): BinaryInstallSpec => ({
  agentId,
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
