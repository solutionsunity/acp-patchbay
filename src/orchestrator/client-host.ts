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
import type { PatchbayAgentId, PatchbaySessionId } from "../shared/ids";

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
  /** Each terminal with the session that made it — the one session it
   * answers: another session's request, or another agent's, finds no such
   * terminal. */
  private readonly terminals = new Map<string, { handle: TerminalHandle; owner: PatchbaySessionId }>();
  private terminalCounter = 0;

  constructor(private readonly deps: ClientHostDeps) {}

  /** `patchbaySessionId` is patchbay's id for the session the agent named —
   * undefined when patchbay holds no such session, which reads nothing. */
  async readTextFile(
    patchbaySessionId: PatchbaySessionId | undefined,
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    if (patchbaySessionId === undefined) throw unknownSession(params.sessionId);
    const content = await this.deps.readLive(params.path).catch((err: unknown) => {
      throw readFailure(err, params.path);
    });
    return { content: sliceTextFileRead(content, params.line, params.limit) };
  }

  /** `patchbaySessionId` is patchbay's id for the session the agent named —
   * undefined when patchbay holds no such session, which asks no one. */
  async writeTextFile(
    patchbaySessionId: PatchbaySessionId | undefined,
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    if (patchbaySessionId === undefined) throw unknownSession(params.sessionId);
    const outcome = await this.deps.broker.gateFileWrite(patchbaySessionId, params.path, params.content);
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
    session: { id: PatchbaySessionId; cwd: string } | null,
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
    this.terminals.set(terminalId, { handle, owner: session.id });
    this.deps.trackProcess(handle);
    const blockId = terminalBlockId(terminalId);
    const patchbaySessionId = session.id;
    this.deps.emit({ kind: "terminalStarted", patchbaySessionId, blockId, command });
    handle.onData((chunk) => this.deps.emit({ kind: "terminalOutputAppended", patchbaySessionId, blockId, chunk }));
    handle.onExit((status) =>
      this.deps.emit({ kind: "terminalExited", patchbaySessionId, blockId, exitCode: status.exitCode }),
    );
    return { terminalId };
  }

  async terminalOutput(
    patchbaySessionId: PatchbaySessionId | undefined,
    params: acp.TerminalOutputRequest,
  ): Promise<acp.TerminalOutputResponse> {
    const handle = this.terminal(patchbaySessionId, params);
    const { output, truncated } = handle.currentOutput();
    const exit = handle.exitStatus();
    return {
      output,
      truncated,
      exitStatus: exit ? { exitCode: exit.exitCode, signal: exit.signal } : null,
    };
  }

  async waitForTerminalExit(
    patchbaySessionId: PatchbaySessionId | undefined,
    params: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse> {
    return this.terminal(patchbaySessionId, params).waitForExit();
  }

  async killTerminal(
    patchbaySessionId: PatchbaySessionId | undefined,
    params: acp.KillTerminalRequest,
  ): Promise<acp.KillTerminalResponse> {
    this.owned(patchbaySessionId, params)?.kill();
    return {};
  }

  async releaseTerminal(
    patchbaySessionId: PatchbaySessionId | undefined,
    params: acp.ReleaseTerminalRequest,
  ): Promise<acp.ReleaseTerminalResponse> {
    // ACP release semantics: a still-running command is killed — before
    // this, releasing dropped the handle and left the process running
    // with nothing pointing at it.
    const handle = this.owned(patchbaySessionId, params);
    if (handle === undefined) return {};
    if (handle.exitStatus() === null) handle.kill();
    this.terminals.delete(params.terminalId);
    return {};
  }

  /** Every command still running, for teardown paths that must stop
   * reality before anything else. */
  runningPids(): number[] {
    return [...this.terminals.values()].flatMap(({ handle: h }) => (h.pid !== null && h.exitStatus() === null ? [h.pid] : []));
  }

  /** Forget every terminal — after the teardown killed them. */
  clear(): void {
    this.terminals.clear();
  }

  /** The terminal a request names, when the session it names made it. A
   * session patchbay doesn't hold is refused; another session's terminal
   * reads as none, so its existence isn't told either. */
  private owned(
    patchbaySessionId: PatchbaySessionId | undefined,
    params: { sessionId: string; terminalId: string },
  ): TerminalHandle | undefined {
    if (patchbaySessionId === undefined) throw unknownSession(params.sessionId);
    const terminal = this.terminals.get(params.terminalId);
    return terminal?.owner === patchbaySessionId ? terminal.handle : undefined;
  }

  private terminal(
    patchbaySessionId: PatchbaySessionId | undefined,
    params: { sessionId: string; terminalId: string },
  ): TerminalHandle {
    const handle = this.owned(patchbaySessionId, params);
    if (handle === undefined) throw unknownTerminal(params.terminalId);
    return handle;
  }
}

/** The pool's fs/terminal hooks, bound to a host. A getter because the host
 * is built after the pool it serves (its gate needs the sessions store,
 * which needs the pool). `sessionFor` is how a request that names a
 * session the agent's way finds patchbay's. */
export function clientRequestHooks(
  host: () => ClientHost,
  sessionFor: (patchbayAgentId: PatchbayAgentId, sessionId: string) => PatchbaySessionId | undefined,
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
    onReadTextFile: (patchbayAgentId, params) => host().readTextFile(sessionFor(patchbayAgentId, params.sessionId), params),
    onWriteTextFile: (patchbayAgentId, params) => host().writeTextFile(sessionFor(patchbayAgentId, params.sessionId), params),
    onCreateTerminal: (patchbayAgentId, params, sessionCwd) => {
      const patchbaySessionId = sessionFor(patchbayAgentId, params.sessionId);
      return host().createTerminal(params, patchbaySessionId === undefined || sessionCwd === null ? null : { id: patchbaySessionId, cwd: sessionCwd });
    },
    onTerminalOutput: (patchbayAgentId, params) => host().terminalOutput(sessionFor(patchbayAgentId, params.sessionId), params),
    onWaitForTerminalExit: (patchbayAgentId, params) =>
      host().waitForTerminalExit(sessionFor(patchbayAgentId, params.sessionId), params),
    onKillTerminal: (patchbayAgentId, params) => host().killTerminal(sessionFor(patchbayAgentId, params.sessionId), params),
    onReleaseTerminal: (patchbayAgentId, params) => host().releaseTerminal(sessionFor(patchbayAgentId, params.sessionId), params),
  };
}
