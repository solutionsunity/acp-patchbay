// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The client side of ACP that patchbay serves to agents: fs/read_text_file,
// fs/write_text_file and the terminal/* family. Every write and every command
// passes patchbay's own gate first; every "no" is answered through
// client-replies.ts. Kept vscode-free — the live-buffer read and write are
// injected — so the handlers the extension runs are the same ones the tests
// run.
import { isAbsolute } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { formatCommandLine } from "../shared/command-line";
import { terminalBlockId, type AgentViewEvent } from "../shared/protocol";
import { type PermissionBroker, sliceTextFileRead } from "./broker";
import { gateRefusal, readFailure, relativeCwd, unknownSession, unknownTerminal } from "./client-replies";
import type { PoolHooks } from "./pool";
import type { CreateTerminalParams, TerminalHandle } from "./terminal-runner";
import type { PatchbayAgentId } from "../shared/ids";

export interface ClientHostDeps {
  broker: PermissionBroker;
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

  /** `sessionId` is patchbay's id for the session the agent named —
   * undefined when patchbay holds no such session, which asks no one. */
  async writeTextFile(
    sessionId: string | undefined,
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    if (sessionId === undefined) throw unknownSession(params.sessionId);
    const outcome = await this.deps.broker.gateFileWrite(sessionId, params.path, params.content);
    if (outcome !== "accepted") throw gateRefusal(outcome, `write to ${params.path}`);
    await this.deps.writeLive(params.path, params.content);
    return {};
  }

  /** `session` is the session the agent named, as patchbay holds it — its
   * id, and the cwd it was opened with: where a command that names no cwd
   * runs, since that is the directory the agent was told it works in. Null
   * when the connection never opened it. */
  async createTerminal(
    params: acp.CreateTerminalRequest,
    session: { id: string; cwd: string } | null,
  ): Promise<acp.CreateTerminalResponse> {
    if (session === null) throw unknownSession(params.sessionId);
    if (params.cwd != null && !isAbsolute(params.cwd)) throw relativeCwd(params.cwd);
    // One description of the run: the gate judges and shows exactly what
    // the runner then spawns.
    const run: CreateTerminalParams = {
      command: params.command,
      args: params.args ?? [],
      env: Object.fromEntries((params.env ?? []).map((e) => [e.name, e.value])),
      cwd: params.cwd ?? session.cwd,
      outputByteLimit: params.outputByteLimit ?? null,
    };
    const command = formatCommandLine(run.command, run.args);
    const outcome = await this.deps.broker.gateCommand(session.id, run);
    if (outcome !== "accepted") throw gateRefusal(outcome, `command \`${command}\``);

    const handle = this.deps.broker.runner.create(run);
    const terminalId = `term-${++this.terminalCounter}`;
    this.terminals.set(terminalId, handle);
    this.deps.trackProcess(handle);
    const blockId = terminalBlockId(terminalId);
    const sessionId = session.id;
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
 * is built after the pool it serves (its gate needs the sessions store,
 * which needs the pool). `sessionFor` is how a request that names a
 * session the agent's way finds patchbay's. */
export function clientRequestHooks(
  host: () => ClientHost,
  sessionFor: (patchbayAgentId: PatchbayAgentId, agentSessionId: string) => string | undefined,
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
    onReadTextFile: (_patchbayAgentId, params) => host().readTextFile(params),
    onWriteTextFile: (patchbayAgentId, params) => host().writeTextFile(sessionFor(patchbayAgentId, params.sessionId), params),
    onCreateTerminal: (patchbayAgentId, params, sessionCwd) => {
      const id = sessionFor(patchbayAgentId, params.sessionId);
      return host().createTerminal(params, id === undefined || sessionCwd === null ? null : { id, cwd: sessionCwd });
    },
    onTerminalOutput: (_patchbayAgentId, params) => host().terminalOutput(params),
    onWaitForTerminalExit: (_patchbayAgentId, params) => host().waitForTerminalExit(params),
    onKillTerminal: (_patchbayAgentId, params) => host().killTerminal(params),
    onReleaseTerminal: (_patchbayAgentId, params) => host().releaseTerminal(params),
  };
}
