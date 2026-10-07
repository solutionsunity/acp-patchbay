// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Launcher health — patchbay's tools for the seams of ecosystem launchers
// (npx/uvx), central on purpose: every launch of a launcher package (an
// agent's connect, an MCP server's probe) prepares it through the same
// molecule instead of growing an inline copy. Two capabilities:
//
// 1. **The package made ready before it runs.** npm never rolls back an
//    install it didn't get to finish — a forced kill (taskkill, SIGKILL, a
//    host reload, a crash) leaves a half-written `_npx/<hash>` entry that
//    every later `npx` reads as installed and dies on: npm 10 runs a bin
//    that was never linked ("not found"), npm ≥ 11.2 fails reading the
//    entry's package.json (ENOENT) before it gets that far. So the entry
//    npm itself would use is read before every launch, by the marker npm
//    writes last, and removed when its install never finished; then the
//    package is installed as its own labeled phase, run to its exit with no
//    clock on it — a slow link is still a working one, and cutting the
//    download is exactly what poisons the cache. *A patchbay-owned install
//    store was considered and rejected*: it would own atomicity, but the
//    price is reimplementing the package manager's whole lifecycle (GC with
//    in-use guards, single-flight, stale-fallback policy, bin resolution) —
//    reading npm's own completion marker is the right-sized answer.
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
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { unlessAborted } from "./abort";
import type { Logger } from "./logger";
import { runToExit } from "./run-to-exit";

/** Normalized launcher name from a command that may be a path or a Windows
 * shim — THE one spelling of "is this an ecosystem launcher", shared by the
 * runtime resolver and every capability here. */
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

/** Cache-warm invocation for ecosystem launchers: a cold `npx`/`uvx`
 * downloads the whole package before the agent can say a byte — in total
 * silence (`npx -y` prints nothing while fetching), indistinguishable on the
 * wire from a hung TUI. The warmup runs the download as its own labeled
 * phase: the same launcher is asked to resolve the same package but run the
 * runtime's `--version` instead of the agent, and its exit is the one
 * reliable "package is ready" signal — or, failing, the launcher's own words
 * on why. Registry arg shapes only (resolveDistribution builds them); a
 * user-typed command downloads inside its own launch, as it would in a
 * terminal. */
