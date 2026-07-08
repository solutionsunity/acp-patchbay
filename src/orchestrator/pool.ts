// ACP client pool: agentId → { process, declared, used, sessions[] }.
// Different agents are always separate subprocesses; sessions with the same
// agent multiplex over one connection (the protocol's own model). Crash is
// visible the moment it happens; recovery is one action.
//
// Connection handling approach checked against vscode-acp's ConnectionManager
// (MIT, formulahendry); rebuilt here on the SDK 1.x client() builder API.
import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentStatus, CapabilityRowId, DeclaredCapabilities } from "../shared/protocol";
import { nullLogger, type Logger } from "./logger";
import {
  clientCapabilitiesWire,
  declaredFromInitialize,
  rowsProvenBy,
  type WireFact,
} from "./capabilities";
import { commandOf, killTree, treeSpawnOptions } from "./process-tree";

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
  /** Per-agent knob defaults, applied post-create (P8) — `options` keyed by
   * the agent's own config-option id (category is UX-only per ACP). */
  defaults?: { mode?: string; options?: Readonly<Record<string, string | boolean>> };
}

export interface PoolHooks {
  /** `stderr` rides crash statuses only — the process's own last words
   * (P16), so a failure's reason is readable without the Output panel. */
  onStatusChanged(agentId: string, status: AgentStatus, detail?: string, stderr?: readonly string[]): void;
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
  /** Fired the instant a wire fact bears on a capability row: "used" when
   * the fact rode a request that succeeded, "suspect" when it rode one that
   * failed (suspicion, not conviction — the failure may not be the row's
   * fault). Which fact bears on which row lives in one place —
   * capabilities.ts's CAPABILITY_PROOFS table — consulted at pool.ts's
   * three chokepoints (agent RPC settled, incoming client request handled,
   * session/update kind tag arrived); no call site ever names a row itself
   * (capability-verification.md: declared ≠ used). Only the outgoing
   * chokepoint can report "suspect": a client-side handler throwing is
   * patchbay's own gate rejecting, never the agent failing. Called
   * synchronously and never awaited so it can't block the RPC it's
   * reporting on. */
  onCapabilityEvidence?(agentId: string, row: CapabilityRowId, evidence: "used" | "suspect"): void;
  /** Wire-log tap (Audit page, opt-in): gates the tap's per-chunk work —
   * while false, chunks are dropped without even being decoded. */
  wireLogActive?(): boolean;
  /** One complete ndjson frame, already line-assembled. Redaction is the
   * receiver's job (wire-log.ts) — pool.ts hands over the raw line. */
  onWireFrame?(agentId: string, direction: "→" | "←", line: string): void;
  /** Status of a process-policy "isolated" instance (P8) — kept off
   * `onStatusChanged` on purpose: an isolated subprocess dying must not flip
   * the shared agent's own status, since the agent itself is unaffected. */
  onIsolatedStatusChanged?(
    poolKey: string,
    agentId: string,
    status: AgentStatus,
    detail?: string,
  ): void;
  /** Spawn-registry taps (P15c) — `onProcessSpawned` fires with the command
   * line read back from the OS shortly after spawn (skipped when the process
   * is already gone by then: a record that would only be stale), and
   * `onProcessEnded` when the exit is observed. */
  onProcessSpawned?(pid: number, command: string): void;
  onProcessEnded?(pid: number): void;
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

/** Grace budgets for `stop`'s ladder (plan.md P15b): EOF → SIGTERM →
 * SIGKILL, each rung waited on only as long as the budget allows. */
export interface StopBudget {
  /** After stdin EOF — a well-behaved agent exits on its own here. */
  eofMs: number;
  /** After SIGTERM, before escalating. */
  termMs: number;
  /** After SIGKILL — un-ignorable, this only bounds observing the exit. */
  killMs: number;
}

/** Interactive Stop can afford patience. */
const INTERACTIVE_STOP: StopBudget = { eofMs: 500, termMs: 2000, killMs: 500 };
/** deactivate's whole window is ~2s — every rung tightens, in parallel
 * across agents (disposeAll). */
const SHUTDOWN_STOP: StopBudget = { eofMs: 200, termMs: 700, killMs: 300 };

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
  private readonly initializeTimeoutMs: number;

