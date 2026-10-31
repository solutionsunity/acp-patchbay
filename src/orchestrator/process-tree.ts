// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The process door — every child process the extension host starts is
// started here, and nowhere else: an agent, a brokered terminal, an MCP
// server's probe, a short program run to its exit (a version check, a
// package warm-up, an archive's extraction), and the reads and kills this
// module itself runs. What decides the door is which process starts the
// child, not whose code asks: a task VS Code runs (a terminal login) is
// VS Code's own process, and what an agent spawns (its MCP servers, its
// tools) is the agent's.
//
// Through the door a child is resolved Windows-safe against the env it
// will run with (spawn-resolve.ts) and leads its own process tree. Agents,
// terminals and probe servers spawn as process-group leaders on POSIX
// (`detached`), so stopping one stops everything it shelled out to —
// grandchildren included (an agent's own mcp-server/bridge children, a
// terminal's test runner, a launcher's server). Windows has no process
// groups: `taskkill /T` walks the tree instead, and has no signal concept,
// so the graceful rung collapses into the forced one there. House
// mechanism, no dependency; vscode-free, like pool.ts, so all of it is
// unit-testable against real spawned processes.
import { type ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { win32 } from "node:path";
import { prefixFrom } from "./npm-shims";
import { isFileSync, type Launch, resolveSpawn } from "./spawn-resolve";

/** Spread into `spawn` options: POSIX children lead their own process
 * group (that's what makes `kill(-pid)` reach the whole tree). stdio stays
 * piped, so `detached` changes group membership only — nothing else. */
export const treeSpawnOptions: Pick<SpawnOptions, "detached"> =
  process.platform === "win32" ? {} : { detached: true };

export interface ChildOptions {
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"];
  /** No console window on Windows — for a program nobody watches. */
  windowsHide?: boolean;
  platform?: NodeJS.Platform;
  /** A stop before the spawn: nothing starts, and the start rejects with
   * its reason. */
  signal?: AbortSignal;
}

/** Starts `command args` through the door: resolved like every launch, a
 * tree leader. A command the resolver refuses never starts — its reason
 * comes back instead. A start the system refuses throws or emits `error`,
 * as Node's own spawn does, for the caller to say why where it is. */
export async function startChild(
  command: string,
  args: readonly string[],
  opts: ChildOptions,
): Promise<{ child: ChildProcess } | { error: string }> {
  const launch = resolveSpawn(command, args, opts.env, opts.platform);
  if (launch.kind === "refused") return { error: launch.error };
  const [file, argv] = launch.kind === "npm" ? [launch.node, [await npmCli(launch, opts), ...launch.args]] : [launch.command, launch.args];
  if (opts.signal?.aborted) throw opts.signal.reason;
  const child = spawn(file, argv, {
    env: (launch.kind === "program" && launch.env !== undefined ? { ...opts.env, ...launch.env } : opts.env) as NodeJS.ProcessEnv,
    cwd: opts.cwd,
    stdio: opts.stdio,
    shell: launch.kind === "shell",
    windowsHide: opts.windowsHide,
    ...treeSpawnOptions,
  });
  return { child };
}

/** The CLI script npm's launcher would run: the one under the global
 * prefix its query prints, where there is one — an npm updated with `npm i
 * -g npm` — else its own. Asked as the launcher asks, in the launch's own
 * folder and env: the prefix can come from a project's .npmrc. */
async function npmCli(launch: Extract<Launch, { kind: "npm" }>, opts: ChildOptions): Promise<string> {
  const answer = await runToExit(launch.node, launch.prefixQuery, { env: opts.env, cwd: opts.cwd, signal: opts.signal, platform: opts.platform });
  const prefix = answer === null ? null : prefixFrom(answer.stdout);
  const updated = prefix === null ? null : win32.join(prefix, launch.prefixCli);
  return updated !== null && isFileSync(updated) ? updated : launch.cli;
}

export interface ExitAnswer {
  /** null when the process died to a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A short-lived program run to its exit — `node --version`, `npm config
 * get cache`, a launcher warming its package cache. Its exit is the answer,
 * and no clock stands in for it: a slow answer (a scanner holding a
 * first-touch binary, a cold disk, a slow link mid-download) is still the
 * answer, and timing it out turns a working system into a "missing" one.
 * What ends the wait early is a stop — the caller's signal — never a guess
 * about speed. Answers once it has exited and its output has drained. Null
 * when it can't run at all (unresolvable, or the spawn itself fails).
 * Aborted, the whole tree is killed and the promise rejects with the
 * signal's reason — never a made-up answer a caller might act on. */
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
  return startChild(command, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).then((started) => new Promise((resolve, reject) => {
    if ("error" in started) return resolve(null);
    const { child } = started;
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    // killTree, not child.kill: a .cmd that isn't npm's rides cmd.exe on
    // win32 and launchers fork node children everywhere — killing the
    // direct child alone would leak the subtree.
    const abort = () => {
      killTree(child, "SIGKILL");
      reject(signal!.reason);
    };
    // A stop that landed while the start resolved finds no listener to
    // tell: it is read here, once the child is in hand.
    if (signal?.aborted) return abort();
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
  }));
}

/** Signals the tree of a process this host spawned. A pid is this host's
 * only while it holds the process — until its exit lands; after that the
 * system may already have given the pid to another process (Windows does
 * so at once), and a kill by it would end that one, tree and all. So a
 * running process's whole tree goes; an exited one's only what can still
 * be reached safely: on POSIX the group its survivors are in (a group id
 * is never reused while the group has members), on Windows nothing — a
 * dead root has no tree taskkill can walk. Fire-and-forget on Windows
 * (taskkill is a subprocess). Every caller is on a "make it dead" path
 * where a gone tree is success, never an error. */
export function killTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const held = child.exitCode === null && child.signalCode === null;
  if (held) killPidTree(pid, signal);
  else if (process.platform !== "win32") signalGroup(pid, signal);
}

