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
//    entry's package.json (ENOENT) before it gets that far. And npm calls an
//    install finished that came up short: any failure of an optional
//    package — a download cut mid-stream, a scanner holding the file — is
//    skipped at verbose level, the marker written, exit 0, and no later
//    `npx` fetches it again; a platform binary shipped that way is simply
//    gone. So the entry npm itself would use is read before every launch —
//    by the marker npm writes last, then against what npm's own records say
//    it was meant to hold — and removed when it never finished or came up
//    short; then the package is installed as its own labeled phase, run to
//    its exit with no clock on it — a slow link is still a working one, and
//    cutting the download is exactly what poisons the cache — and tried
//    again when it doesn't complete. *A patchbay-owned install store was
//    considered and rejected*: it would own atomicity, but the price is
//    reimplementing the package manager's whole lifecycle (GC with in-use
//    guards, single-flight, stale-fallback policy, bin resolution) —
//    reading npm's own records, judged by npm's own rules, is the
//    right-sized answer.
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
import { checkPlatform } from "npm-install-checks";
import { unlessAborted } from "./abort";
import type { Logger } from "./logger";
import { runToExit, type ExitAnswer } from "./run-to-exit";

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

/** A package record as npm's lockfiles keep it — the fields read here. */
interface LockRecord {
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

async function lockPackages(file: string): Promise<Record<string, LockRecord> | null> {
  try {
    return (JSON.parse(await readFile(file, "utf8")) as { packages?: Record<string, LockRecord> }).packages ?? null;
  } catch {
    return null;
  }
}

/** Where node finds `name` from the package at lockfile path `from`: its own
 * node_modules, then each enclosing one up to the entry's. */
function lookupPaths(from: string, name: string): string[] {
  const paths: string[] = [];
  for (let dir = from; ; ) {
    paths.push(`${dir === "" ? "" : `${dir}/`}node_modules/${name}`);
    if (dir === "") return paths;
    const up = dir.lastIndexOf("/node_modules/");
    dir = up < 0 ? "" : dir.slice(0, up);
  }
}

/** A package's platform facts from npm's own cache — the registry manifest
 * npm read to plan the install, asked offline. The whole manifest, never
 * named fields: asked for fields of which only one exists, npm prints that
 * one bare, nameless. Null when npm can't say. */
async function cachedPlatformFacts(
  spec: string,
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<LockRecord | null> {
  const answer = await runToExit("npm", ["view", spec, "--json", "--offline"], { env, signal });
  if (answer?.code !== 0) return null;
  try {
    const manifest = JSON.parse(answer.stdout) as LockRecord | LockRecord[];
    // A range matching several versions: npm lists them oldest first.
    return (Array.isArray(manifest) ? manifest.at(-1) : manifest) ?? null;
  } catch {
    return null;
  }
}

/** The platform npm installs for: its own node's, which is not always
 * patchbay's — an x64 node under Rosetta or on Windows ARM installs x64
 * binaries beside an arm64 editor. Asked of the node the launch's env finds,
 * the one npx's own shim runs. Null when it can't be asked. */
async function npmPlatform(
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<{ os: string; cpu: string } | null> {
  const answer = await runToExit("node", ["-p", "process.platform + ' ' + process.arch"], { env, signal });
  const [os, cpu] = answer?.code === 0 ? answer.stdout.trim().split(" ") : [];
  return os !== undefined && cpu !== undefined ? { os, cpu } : null;
}

/** The optional packages a finished npx entry was meant to hold but
 * doesn't — what npm skipped when they failed. The candidates are npm's own
 * record: each installed package's declared optionalDependencies (the
 * hidden lockfile lists what was installed) that resolve to nothing on
 * disk. Most are another platform's binary, skipped on purpose; npm's own
 * rule tells which (npm-install-checks), judging each one's platform facts
 * against the platform npm installs for — facts from the full lockfile npm
 * writes beside the install, or from npm's cache where that lacks them
 * (`package-lock=false` writes none; npm 10 leaves `libc` out, which only
 * Linux reads). One neither can describe stays unjudged, never guessed; so
 * does everything when npm's platform can't be asked. */
export async function droppedOptionals(
  dir: string,
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<string[]> {
  const installed = await lockPackages(join(dir, "node_modules", ".package-lock.json"));
  if (installed === null) return [];
  const planned = (await lockPackages(join(dir, "package-lock.json"))) ?? {};
  const missing = new Map<string, { spec: string; facts: LockRecord | undefined }>();
  for (const [path, record] of Object.entries(installed)) {
    for (const [name, spec] of Object.entries(record.optionalDependencies ?? {})) {
      if (missing.has(name)) continue;
      const paths = lookupPaths(path, name);
      const present = await Promise.all(paths.map((p) => pathExists(join(dir, p, "package.json"))));
      if (present.includes(true)) continue;
      missing.set(name, { spec, facts: paths.map((p) => planned[p]).find((r) => r !== undefined) });
    }
  }
  if (missing.size === 0) return [];
  const installsFor = await npmPlatform(env, signal);
  if (installsFor === null) return [];
  const judged = await Promise.all(
    [...missing].map(async ([name, { spec, facts }]) => {
      const known = facts !== undefined && (installsFor.os !== "linux" || facts.libc !== undefined);
      const platform = known ? facts : await cachedPlatformFacts(`${name}@${spec}`, env, signal);
      if (platform === null) return null;
      try {
        checkPlatform(platform, false, installsFor);
        return name;
      } catch {
        return null;
      }
    }),
  );
  return judged.filter((name) => name !== null);
}

/** Before an npx launch: the entry npm would use, removed when its install
 * never finished or came up short (droppedOptionals), so npm installs it
 * fresh — fetching only what didn't land: npm's cache keeps every package
 * that did. Answers the entry and its state after that — absent or
 * finished, an install in progress waited out first; null when this isn't
 * an npx package launch or npm can't say where its cache is. A stop ends
 * the wait with its reason. A removal that fails rejects with why — a
 * half-written entry left in place is a certain failure, said rather than
 * skipped.
 * npm 10 keeps no concurrency lock, so another window installing the same
 * package this very moment reads as unfinished there: a deliberate scope
 * decision — that install fails visibly, and its next connect heals. */
export async function healNpxEntry(
  spec: { command: string; args: readonly string[] },
  env: Readonly<Record<string, string | undefined>>,
  opts: { signal?: AbortSignal; log: Logger; onPhase?: (label: string) => void },
): Promise<{ dir: string; state: "absent" | "finished" } | null> {
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
  if (state === "absent") return { dir, state };
  const dropped = state === "finished" ? await droppedOptionals(dir, env, opts.signal) : [];
  if (state === "finished" && dropped.length === 0) return { dir, state };
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    throw new Error(
      `the incomplete ${pkgSpec} in ${dir} couldn't be removed (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}) — close whatever holds it, or delete that folder, then connect again`,
    );
  }
  opts.log.info(
    dropped.length > 0
      ? `launcher-health: removed ${pkgSpec}'s install that came up short (${dir}; npm skipped ${dropped.join(", ")}) — npm installs what's missing`
      : `launcher-health: removed ${pkgSpec}'s unfinished install (${dir}) — npm installs it fresh`,
  );
  return { dir, state: "absent" };
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

/** Tries after the first when an install doesn't complete. A link that
 * drops mid-download fails npm's fetch outright — npm retries a request
 * that can't start, never one cut mid-stream, and resumes nothing — while
 * each try fetches only what didn't land. No clock between tries: a link
 * that is down fails npm's own retries, which wait between attempts. */
const INSTALL_RETRIES = 3;

/** A launcher package made ready before it runs: the npx entry healed, then
 * the package installed through warmupSpawn — and an install that doesn't
 * complete (the launcher fails, or npm finishes short of what it meant to
 * hold) healed and tried again, INSTALL_RETRIES times. `onPhase` hears a
 * label for the install phase — "downloading" when the npx entry shows one
 * is genuinely needed, "preparing" when nothing can say (uvx's cache isn't
 * ours to read), nothing for an npx package already installed, and each
 * retry as it starts. Rejects with the signal's reason when stopped, and
 * with the last try's LauncherFailure — the launcher's words, or what npm
 * left out. Anything that isn't a launcher package passes through
 * untouched. */
export async function prepareLauncher(
  spec: { command: string; args: readonly string[]; cwd?: string },
  env: Readonly<Record<string, string | undefined>>,
  opts: { signal?: AbortSignal; log: Logger; who: string; onPhase?: (label: string) => void },
): Promise<void> {
  const warm = warmupSpawn(spec);
  for (let retry = 0; ; retry++) {
    const entry = await healNpxEntry(spec, env, opts);
    if (warm === null) return;
    if (retry === 0) {
      if (entry === null) opts.onPhase?.("preparing the agent package…");
      else if (entry.state !== "finished") opts.onPhase?.("downloading the agent package…");
    }
    opts.log.info(`${opts.who}: installing its launcher package (${warm.args.join(" ")})`);
    const answer = await runToExit(warm.command, warm.args, { env, cwd: spec.cwd, signal: opts.signal });
    // Couldn't run at all: the real spawn refuses with the reason.
    if (answer === null) return;
    const failure =
      answer.code !== 0
        ? exitFailure(spec.command, answer, opts)
        : entry?.state === "absent"
          ? await shortFailure(entry.dir, env, opts.signal)
          : null;
    if (failure === null) return;
    if (retry === INSTALL_RETRIES) throw failure;
    opts.log.info(`${opts.who}: ${failure.message} — trying again (${retry + 1} of ${INSTALL_RETRIES})`);
    opts.onPhase?.(`the download didn't complete — trying again (${retry + 1} of ${INSTALL_RETRIES})…`);
  }
}

/** A launcher that exited failing, in its own last words. */
function exitFailure(command: string, answer: ExitAnswer, opts: { log: Logger; who: string }): LauncherFailure {
  const output = answer.stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-FAILURE_OUTPUT_LINES);
  for (const line of output) opts.log.info(`${opts.who} launcher: ${line}`);
  return new LauncherFailure(
    `${launcherKind(command)} couldn't install the package (${answer.code === null ? "killed" : `exit ${answer.code}`})`,
    output,
  );
}

/** An install npm finished short of what it meant to hold — it says nothing
 * of it, so the missing packages are the words. The cause is inferred, not
 * seen: npm skips a failed optional package whatever failed it, and a cut
 * download is by far the commonest. */
async function shortFailure(
  dir: string,
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<LauncherFailure | null> {
  const dropped = await droppedOptionals(dir, env, signal);
  if (dropped.length === 0) return null;
  return new LauncherFailure(
    `part of the package didn't finish downloading (${dropped.join(", ")}) — probably an unstable internet connection; trying again downloads only what's missing`,
    [],
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
