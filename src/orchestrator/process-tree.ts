// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Tree-wide process control (plan.md P15b/c) — house mechanism, no
// dependency. Agents and brokered terminals spawn as process-group leaders
// on POSIX (`detached`), so stopping one stops everything it shelled out to
// — grandchildren included (an agent's own mcp-server/bridge children, a
// terminal's test runner). Windows has no process groups: `taskkill /T`
// walks the tree instead, and has no signal concept, so the graceful rung
// collapses into the forced one there. vscode-free, like pool.ts, so all of
// it is unit-testable against real spawned processes.
import { execFile, type SpawnOptions } from "node:child_process";

/** Spread into `spawn` options: POSIX children lead their own process
 * group (that's what makes `kill(-pid)` reach the whole tree). stdio stays
 * piped, so `detached` changes group membership only — nothing else. */
export const treeSpawnOptions: Pick<SpawnOptions, "detached"> =
  process.platform === "win32" ? {} : { detached: true };

/** Signals the whole tree rooted at `pid`. Already-gone trees are a no-op,
 * never an error — every caller is on a "make it dead" path where ESRCH is
 * success. Fire-and-forget on Windows (taskkill is a subprocess). */
export function killTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
    return;
  }
  try {
    process.kill(-pid, signal); // negative pid = the whole group
  } catch {
    // Group already gone (or the leader never became one — spawn raced its
    // own failure): fall back to the bare pid, and swallow ESRCH the same.
    try {
      process.kill(pid, signal);
    } catch {
      /* already dead — the desired state */
    }
  }
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
export function commandOf(pid: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile(
        "powershell",
        ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        (err, stdout) => resolve(err ? "" : stdout.trim()),
      );
      return;
    }
    execFile("ps", ["-o", "args=", "-p", String(pid)], (err, stdout) =>
      resolve(err ? "" : stdout.trim()),
    );
  });
}

export interface OrphanRecord {
  pid: number;
  /** As `commandOf` reported it right after spawn. */
  command: string;
}

/** Reaps leftovers from a session that never ran its cleanup (plan.md P15c):
 * SIGKILLs the tree of every record whose pid is alive *and* still runs the
 * recorded command line; a mismatch is a reused pid and is spared. Returns
 * what happened per record so the caller can log it and drop them all —
 * dead, killed, or spared, the record itself is spent either way. Generic so
 * callers get their own record type back (the spawn registry logs `kind`). */
export async function reapOrphans<T extends OrphanRecord>(
  records: readonly T[],
): Promise<{ killed: T[]; spared: T[] }> {
  const killed: T[] = [];
  const spared: T[] = [];
  for (const record of records) {
    if (!isAlive(record.pid)) continue; // already gone — nothing to do
    const now = await commandOf(record.pid);
    if (now !== "" && now === record.command) {
      killTree(record.pid, "SIGKILL");
      killed.push(record);
    } else {
      spared.push(record);
    }
  }
  return { killed, spared };
}
