// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Installs a downloaded executable: fetch the archive (or a raw executable
// — the registry format allows both), check it against its published
// SHA-256 when one exists, extract, chmod, resolve to an absolute launch
// path. Cached per (distribution, version) under globalStorageUri so
// re-adding/reconnecting never re-downloads.
//
// The digest is checked on the downloaded bytes before anything touches
// disk, so a mismatch leaves nothing behind; what lands in the cache has
// passed the check (or had none to pass). Without a digest, integrity is
// HTTPS + the host's own authenticity — the trust a manual browser
// download has. Either way callers gate the first install of each
// (distribution, version) behind an explicit, visible user confirmation, and
// tell the user which of the two it is.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Logger, nullLogger } from "../logger";
import { describeNetFailure, readBytes } from "../net";

const ARCHIVE_EXTENSIONS = [".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".zip"];

function archiveExtension(url: string): string | null {
  const lower = url.toLowerCase();
  return ARCHIVE_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}

export interface BinaryInstallSpec {
  /** What the download is — a registry agent's id, or a runtime's name
   * (`.runtime-node`) — the cache directory it lands in. */
  distribution: string;
  version: string;
  archiveUrl: string;
  /** Relative path to the executable, within the extracted/downloaded dir —
   * verbatim from the registry's `cmd` field. */
  cmd: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  /** The archive's published SHA-256, lowercase hex (`parseSha256`) — the
   * downloaded bytes must match it before anything is written. Null: none
   * published, the bytes are taken as served. */
  sha256: string | null;
}

/** A published SHA-256 as the installer compares it: 64 hex characters in
 * either case, lowercased — null when the text is not one. */
export function parseSha256(raw: string): string | null {
  return /^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : null;
}

/** The download is not the file its digest describes. Carries both digests
 * so the failure can name them. */
export class ChecksumMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`checksum mismatch: expected ${expected}, got ${actual}`);
  }
}

export interface InstalledBinary {
  command: string; // absolute, resolved
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function resolvedBinaryPath(
  cacheRoot: string,
  distribution: string,
  version: string,
  cmd: string,
): string {
  return join(cacheRoot, distribution, version, cmd);
}

/** Whether this exact (distribution, version) is already cached — callers use
 * this to decide whether the one-time download confirmation is even
 * necessary (already-installed reconnects never re-prompt). */
export function isBinaryInstalled(
  cacheRoot: string,
  distribution: string,
  version: string,
  cmd: string,
): Promise<boolean> {
  return pathExists(resolvedBinaryPath(cacheRoot, distribution, version, cmd));
}

/** Shells out to the system `tar` — GNU tar (Linux) / bsdtar (macOS, and
 * Windows 10 1803+ ships tar.exe as bsdtar too, which also reads .zip) —
 * rather than adding a zip/tar dependency for a format set every platform
 * this extension targets already covers natively. */
function extractArchive(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", archivePath, "-C", destDir]);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
    });
  });
}

export async function installBinary(
  cacheRoot: string,
  spec: BinaryInstallSpec,
  log: Logger = nullLogger,
): Promise<InstalledBinary> {
  const destDir = join(cacheRoot, spec.distribution, spec.version);
  const resolvedCmd = resolvedBinaryPath(cacheRoot, spec.distribution, spec.version, spec.cmd);
  if (!(await pathExists(resolvedCmd))) {
    // Staging + rename-on-success: `resolvedCmd` existing IS the installed
    // check (isBinaryInstalled), so nothing may appear at that path until
    // the whole install has succeeded — a killed download or extract must
    // leave nothing that passes the check (the same interrupted-install
    // poison the npx cache suffers from, launcher-health.ts; here we own
    // the disk, so it's prevented rather than repaired). Same parent dir on
    // purpose: rename stays atomic on one filesystem.
    const download = await readBytes(spec.archiveUrl, { log, what: `download of ${spec.distribution} ${spec.version}` });
    if (!download.ok) throw new Error(`download failed: ${describeNetFailure(download.failure)}`);
    const { bytes } = download.value;
    if (spec.sha256 !== null) {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== spec.sha256) throw new ChecksumMismatch(spec.sha256, actual);
    }
    const staging = join(cacheRoot, spec.distribution, `.staging-${spec.version}`);
    await rm(staging, { recursive: true, force: true }); // a prior interrupted attempt
    await mkdir(staging, { recursive: true });
    const stagedCmd = join(staging, spec.cmd);
    const ext = archiveExtension(spec.archiveUrl);
    if (ext === null) {
      // A raw binary — `cmd` names the downloaded file directly, nothing
      // to extract.
      await writeFile(stagedCmd, bytes);
    } else {
      const archivePath = join(staging, `download${ext}`);
      await writeFile(archivePath, bytes);
      await extractArchive(archivePath, staging);
      await rm(archivePath, { force: true });
    }
    if (!(await pathExists(stagedCmd))) {
      await rm(staging, { recursive: true, force: true });
      throw new Error(`archive did not contain ${spec.cmd} — the registry's cmd field may be wrong`);
    }
    if (process.platform !== "win32") await chmod(stagedCmd, 0o755).catch(() => {});
    await rm(destDir, { recursive: true, force: true });
    await rename(staging, destDir);
  }
  return { command: resolvedCmd, args: spec.args, env: spec.env, cwd: destDir };
}
