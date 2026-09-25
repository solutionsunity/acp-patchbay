// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The client side of ACP that patchbay serves to agents: fs/read_text_file,
// fs/write_text_file and the terminal/* family. Every write and every command
// passes patchbay's own gate first; every "no" is answered through
// client-replies.ts. Kept vscode-free — the live-buffer read and write are
// injected — so the handlers the extension runs are the same ones the tests
// run.
import type * as acp from "@agentclientprotocol/sdk";
import { terminalBlockId, type AgentViewEvent } from "../shared/protocol";
import { type PermissionBroker, sliceTextFileRead } from "./broker";
import { gateRefusal, readFailure, unknownTerminal } from "./client-replies";
import type { PoolHooks } from "./pool";
import type { SessionManager } from "./session-manager";
import type { TerminalHandle } from "./terminal-runner";

export interface ClientHostDeps {
  broker: PermissionBroker;
  sessionManager: Pick<SessionManager, "noteFileBaseline" | "noteFileWrite">;
  /** The file as the user sees it — an open, possibly unsaved editor wins
   * over disk. Throws the underlying error when the file can't be read. */
  readLive(path: string): Promise<string>;
  /** The write the user sees — into an open editor when one holds the file,
   * else to disk. Throws when the write didn't land. */
  writeLive(path: string, content: string): Promise<void>;
  emit(event: AgentViewEvent): void;
  /** Every spawned command, for the process bookkeeping that outlives a
   * crash. */
  trackProcess(handle: TerminalHandle): void;
}

export class ClientHost {
  private readonly terminals = new Map<string, TerminalHandle>();
  private terminalCounter = 0;

  constructor(private readonly deps: ClientHostDeps) {}

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await this.deps.readLive(params.path).catch((err: unknown) => {
      throw readFailure(err, params.path);
    });
    return { content: sliceTextFileRead(content, params.line, params.limit) };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    // Pre-image captured before anything moves — the gate-side baseline
    // source for "since first agent touch" diffs. Buffer truth, same
    // lookup the write itself uses; noted at card time (not acceptance)
    // so every diff card the user can see has an answerable baseline.
    const pre = await this.deps.readLive(params.path).catch(() => "");
    this.deps.sessionManager.noteFileBaseline(params.sessionId, params.path, pre);
    const outcome = await this.deps.broker.gateFileWrite(params.sessionId, params.path, params.content);
    // Disk (and the baseline) stay untouched, so the ± badge stays absent
    // rather than claiming a change that never happened.
    if (outcome !== "accepted") throw gateRefusal(outcome, `write to ${params.path}`);
    await this.deps.writeLive(params.path, params.content);
    this.deps.sessionManager.noteFileWrite(params.sessionId, params.path, params.content);
    return {};
  }

  async createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    const command = [params.command, ...(params.args ?? [])].join(" ");
    const outcome = await this.deps.broker.gateCommand(params.sessionId, command);
    if (outcome !== "accepted") throw gateRefusal(outcome, `command \`${command}\``);

    const handle = this.deps.broker.runner.create({
      command: params.command,
      args: params.args ?? [],
      env: Object.fromEntries((params.env ?? []).map((e) => [e.name, e.value])),
      cwd: params.cwd ?? null,
      outputByteLimit: params.outputByteLimit ?? null,
    });
    const terminalId = `term-${++this.terminalCounter}`;
    this.terminals.set(terminalId, handle);
    this.deps.trackProcess(handle);
    const blockId = terminalBlockId(terminalId);
    const { sessionId } = params;
    this.deps.emit({ kind: "terminalStarted", sessionId, blockId, command });
    handle.onData((chunk) => this.deps.emit({ kind: "terminalOutputAppended", sessionId, blockId, chunk }));
    handle.onExit((status) =>
      this.deps.emit({ kind: "terminalExited", sessionId, blockId, exitCode: status.exitCode }),
    );
    return { terminalId };
  }

  async terminalOutput(params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
    const handle = this.terminal(params.terminalId);
    const { output, truncated } = handle.currentOutput();
    const exit = handle.exitStatus();
    return {
      output,
      truncated,
      exitStatus: exit ? { exitCode: exit.exitCode, signal: exit.signal } : null,
    };
  }

  async waitForTerminalExit(params: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse> {
    return this.terminal(params.terminalId).waitForExit();
  }

  async killTerminal(params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse> {
    this.terminals.get(params.terminalId)?.kill();
    return {};
  }

  async releaseTerminal(params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> {
    // ACP release semantics: a still-running command is killed — before
    // this, releasing dropped the handle and left the process running
    // with nothing pointing at it.
    const handle = this.terminals.get(params.terminalId);
    if (handle !== undefined && handle.exitStatus() === null) handle.kill();
    this.terminals.delete(params.terminalId);
    return {};
  }

  /** Every command still running, for teardown paths that must stop
   * reality before anything else. */
  runningPids(): number[] {
    return [...this.terminals.values()].flatMap((h) => (h.pid !== null && h.exitStatus() === null ? [h.pid] : []));
  }

  /** Forget every terminal — after the teardown killed them. */
  clear(): void {
    this.terminals.clear();
  }

  private terminal(terminalId: string): TerminalHandle {
    const handle = this.terminals.get(terminalId);
    if (!handle) throw unknownTerminal(terminalId);
    return handle;
  }
}

/** The pool's fs/terminal hooks, bound to a host. A getter because the host
 * is built after the pool it serves (its gate needs the session manager,
 * which needs the pool). */
export function clientRequestHooks(
  host: () => ClientHost,
): Pick<
  PoolHooks,
  | "onReadTextFile"
  | "onWriteTextFile"
  | "onCreateTerminal"
  | "onTerminalOutput"
  | "onWaitForTerminalExit"
  | "onKillTerminal"
  | "onReleaseTerminal"
> {
  return {
    onReadTextFile: (_agentId, params) => host().readTextFile(params),
    onWriteTextFile: (_agentId, params) => host().writeTextFile(params),
    onCreateTerminal: (_agentId, params) => host().createTerminal(params),
    onTerminalOutput: (_agentId, params) => host().terminalOutput(params),
    onWaitForTerminalExit: (_agentId, params) => host().waitForTerminalExit(params),
    onKillTerminal: (_agentId, params) => host().killTerminal(params),
    onReleaseTerminal: (_agentId, params) => host().releaseTerminal(params),
  };
}