export function warmupSpawn(spec: { command: string; args: readonly string[] }): { command: string; args: string[] } | null {
  const kind = launcherKind(spec.command);
  if (kind === "npx") {
    const pkg = spec.args[0] === "-y" ? npxPackageSpec(spec) : null;
    if (pkg === null) return null;
    return { command: spec.command, args: ["-y", "--package", pkg, "node", "--version"] };
  }
  if (kind === "uvx") {
    const pkg = spec.args[0];
    if (pkg === undefined || pkg.startsWith("-")) return null;
    return { command: spec.command, args: ["--from", pkg, "python", "--version"] };
  }
  return null;
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
 * agent's env — asked of npm itself (same env the launch uses) rather than
 * hardcoding per-platform defaults. Null when npm can't be asked. */
async function npmNpxRoot(
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const answer = await runToExit("npm", ["config", "get", "cache"], { env, signal, platform });
  const dir = answer?.stdout.trim() ?? "";
  return answer?.code === 0 && dir !== "" ? join(dir, "_npx") : null;
}

/** The `_npx` entry npm installs `pkgSpec` into — npm's own naming: the
 * first 16 hex characters of the sha512 of the launch's package specs,
 * sorted and newline-joined; one spec here, so the spec itself (the same
 * in npm 10 and 11). A local-directory spec, which npm names by its
 * resolved path instead, names no entry npm uses — read as absent,
 * nothing touched. */
export function npxEntryDir(npxRoot: string, pkgSpec: string): string {
  return join(npxRoot, createHash("sha512").update(pkgSpec).digest("hex").slice(0, 16));
}

export type NpxEntryState = "absent" | "finished" | "installing" | "unfinished";

/** npm's own rules for its `concurrency.lock` (npm ≥ 11): a live holder
 * touches it every second, and one untouched for a minute is stale — the
 * holder died. Read here as npm defines them, never as patchbay's guess. */
const NPM_LOCK_TOUCH_MS = 1_000;
const NPM_LOCK_STALE_MS = 60_000;

/** Where an `_npx` entry's install stands. The marker is the hidden
 * lockfile, `node_modules/.package-lock.json`: arborist writes it after
 * everything else an install does — unpack, install scripts, bins, the
 * root package.json and lockfile — whatever the user's npm config (it is
 * written for every local install, while `package-lock=false` or
 * `save=false` drop the others). An entry without it never finished,
 * unless an npm is installing into it right now. */
export async function npxEntryState(dir: string, now: number = Date.now()): Promise<NpxEntryState> {
  if (!(await pathExists(dir))) return "absent";
  if (await pathExists(join(dir, "node_modules", ".package-lock.json"))) return "finished";
  try {
    const lock = await stat(join(dir, "concurrency.lock"));
    if (now - lock.mtimeMs <= NPM_LOCK_STALE_MS) return "installing";
  } catch {
    // No lock: nobody is installing.
  }
  return "unfinished";
}

/** Before an npx launch: the entry npm would use, removed when its install
 * never finished, so npm installs it fresh. Answers the entry's state after
 * that — absent or finished, an install in progress waited out first; null
 * when this isn't an npx package launch or npm can't say where its cache
 * is. A stop ends the wait with its reason. A removal that fails rejects
 * with why — a half-written entry left in place is a certain failure, said
 * rather than skipped.
 * npm 10 keeps no concurrency lock, so another window installing the same
 * package this very moment reads as unfinished there: a deliberate scope
 * decision — that install fails visibly, and its next connect heals. */
export async function healNpxEntry(
  spec: { command: string; args: readonly string[] },
  env: Readonly<Record<string, string | undefined>>,
  opts: { signal?: AbortSignal; log: Logger; onPhase?: (label: string) => void },
): Promise<NpxEntryState | null> {
  const pkgSpec = npxPackageSpec(spec);
  if (pkgSpec === null) return null;
  const npxRoot = await npmNpxRoot(env, opts.signal);
  if (npxRoot === null) {
    opts.log.info(`launcher-health: npm couldn't say where its cache is — ${pkgSpec}'s cache entry left unchecked`);
    return null;
  }
  const dir = npxEntryDir(npxRoot, pkgSpec);
  let state = await npxEntryState(dir);
  // An npm holding the entry's lock is installing — another window's, or
  // one just killed whose lock npm hasn't yet judged stale. Either way npm
  // itself would wait on that lock, so this waits as npm does: until the
  // lock is released or goes stale by npm's rule (its holder touches it
  // every second), then reads the entry again.
  if (state === "installing") opts.onPhase?.("waiting for another install of the agent package…");
  while (state === "installing") {
    await unlessAborted(new Promise<void>((r) => setTimeout(r, NPM_LOCK_TOUCH_MS)), opts.signal);
    state = await npxEntryState(dir);
  }
  if (state !== "unfinished") return state;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    throw new Error(
      `the half-installed ${pkgSpec} in ${dir} couldn't be removed (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}) — close whatever holds it, or delete that folder, then connect again`,
    );
  }
  opts.log.info(`launcher-health: removed ${pkgSpec}'s unfinished install (${dir}) — npm installs it fresh`);
  return "absent";
}

/** A launcher that couldn't install its package: `detail` is the one line
 * a card shows, `output` the launcher's own last words. */
export class LauncherFailure extends Error {
  constructor(
    readonly detail: string,
    readonly output: readonly string[],
  ) {
    super(output.length > 0 ? `${detail} — ${output.slice(-3).join(" · ")}` : detail);
  }
}

/** How much of a failed launcher's output is kept — its error and the lines
 * leading to it, never a whole install log. */
