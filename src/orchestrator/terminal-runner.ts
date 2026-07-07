// Runs the child process behind an ACP terminal/create call. vscode-free (so
// it's testable against the fake agent without a real extension host) —
// visibility in a real VS Code terminal is a thin wrapper layered on top in
// the extension host (orchestrator.ts), not this module's concern.
import { spawn } from "node:child_process";
import { killTree, treeSpawnOptions } from "./process-tree";

export interface ExitStatus {
  exitCode: number | null;
  signal: string | null;
}

export interface TerminalHandle {
  /** The spawned root's pid (null when spawn itself failed) — what the
   * spawn registry records and what shutdown's sweep tree-kills. */
  pid: number | null;
  /** Output captured so far (stdout+stderr interleaved, ACP doesn't distinguish). */
  currentOutput(): { output: string; truncated: boolean };
  exitStatus(): ExitStatus | null;
  waitForExit(): Promise<ExitStatus>;
  kill(): void;
  /** Fired as new bytes arrive — the orchestrator mirrors these into the
   * transcript live, independent of whether/when the agent polls output. */
  onData(listener: (chunk: string) => void): () => void;
  onExit(listener: (status: ExitStatus) => void): () => void;
}

export interface CreateTerminalParams {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  outputByteLimit: number | null;
}

export interface TerminalRunner {
  create(params: CreateTerminalParams): TerminalHandle;
}

const DEFAULT_OUTPUT_LIMIT = 1_000_000;

export class NodeTerminalRunner implements TerminalRunner {
  create(params: CreateTerminalParams): TerminalHandle {
    const limit = params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT;
    let output = "";
    let truncated = false;
    let exited: ExitStatus | null = null;
    const dataListeners = new Set<(chunk: string) => void>();
    const exitListeners = new Set<(status: ExitStatus) => void>();
    const exitWaiters: Array<(status: ExitStatus) => void> = [];

    const child = spawn(params.command, params.args, {
      cwd: params.cwd ?? undefined,
      env: { ...process.env, ...params.env },
      stdio: ["ignore", "pipe", "pipe"],
      // Group leader on POSIX (process-tree.ts): terminal/kill must end the
      // whole tree — build tools fork, and ACP's contract is "the command
      // stops", not "its top process stops".
      ...treeSpawnOptions,
    });

    const append = (chunk: string) => {
      output += chunk;
      if (output.length > limit) {
        output = output.slice(output.length - limit);
        truncated = true;
      }
      for (const listener of dataListeners) listener(chunk);
    };
    child.stdout!.setEncoding("utf8").on("data", append);
    child.stderr!.setEncoding("utf8").on("data", append);

    const finish = (status: ExitStatus) => {
      if (exited !== null) return;
      exited = status;
      for (const listener of exitListeners) listener(status);
      for (const waiter of exitWaiters.splice(0)) waiter(status);
    };
    child.on("exit", (code, signal) => finish({ exitCode: code, signal }));
    child.on("error", () => finish({ exitCode: null, signal: null }));

    return {
      pid: child.pid ?? null,
      currentOutput: () => ({ output, truncated }),
      exitStatus: () => exited,
      waitForExit: () =>
        exited !== null ? Promise.resolve(exited) : new Promise((resolve) => exitWaiters.push(resolve)),
      kill: () => {
        if (child.pid === undefined) return;
        const pid = child.pid;
        killTree(pid, "SIGTERM");
        // Escalation for trees that ignore SIGTERM; unref'd — never holds
        // the host open, and SIGKILL on an already-dead tree is a no-op.
        setTimeout(() => killTree(pid, "SIGKILL"), 2_000).unref();
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
