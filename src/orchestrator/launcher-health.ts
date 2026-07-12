// Launcher health — patchbay's tools for the seams of ecosystem launchers
// (npx/uvx), central on purpose: every chokepoint (connect crash, warmup
// abort, future add/update flows) calls the same capability instead of
// growing an inline copy. Two capabilities:
//
// 1. **Corrupted-cache detect + repair.** An interrupted `npx` install
//    (SIGKILL mid-download — warmup's own 180s cap, a host reload) leaves a
//    partial `~/.npm/_npx/<hash>` dir that npx forever treats as installed:
//    the real spawn then dies with "codex-acp: not found" (exit 127) before
//    it can say an ACP byte, surfacing as "initialize failed: ACP connection
//    closed" (observed 2026-07-11, Codex). npm neither rolls back nor
//    self-heals; the repair purges attributable entries so the next connect
//    reinstalls cleanly. *A patchbay-owned install store was considered and
//    rejected*: it would fix this by owning atomicity, but the price is
//    reimplementing the package manager's whole lifecycle (GC with in-use
//    guards, single-flight, stale-fallback policy, bin resolution) — repair
//    at the chokepoint is the right-sized answer, recorded in
//    architecture.md § ACP client pool.
//
// 2. **PATH-sibling divergence probe.** A patchbay-launched agent and the
//    user's own terminal CLI share one per-user state store (`~/.codex`,
//    `~/.gemini`, …) regardless of which binary runs — two installs, one
//    memory. That's the design, but a wide version gap means two writers of
//    different vintages on one store: worth a warning, never a gate. The
//    probe compares the CLI patchbay actually runs (the bundled package
//    inside the launcher cache) against the PATH sibling — like with like,
//    which is why the table maps per agent: an adapter's own version is NOT
//    its CLI's version.
import { spawn } from "node:child_process";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Logger } from "./logger";

/** Normalized launcher name from a command that may be a path or a Windows
 * shim — THE one spelling of "is this an ecosystem launcher", shared by
 * warmupSpawn (pool.ts) and every capability here. */
export function launcherKind(command: string): "npx" | "uvx" | null {
  const cmd = basename(command).replace(/\.(cmd|bat|exe)$/i, "").toLowerCase();
  return cmd === "npx" || cmd === "uvx" ? cmd : null;
}

/** The package spec (version kept) an npx launch would install — registry
 * shape (`npx -y <pkg> …`) or user-typed (`npx <pkg> …`): both hit the same
 * npx cache, so both concern launcher health. Null for anything else: uvx
 * has no known corruption signature yet, so it earns handling when one is
 * observed, not before. */
export function npxPackageSpec(spec: {
  command: string;
  args: readonly string[];
}): string | null {
  if (launcherKind(spec.command) !== "npx") return null;
  const pkg = spec.args[0] === "-y" ? spec.args[1] : spec.args[0];
  if (pkg === undefined || pkg.startsWith("-")) return null;
  return pkg;
}

/** The bare package name of an npx launch — what cache attribution and
 * manifest lookups key on. */
export function npxPackageName(spec: {
  command: string;
  args: readonly string[];
}): string | null {
  const pkg = npxPackageSpec(spec);
  if (pkg === null) return null;
  // Strip a version suffix; the scope's leading @ is index 0, never a hit.
  const at = pkg.lastIndexOf("@");
  return at > 0 ? pkg.slice(0, at) : pkg;
}

/** The missing-bin death shape: the launcher's shell couldn't find the
 * package's bin — POSIX `sh` says "not found" and exits 127; cmd.exe says
 * "is not recognized" (exit code 1, so the text is the signal there). Only
 * meaningful for launcher spawns — callers gate on npxPackageName first. */
export function isMissingBinSignature(
  exitCode: number | null,
  stderrTail: readonly string[],
): boolean {
  const text = stderrTail.join("\n");
  if (exitCode === 127) return /(command )?not found/i.test(text);
  return /is not recognized as an internal or external command/i.test(text);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** npm's `_npx` cache root, honoring any npm_config_cache override in the
 * agent's env — asked of npm itself (same env the launch uses, per pool.ts's
 * one-spelling rule) rather than hardcoding per-platform defaults. */
export function npmNpxRoot(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const npm = platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve) => {
    // Fixed literal args — nothing registry-supplied rides this shell.
    const child = spawn(npm, ["config", "get", "cache"], {
      env: env as NodeJS.ProcessEnv,
      shell: platform === "win32",
      timeout: 10_000,
    });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => {
      const dir = out.trim();
      resolve(code === 0 && dir !== "" ? join(dir, "_npx") : null);
    });
  });
}

/** The `_npx` entries attributable to `pkgName`. Two matchers, both needed:
 * a healthy entry names the package in its root package.json dependencies;
 * a poisoned one may have no root package.json at all (the observed
 * corruption) but still holds `node_modules/<pkg>` — presence there is the
 * attribution. Unattributable dirs are never touched: they may be another
 * tool's, healthy or not. */