  constructor(
    private readonly hooks: PoolHooks,
    /** Output-channel seam (logger.ts) — argv and env values never logged. */
    private readonly log: Logger = nullLogger,
    /** The default is generous on purpose: cold `npx`/`uvx` first runs
     * download whole packages (P16 — a short fuse would false-fail them).
     * Tests inject a short one to exercise the timeout path itself. */
    opts?: { initializeTimeoutMs?: number },
  ) {
    this.initializeTimeoutMs = opts?.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
  }

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

    this.log.info(
      `${poolKey}: spawning ${spec.command} (${spec.args.length} args${isolated ? ", isolated" : ""})`,
    );
    const child = spawn(resolveCommand(spec.command), spec.args, {
      env: { ...process.env, ...spec.env },
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Process-group leader on POSIX (process-tree.ts) — what lets stop()
      // reach grandchildren (the agent's own mcp-server/bridge children).
      ...treeSpawnOptions,
    });
    entry.process = child;

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() === "") continue;
        entry.stderrTail.push(line);
        if (entry.stderrTail.length > STDERR_TAIL_LINES) entry.stderrTail.shift();
        // The agent's own stderr, otherwise invisible until a crash —
        // debug level so the Output panel's level switch controls the noise.
        this.log.debug(`${poolKey} stderr: ${line}`);
      }
    });

    if (child.pid !== undefined) {
      const pid = child.pid;
      void commandOf(pid).then((command) => {
        // Already exited (fast crash) → the record would only be stale.
        if (command !== "" && child.exitCode === null && child.signalCode === null) {
          this.hooks.onProcessSpawned?.(pid, command);
        }
      });
    }
    child.on("error", (err) => {
      this.markDead(entry, `spawn failed: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      if (child.pid !== undefined) this.hooks.onProcessEnded?.(child.pid);
      if (entry.stopping) this.setStatus(entry, "stopped");
      else this.markDead(entry, `exited ${code ?? String(signal)} · ${timeOfDay()}`);
    });

    // Wire-log tap: outgoing frames pass through `toAgent` on their way to
    // the child's stdin; incoming get an extra data listener alongside the
    // pipe into the SDK. Both directions line-assemble before handing off —
    // redaction (wire-log.ts) needs whole frames, and chunks split anywhere.
    const toAgent = new PassThrough();
    toAgent.pipe(child.stdin!);
    this.tapLines(reportAs, "→", toAgent);
    const fromAgent = new PassThrough();
    child.stdout!.pipe(fromAgent);
    this.tapLines(reportAs, "←", child.stdout!);
    const stream = acp.ndJsonStream(
      Writable.toWeb(toAgent),
      Readable.toWeb(fromAgent) as ReadableStream<Uint8Array>,
    );

    // Chokepoint: every incoming request registers through `proven`, so a
    // handler resolving marks whatever row the proof table ties to its
    // method (capabilities.ts CAPABILITY_PROOFS) — registration sites never
    // name rows, and a future handler (P7 elicitation) marks for free.
    const proven = <M extends acp.ClientRequestMethod>(
      method: M,
      handler: acp.ClientRequestHandlersByMethod[M],
    ): [M, acp.ClientRequestHandlersByMethod[M]] => [
      method,
      (async (ctx: never) => {
        const result = await (handler as (ctx: never) => Promise<unknown>)(ctx);
        this.markProven(reportAs, { via: "clientRequest", method });
        return result;
      }) as acp.ClientRequestHandlersByMethod[M],
    ];
    const connection = acp
      .client({ name: "acp-patchbay" })
      .onRequest(
        ...proven(acp.methods.client.session.requestPermission, (ctx) => {
          const handler = this.hooks.onPermissionRequest;
          if (handler) return handler(reportAs, ctx.params);
          return Promise.resolve<acp.RequestPermissionResponse>({
            outcome: { outcome: "cancelled" },
          });
        }),
      )
      .onNotification(acp.methods.client.session.update, (ctx) => {
        // Chokepoint: the kind tag is the wire fact (e.g. usage_update has
        // no initialize-time claim — its arrival is the only signal), so it
        // goes through the table before session-manager decodes the payload.
        this.markProven(reportAs, {
          via: "sessionUpdate",
          updateKind: ctx.params.update.sessionUpdate,
        });
        this.hooks.onSessionUpdate(reportAs, ctx.params);
      })
      .onRequest(
        ...proven(acp.methods.client.fs.readTextFile, (ctx) =>
          this.hooks.onReadTextFile(reportAs, ctx.params),
        ),
      )
      .onRequest(
        ...proven(acp.methods.client.fs.writeTextFile, (ctx) =>
          this.hooks.onWriteTextFile(reportAs, ctx.params),
        ),
      )
      .onRequest(
        ...proven(acp.methods.client.terminal.create, (ctx) =>
          this.hooks.onCreateTerminal(reportAs, ctx.params),
        ),
      )
      .onRequest(
        ...proven(acp.methods.client.terminal.output, (ctx) =>
          this.hooks.onTerminalOutput(reportAs, ctx.params),
        ),
      )
      .onRequest(
        ...proven(acp.methods.client.terminal.waitForExit, (ctx) =>
          this.hooks.onWaitForTerminalExit(reportAs, ctx.params),
        ),
      )
      .onRequest(
        ...proven(acp.methods.client.terminal.kill, (ctx) =>
          this.hooks.onKillTerminal(reportAs, ctx.params),
        ),
      )
      .onRequest(
        ...proven(acp.methods.client.terminal.release, (ctx) =>
          this.hooks.onReleaseTerminal(reportAs, ctx.params),
        ),
      )
      .connect(stream);
    entry.connection = connection;

    let init: acp.InitializeResponse;
    try {
      init = await this.withTimeout(
        this.request(entry, acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: { name: "acp-patchbay", version: "0.0.1" },
          clientCapabilities: clientCapabilitiesWire(),
        }),
        this.initializeTimeoutMs,
        // The classic silent hang is a CLI doing first-run setup against a
        // TTY it doesn't have (P16) — name that instead of a bare timeout.
        // Reads as "initialize failed: timed out — …" through markDead.
        "timed out — the CLI may need interactive first-run setup; run it once manually",
      );
    } catch (err) {
      // Crash with the reason, never a silent "stopped": the stopping flag
      // used to be set here first, routing markDead to "stopped" and
      // swallowing the detail — the exact silent failure P16 exists to
      // kill. markDead runs before the kill so the 'exit' handler can't
      // relabel it "exited N" either.
      this.markDead(entry, `initialize failed: ${(err as Error).message}`);
      if (child.pid !== undefined) {
        const pid = child.pid;
        killTree(pid, "SIGTERM");
        // Stragglers of a half-started launch (npx → node → …) get the
        // sweep a moment later; unref'd so it never holds the host open.
        setTimeout(() => killTree(pid, "SIGKILL"), 2_000).unref();
      }
      throw err;
    }

    entry.initializeRaw = init;
    entry.declared = declaredFromInitialize(init);
    this.log.info(
      `${poolKey}: initialized — ${init.agentInfo?.name ?? "unnamed"}` +
        `${init.agentInfo?.version !== undefined ? ` v${init.agentInfo.version}` : ""}` +
        `, protocol ${init.protocolVersion}`,
    );
    if (!isolated) this.hooks.onDeclaredCaptured(reportAs, entry.declared, init);
    this.setStatus(entry, "running");
    return entry.declared;
  }

  /** Intentional stop — reads as "stopped", never "crashed". The graceful
   * ladder (plan.md P15b): protocol close, stdin EOF (a well-behaved agent
   * exits on its own — `connection.close()` never ends the pipe), grace,
   * SIGTERM the tree, grace, SIGKILL the tree — then a final group sweep,
   * because a leader that exited cleanly can still leave grandchildren
   * behind. */
  async stop(poolKey: string, budget: StopBudget = INTERACTIVE_STOP): Promise<void> {
    const entry = this.entries.get(poolKey);
    if (!entry || entry.process === null) return;
    entry.stopping = true;
    entry.connection?.close();
    const proc = entry.process;
    if (proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) resolve();
        else proc.once("exit", () => resolve());
      });
      const exitedWithin = (ms: number) =>
        this.withTimeout(exited, ms, "still alive").then(
          () => true,
          () => false,
        );
      // EOF may hit a pipe whose far end is already gone — that's an EPIPE
      // on the stream, not a reason to crash the host.
      proc.stdin?.once("error", () => {});
      proc.stdin?.end();
      if (!(await exitedWithin(budget.eofMs))) {
        killTree(proc.pid, "SIGTERM");
        if (!(await exitedWithin(budget.termMs))) {
          killTree(proc.pid, "SIGKILL");
          await exitedWithin(budget.killMs);
        }
      }
    }
    if (proc.pid !== undefined) killTree(proc.pid, "SIGKILL"); // group sweep — ESRCH is success
    entry.sessions.clear();
    this.setStatus(entry, "stopped");
  }

  /** One-action recovery. Fresh connect ⇒ declared re-captured, used resets (P5). */
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
    const response = await this.request(entry, acp.methods.agent.session.new, {
      cwd,
      mcpServers,
      additionalDirectories,
    });
    entry.sessions.add(response.sessionId);
    this.log.debug(`${poolKey}: session/new -> ${response.sessionId}`);
    return response;
  }

  /** Stable ACP call (`authenticate`, not the unstable terminal-auth
   * extension): the agent handles whatever interactive flow its method
   * needs (browser, device code, ...) — patchbay only picks the methodId
   * and awaits the round trip. Callers retry whatever hit `auth_required`
   * once this resolves. */
  async authenticate(poolKey: string, methodId: string): Promise<void> {
    const entry = this.running(poolKey);
    await this.request(entry, acp.methods.agent.authenticate, { methodId });
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
    const response = await this.request(entry, acp.methods.agent.session.fork, {
      sessionId,
      cwd,
      mcpServers,
      additionalDirectories,
    });
    entry.sessions.add(response.sessionId);
    this.log.debug(`${poolKey}: session/fork ${sessionId} -> ${response.sessionId}`);
    return response;
  }

  async prompt(
    poolKey: string,
    sessionId: string,
    prompt: acp.ContentBlock[],
  ): Promise<acp.PromptResponse> {
    const entry = this.running(poolKey);
    return this.request(entry, acp.methods.agent.session.prompt, { sessionId, prompt });
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
    const response = await this.request(entry, acp.methods.agent.session.load, {
      sessionId,
      cwd,
      mcpServers,
      additionalDirectories,
    });
    entry.sessions.add(sessionId);
    this.log.debug(`${poolKey}: session/load ${sessionId} replayed`);
    return response;
  }

  /** Sets a session's operational mode. Display must come only from the
   * agent's own `current_mode_update` notification, never this call's
   * response (architecture.md § Session model, mode, effort — bridges have
   * reported success for rejected changes), so the response is discarded. */
  async setSessionMode(poolKey: string, sessionId: string, modeId: string): Promise<void> {
    const entry = this.running(poolKey);
    await this.request(entry, acp.methods.agent.session.setMode, { sessionId, modeId });
  }

  /** Unlike `setSessionMode` (whose response carries no state), the spec
   * makes this response's `configOptions` required — "the full set of
   * configuration options and their current values" — and agents are not
   * obliged to echo a `config_option_update` notification at the client
   * that initiated the change (claude-agent-acp doesn't). The response is
   * agent-authored state, not an echo of the request, so callers consume it. */
  async setSessionConfigOption(
    poolKey: string,
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const entry = this.running(poolKey);
    const params: acp.SetSessionConfigOptionRequest =
      typeof value === "boolean" ? { sessionId, configId, type: "boolean", value } : { sessionId, configId, value };
    return this.request(entry, acp.methods.agent.session.setConfigOption, params);
  }

  /** Attaches the wire-log tap to one direction of a connection's stdio.
   * Zero-cost while the log is off: chunks are dropped before decode, and
   * the partial-line buffer resets so a mid-frame enable never emits a torn
   * frame as if it were whole. */
  private tapLines(agentId: string, direction: "→" | "←", stream: NodeJS.ReadableStream): void {
    const { onWireFrame, wireLogActive } = this.hooks;
    if (onWireFrame === undefined) return;
    let buffer = "";
    stream.on("data", (chunk: Buffer | string) => {
      if (wireLogActive?.() !== true) {
        buffer = "";
        return;
      }
      buffer += chunk.toString();
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line !== "") onWireFrame(agentId, direction, line);
      }
      // A runaway partial line (a frame far beyond any sane size) is not
      // worth holding — this is a debug tap, never the protocol path.
      if (buffer.length > 1_000_000) buffer = "";
    });
  }

  /** Local-only bookkeeping once a session is no longer in use — lets an
   * isolated instance's session count reach zero so its subprocess can be
   * freed (P8; see SessionManager.close). */
  forgetSession(poolKey: string, sessionId: string): void {
    this.entries.get(poolKey)?.sessions.delete(sessionId);
  }

  /** Stops the primary connection *and* every process-policy "isolated"
   * instance reporting as this agent — Remove's semantics (a removed agent
   * must not keep running anywhere), where `stop(poolKey)` is one
   * connection. */
  async stopAllFor(agentId: string): Promise<void> {
    const keys = [...this.entries.entries()]
      .filter(([, entry]) => entry.reportAs === agentId)
      .map(([key]) => key);
    await Promise.allSettled(keys.map((key) => this.stop(key)));
  }

  /** The deactivate path: every connection down on the tight budget, in
   * parallel — the whole sweep has to fit VS Code's ~2s shutdown window. */
  async disposeAll(budget: StopBudget = SHUTDOWN_STOP): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((id) => this.stop(id, budget)));
  }

  /** Chokepoint: every outgoing agent RPC goes through here, so however the
   * call settles, whatever rows the proof table ties to its method + params
   * (capabilities.ts CAPABILITY_PROOFS) get their evidence — "used" on
   * success, "suspect" on failure — and no other place in pool.ts decides
   * what a wire fact means. One failure is exempt from suspicion:
   * auth_required (-32000) is the honest pre-login state, already surfaced
   * as its own condition, not a capability misbehaving. `priorSessionCount`
   * is captured before the await: "a second session on a connection already
   * serving one" must count the sessions as they stood when the call was
   * made. */
  private async request<M extends acp.AgentRequestMethod>(
    entry: Entry,
    method: M,
    params: acp.AgentRequestParamsByMethod[M],
  ): Promise<acp.AgentRequestResponsesByMethod[M]> {
    const priorSessionCount = entry.sessions.size;
    const fact: WireFact = { via: "agentRequest", method, params, priorSessionCount };
    try {
      const result = await entry.connection!.agent.request(method, params);
      this.markProven(entry.reportAs, fact);
      return result;
    } catch (err) {
      if (!(err instanceof acp.RequestError && err.code === -32000)) {
        for (const row of rowsProvenBy(fact)) {
          this.hooks.onCapabilityEvidence?.(entry.reportAs, row, "suspect");
        }
      }
      throw err;
    }
  }

  private markProven(reportAs: string, fact: WireFact): void {
    for (const row of rowsProvenBy(fact)) this.hooks.onCapabilityEvidence?.(reportAs, row, "used");
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
    // Crash carries the process's own last words (P16); every other status
    // clears them — stale stderr on a running agent would be a lie.
    const stderr =
      status === "crashed" && entry.stderrTail.length > 0 ? [...entry.stderrTail] : undefined;
    if (entry.isolated) this.hooks.onIsolatedStatusChanged?.(entry.poolKey, entry.reportAs, status, detail);
    else this.hooks.onStatusChanged(entry.reportAs, status, detail, stderr);
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
