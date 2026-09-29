// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Launch prerequisites: what must exist on disk before an agent can spawn,
// acquired as a labeled phase of the connect — on the agent's own card,
// never as part of adding it. Two kinds share one molecule (single-flight
// per artifact, explicit consent before any download, a phase label while
// it runs, the binary installer's staging+rename underneath):
//
// Runtime resolution for ecosystem launchers: an `npx` agent needs a working
// Node.js, a `uvx` agent needs uv (which provisions its own Python) —
// neither is guaranteed on the machine, and Windows is where the gap
// actually bites. Detect-first, sandbox-fallback: the system runtime is
// used when a real `--version` round-trip — through the same spawn rules as
// the launch itself — proves it works (presence on PATH proves nothing; the
// gate is the round-trip, re-run fresh every connect, never persisted), and
// only on a failed gate is a pinned runtime downloaded into the extension's
// own storage and PATH-prepended into that one agent's spawn env. The
// user's system is never written to: no installs, no PATH edits, no admin —
// the managed runtime is invisible outside the child process. Everything
// else about the agent (its own state dirs, auth, sessions) stays wherever
// the agent puts it; only the interpreter is ours.
//
// Registry `binary` distributions: the archive provides the command itself.
// The spec carries the archive facts; the phase resolves `command` to the
// cached absolute path, downloading first when this exact version isn't
// cached yet — checked against the SHA-256 its registry entry publishes
// when there is one, and always confirmed first, never a silent
// fetch-and-run.
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { launcherKind } from "./launcher-health";
import type { Logger } from "./logger";
import type { LaunchSpec } from "./pool";
import { resolveSpawn } from "./spawn-resolve";
import { killTree, treeSpawnOptions } from "./process-tree";
import {
  ChecksumMismatch,
  installBinary,
  isBinaryInstalled,
  parseSha256,
  type BinaryInstallSpec,
  type InstalledBinary,
} from "./stores/binary-installer";

export type RuntimeKind = "node" | "uv";

/** What interpreter a launch command needs before it can say a byte —
 * a property of the launcher, not the OS: `npx` is a Node.js program,
 * `uvx` is a self-contained binary that provides its own Python. Anything
 * else (binary distributions, user-typed executables) needs nothing. */
export function requiredRuntime(command: string): RuntimeKind | null {
  const kind = launcherKind(command);
  if (kind === "npx") return "node";
  if (kind === "uvx") return "uv";
  return null;
}

export function runtimeName(kind: RuntimeKind): string {
  return kind === "node" ? "Node.js" : "uv";
}

/** Agents on npm routinely assume a current-LTS Node; a node old enough to
 * fail this floor would pass a bare presence check and then die inside the
 * agent with an unrelated-looking syntax error. Conservative on purpose —
 * one LTS behind current, not bleeding edge. */
export const NODE_FLOOR_MAJOR = 18;

/** First line of `node --version` ("v22.14.0") → 22; null when unparseable. */
export function nodeMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version.trim());
  return m === null ? null : Number(m[1]);
}

/** Generous: a warm `--version` answers in milliseconds, so a runtime that
 * needs longer than this is pathological — but Windows AV scanning a
 * first-touch node.exe can genuinely take seconds, and timing a *working*
 * system into a runtime download would be the worse failure. */
const PROBE_TIMEOUT_MS = 10_000;

/** One `--version` round-trip: the version string on success, null on any
 * failure (not found, non-zero exit, empty output, timeout). Goes through
 * resolveSpawn so a Windows `npx` probe gets the same .cmd + shell
 * treatment the real launch would — probing a path the launch won't take
 * would prove nothing. */
export function probeVersion(
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const launch = resolveSpawn(command, ["--version"], env);
  if (launch.error !== undefined) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, {
      env,
      shell: launch.shell,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      ...treeSpawnOptions,
    });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    // killTree, not child.kill: an npx probe rides cmd.exe on win32 and
    // forks node children everywhere — killing the direct child alone
    // leaks the subtree the timeout gave up on.
    const timer = setTimeout(() => {
      if (child.pid !== undefined) killTree(child.pid, "SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    // "close", not "exit": exit fires when the process dies, which can beat
    // the delivery of its buffered stdout — a fast --version would then
    // read as empty and fail the gate it should pass. close waits for the
    // stdio streams to drain.
    child.on("close", (code) => {
      clearTimeout(timer);
      const version = out.trim().split(/\r?\n/)[0]?.trim() ?? "";
      resolve(code === 0 && version !== "" ? version : null);
    });
  });
}

