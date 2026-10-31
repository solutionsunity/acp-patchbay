// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// npm's .cmd files, read. On Windows a .cmd runs only through cmd.exe, and
// cmd.exe has no faithful way to pass an argument on — each layer re-reads
// the line, and a shim hands its arguments to a second read. Nearly every
// .cmd a launch meets is npm's: its own launchers (npx.cmd, npm.cmd) and the
// shims it writes for every installed bin. Each only runs a JavaScript file
// with node, so read, it can run as node and that file, with no shell, and
// every argument arrives as given. Only what is read exactly is run that
// way; anything else is no npm file here, and keeps cmd.exe.
import { win32 } from "node:path";
import readCmdShim from "read-cmd-shim";

/** npm's own launcher, as npm writes it (every npm from 6 on): node runs
 * its CLI script, unless the global prefix npm reports holds one — an npm
 * updated with `npm i -g npm`. Paths are relative to the launcher's folder,
 * `prefixCli` to the prefix. */
export interface NpmLauncher {
  cli: string;
  /** What node runs to ask for the prefix: a script, and its arguments. */
  prefixQuery: string[];
  prefixCli: string;
}

const HEAD = [
  ":: Created by npm, please don't edit manually.",
  "@ECHO OFF",
  "SETLOCAL",
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" (',
  'SET "NODE_EXE=node"',
  ")",
];

/** The launcher's text, or null when it isn't one, line for line. */
export function readNpmLauncher(text: string): NpmLauncher | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (HEAD.some((line, i) => lines[i] !== line)) return null;
  let i = HEAD.length;
  const scripts = new Map<string, string>();
  for (let m; (m = /^SET "(\w+)=%~dp0\\([^"%]+)"$/.exec(lines[i] ?? "")) !== null; i++) scripts.set(m[1]!, m[2]!);
  const query = /^FOR \/F "delims=" %%F IN \('CALL "%NODE_EXE%" "%(\w+)%"( prefix -g)?'\) DO \($/.exec(lines[i++] ?? "");
  const override = /^SET "NPM_PREFIX_(\w+)=%%F\\([^"%]+)"$/.exec(lines[i++] ?? "");
  if (query === null || override === null || lines[i++] !== ")") return null;
  const target = override[1]!;
  const tail = [`IF EXIST "%NPM_PREFIX_${target}%" (`, `SET "${target}=%NPM_PREFIX_${target}%"`, ")", `"%NODE_EXE%" "%${target}%" %*`];
  if (tail.some((line, j) => lines[i + j] !== line) || lines.length !== i + tail.length) return null;
  const cli = scripts.get(target);
  const queryScript = scripts.get(query[1]!);
  if (cli === undefined || queryScript === undefined) return null;
  return { cli, prefixQuery: [queryScript, ...(query[2] !== undefined ? ["prefix", "-g"] : [])], prefixCli: override[2]! };
}

/** Where the global prefix a launcher's query printed points: its last
 * line, as the launcher's FOR /F keeps it — empty lines and `;` lines
 * skipped. Null when it printed none. */
export function prefixFrom(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith(";"));
  return lines.at(-1) ?? null;
}

/** A shim npm wrote for a bin: the script it points at, and the arguments
 * node takes before it. Null when the
 * file isn't one, or its script isn't plain node's — the script's shebang
 * names its interpreter, as it did when npm wrote the shim (npm's own
 * reading of it, cmd-shim's), and only node, with no variables set and
 * only plain flags, is run here. */
export function readNodeShim(shimPath: string, firstLineOf: (script: string) => string | null): { script: string; nodeArgs: string[] } | null {
  let script: string;
  try {
    script = win32.resolve(win32.dirname(shimPath), readCmdShim.sync(shimPath));
  } catch {
    return null;
  }
  const line = firstLineOf(script);
  const shebang = line === null ? null : /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?((?:[^ \t=]+=[^ \t=]+\s+)*))?([^ \t]+)(.*)$/.exec(line);
  if (shebang === null || (shebang[1] ?? "") !== "" || shebang[2] !== "node") return null;
  const nodeArgs = (shebang[3] ?? "").trim().split(/\s+/).filter((a) => a !== "");
  if (nodeArgs.some((a) => !/^[\w.,:=/@+-]+$/.test(a))) return null;
  return { script, nodeArgs };
}
