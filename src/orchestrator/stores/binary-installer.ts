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
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
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
    await mkdir(destDir, { recursive: true });
    const bytes = await downloadToBuffer(spec.archiveUrl);
    const ext = archiveExtension(spec.archiveUrl);
    if (ext === null) {
      // A raw binary (FORMAT.md: "or raw binaries") — `cmd` names the
      // downloaded file directly, nothing to extract.
      await writeFile(resolvedCmd, bytes);
    } else {
      const archivePath = join(destDir, `download${ext}`);
      await writeFile(archivePath, bytes);
      await extractArchive(archivePath, destDir);
      await rm(archivePath, { force: true });
    }
    if (process.platform !== "win32") await chmod(resolvedCmd, 0o755).catch(() => {});
  }
  return { command: resolvedCmd, args: spec.args, env: spec.env, cwd: destDir };
}