export interface RuntimeGate {
  ok: boolean;
  detail: string;
  /** Which probe failed — "interpreter" (bare `node`, PATH-resolved, the
   * thing a managed install replaces) or "launcher" (the configured
   * command itself). Drives the purge decision on a failed post-install
   * gate: only a failure the managed runtime could own justifies evicting
   * its cache. */
  failed?: "interpreter" | "launcher";
}

/** The gate: does this env's runtime actually answer? The launcher probe
 * runs the CONFIGURED command (`spec.command` — absolute path or bare
 * name), never a hardcoded literal: gating a command the launch won't run
 * proves nothing (an absolute-path npx that works must pass). For node the
 * bare interpreter must also round-trip above the version floor (npx
 * resolves node via PATH/shebang, so bare `node` is exactly what the
 * launch will look up); for uv the launcher is the runtime — one probe.
 * `opts` overrides are the test seam: fake runtimes under other names. */
export async function gateRuntime(
  kind: RuntimeKind,
  env: NodeJS.ProcessEnv,
  opts?: { launcher?: string; interpreter?: string },
): Promise<RuntimeGate> {
  const launcher = opts?.launcher ?? (kind === "node" ? "npx" : "uvx");
  if (kind === "node") {
    const interpreter = opts?.interpreter ?? "node";
    const [nodeVersion, launcherVersion] = await Promise.all([
      probeVersion(interpreter, env),
      probeVersion(launcher, env),
    ]);
    if (nodeVersion === null) {
      return { ok: false, failed: "interpreter", detail: "node did not answer --version" };
    }
    if (launcherVersion === null) {
      return { ok: false, failed: "launcher", detail: `${launcher} did not answer --version` };
    }
    const major = nodeMajor(nodeVersion);
    if (major === null || major < NODE_FLOOR_MAJOR) {
      return {
        ok: false,
        failed: "interpreter",
        detail: `node ${nodeVersion} is below the v${NODE_FLOOR_MAJOR} floor`,
      };
    }
    return { ok: true, detail: `node ${nodeVersion}` };
  }
  const uvxVersion = await probeVersion(launcher, env);
  if (uvxVersion === null) {
    return { ok: false, failed: "launcher", detail: `${launcher} did not answer --version` };
  }
  return { ok: true, detail: uvxVersion };
}

// Curated pins, bumped deliberately like any registry entry — never
// "latest", which would re-decide the runtime on every download. node.org
// and the uv release CDN are first-party sources over HTTPS, and each
// archive is held to the digest its publisher lists, pinned below; the
// archives carry npx/uvx alongside the interpreter, so PATH-prepending the
// one directory equips the whole launch.
const NODE_VERSION = "22.14.0";
const UV_VERSION = "0.7.3";

/** Every pinned runtime archive's SHA-256, as its publisher lists it —
 * nodejs.org's SHASUMS256.txt, uv's per-archive `.sha256` — keyed by the
 * archive's file name. The name carries the version, so bumping a pin
 * without its digests leaves an archive with none, which the catalog's
 * test refuses. A released archive never changes, so a digest checked in
 * here is not a copy that can drift. */
