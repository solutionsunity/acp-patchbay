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
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { type Logger, nullLogger } from "../logger";
import { describeNetFailure, readBytes } from "../net";
import { runToExit } from "../process-tree";

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

/** Whether `path` is where `resolvedBinaryPath` puts this executable,
 * under whatever cache root it was written with — a root moves with the
 * extension's storage, the layout below it does not. Either separator. */
export function isResolvedBinaryPath(path: string, distribution: string, version: string, cmd: string): boolean {
  const slashed = (p: string) => p.replaceAll("\\", "/");
  return slashed(path).endsWith(`/${posix.join(distribution, version, slashed(cmd))}`);
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

/** Which tar extracts the tar formats — every platform this extension
 * targets ships one: GNU tar on Linux, bsdtar on macOS and Windows. A .zip
 * never comes here (`extractZip`): GNU tar cannot read one, and a Linux host
 * has no zip reader to count on.
 *
 * On Windows the bare name is not enough — it resolves to whichever tar the
 * process that started the editor happened to put first on PATH. A shell
 * like Git Bash puts its own GNU tar there, and GNU tar reads a Windows
 * path's drive letter as a remote host (`Cannot connect to C: resolve
 * failed`, exit 128). System32's tar is bsdtar — it takes Windows paths —
 * and Windows 10 1803+ ships it, so name it outright.
 *
 * Built with backslashes, not `join`: this names a Windows path whatever
 * host runs the code that asks. */
export function tarCommand(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (platform !== "win32") return "tar";
  const root = (env.SystemRoot ?? `${env.SystemDrive ?? "C:"}\\Windows`).replace(/[\\/]+$/, "");
  return `${root}\\System32\\tar.exe`;
}

/** Extracts a tar archive into the staging dir with `tarCommand`'s tool. */
async function extractTar(archivePath: string, destDir: string): Promise<void> {
  const tar = tarCommand();
  const answer = await runToExit(tar, ["-xf", archivePath, "-C", destDir], { env: process.env });
  if (answer === null) throw new Error(`${tar} could not be run`);
  if (answer.code !== 0) throw new Error(`tar exited ${answer.code}: ${answer.stderr.trim()}`);
}

/** Extracts a .zip into the staging dir, in-process, on every platform.
 * Each entry keeps the mode it was archived with: an agent's zip carries
 * more executables than its cmd (a bundled runtime, a helper it spawns).
 * The reader refuses a name outside the dir (absolute, `..`); a symlink is
 * refused here — none is served today, and one could point anywhere. */
function extractZip(bytes: Buffer, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true }, (opened, zip) => {
      if (opened !== null) return reject(opened);
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: Entry) => {
        writeZipEntry(zip, entry, destDir).then(
          () => zip.readEntry(),
          (failed: unknown) => {
            zip.close();
            reject(failed);
          },
        );
      });
      zip.readEntry();
    });
  });
}

async function writeZipEntry(zip: ZipFile, entry: Entry, destDir: string): Promise<void> {
  const target = join(destDir, entry.fileName);
  // The mode is the entry's only where a Unix tool made it.
  const mode = entry.versionMadeBy >> 8 === 3 ? entry.externalFileAttributes >>> 16 : null;
  if (mode !== null && (mode & 0o170000) === 0o120000) {
    throw new Error(`archive entry ${entry.fileName} is a symlink — not extracted`);
  }
  if (entry.fileName.endsWith("/")) {
    await mkdir(target, { recursive: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  const content = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
    zip.openReadStream(entry, (failed, stream) => (failed !== null ? reject(failed) : resolve(stream))),
  );
  await pipeline(content, createWriteStream(target));
  if (mode !== null && process.platform !== "win32") await chmod(target, mode & 0o777);
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
    const download = await readBytes(spec.archiveUrl, {
      log,
      what: `download of ${spec.distribution} ${spec.version}`,
      class: "essential",
    });
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
    try {
      if (ext === null) {
        // A raw binary — `cmd` names the downloaded file directly, nothing
        // to extract.
        await writeFile(stagedCmd, bytes);
      } else if (ext === ".zip") {
        await extractZip(bytes, staging);
      } else {
        const archivePath = join(staging, `download${ext}`);
        await writeFile(archivePath, bytes);
        await extractTar(archivePath, staging);
        await rm(archivePath, { force: true });
      }
      if (!(await pathExists(stagedCmd))) {
        throw new Error(`archive did not contain ${spec.cmd} — the registry's cmd field may be wrong`);
      }
    } catch (failed) {
      // A failed install leaves nothing, staging included.
      await rm(staging, { recursive: true, force: true });
      throw failed;
    }
    if (process.platform !== "win32") await chmod(stagedCmd, 0o755).catch(() => {});
    await rm(destDir, { recursive: true, force: true });
    await rename(staging, destDir);
  }
  return { command: resolvedCmd, args: spec.args, env: spec.env, cwd: destDir };
}
