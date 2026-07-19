// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Windows-safe command resolution — THE one spelling of "this configured
// command becomes that spawned executable", shared by the agent launch,
// the launcher warmup, and every version probe. POSIX passes through
// untouched: execvp searches PATH only, never the working directory.
// Windows is where resolution bites, three ways at once:
//
// 1. **CWD planting.** cmd.exe resolves an unqualified name against the
//    current directory before PATH, and agent spawns run in the workspace
//    root — an opened repo carrying `npx.cmd` at its top level would run
//    on connect. Resolving to an absolute path up front means no lookup
//    ever happens in the spawn's cwd: PATH entries are walked here, and
//    relative or "." entries are skipped (they would re-admit the cwd by
//    the back door).
// 2. **PATHEXT.** A shell-less spawn finds only .exe for a bare name, so
//    an npm global shim (`gemini` → gemini.cmd) is invisible — only
//    npx/npm used to be special-cased, by name. The walk tries the PATHEXT
//    extensions in PATHEXT's own order, filtered to the four a spawn can
//    actually execute (.com/.exe directly, .bat/.cmd via cmd.exe).
// 3. **.cmd/.bat need a shell** — Node ≥ 20.12 (CVE-2024-27980) refuses
//    them shell-less. shell:true is scoped to exactly that case, with
//    shell-active args refused rather than quoted-and-hoped, and the
//    resolved path itself quoted so a "Program Files"-style space
//    survives cmd.exe.
//
// Resolution runs fresh at every spawn, against the env that spawn will
// use — a managed-runtime PATH prepend must be visible here — and is
// never cached or persisted.
import { statSync } from "node:fs";
import { win32 } from "node:path";

/** The extension classes a child_process spawn can execute, in default
 * PATHEXT order. Anything else PATHEXT lists (.PS1, .VBS, …) needs an
 * interpreter we won't invoke. */
const EXECUTABLE_EXTS = [".COM", ".EXE", ".BAT", ".CMD"];

function isFileSync(p: string): boolean {
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

/** The launch decision for a configured command: what actually spawns, and
 * whether it needs the Windows shell. `error` set = refuse to spawn, with
 * the reason the caller surfaces. A relative path containing a separator
 * is explicit user config resolved by the OS against the spawn cwd —
 * passed through as typed; bare names and absolute paths resolve here. */
export function resolveSpawn(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  isFile: (p: string) => boolean = isFileSync,
): { command: string; args: string[]; shell: boolean; error?: string } {
  if (platform !== "win32") return { command, args: [...args], shell: false };

  const qualified = /[\\/]/.test(command);
  let resolved = command;
  if (!qualified || win32.isAbsolute(command)) {
    const hit = resolveExecutableWin32(command, env, isFile);
    if (hit === null) {
      return {
        command,
        args: [...args],
        shell: false,
        error: qualified
          ? `refusing to spawn: ${command} does not exist (PATHEXT variants checked)`
          : `refusing to spawn: ${command} not found on PATH (PATHEXT variants checked)`,
      };
    }
    resolved = hit;
  }
  const shell = /\.(cmd|bat)$/i.test(resolved);
  if (shell) {
    const active = args.find((a) => /[\s&|<>^%!"']/.test(a));
    if (active !== undefined) {
      return {
        command: resolved,
        args: [...args],
        shell,
        error: `refusing to spawn: argument ${JSON.stringify(active)} is shell-active and ${resolved} needs a Windows shell`,
      };
    }
  }
  return {
    command: shell && /\s/.test(resolved) ? `"${resolved}"` : resolved,
    args: [...args],
    shell,
  };
}