const RUNTIME_SHA256: Readonly<Record<string, string>> = {
  "node-v22.14.0-darwin-arm64.tar.gz": "e9404633bc02a5162c5c573b1e2490f5fb44648345d64a958b17e325729a5e42",
  "node-v22.14.0-darwin-x64.tar.gz": "6698587713ab565a94a360e091df9f6d91c8fadda6d00f0cf6526e9b40bed250",
  "node-v22.14.0-linux-arm64.tar.gz": "8cf30ff7250f9463b53c18f89c6c606dfda70378215b2c905d0a9a8b08bd45e0",
  "node-v22.14.0-linux-x64.tar.gz": "9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2",
  "node-v22.14.0-win-arm64.zip": "2d71f5f9b2fffa33baa108c07d74b0d24e0c3dd8f441d567772ae0e3dd4b1a22",
  "node-v22.14.0-win-x64.zip": "55b639295920b219bb2acbcfa00f90393a2789095b7323f79475c9f34795f217",
  "uv-aarch64-apple-darwin.tar.gz": "162b328fc63e0075d4267688201de91356e1c1b81db50419fa4466cfe2dfdebc",
  "uv-aarch64-pc-windows-msvc.zip": "542b318c98b0295dd3d620fbcd63388757f382e14c69c569cb3ce793aa75c975",
  "uv-aarch64-unknown-linux-gnu.tar.gz": "2c2be8bbb83e9bc722f2013de8bb7506cfe6521d0e30b4ad046849d036b3eea6",
  "uv-x86_64-apple-darwin.tar.gz": "d676940b51bdd5606b218bc2965fed67731f94ad07926045716acbf78626e09b",
  "uv-x86_64-pc-windows-msvc.zip": "20d3a420abbf2af9699cd9a02225d9325344046af8deb15563cc451e3c4fd059",
  "uv-x86_64-unknown-linux-gnu.tar.gz": "17fc118ba4d7e9303f84fcabdc0a593fc3480ba76eb6980668fdbbb96fe88562",
};

/** A pinned runtime archive as an install spec, its digest looked up by
 * the archive's file name. */
function runtimeEntry(agentId: string, version: string, archiveUrl: string, cmd: string): BinaryInstallSpec {
  const file = archiveUrl.slice(archiveUrl.lastIndexOf("/") + 1);
  return { agentId, version, archiveUrl, cmd, args: [], env: {}, sha256: RUNTIME_SHA256[file] ?? null };
}

/** The download that backs a failed gate, as a binary-installer spec —
 * pseudo agentIds keep runtimes in the same cache with the same
 * staging/rename integrity story as agent binaries; the dot prefix
 * reserves them (no registry or user agent id starts with a dot), so a
 * real agent can never collide with a runtime's cache slot. Null when no
 * managed build exists for this platform/arch (the caller surfaces that
 * honestly).
 * `cmd` names the launcher-adjacent interpreter; its dirname is the PATH
 * entry. Official node builds are glibc — on musl (Alpine) the
 * post-install gate fails and the connect dies with a real reason instead
 * of a half-running agent. */
export function runtimeInstallSpec(
  kind: RuntimeKind,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): BinaryInstallSpec | null {
  if (arch !== "x64" && arch !== "arm64") return null;
  if (kind === "node") {
    if (platform !== "win32" && platform !== "darwin" && platform !== "linux") return null;
    const slug =
      platform === "win32"
        ? `node-v${NODE_VERSION}-win-${arch}`
        : `node-v${NODE_VERSION}-${platform}-${arch}`;
    const ext = platform === "win32" ? "zip" : "tar.gz";
    return runtimeEntry(
      ".runtime-node",
      NODE_VERSION,
      `https://nodejs.org/dist/v${NODE_VERSION}/${slug}.${ext}`,
      // win zips put node.exe + npx.cmd at the package root; tars under bin/.
      platform === "win32" ? `${slug}/node.exe` : `${slug}/bin/node`,
    );
  }
  const rustArch = arch === "x64" ? "x86_64" : "aarch64";
  if (platform === "win32") {
    return runtimeEntry(
      ".runtime-uv",
      UV_VERSION,
      `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${rustArch}-pc-windows-msvc.zip`,
      "uvx.exe", // windows zips are flat: uv.exe + uvx.exe at the root
    );
  }
  if (platform !== "darwin" && platform !== "linux") return null;
  const target =
    platform === "darwin" ? `uv-${rustArch}-apple-darwin` : `uv-${rustArch}-unknown-linux-gnu`;
  return runtimeEntry(
    ".runtime-uv",
    UV_VERSION,
    `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${target}.tar.gz`,
    `${target}/uvx`,
  );
}

/** PATH-prepend into the spec's env map. The spawn env is
 * `{...process.env, ...spec.env}`, so writing the spec's PATH key replaces
 * the inherited one wholesale — the injected value must carry the full
 * existing PATH after the managed dir. The inherited key's own casing
 * (Windows convention is "Path") is reused: a spawn env block holding both
 * "PATH" and "Path" is undefined territory. Idempotent — a restart
 * re-resolves the already-resolved snapshot and must not stack the dir. */