export async function findNpxEntries(npxRoot: string, pkgName: string): Promise<string[]> {
  let dirs: string[];
  try {
    dirs = await readdir(npxRoot);
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const d of dirs) {
    const entry = join(npxRoot, d);
    if (await pathExists(join(entry, "node_modules", ...pkgName.split("/")))) {
      hits.push(entry);
      continue;
    }
    try {
      const manifest = JSON.parse(await readFile(join(entry, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      if (manifest.dependencies?.[pkgName] !== undefined) hits.push(entry);
    } catch {
      // No root package.json and no node_modules/<pkg> — not ours to judge.
    }
  }
  return hits;
}

/** Removes every cache entry attributable to the package; returns what was
 * purged so callers can decide whether a retry is even warranted (nothing
 * purged = the cache wasn't the problem). */
export async function purgeNpxEntries(
  npxRoot: string,
  pkgName: string,
  log: Logger,
): Promise<string[]> {
  const entries = await findNpxEntries(npxRoot, pkgName);
  for (const entry of entries) {
    await rm(entry, { recursive: true, force: true });
    log.info(`launcher-health: purged npx cache entry ${entry} (${pkgName})`);
  }
  return entries;
}

/** Per-agent mapping for the divergence probe, keyed by registry agent id.
 * `bundledPkg` is the package whose version IS the CLI's version — the
 * launch package itself when the npx package is the CLI (gemini), a
 * dependency when it's an adapter wrapping the CLI (codex-acp bundles
 * @openai/codex). Entries are earned by verifying that mapping, never
 * guessed: claude-acp is absent because its adapter bundles the agent SDK,
 * not the claude CLI — no honest comparison exists. */
const PATH_SIBLINGS: Readonly<Record<string, { bundledPkg: string; bin: string }>> = {
  "codex-acp": { bundledPkg: "@openai/codex", bin: "codex" },
  gemini: { bundledPkg: "@google/gemini-cli", bin: "gemini" },
};

/** Major-version divergence — with the semver 0.x convention honored: below
 * 1.0 the minor is the breaking slot, so 0.98 vs 0.144 diverges while 1.2
 * vs 1.9 does not. Unparseable versions never diverge (no false alarms). */
export function versionsDiverge(a: string, b: string): boolean {
  const pa = /(\d+)\.(\d+)/.exec(a);
  const pb = /(\d+)\.(\d+)/.exec(b);
  if (pa === null || pb === null) return false;
  if (pa[1] !== pb[1]) return true;
  return pa[1] === "0" && pa[2] !== pb[2];
}

/** The version of `bundledPkg` inside the npx cache entry for `launchPkg` —
 * i.e. the CLI patchbay actually runs. Read-only inspection of npm's dir,
 * same access level as the repair. Null when not installed yet. */
export async function bundledVersionInNpxCache(
  npxRoot: string,
  launchPkg: string,
  bundledPkg: string,
): Promise<string | null> {
  for (const entry of await findNpxEntries(npxRoot, launchPkg)) {
    try {
      const manifest = JSON.parse(
        await readFile(join(entry, "node_modules", ...bundledPkg.split("/"), "package.json"), "utf8"),
      ) as { version?: string };
      if (typeof manifest.version === "string") return manifest.version;
    } catch {
      // partial entry — keep looking
    }
  }
  return null;
}

/** `<bin> --version` for the PATH sibling; null when absent (nothing to
 * compare — silence, not an error). Bin names come from PATH_SIBLINGS only,
 * never from registry data, so the win32 shell is safe. */
export function pathSiblingVersion(
  bin: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], {
      env: env as NodeJS.ProcessEnv,
      shell: platform === "win32",
      timeout: 5_000,
    });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => {
      const m = /\d+\.\d+(\.\d+)?/.exec(out);
      resolve(code === 0 && m !== null ? m[0] : null);
    });
  });
}

export interface PathDivergence {
  bin: string;
  pathVersion: string;
  bundledVersion: string;
}

/** The whole probe: mapped agent → find both versions → compare. Null on
 * every quiet path (unmapped agent, non-npx launch, no PATH sibling, cache
 * not populated yet, versions compatible) — callers only ever see a real
 * divergence. */
export async function checkPathDivergence(spec: {
  agentId: string;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}): Promise<PathDivergence | null> {
  const sibling = PATH_SIBLINGS[spec.agentId];
  if (sibling === undefined) return null;
  const launchPkg = npxPackageName(spec);
  if (launchPkg === null) return null;
  const env = { ...process.env, ...spec.env };
  const [npxRoot, pathVersion] = await Promise.all([
    npmNpxRoot(env),
    pathSiblingVersion(sibling.bin, env),
  ]);
  if (npxRoot === null || pathVersion === null) return null;
  const bundledVersion = await bundledVersionInNpxCache(npxRoot, launchPkg, sibling.bundledPkg);
  if (bundledVersion === null) return null;
  return versionsDiverge(pathVersion, bundledVersion)
    ? { bin: sibling.bin, pathVersion, bundledVersion }
    : null;
}