/** The tree rooted at `pid`, by the pid alone — for a process whose pid is
 * known to be the one meant: one held, or an orphan whose command line was
 * just read back as the one recorded. */
function killPidTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    void runToExit("taskkill", ["/pid", String(pid), "/T", "/F"], { env: process.env });
    return;
  }
  // Group already gone (or the leader never became one — spawn raced its
  // own failure): the bare pid, still the one meant.
  if (!signalGroup(pid, signal)) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already dead — the desired state */
    }
  }
}

/** Signals the POSIX process group `pgid`; false when there is none. */
function signalGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
  try {
    process.kill(-pgid, signal); // negative pid = the whole group
    return true;
  } catch {
    return false;
  }
}

/** A process this host spawned, as its bookkeeping sees it — whatever
 * spawned it (an agent's connection, a terminal). */
export interface TrackedProcess {
  readonly pid: number;
  /** True until its exit has been observed. */
  running(): boolean;
  onExit(listener: () => void): void;
}

/** `child` as a `TrackedProcess`; null when it never got a pid (its spawn
 * failed). */
export function trackedChild(child: ChildProcess): TrackedProcess | null {
  const pid = child.pid;
  if (pid === undefined) return null;
  return {
    pid,
    running: () => child.exitCode === null && child.signalCode === null,
    onExit: (listener) => void child.once("exit", listener),
  };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The live command line of `pid`, "" when the process is gone or the read
 * fails. Read once right after spawn (record what reality says) and again
 * at reap time (compare with what reality says now) — the PID-reuse guard:
 * a mismatch means this pid is somebody else now, and the only safe move is
 * to spare it. */
export async function commandOf(pid: number): Promise<string> {
  return (await commandsOf([pid])).get(pid) ?? "";
}

/** The live command line of each of `pids`, in one read of the OS however
 * many there are (on Windows each read is a PowerShell process — the cost
 * worth sharing). A pid that is gone, or whose line can't be read, is
 * absent. */
export async function commandsOf(pids: readonly number[]): Promise<Map<number, string>> {
  const lines = new Map<number, string>();
  if (pids.length === 0) return lines;
  if (process.platform === "win32") {
    const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
    const answer = await runToExit(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId, CommandLine)`,
      ],
      { env: process.env },
    );
    try {
      for (const row of JSON.parse(answer?.stdout ?? "") as { ProcessId: number; CommandLine: string | null }[]) {
        const line = row.CommandLine?.trim() ?? "";
        if (line !== "") lines.set(row.ProcessId, line);
      }
    } catch {
      /* no answer — every pid reads as unreadable */
    }
    return lines;
  }
  // `ps` lists what it found and fails only when it found none.
  const answer = await runToExit("ps", ["-o", "pid=,args=", "-p", pids.join(",")], { env: process.env });
  for (const row of (answer?.stdout ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(.*\S)/.exec(row);
    if (match !== null) lines.set(Number(match[1]), match[2]!);
  }
  return lines;
}

export interface OrphanRecord {
  pid: number;
  /** As `commandOf` reported it right after spawn. */
  command: string;
}

/** Reaps leftovers from a session that never ran its cleanup:
 * SIGKILLs the tree of every record whose pid is alive *and* still runs the
 * recorded command line — `running` is what `commandsOf` read of them just
 * now; a mismatch is a reused pid and is spared. Returns what happened per
 * record so the caller can log it and drop them all — dead, killed, or
 * spared, the record itself is spent either way. Generic so callers get
 * their own record type back (the spawn registry logs `kind`). */
export function reapOrphans<T extends OrphanRecord>(
  records: readonly T[],
  running: ReadonlyMap<number, string>,
): { killed: T[]; spared: T[] } {
  const killed: T[] = [];
  const spared: T[] = [];
  for (const record of records) {
    if (!isAlive(record.pid)) continue; // already gone — nothing to do
    if (running.get(record.pid) === record.command) {
      killPidTree(record.pid, "SIGKILL");
      killed.push(record);
    } else {
      spared.push(record);
    }
  }
  return { killed, spared };
}
