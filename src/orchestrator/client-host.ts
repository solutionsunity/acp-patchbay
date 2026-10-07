// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The client side of ACP that patchbay serves to agents: fs/read_text_file,
// fs/write_text_file and the terminal/* family. Every write and every command
// passes patchbay's own gate first; every "no" is answered through
// client-replies.ts. What it serves, it does here: the reads it slices, the
// writes it lands, the commands it runs. Kept vscode-free — the live-buffer
// read and write are injected — so the handlers the extension runs are the
// same ones the tests run.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { formatCommandLine } from "../shared/command-line";
import { terminalBlockId, type AgentViewEvent } from "../shared/protocol";
import type { PermissionBroker } from "./broker";
import { gateRefusal, readFailure, relativeCwd, relativePath, unknownSession, unknownTerminal } from "./client-replies";
import type { PoolHooks } from "./pool";
import type { FileReadFact, FileWriteFact, TerminalCreateFact, TerminalRefFact } from "./readers/client-requests";
import { NodeTerminalRunner, type CreateTerminalParams, type TerminalHandle, type TerminalRunner } from "./terminal-runner";
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
  private readonly runner: TerminalRunner = new NodeTerminalRunner();

  constructor(private readonly deps: ClientHostDeps) {}

  /** `patchbaySessionId` is patchbay's id for the session the agent named —
   * undefined when patchbay holds no such session, which reads nothing. */
  async readTextFile(patchbaySessionId: PatchbaySessionId | undefined, request: FileReadFact): Promise<acp.ReadTextFileResponse> {
    if (patchbaySessionId === undefined) throw unknownSession(request.sessionId);
    if (!isAbsolute(request.path)) throw relativePath(request.path);
    const content = await this.deps.readLive(request.path).catch((err: unknown) => {
      throw readFailure(err, request.path);
    });
    return { content: sliceTextFileRead(content, request.line, request.limit) };
  }

  /** `patchbaySessionId` is patchbay's id for the session the agent named —
   * undefined when patchbay holds no such session, which asks no one. */
  async writeTextFile(patchbaySessionId: PatchbaySessionId | undefined, request: FileWriteFact): Promise<acp.WriteTextFileResponse> {
    if (patchbaySessionId === undefined) throw unknownSession(request.sessionId);
    if (!isAbsolute(request.path)) throw relativePath(request.path);
    const outcome = await this.deps.broker.gateFileWrite(patchbaySessionId, request.path, request.content);
    if (outcome !== "accepted") throw gateRefusal(outcome, `write to ${request.path}`);
    await this.deps.writeLive(request.path, request.content);
    return {};
  }

  /** `session` is the session the agent named, as patchbay holds it — its
   * id, and the cwd it was opened with: where a command that names no cwd
   * runs, since that is the directory the agent was told it works in. Null
   * when the connection never opened it. */
  async createTerminal(
    request: TerminalCreateFact,
    session: { id: PatchbaySessionId; cwd: string } | null,
  ): Promise<acp.CreateTerminalResponse> {
    if (session === null) throw unknownSession(request.sessionId);
    if (request.cwd !== undefined && !isAbsolute(request.cwd)) throw relativeCwd(request.cwd);
    // One description of the run: the gate judges and shows exactly what
    // the runner then spawns.
    const run: CreateTerminalParams = {
      command: request.command,
      args: [...request.args],
      env: { ...request.env },
      cwd: request.cwd ?? session.cwd,
      outputByteLimit: request.outputByteLimit ?? null,
    };
    const command = formatCommandLine(run.command, run.args);
    const outcome = await this.deps.broker.gateCommand(session.id, run);
    if (outcome !== "accepted") throw gateRefusal(outcome, `command \`${command}\``);

    const handle = this.runner.create(run);
    // Unique beyond this window: a replayed call naming a terminal of an
    // earlier window must never bind to a new one that happens to share
    // its number.
    const terminalId = `term-${randomUUID()}`;
    this.terminals.set(terminalId, { handle, owner: session.id });
    this.deps.trackProcess(handle);
    const blockId = terminalBlockId(terminalId);
    const patchbaySessionId = session.id;
    this.deps.emit({ kind: "terminalStarted", patchbaySessionId, blockId, command });
    handle.onData((chunk) => this.deps.emit({ kind: "terminalOutputAppended", patchbaySessionId, blockId, chunk }));
    handle.onExit((status) =>
      this.deps.emit({
        kind: "terminalExited",
        patchbaySessionId,
        blockId,
        exitCode: status.exitCode,
        ...(status.signal !== null ? { signal: status.signal } : {}),
      }),
    );
    return { terminalId };
  }

  async terminalOutput(patchbaySessionId: PatchbaySessionId | undefined, request: TerminalRefFact): Promise<acp.TerminalOutputResponse> {
    const handle = this.terminal(patchbaySessionId, request);
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
    request: TerminalRefFact,
  ): Promise<acp.WaitForTerminalExitResponse> {
    const { exitCode, signal } = await this.terminal(patchbaySessionId, request).waitForExit();
    return { exitCode, signal };
  }

  /** A terminal the session never got — or already released — is the
   * agent's mistake, answered like output and wait: never an untrue
   * "killed". */
  async killTerminal(patchbaySessionId: PatchbaySessionId | undefined, request: TerminalRefFact): Promise<acp.KillTerminalResponse> {
    this.terminal(patchbaySessionId, request).kill();
    return {};
  }

  async releaseTerminal(patchbaySessionId: PatchbaySessionId | undefined, request: TerminalRefFact): Promise<acp.ReleaseTerminalResponse> {
    // ACP release semantics: a still-running command is killed — before
    // this, releasing dropped the handle and left the process running
    // with nothing pointing at it.
    const handle = this.terminal(patchbaySessionId, request);
    if (handle.exitStatus() === null) handle.kill();
    this.terminals.delete(request.terminalId);
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

/** Writes newContent to path (creating parent dirs as needed) — the actual
 * disk mutation, called only after the write's gate settled accepted. */
export async function applyFileWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/** ACP `fs/read_text_file` range params: `line` is 1-based, `limit` is a
 * max line count. The requested slice is what returns — over-serving the
 * whole file costs the agent tokens and disobeys the request shape. */
export function sliceTextFileRead(
  content: string,
  line?: number | null,
  limit?: number | null,
): string {
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit != null ? start + limit : lines.length;
  return lines.slice(start, end).join("\n");
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
    onReadTextFile: (patchbayAgentId, request) => host().readTextFile(sessionFor(patchbayAgentId, request.sessionId), request),
    onWriteTextFile: (patchbayAgentId, request) => host().writeTextFile(sessionFor(patchbayAgentId, request.sessionId), request),
    onCreateTerminal: (patchbayAgentId, request, sessionCwd) => {
      const patchbaySessionId = sessionFor(patchbayAgentId, request.sessionId);
      return host().createTerminal(request, patchbaySessionId === undefined || sessionCwd === null ? null : { id: patchbaySessionId, cwd: sessionCwd });
    },
    onTerminalOutput: (patchbayAgentId, request) => host().terminalOutput(sessionFor(patchbayAgentId, request.sessionId), request),
    onWaitForTerminalExit: (patchbayAgentId, request) =>
      host().waitForTerminalExit(sessionFor(patchbayAgentId, request.sessionId), request),
    onKillTerminal: (patchbayAgentId, request) => host().killTerminal(sessionFor(patchbayAgentId, request.sessionId), request),
    onReleaseTerminal: (patchbayAgentId, request) => host().releaseTerminal(sessionFor(patchbayAgentId, request.sessionId), request),
  };
}
