// Installs a registry `binary` distribution: download the archive (or raw
// executable — the spec allows both, FORMAT.md), extract, chmod, resolve to
// an absolute launch path. Cached per (agentId, version) under
// globalStorageUri so re-adding/reconnecting never re-downloads.
//
// No checksum/signature field exists anywhere in the registry spec (checked
// against FORMAT.md directly) — integrity here is HTTPS + the CDN's own
// authenticity, the same trust boundary a manual browser download would
// have. Callers must gate the first install of each (agentId, version)
// behind an explicit, visible user confirmation — never silent — to
// compensate for the spec's own gap (docs/architecture.md § Agent capability
// matrix's "never silently trusted" ethos, extended to installs).
import { spawn } from "node:child_process";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ARCHIVE_EXTENSIONS = [".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".zip"];

function archiveExtension(url: string): string | null {
  const lower = url.toLowerCase();
  return ARCHIVE_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}

export interface BinaryInstallSpec {
  agentId: string;
  version: string;
  archiveUrl: string;
  /** Relative path to the executable, within the extracted/downloaded dir —
   * verbatim from the registry's `cmd` field. */
  cmd: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
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
  agentId: string,
  version: string,
  cmd: string,
): string {
  return join(cacheRoot, agentId, version, cmd);
}

/** Whether this exact (agentId, version) is already cached — callers use
 * this to decide whether the one-time download confirmation is even
 * necessary (already-installed reconnects never re-prompt). */
export function isBinaryInstalled(
  cacheRoot: string,
  agentId: string,
  version: string,
  cmd: string,
): Promise<boolean> {
  return pathExists(resolvedBinaryPath(cacheRoot, agentId, version, cmd));
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
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
): Promise<InstalledBinary> {
  const destDir = join(cacheRoot, spec.agentId, spec.version);
  const resolvedCmd = join(destDir, spec.cmd);
  if (!(await pathExists(resolvedCmd))) {
    // Staging + rename-on-success: `resolvedCmd` existing IS the installed
    // check (isBinaryInstalled), so nothing may appear at that path until
    // the whole install has succeeded — a killed download or extract must
    // leave nothing that passes the check (the same interrupted-install
    // poison the npx cache suffers from, launcher-health.ts; here we own
    // the disk, so it's prevented rather than repaired). Same parent dir on
    // purpose: rename stays atomic on one filesystem.
    const staging = join(cacheRoot, spec.agentId, `.staging-${spec.version}`);
    await rm(staging, { recursive: true, force: true }); // a prior interrupted attempt
    await mkdir(staging, { recursive: true });
    const stagedCmd = join(staging, spec.cmd);
    const bytes = await downloadToBuffer(spec.archiveUrl);
    const ext = archiveExtension(spec.archiveUrl);
    if (ext === null) {
      // A raw binary (FORMAT.md: "or raw binaries") — `cmd` names the
      // downloaded file directly, nothing to extract.
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