const FAILURE_OUTPUT_LINES = 40;

/** A launcher package made ready before it runs: the npx entry healed, then
 * the package installed through warmupSpawn. `onPhase` hears a label for
 * the install phase — "downloading" when the npx entry shows one is
 * genuinely needed, "preparing" when nothing can say (uvx's cache isn't
 * ours to read), nothing for an npx package already installed. Rejects
 * with the signal's reason when stopped, and with a LauncherFailure
 * carrying the launcher's words when the install fails. Anything that
 * isn't a launcher package passes through untouched. */
export async function prepareLauncher(
  spec: { command: string; args: readonly string[]; cwd?: string },
  env: Readonly<Record<string, string | undefined>>,
  opts: { signal?: AbortSignal; log: Logger; who: string; onPhase?: (label: string) => void },
): Promise<void> {
  const state = await healNpxEntry(spec, env, opts);
  const warm = warmupSpawn(spec);
  if (warm === null) return;
  if (state === null) opts.onPhase?.("preparing the agent package…");
  else if (state !== "finished") opts.onPhase?.("downloading the agent package…");
  opts.log.info(`${opts.who}: installing its launcher package (${warm.args.join(" ")})`);
  const answer = await runToExit(warm.command, warm.args, { env, cwd: spec.cwd, signal: opts.signal });
  // Couldn't run at all: the real spawn refuses with the reason.
  if (answer === null || answer.code === 0) return;
  const output = answer.stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-FAILURE_OUTPUT_LINES);
  for (const line of output) opts.log.info(`${opts.who} launcher: ${line}`);
  throw new LauncherFailure(
    `${launcherKind(spec.command)} couldn't install the package (${answer.code === null ? "killed" : `exit ${answer.code}`})`,
    output,
  );
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

/** The version of `bundledPkg` inside the npx entry `launchSpec` runs from —
 * i.e. the CLI patchbay actually runs. Read-only inspection of npm's dir.
 * Null when not installed (yet). */
export async function bundledVersionInNpxCache(
  npxRoot: string,
  launchSpec: string,
  bundledPkg: string,
): Promise<string | null> {
  try {
    const manifest = JSON.parse(
      await readFile(join(npxEntryDir(npxRoot, launchSpec), "node_modules", ...bundledPkg.split("/"), "package.json"), "utf8"),
    ) as { version?: string };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/** `<bin> --version` for the PATH sibling; null when absent (nothing to
 * compare — silence, not an error). Bin names come from PATH_SIBLINGS only,
 * never from registry data; resolution (spawn-resolve.ts) finds the npm
 * .cmd shims these CLIs usually are on Windows. */
async function pathSiblingVersion(
  bin: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const answer = await runToExit(bin, ["--version"], { env, platform });
  const m = answer === null ? null : /\d+\.\d+(\.\d+)?/.exec(answer.stdout);
  return answer?.code === 0 && m != null ? m[0] : null;
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
export async function checkPathDivergence(
  spec: { command: string; args: readonly string[]; env: Readonly<Record<string, string>> },
  registryId: string | null,
): Promise<PathDivergence | null> {
  const sibling = registryId === null ? undefined : PATH_SIBLINGS[registryId];
  if (sibling === undefined) return null;
  const launchSpec = npxPackageSpec(spec);
  if (launchSpec === null) return null;
  const env = { ...process.env, ...spec.env };
  const [npxRoot, pathVersion] = await Promise.all([
    npmNpxRoot(env),
    pathSiblingVersion(sibling.bin, env),
  ]);
  if (npxRoot === null || pathVersion === null) return null;
  const bundledVersion = await bundledVersionInNpxCache(npxRoot, launchSpec, sibling.bundledPkg);
  if (bundledVersion === null) return null;
  return versionsDiverge(pathVersion, bundledVersion)
    ? { bin: sibling.bin, pathVersion, bundledVersion }
    : null;
}