export function prependPath(
  env: Record<string, string>,
  dir: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const keyOf = (o: Record<string, unknown>) =>
    Object.keys(o).find((k) => k.toUpperCase() === "PATH");
  const key = keyOf(env) ?? keyOf(base) ?? "PATH";
  const existing = env[key] ?? base[key] ?? "";
  if (existing === dir || existing.startsWith(dir + delimiter)) return env;
  return { ...env, [key]: existing === "" ? dir : `${dir}${delimiter}${existing}` };
}

/** Whether a download will be held to a published SHA-256 — and when not,
 * which of the two reasons it is: nothing was published, or the registry
 * that would say couldn't be read. */
export type DownloadCheck = "sha256" | "none-published" | "registry-unreachable";

/** What the user is asked to consent to before a download — a pinned
 * runtime the launcher needs, or a registry agent's own binary archive. */
export type DownloadAsk =
  | { kind: "runtime"; runtime: RuntimeKind; version: string; check: DownloadCheck }
  | { kind: "agent"; name: string; version: string; archiveUrl: string; check: DownloadCheck };

/** A second mismatch, as the connect failure the card shows — `whose`
 * names where the digest came from. Nothing was installed. */
function mismatchFailure(label: string, archiveUrl: string, whose: string, err: ChecksumMismatch, next: string): Error {
  return new Error(
    `${label}: the download from ${new URL(archiveUrl).host} doesn't match the SHA-256 ${whose} ` +
      `(expected ${err.expected}, got ${err.actual}) — nothing was installed. ${next}`,
  );
}

export interface LaunchResolveDeps {
  /** binary-installer cache root (bin-cache under globalStorage). */
  cacheRoot: string;
  log: Logger;
  /** Explicit first-download gate — the catalog is curated and pinned, but
   * a download is still a download: never silent. Only consulted when a
   * download would actually happen; a cached artifact never re-asks.
   * Absent → allowed (tests). */
  confirmDownload?: (ask: DownloadAsk) => Promise<boolean>;
  /** Connect-status label seam, live only while genuinely downloading. */
  onPhase?: (label: string) => void;
  /** The digest a registry binary's download is checked against (raw, as
   * published), given the one pinned with its version — the registry's
   * current word while it still lists that version. Absent → the pinned
   * one (tests). */
  digestFor?: (agentId: string, version: string, pinned: string | null) => string | null;
  /** Reads the registry now — before a download and again after a
   * mismatch — answering whether it could be read. */
  refreshRegistry?: () => Promise<boolean>;
  /** Test seams. `probes.launcher` replaces spec.command in the gate;
   * `probes.interpreter` replaces bare `node`. */
  probes?: { launcher?: string; interpreter?: string };
  install?: typeof installBinary;
}

/** Single-flight per (artifact id, version, cacheRoot): concurrent connects
 * needing the same artifact (startup fans runtime-needing agents out
 * together; Connect and Upgrade can race on one agent) must share one
 * confirmation and one install — unlocked, they'd stack modals and
 * interleave rm/extract/rename inside the same staging directory. The
 * entry clears on settle so a failed install retries fresh next connect. */
const inflightInstalls = new Map<string, Promise<InstalledBinary>>();

/** The digest a download is held to, and what the prompt may say of it. */
interface Digest {
  sha256: string | null;
  check: DownloadCheck;
}

/** The one download molecule: cached → hand it back; not cached → read
 * the digest, ask, label the phase, install. `declined` is the thrown
 * message when the user says no — the connect failure it is. `digest` is
 * read only when a download is about to happen (a cached copy is never
 * blocked by what a source says now), and read again after a mismatch;
 * absent, the catalog's own digest stands. A mismatch earns one more
 * download against the digest as its source reads then — a host still
 * serving an older file, or a vendor mid-way through re-publishing, clears
 * there; a second mismatch is thrown as the answer. A consented check is
 * never dropped: a source that stops publishing its digest mid-install
 * keeps the first one. */
