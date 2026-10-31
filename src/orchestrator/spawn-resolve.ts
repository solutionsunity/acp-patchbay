// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Windows-safe command resolution — THE one spelling of "this configured
// command becomes that spawned executable", applied by the process door
// (process-tree.ts) to every child it starts: the agent launch, the
// launcher warmup, every version probe, an MCP server's probe, and the
// terminal commands an agent runs. POSIX passes through
// untouched: execvp searches PATH only, never the working directory.
// Windows is where resolution bites, three ways at once:
//
// 1. **CWD planting.** cmd.exe resolves an unqualified name against the
//    current directory before PATH, and agent spawns and terminals run in
//    the workspace — an opened repo carrying `npx.cmd` or `git.exe` at its
//    top level would run on connect, or under a rule that trusts `git`. Resolving to an absolute path up front means no lookup
//    ever happens in the spawn's cwd: PATH entries are walked here, and
//    relative or "." entries are skipped (they would re-admit the cwd by
//    the back door).
// 2. **PATHEXT.** A shell-less spawn finds only .exe for a bare name, so
//    an npm global shim (`gemini` → gemini.cmd) is invisible — only
//    npx/npm used to be special-cased, by name. The walk tries the PATHEXT
//    extensions in PATHEXT's own order, filtered to the four a spawn can
//    actually execute (.com/.exe directly, .bat/.cmd via cmd.exe).
// 3. **.cmd/.bat need a shell** — Node ≥ 20.12 (CVE-2024-27980) refuses
//    them shell-less, and cmd.exe has no faithful way to pass an argument
//    on. npm's own — its launchers and the shims it writes, nearly every
//    .cmd a launch meets — are read and run as node and their script, no
//    shell (npm-shims.ts). Any other runs through cmd.exe, scoped to
//    exactly that case, with shell-active args refused rather than
//    quoted-and-hoped, and the resolved path itself quoted so a "Program
//    Files"-style space survives cmd.exe.
//
// Resolution runs fresh at every spawn, against the env that spawn will
// use — a managed-runtime PATH prepend must be visible here — and is
// never cached or persisted.
import { readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { readNodeShim, readNpmLauncher } from "./npm-shims";

/** The extension classes a child_process spawn can execute, in default
 * PATHEXT order. Anything else PATHEXT lists (.PS1, .VBS, …) needs an
 * interpreter we won't invoke. */
const EXECUTABLE_EXTS = [".COM", ".EXE", ".BAT", ".CMD"];

/** `over` laid on `base`, as the spawned process will read it. Windows env
 * names are case-insensitive, and a spawn handed two spellings of one name
 * keeps whichever sorts first — an override spelled `path` loses to an
 * inherited `Path`, `npm_config_cache` to `NPM_CONFIG_CACHE`. There a base
 * name the override sets, in any case, is dropped first; elsewhere names
 * are case-sensitive and the spread is the whole rule. */
export function mergeEnv<T extends string | undefined>(
  base: Readonly<Record<string, T>>,
  over: Readonly<Record<string, T>> | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, T> {
  if (platform !== "win32") return { ...base, ...over };
  const named = new Set(Object.keys(over ?? {}).map((k) => k.toUpperCase()));
  return { ...Object.fromEntries(Object.entries(base).filter(([k]) => !named.has(k.toUpperCase()))), ...over };
}

export function isFileSync(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Env lookup by uppercase name — Windows env keys are case-insensitive
 * and conventionally mixed ("Path"). */
function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** PATHEXT filtered to the executable classes, in PATHEXT's own order; the
 * standard four when unset or when nothing survives the filter. */
function executableExts(env: Readonly<Record<string, string | undefined>>): string[] {
  const raw = envValue(env, "PATHEXT");
  if (raw === undefined) return EXECUTABLE_EXTS;
  const listed = raw
    .split(";")
    .map((e) => e.trim().toUpperCase())
    .filter((e) => EXECUTABLE_EXTS.includes(e));
  return listed.length > 0 ? listed : EXECUTABLE_EXTS;
}

/** The file names a command name stands for: an executable-class extension
 * as typed, anything else as typed plus the extension variants (a dotted
 * name is still subject to PATHEXT appends, cmd-style), a bare name only
 * the variants (an extensionless file cannot execute on Windows). */
function candidatesFor(name: string, exts: string[]): string[] {
  const ext = win32.extname(name);
  if (ext !== "" && exts.includes(ext.toUpperCase())) return [name];
  const appended = exts.map((e) => name + e.toLowerCase());
  return ext === "" ? appended : [name, ...appended];
}

/** Absolute path of the first PATH×PATHEXT hit for a bare name (or of the
 * first existing variant of an absolute one); null = nowhere. Relative
 * PATH entries and "." never participate — a planted workspace can't win. */
export function resolveExecutableWin32(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  isFile: (p: string) => boolean = isFileSync,
): string | null {
  const candidates = candidatesFor(command, executableExts(env));
  if (win32.isAbsolute(command)) {
    return candidates.find(isFile) ?? null;
  }
  const dirs = (envValue(env, "PATH") ?? "")
    .split(";")
    .map((d) => d.trim().replace(/"/g, ""))
    .filter((d) => d !== "" && win32.isAbsolute(d));
  for (const dir of dirs) {
    for (const name of candidates) {
      const hit = win32.join(dir, name);
      if (isFile(hit)) return hit;
    }
  }
  return null;
}

/** Whether a configured command names something this machine can run —
 * found on PATH, or an absolute path that exists. A relative path with a
 * separator resolves against a spawn's cwd, unknown until then: never
 * reported missing. */
export function commandFound(
  command: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  isFile: (p: string) => boolean = isFileSync,
): boolean {
  if (platform === "win32") {
    if (/[\\/]/.test(command) && !win32.isAbsolute(command)) return true;
    return resolveExecutableWin32(command, env, isFile) !== null;
  }
  if (command.includes("/")) return !posix.isAbsolute(command) || isFile(command);
  return (envValue(env, "PATH") ?? "")
    .split(":")
    .filter((d) => posix.isAbsolute(d))
    .some((dir) => isFile(posix.join(dir, command)));
}

/** How a configured command starts. */
export type Launch =
  /** Spawned as it is: a program — on POSIX, anything. `env`: names the
   * launch sets over the spawn's own. */
  | { kind: "program"; command: string; args: string[]; env?: Record<string, string> }
  /** A .cmd/.bat only cmd.exe runs — none of its arguments one cmd.exe
   * would act on. */
  | { kind: "shell"; command: string; args: string[] }
  /** npm's own launcher: node runs its CLI script, unless the global
   * prefix `prefixQuery` prints holds `prefixCli` — asked as the launcher
   * asks it, by whoever starts the launch. */
  | { kind: "npm"; node: string; cli: string; prefixQuery: string[]; prefixCli: string; args: string[] }
  /** Never started, and why. */
  | { kind: "refused"; error: string };

function textOf(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** The launch decision for a configured command. A relative path
 * containing a separator is explicit user config resolved by the OS against
 * the spawn cwd — passed through as typed; bare names and absolute paths
 * resolve here. */
export function resolveSpawn(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  isFile: (p: string) => boolean = isFileSync,
  readText: (p: string) => string | null = textOf,
): Launch {
  if (platform !== "win32") return { kind: "program", command, args: [...args] };

  const qualified = /[\\/]/.test(command);
  let resolved = command;
  if (!qualified || win32.isAbsolute(command)) {
    const hit = resolveExecutableWin32(command, env, isFile);
    if (hit === null) {
      return {
        kind: "refused",
        error: qualified
          ? `refusing to spawn: ${command} does not exist (PATHEXT variants checked)`
          : `refusing to spawn: ${command} not found on PATH (PATHEXT variants checked)`,
      };
    }
    resolved = hit;
  }
  if (!/\.(cmd|bat)$/i.test(resolved)) return { kind: "program", command: resolved, args: [...args] };
  if (win32.isAbsolute(resolved)) {
    const npm = npmLaunch(resolved, args, env, isFile, readText);
    if (npm !== null) return npm;
  }
  const active = args.find((a) => /[\s&|<>^%!"']/.test(a));
  if (active !== undefined) {
    return {
      kind: "refused",
      error: `refusing to spawn: argument ${JSON.stringify(active)} is shell-active and ${resolved} needs a Windows shell`,
    };
  }
  return { kind: "shell", command: /\s/.test(resolved) ? `"${resolved}"` : resolved, args: [...args] };
}

/** An npm .cmd as node and its script: the node.exe beside it, as npm's
 * files look first, else the one on PATH — found by the walk above, never
 * in the spawn's cwd. Null when the file isn't npm's, or no node.exe is
 * there to run it. */
function npmLaunch(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  isFile: (p: string) => boolean,
  readText: (p: string) => string | null,
): Launch | null {
  const dir = win32.dirname(file);
  const text = readText(file);
  const launcher = text === null ? null : readNpmLauncher(text);
  const shim = launcher === null ? readNodeShim(file, (script) => readText(script)?.split(/\r?\n/, 1)[0] ?? null) : null;
  if (launcher === null && shim === null) return null;
  const beside = win32.join(dir, "node.exe");
  const node = isFile(beside) ? beside : resolveExecutableWin32("node", env, isFile);
  if (node === null || !/\.exe$/i.test(node)) return null;
  if (launcher !== null) {
    return {
      kind: "npm",
      node,
      cli: win32.join(dir, launcher.cli),
      prefixQuery: [win32.join(dir, launcher.prefixQuery[0]!), ...launcher.prefixQuery.slice(1)],
      prefixCli: launcher.prefixCli,
      args: [...args],
    };
  }
  // The shim's own last step: PATHEXT without .JS, so a bin the program
  // runs by name is never a .js file Windows would open with its script
  // host — as the shim's `%PATHEXT:;.JS;=;%` has it.
  const pathext = Object.entries(env).find(([k]) => k.toUpperCase() === "PATHEXT");
  return {
    kind: "program",
    command: node,
    args: [...shim!.nodeArgs, shim!.script, ...args],
    ...(pathext?.[1] !== undefined ? { env: { [pathext[0]]: pathext[1].replace(/;\.JS;/gi, ";") } } : {}),
  };
}
