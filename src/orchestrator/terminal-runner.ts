// Runs the child process behind an ACP terminal/create call. vscode-free (so
// it's testable against the fake agent without a real extension host) —
// visibility in a real VS Code terminal is a thin wrapper layered on top in
// the extension host (orchestrator.ts), not this module's concern.
import { spawn } from "node:child_process";

export interface ExitStatus {
  exitCode: number | null;
  signal: string | null;
}

export interface TerminalHandle {
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
      currentOutput: () => ({ output, truncated }),
      exitStatus: () => exited,
      waitForExit: () =>
        exited !== null ? Promise.resolve(exited) : new Promise((resolve) => exitWaiters.push(resolve)),
      kill: () => child.kill(),
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