function installOnce(
  deps: LaunchResolveDeps,
  catalog: BinaryInstallSpec,
  gate: {
    ask: (check: DownloadCheck) => DownloadAsk;
    phase: string;
    declined: string;
    digest?: () => Promise<Digest>;
  },
): Promise<InstalledBinary> {
  const flightKey = `${catalog.agentId}@${catalog.version}@${deps.cacheRoot}`;
  let flight = inflightInstalls.get(flightKey);
  if (flight === undefined) {
    flight = (async () => {
      const install = deps.install ?? installBinary;
      if (await isBinaryInstalled(deps.cacheRoot, catalog.agentId, catalog.version, catalog.cmd)) {
        return install(deps.cacheRoot, catalog, deps.log);
      }
      const own: Digest = { sha256: catalog.sha256, check: catalog.sha256 === null ? "none-published" : "sha256" };
      const { sha256, check } = gate.digest === undefined ? own : await gate.digest();
      const allowed = (await deps.confirmDownload?.(gate.ask(check))) ?? true;
      if (!allowed) throw new Error(gate.declined);
      deps.onPhase?.(gate.phase);
      let installed: InstalledBinary;
      try {
        installed = await install(deps.cacheRoot, { ...catalog, sha256 }, deps.log);
      } catch (err) {
        if (!(err instanceof ChecksumMismatch)) throw err;
        deps.log.info(`${catalog.agentId} ${catalog.version}: ${err.message} — reading the digest again, downloading once more`);
        const again = (gate.digest === undefined ? null : (await gate.digest()).sha256) ?? sha256;
        installed = await install(deps.cacheRoot, { ...catalog, sha256: again }, deps.log);
      }
      if (sha256 !== null) deps.log.info(`${catalog.agentId} ${catalog.version}: download matched its SHA-256`);
      else if (check === "registry-unreachable") {
        deps.log.warn(`${catalog.agentId} ${catalog.version}: installed unchecked — the ACP registry couldn't be read for its SHA-256`);
      } else deps.log.info(`${catalog.agentId} ${catalog.version}: installed unchecked — no SHA-256 is published for it`);
      return installed;
    })();
    inflightInstalls.set(flightKey, flight);
    const clear = () => inflightInstalls.delete(flightKey);
    flight.then(clear, clear);
  }
  return flight;
}

/** The launch-phase decision: given the spec about to spawn, return the
 * spec that actually spawns. Non-launcher specs pass through untouched; a
 * launcher whose system runtime passes the gate passes through untouched
 * (reality wins — zero behavior change); only a failed gate provisions the
 * managed runtime and returns a copy with its bin dir PATH-prepended. The
 * command itself is never rewritten — `npx` stays `npx`, findable through
 * the injected PATH, so every downstream spelling (warmup, .cmd shim
 * handling, cache repair) keeps working unchanged. Throws when no runtime
 * can be had; the caller surfaces that as the connect failure it is. */
export async function resolveRuntime(
  spec: LaunchSpec,
  deps: LaunchResolveDeps,
): Promise<LaunchSpec> {
  const kind = requiredRuntime(spec.command);
  if (kind === null) return spec;

  const probes = { launcher: deps.probes?.launcher ?? spec.command, interpreter: deps.probes?.interpreter };
  const system = await gateRuntime(kind, { ...process.env, ...spec.env }, probes);
  if (system.ok) {
    deps.log.debug(`${spec.agentId}: system runtime OK (${system.detail})`);
    return spec;
  }

  const catalog = runtimeInstallSpec(kind);
  if (catalog === null) {
    throw new Error(
      `${spec.command} needs ${runtimeName(kind)} (${system.detail}) and no managed build exists for ${process.platform}-${process.arch} — install ${runtimeName(kind)} manually and reconnect`,
    );
  }
  deps.log.info(
    `${spec.agentId}: system runtime unusable (${system.detail}) — using managed ${runtimeName(kind)} ${catalog.version}`,
  );

  const label = `${runtimeName(kind)} ${catalog.version}`;
  const installed = await installOnce(deps, catalog, {
    ask: (check) => ({ kind: "runtime", runtime: kind, version: catalog.version, check }),
    phase: `downloading ${label}…`,
    declined: `${runtimeName(kind)} download declined (${system.detail}) — install ${runtimeName(kind)} manually and reconnect`,
  }).catch((err: unknown) => {
    if (!(err instanceof ChecksumMismatch)) throw err;
    throw mismatchFailure(label, catalog.archiveUrl, "its publisher lists", err, `Install ${runtimeName(kind)} manually and reconnect.`);
  });
  const env = prependPath(spec.env, dirname(installed.command));

  // The gate that judged the system runtime judges ours too: a managed
  // runtime that can't answer --version (glibc build on musl, truncated
  // archive) must fail the connect with a real reason, not crash the agent
  // spawn cryptically.
  const verified = await gateRuntime(kind, { ...process.env, ...env }, probes);
  if (!verified.ok) {
    // Evict only a failure the managed install could own: the bare
    // interpreter, or a bare-name launcher (both resolve through the
    // prepended dir first). Without the purge, a cached-but-broken runtime
    // is a permanent connect-failure loop — the file's existence keeps
    // short-circuiting the download forever. An absolute-path launcher
    // failing is the config's fault; the cache stays.
    const managedAtFault =
      verified.failed === "interpreter" || basename(probes.launcher) === probes.launcher;
    if (managedAtFault) {
      await rm(join(deps.cacheRoot, catalog.agentId, catalog.version), { recursive: true, force: true });
      throw new Error(
        `managed ${runtimeName(kind)} ${catalog.version} failed its own gate (${verified.detail}) — cached copy removed; reconnect to retry, or install ${runtimeName(kind)} manually`,
      );
    }
    throw new Error(
      `${spec.command} did not answer even with managed ${runtimeName(kind)} ${catalog.version} on PATH (${verified.detail}) — check the agent's command`,
    );
  }
  deps.log.info(`${spec.agentId}: managed ${runtimeName(kind)} ready (${verified.detail})`);
  return { ...spec, env };
}

