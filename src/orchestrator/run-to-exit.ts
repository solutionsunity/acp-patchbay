// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A short-lived program run to its exit — `node --version`, `npm config get
// cache`, a launcher warming its package cache. Its exit is the answer, and
// no clock stands in for it: a slow answer (a scanner holding a first-touch
// binary, a cold disk, a slow link mid-download) is still the answer, and
// timing it out turns a working system into a "missing" one. What ends the
// wait early is a stop — the caller's signal — never a guess about speed.
import { spawn } from "node:child_process";
import { killTree, treeSpawnOptions } from "./process-tree";
import { resolveSpawn } from "./spawn-resolve";

export interface ExitAnswer {
  /** null when the process died to a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `command args`, resolved like any launch (spawn-resolve.ts), and
 * answers once it has exited and its output has drained. Null when it can't
 * run at all (unresolvable, or the spawn itself fails). Aborted, the whole
 * tree is killed and the promise rejects with the signal's reason — never a
 * made-up answer a caller might act on. */
export function runToExit(
  command: string,
  args: readonly string[],
  opts: {
    env: Readonly<Record<string, string | undefined>>;
    cwd?: string;
    signal?: AbortSignal;
    platform?: NodeJS.Platform;
  },
): Promise<ExitAnswer | null> {
  const { signal } = opts;
  if (signal?.aborted) return Promise.reject(signal.reason);
  const launch = resolveSpawn(command, args, opts.env, opts.platform);
  if (launch.error !== undefined) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      env: opts.env as NodeJS.ProcessEnv,
      cwd: opts.cwd,
      shell: launch.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // killTree, not child.kill: a .cmd shim rides cmd.exe on win32 and
      // launchers fork node children everywhere — killing the direct child
      // alone would leak the subtree.
      ...treeSpawnOptions,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    const abort = () => {
      if (child.pid !== undefined) killTree(child.pid, "SIGKILL");
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => {
      signal?.removeEventListener("abort", abort);
      resolve(null);
    });
    // "close", not "exit": exit can beat the delivery of buffered output,
    // reading a fast answer as empty. close waits for the streams to drain.
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      resolve({ code, stdout, stderr });
    });
  });
}
