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
}

interface Entry {
  spec: LaunchSpec;
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

  get(agentId: string): PooledAgentView | undefined {
    const e = this.entries.get(agentId);
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

  list(): PooledAgentView[] {
    return [...this.entries.keys()].map((id) => this.get(id)!);
  }

  /** Spawn + initialize. Declared table is captured fresh on every connect. */
  async connect(spec: LaunchSpec): Promise<DeclaredCapabilities> {
    const existing = this.entries.get(spec.agentId);
    if (existing && (existing.status === "running" || existing.status === "reconnecting")) {
      throw new Error(`agent ${spec.agentId} is already connected`);
    }

    const entry: Entry = {
      spec,
      process: null,
      connection: null,
      declared: null,
      initializeRaw: null,
      status: "reconnecting",
      sessions: new Set(),
      stopping: false,
      stderrTail: [],
    };
    this.entries.set(spec.agentId, entry);
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
        if (handler) return handler(spec.agentId, ctx.params);
        return Promise.resolve<acp.RequestPermissionResponse>({
          outcome: { outcome: "cancelled" },
        });
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.hooks.onSessionUpdate(spec.agentId, ctx.params);
      })
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
    this.hooks.onDeclaredCaptured(spec.agentId, entry.declared, init);
    this.setStatus(entry, "running");
    return entry.declared;
  }

  /** Intentional stop — reads as "stopped", never "crashed". */
  async stop(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
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
  async restart(agentId: string): Promise<DeclaredCapabilities> {
    const entry = this.entries.get(agentId);
    if (!entry) throw new Error(`unknown agent ${agentId}`);
    await this.stop(agentId);
    entry.stopping = false;
    return this.connect(entry.spec);
  }

  async newSession(
    agentId: string,
    cwd: string,
    mcpServers: acp.McpServer[] = [],
  ): Promise<acp.NewSessionResponse> {
    const entry = this.running(agentId);
    const hadOtherSessions = entry.sessions.size > 0;
    const response = await entry.connection!.agent.request(
      acp.methods.agent.session.new,
      { cwd, mcpServers },
    );
    entry.sessions.add(response.sessionId);
    if (hadOtherSessions) this.hooks.onConcurrentSessionsVerified?.(agentId);
    return response;
  }

  /** Ephemeral protocol-level check, not user-facing session creation —
   * P5's automatic fork-verification round-trip runs through this too. */
  async fork(
    agentId: string,
    sessionId: string,
    cwd: string,
  ): Promise<acp.ForkSessionResponse> {
    const entry = this.running(agentId);
    const response = await entry.connection!.agent.request(
      acp.methods.agent.session.fork,
      { sessionId, cwd },
    );
    entry.sessions.add(response.sessionId);
    return response;
  }

  async prompt(
    agentId: string,
    sessionId: string,
    prompt: acp.ContentBlock[],
  ): Promise<acp.PromptResponse> {
    const entry = this.running(agentId);
    return entry.connection!.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt,
    });
  }

  async cancel(agentId: string, sessionId: string): Promise<void> {
    const entry = this.running(agentId);
    await entry.connection!.agent.notify(acp.methods.agent.session.cancel, {
      sessionId,
    });
  }

  /** Re-attaches to a session on a fresh connection; the agent replays its
   * own history as session/update notifications before this resolves. Only
   * meaningful when declared.loadSession is true — callers check first. */
  async loadSession(
    agentId: string,
    sessionId: string,
    cwd: string,
    mcpServers: acp.McpServer[] = [],
  ): Promise<acp.LoadSessionResponse> {
    const entry = this.running(agentId);
    const response = await entry.connection!.agent.request(
      acp.methods.agent.session.load,
      { sessionId, cwd, mcpServers },
    );
    entry.sessions.add(sessionId);
    return response;
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((id) => this.stop(id)));
  }

  private running(agentId: string): Entry {
    const entry = this.entries.get(agentId);
    if (!entry || entry.status !== "running" || entry.connection === null) {
      throw new Error(`agent ${agentId} is not running`);
    }
    return entry;
  }

  private setStatus(entry: Entry, status: AgentStatus, detail?: string): void {
    entry.status = status;
    entry.detail = detail;
    this.hooks.onStatusChanged(entry.spec.agentId, status, detail);
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
