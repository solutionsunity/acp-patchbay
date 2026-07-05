// ACP client pool: agentId → { process, declared, verified, sessions[] }.
// Different agents are always separate subprocesses; sessions with the same
// agent multiplex over one connection (the protocol's own model). Crash is
// visible the moment it happens; recovery is one action.
//
// Connection handling approach checked against vscode-acp's ConnectionManager
// (MIT, formulahendry); rebuilt here on the SDK 1.x client() builder API.
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentStatus, DeclaredCapabilities } from "../shared/protocol";
import { declaredFromInitialize } from "./capabilities";

export interface LaunchSpec {
  agentId: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Per-agent process policy (architecture.md § process model). Absent →
   * "auto", same as an unset config-file field. */
  processPolicy?: "auto" | "shared" | "isolated";
  /** Per-agent knob defaults, applied post-create (P8). */
  defaults?: { model?: string; mode?: string; effort?: string };
}

export interface PoolHooks {
  onStatusChanged(agentId: string, status: AgentStatus, detail?: string): void;
  onDeclaredCaptured(
    agentId: string,
    declared: DeclaredCapabilities,
    raw: acp.InitializeResponse,
  ): void;
  onSessionUpdate(agentId: string, notification: acp.SessionNotification): void;
  /** P6 replaces this with the permission broker; absent → reject-by-cancel. */
  onPermissionRequest?(
    agentId: string,
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse>;
  /** A second session succeeded on a connection already serving one — the
   * one opportunistic signal for concurrent-session behavior (P5 matrix). */
  onConcurrentSessionsVerified?(agentId: string): void;
  /** Status of a process-policy "isolated" instance (P8) — kept off
   * `onStatusChanged` on purpose: an isolated subprocess dying must not flip
   * the shared agent's own status, since the agent itself is unaffected. */
  onIsolatedStatusChanged?(
    poolKey: string,
    agentId: string,
    status: AgentStatus,
    detail?: string,
  ): void;
  /** Patchbay declares fs+terminal unconditionally (P2), so these are
   * required — a declared-but-unhandled method would be exactly the kind of
   * lie bet #2 exists to prevent. Live-buffer reads and pre-gated writes
   * (P6) live behind these hooks so the pool itself stays vscode-free. */
  onReadTextFile(agentId: string, params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  onWriteTextFile(agentId: string, params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>;
  onCreateTerminal(agentId: string, params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse>;
  onTerminalOutput(
    agentId: string,
    params: acp.TerminalOutputRequest,
  ): Promise<acp.TerminalOutputResponse>;
  onWaitForTerminalExit(
    agentId: string,
    params: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse>;
  onKillTerminal(agentId: string, params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse>;
  onReleaseTerminal(
    agentId: string,
    params: acp.ReleaseTerminalRequest,
  ): Promise<acp.ReleaseTerminalResponse>;
}

interface Entry {
  spec: LaunchSpec;
  /** The `entries` map key — same as `spec.agentId` for a primary connection,
   * a synthetic instance id for a process-policy "isolated" one. */
  poolKey: string;
  /** The real roster agentId, for hook attribution — equals `poolKey` unless
   * `isolated`. */
  reportAs: string;
  /** A process-policy "isolated" instance: invisible to `list()`, doesn't
   * recapture/reset the shared agent's declared capabilities, and its status
   * changes route through `onIsolatedStatusChanged` instead of the normal
   * agent-wide status hook. */
  isolated: boolean;
  process: ChildProcess | null;
  connection: acp.ClientConnection | null;
  declared: DeclaredCapabilities | null;
  initializeRaw: acp.InitializeResponse | null;
  status: AgentStatus;
  detail?: string;
  sessions: Set<string>;
  stopping: boolean;
  stderrTail: string[];
}

export interface PooledAgentView {
  spec: LaunchSpec;
  status: AgentStatus;
  detail?: string;
  declared: DeclaredCapabilities | null;
  sessions: readonly string[];
  stderrTail: readonly string[];
}

const INITIALIZE_TIMEOUT_MS = 15_000;
const STDERR_TAIL_LINES = 40;

function resolveCommand(command: string): string {
  // npx/npm are .cmd shims on Windows; spawn without a shell needs the suffix
  if (process.platform === "win32" && (command === "npx" || command === "npm")) {
    return `${command}.cmd`;
  }
  return command;
}

function timeOfDay(): string {
  return new Date().toTimeString().slice(0, 5);
}

export class AgentPool {
  private entries = new Map<string, Entry>();

  constructor(private readonly hooks: PoolHooks) {}

  get(poolKey: string): PooledAgentView | undefined {
    const e = this.entries.get(poolKey);
    if (!e) return undefined;
    return {
      spec: e.spec,
      status: e.status,
      detail: e.detail,
      declared: e.declared,
      sessions: [...e.sessions],
      stderrTail: [...e.stderrTail],
    };
  }

  /** Real agents only — process-policy "isolated" instances are an
   * implementation detail, never a separate row in the Agents list. */
  list(): PooledAgentView[] {
    return [...this.entries.entries()].filter(([, e]) => !e.isolated).map(([id]) => this.get(id)!);
  }

  /** Spawn + initialize. Declared table is captured fresh on every connect.
   * `opts` backs process-policy "isolated" instances (P8): a distinct
   * `poolKey` from `spec.agentId` so a dedicated subprocess can coexist with
   * the shared one, while `reportAs` keeps every hook call attributed to the
   * real roster agent. Declared capabilities are still recorded locally
   * (`entry.declared`, e.g. for `reopen`'s `loadSession` check) but never
   * re-broadcast via `onDeclaredCaptured` for an isolated instance — the
   * shared agent's own matrix must not reset just because a sibling process
   * connected. */
  async connect(
    spec: LaunchSpec,
    opts?: { poolKey?: string; reportAs?: string; isolated?: boolean },
  ): Promise<DeclaredCapabilities> {
    const poolKey = opts?.poolKey ?? spec.agentId;
    const reportAs = opts?.reportAs ?? spec.agentId;
    const isolated = opts?.isolated ?? false;
    const existing = this.entries.get(poolKey);
    if (existing && (existing.status === "running" || existing.status === "reconnecting")) {
      throw new Error(`agent ${poolKey} is already connected`);
    }

    const entry: Entry = {
      spec,
      poolKey,
      reportAs,
      isolated,
      process: null,
      connection: null,
      declared: null,
      initializeRaw: null,
      status: "reconnecting",
      sessions: new Set(),
      stopping: false,
      stderrTail: [],
    };
    this.entries.set(poolKey, entry);
    this.setStatus(entry, "reconnecting");

    const child = spawn(resolveCommand(spec.command), spec.args, {
      env: { ...process.env, ...spec.env },
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    entry.process = child;

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() === "") continue;
        entry.stderrTail.push(line);
        if (entry.stderrTail.length > STDERR_TAIL_LINES) entry.stderrTail.shift();
      }
    });

    child.on("error", (err) => {
      this.markDead(entry, `spawn failed: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      if (entry.stopping) this.setStatus(entry, "stopped");
      else this.markDead(entry, `exited ${code ?? String(signal)} · ${timeOfDay()}`);
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!),
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    const connection = acp
      .client({ name: "acp-patchbay" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        const handler = this.hooks.onPermissionRequest;
        if (handler) return handler(reportAs, ctx.params);
        return Promise.resolve<acp.RequestPermissionResponse>({
          outcome: { outcome: "cancelled" },
        });
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.hooks.onSessionUpdate(reportAs, ctx.params);
      })
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) =>
        this.hooks.onReadTextFile(reportAs, ctx.params),
      )
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) =>
        this.hooks.onWriteTextFile(reportAs, ctx.params),
      )
      .onRequest(acp.methods.client.terminal.create, (ctx) =>
        this.hooks.onCreateTerminal(reportAs, ctx.params),
      )
      .onRequest(acp.methods.client.terminal.output, (ctx) =>
        this.hooks.onTerminalOutput(reportAs, ctx.params),
      )
      .onRequest(acp.methods.client.terminal.waitForExit, (ctx) =>
        this.hooks.onWaitForTerminalExit(reportAs, ctx.params),
      )
      .onRequest(acp.methods.client.terminal.kill, (ctx) =>
        this.hooks.onKillTerminal(reportAs, ctx.params),
      )
      .onRequest(acp.methods.client.terminal.release, (ctx) =>
        this.hooks.onReleaseTerminal(reportAs, ctx.params),
      )
      .connect(stream);
    entry.connection = connection;

    let init: acp.InitializeResponse;
    try {
      init = await this.withTimeout(
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: { name: "acp-patchbay", version: "0.0.1" },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
        }),
        INITIALIZE_TIMEOUT_MS,
        "initialize timed out",
      );
    } catch (err) {
      entry.stopping = true;
      connection.close(err);
      child.kill();
      this.markDead(entry, `initialize failed: ${(err as Error).message}`);
      throw err;
    }

    entry.initializeRaw = init;
    entry.declared = declaredFromInitialize(init);
    if (!isolated) this.hooks.onDeclaredCaptured(reportAs, entry.declared, init);
    this.setStatus(entry, "running");
    return entry.declared;
  }

  /** Intentional stop — reads as "stopped", never "crashed". */
  async stop(poolKey: string): Promise<void> {
    const entry = this.entries.get(poolKey);
    if (!entry || entry.process === null) return;
    entry.stopping = true;
    entry.connection?.close();
    const proc = entry.process;
    if (proc.exitCode === null && !proc.killed) {
      const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      proc.kill();
      await this.withTimeout(exited, 3_000, "kill timed out").catch(() => {
        proc.kill("SIGKILL");
      });
    }
    entry.sessions.clear();
    this.setStatus(entry, "stopped");
  }

  /** One-action recovery. Fresh connect ⇒ declared re-captured, verified resets (P5). */
  async restart(poolKey: string): Promise<DeclaredCapabilities> {
    const entry = this.entries.get(poolKey);
    if (!entry) throw new Error(`unknown agent ${poolKey}`);
    const { reportAs, isolated } = entry;
    await this.stop(poolKey);
    entry.stopping = false;
    return this.connect(entry.spec, { poolKey, reportAs, isolated });
  }

  async newSession(
    poolKey: string,
    cwd: string,
    mcpServers: acp.McpServer[] = [],
    additionalDirectories: string[] = [],
  ): Promise<acp.NewSessionResponse> {
    const entry = this.running(poolKey);
    const hadOtherSessions = entry.sessions.size > 0;
    const response = await entry.connection!.agent.request(
      acp.methods.agent.session.new,
      { cwd, mcpServers, additionalDirectories },
    );
    entry.sessions.add(response.sessionId);
    if (hadOtherSessions) this.hooks.onConcurrentSessionsVerified?.(entry.reportAs);
    return response;
  }

  /** Also used for P5's automatic, ephemeral fork-verification round-trip
   * and for real user-triggered branching (P8) — `session/fork` is
   * addressed to the connection holding the parent's context (architecture.md
   * § process model: "no cross-process handoff exists"), so a branch always
   * rides whatever poolKey its parent lives on, never a fresh decision. */
  async fork(
    poolKey: string,
    sessionId: string,
    cwd: string,
    mcpServers: acp.McpServer[] = [],
    additionalDirectories: string[] = [],
  ): Promise<acp.ForkSessionResponse> {
    const entry = this.running(poolKey);
    const response = await entry.connection!.agent.request(
      acp.methods.agent.session.fork,
      { sessionId, cwd, mcpServers, additionalDirectories },
    );
    entry.sessions.add(response.sessionId);
    // The parent was already on `entry.sessions` — a fork always proves this
    // connection sustains 2+ concurrent sessions, the same signal newSession's
    // hadOtherSessions case reports (P8: this is what lets "auto" process
    // policy bootstrap toward sharing without ever risking an unverified
    // top-level session/new).
    this.hooks.onConcurrentSessionsVerified?.(entry.reportAs);
    return response;
  }

  async prompt(
    poolKey: string,
    sessionId: string,
    prompt: acp.ContentBlock[],
  ): Promise<acp.PromptResponse> {
    const entry = this.running(poolKey);
    return entry.connection!.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt,
    });
  }

  async cancel(poolKey: string, sessionId: string): Promise<void> {
    const entry = this.running(poolKey);
    await entry.connection!.agent.notify(acp.methods.agent.session.cancel, {
      sessionId,
    });
  }

  /** Re-attaches to a session on a fresh connection; the agent replays its
   * own history as session/update notifications before this resolves. Only
   * meaningful when declared.loadSession is true — callers check first. */
  async loadSession(
    poolKey: string,
    sessionId: string,
    cwd: string,
    mcpServers: acp.McpServer[] = [],
    additionalDirectories: string[] = [],
  ): Promise<acp.LoadSessionResponse> {
    const entry = this.running(poolKey);
    const response = await entry.connection!.agent.request(
      acp.methods.agent.session.load,
      { sessionId, cwd, mcpServers, additionalDirectories },
    );
    entry.sessions.add(sessionId);
    return response;
  }

  /** Sets a session's operational mode. Display must come only from the
   * agent's own `current_mode_update` notification, never this call's
   * response (architecture.md § Session model, mode, effort — bridges have
   * reported success for rejected changes), so the response is discarded. */
  async setSessionMode(poolKey: string, sessionId: string, modeId: string): Promise<void> {
    const entry = this.running(poolKey);
    await entry.connection!.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId });
  }

  /** Same distrust-the-response rule as `setSessionMode` — callers must wait
   * for the `config_option_update` notification to reflect the change. */
  async setSessionConfigOption(
    poolKey: string,
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<void> {
    const entry = this.running(poolKey);
    const params: acp.SetSessionConfigOptionRequest =
      typeof value === "boolean" ? { sessionId, configId, type: "boolean", value } : { sessionId, configId, value };
    await entry.connection!.agent.request(acp.methods.agent.session.setConfigOption, params);
  }

  /** Local-only bookkeeping once a session is no longer in use — lets an
   * isolated instance's session count reach zero so its subprocess can be
   * freed (P8; see SessionManager.close). */
  forgetSession(poolKey: string, sessionId: string): void {
    this.entries.get(poolKey)?.sessions.delete(sessionId);
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((id) => this.stop(id)));
  }

  private running(poolKey: string): Entry {
    const entry = this.entries.get(poolKey);
    if (!entry || entry.status !== "running" || entry.connection === null) {
      throw new Error(`agent ${poolKey} is not running`);
    }
    return entry;
  }

  private setStatus(entry: Entry, status: AgentStatus, detail?: string): void {
    entry.status = status;
    entry.detail = detail;
    if (entry.isolated) this.hooks.onIsolatedStatusChanged?.(entry.poolKey, entry.reportAs, status, detail);
    else this.hooks.onStatusChanged(entry.reportAs, status, detail);
  }

  private markDead(entry: Entry, detail: string): void {
    if (entry.status === "crashed" || entry.status === "stopped") return;
    entry.connection?.close(new Error(detail));
    entry.sessions.clear();
    if (entry.stopping) this.setStatus(entry, "stopped");
    else this.setStatus(entry, "crashed", detail);
  }

  private withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }
}