/** A registry `binary` agent's own archive, as the launch phase: the spec
 * names the command relative to the archive; this hands back the spec with
 * `command` resolved to the cached absolute path (and the install dir as
 * cwd, where the archive's siblings live), downloading first when this
 * exact version isn't cached — one confirmation, one install, however many
 * connects race for it. Specs without archive facts pass through untouched.
 * The download is held to its published SHA-256 when there is one. Throws
 * — the connect failing on the card — when the user declines (the next
 * Connect asks again), when the published digest isn't one (nothing is
 * downloaded), and when the download still doesn't match it after the one
 * retry (nothing is installed, and there is no run-anyway: a user who
 * wants those bytes regardless adds them as a custom command, owning them
 * outright). */
export async function resolveBinaryLaunch(
  spec: LaunchSpec,
  deps: LaunchResolveDeps,
): Promise<LaunchSpec> {
  if (spec.binary === undefined) return spec;
  const { archiveUrl, version, cmd } = spec.binary;
  const pinned = spec.binary.sha256 ?? null;
  const label = `${spec.name} ${version}`;
  // Read the registry at the moment it matters — right before the bytes
  // arrive — so the digest is today's, never a stale cache's silence.
  const digest = async (): Promise<Digest> => {
    const reachable = (await deps.refreshRegistry?.()) ?? true;
    const raw = deps.digestFor === undefined ? pinned : deps.digestFor(spec.agentId, version, pinned);
    if (raw === null) return { sha256: null, check: reachable ? "none-published" : "registry-unreachable" };
    const sha256 = parseSha256(raw);
    if (sha256 === null) {
      throw new Error(`${label}: its registry entry's SHA-256 isn't one ("${raw}") — nothing was downloaded`);
    }
    return { sha256, check: "sha256" };
  };
  let installed: InstalledBinary;
  try {
    installed = await installOnce(
      deps,
      { agentId: spec.agentId, version, archiveUrl, cmd, args: spec.args, env: spec.env, sha256: pinned },
      {
        ask: (check) => ({ kind: "agent", name: spec.name, version, archiveUrl, check }),
        phase: `downloading ${label}…`,
        declined: `${label} download declined — Connect again to be asked again`,
        digest,
      },
    );
  } catch (err) {
    if (!(err instanceof ChecksumMismatch)) throw err;
    throw mismatchFailure(
      label,
      archiveUrl,
      "its registry entry publishes",
      err,
      "Connect again later, or add it as a custom command to run it regardless.",
    );
  }
  deps.log.info(`${spec.agentId}: binary ${version} ready (${installed.command})`);
  return { ...spec, command: installed.command, cwd: installed.cwd };
}

/** The pool's one launch-phase seam: every prerequisite, in the order the
 * spawn needs them — the agent's own binary first (it *is* the command),
 * then the runtime its launcher needs. */
export async function resolveLaunch(spec: LaunchSpec, deps: LaunchResolveDeps): Promise<LaunchSpec> {
  return resolveRuntime(await resolveBinaryLaunch(spec, deps), deps);
}
