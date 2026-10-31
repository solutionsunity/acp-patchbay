// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Runs the child process behind an ACP terminal/create call. vscode-free (so
// it's testable against the fake agent without a real extension host) —
// visibility in a real VS Code terminal is a thin wrapper layered on top in
// the extension host (orchestrator-host.ts), not this module's concern.
import type { ChildProcess } from "node:child_process";
import { killTree, startChild, trackedChild, type TrackedProcess } from "./process-tree";
import { mergeEnv } from "./spawn-resolve";
import { agentErrorText } from "./readers/agent-error";

export interface ExitStatus {
  exitCode: number | null;
  signal: string | null;
}

export interface TerminalHandle {
  /** The spawned root as the spawn registry tracks it (null when spawn
   * itself failed). A kill goes through the handle, never by its pid. */
  process: TrackedProcess | null;
  /** Output captured so far (stdout+stderr interleaved, ACP doesn't distinguish). */
  currentOutput(): { output: string; truncated: boolean };
  exitStatus(): ExitStatus | null;
  waitForExit(): Promise<ExitStatus>;
  /** Asks the command's tree to stop, then forces it if it hasn't. */
  kill(): void;
  /** Forces the command's tree down at once — for a teardown that can't
   * wait. */
  killNow(): void;
  /** Fired as new bytes arrive — the orchestrator mirrors these into the
   * transcript live, independent of whether/when the agent polls output. */
  onData(listener: (chunk: string) => void): () => void;
  onExit(listener: (status: ExitStatus) => void): () => void;
}

export interface CreateTerminalParams {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  outputByteLimit: number | null;
}

export interface TerminalRunner {
  create(params: CreateTerminalParams): Promise<TerminalHandle>;
}

const DEFAULT_OUTPUT_LIMIT = 1_000_000;

/** The last ≤ maxBytes *bytes* of s, cut at a character boundary — ACP's
 * outputByteLimit is bytes, and the spec's truncation rule is "from the
 * beginning, at a character boundary". Skipping
 * UTF-8 continuation bytes lands on a code-point start, which also keeps
 * surrogate pairs whole (one 4-byte code point in UTF-8). */
export function tailBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return { text: s, truncated: false };
  const buf = Buffer.from(s, "utf8");
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0b1100_0000) === 0b1000_0000) start++;
  return { text: buf.subarray(start).toString("utf8"), truncated: true };
}

export class NodeTerminalRunner implements TerminalRunner {
  async create(params: CreateTerminalParams): Promise<TerminalHandle> {
    const limit = params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT;
    let output = "";
    let truncated = false;
    let exited: ExitStatus | null = null;
    const dataListeners = new Set<(chunk: string) => void>();
    const exitListeners = new Set<(status: ExitStatus) => void>();
    const exitWaiters: Array<(status: ExitStatus) => void> = [];

    const append = (chunk: string) => {
      output += chunk;
      const tail = tailBytes(output, limit);
      if (tail.truncated) {
        output = tail.text;
        truncated = true;
      }
      for (const listener of dataListeners) listener(chunk);
    };
    const finish = (status: ExitStatus) => {
      if (exited !== null) return;
      exited = status;
      for (const listener of exitListeners) listener(status);
      for (const waiter of exitWaiters.splice(0)) waiter(status);
    };
    // A command that never started says why in its own output — what the
    // agent reads back and the transcript shows, never a bare "exit ?" and
    // never an error to the agent's request. However it failed: the
    // resolver refused it, the system refused it on the spot, or it failed
    // to start after.
    const neverStarted = (reason: string) => {
      append(`${reason}\n`);
      finish({ exitCode: null, signal: null });
    };

    // Resolved as an agent's own launch is: on Windows a bare name is found
    // through PATH × PATHEXT, npm's .cmd files run as node and their script,
    // and any other .cmd/.bat runs through cmd.exe only when no argument is
    // one cmd would act on — so what runs is exactly the program and
    // arguments the rules judged. A tree leader:
    // terminal/kill must end the whole tree — build tools fork, and ACP's
    // contract is "the command stops", not "its top process stops".
    let child: ChildProcess | null = null;
    try {
      const started = await startChild(params.command, params.args, {
        env: mergeEnv(process.env, params.env),
        cwd: params.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if ("error" in started) throw new Error(started.error);
      child = started.child;
    } catch (err) {
      // Told once its caller is listening, as a failure after the spawn is:
      // a turn after this start resolves and the caller attaches.
      const reason = agentErrorText(err);
      setImmediate(() => neverStarted(reason));
    }
    if (child !== null) {
      child.stdout!.setEncoding("utf8").on("data", append);
      child.stderr!.setEncoding("utf8").on("data", append);
      child.on("exit", (code, signal) => finish({ exitCode: code, signal }));
      child.on("error", (err) => neverStarted(err.message));
    }
    const started = child;

    return {
      process: started === null ? null : trackedChild(started),
      currentOutput: () => ({ output, truncated }),
      exitStatus: () => exited,
      waitForExit: () =>
        exited !== null ? Promise.resolve(exited) : new Promise((resolve) => exitWaiters.push(resolve)),
      kill: () => {
        if (started === null) return;
        killTree(started, "SIGTERM");
        // Escalation for trees that ignore SIGTERM; unref'd — never holds
        // the host open. A tree that ended meanwhile is no longer this
        // host's to kill by its pid; killTree reaches only what is.
        setTimeout(() => killTree(started, "SIGKILL"), 2_000).unref();
      },
      killNow: () => {
        if (started !== null) killTree(started, "SIGKILL");
      },
      onData: (listener) => {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onExit: (listener) => {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
    };
  }
}
