// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

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
import type { AgentStatus, CapabilityRowId, DeclaredCapabilities, KnobSeed } from "../shared/protocol";
import { nullLogger, type Logger } from "./logger";
import {
  clientCapabilitiesWire,
  declaredFromInitialize,
  rowsProvenBy,
  type WireFact,
} from "./capabilities";
import { isMissingBinSignature, launcherKind, npmNpxRoot, npxPackageName, npxPackageSpec, purgeNpxEntries } from "./launcher-health";
import { guardResponse } from "./response-guards";
import { resolveSpawn } from "./spawn-resolve";
import { commandOf, killTree, treeSpawnOptions } from "./process-tree";

/** Launch-phase seam (runtime-resolver.ts): given the spec about to spawn,
 * returns the spec that actually spawns — the same spec when the system
 * runtime passes its gate, a PATH-prepended copy when a managed runtime
 * backs the launch. `onPhase` surfaces a download in progress as the
 * connect's status detail. A throw is the connect failure: no runtime, no
 * agent. */
export type RuntimeResolver = (
  spec: LaunchSpec,
  onPhase: (label: string) => void,
) => Promise<LaunchSpec>;

export interface LaunchSpec {
  agentId: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Per-agent process policy. Absent →
   * "auto", same as an unset config-file field. */
  processPolicy?: "auto" | "shared" | "isolated";
  /** Per-agent knob defaults, applied post-create — the folded,
   * knob-id-keyed seed (knobs.ts; category is UX-only per ACP). */
  defaults?: KnobSeed;
}

export interface PoolHooks {
  /** `stderr` rides crash statuses only — the process's own last words,
   * so a failure's reason is readable without the Output panel. */
  onStatusChanged(agentId: string, status: AgentStatus, detail?: string, stderr?: readonly string[]): void;
  onDeclaredCaptured(
    agentId: string,
    declared: DeclaredCapabilities,
    raw: acp.InitializeResponse,
  ): void;
  onSessionUpdate(agentId: string, notification: acp.SessionNotification): void;
  /** The permission broker replaces this; absent → reject-by-cancel. */
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
   * (declared ≠ used). Only the outgoing
   * chokepoint can report "suspect": a client-side handler throwing is
   * patchbay's own gate rejecting, never the agent failing. Called
   * synchronously and never awaited so it can't block the RPC it's
   * reporting on. */
  onCapabilityEvidence?(agentId: string, row: CapabilityRowId, evidence: "used" | "suspect"): void;
  /** Any outgoing agent RPC settling with `auth_required` (-32000) — the
   * connect-time probe, a mid-session prompt after the agent's credentials
   * expired, or a post-logout session attempt all funnel through here, so
   * "prompt the user to authenticate again" (per the spec) has one
   * writer. `reason` is the error's own message — the agent's login
   * instruction, and the only guidance on the wire when `authMethods` is
   * empty (Auggie); null when blank. Like onCapabilityEvidence:
   * synchronous, never awaited. */
  onAuthRequired?(agentId: string, reason: string | null): void;
  /** Wire-log tap (Audit page, opt-in): gates the tap's per-chunk work —
   * while false, chunks are dropped without even being decoded. */
  wireLogActive?(): boolean;
  /** One complete ndjson frame, already line-assembled. Redaction is the
   * receiver's job (wire-log.ts) — pool.ts hands over the raw line. */
  onWireFrame?(agentId: string, direction: "→" | "←", line: string): void;
  /** Status of a process-policy "isolated" instance — kept off
   * `onStatusChanged` on purpose: an isolated subprocess dying must not flip
   * the shared agent's own status, since the agent itself is unaffected. */
  onIsolatedStatusChanged?(
    poolKey: string,
    agentId: string,
    status: AgentStatus,
    detail?: string,
  ): void;
  /** Spawn-registry taps — `onProcessSpawned` fires with the command
   * line read back from the OS shortly after spawn (skipped when the process
   * is already gone by then: a record that would only be stale), and
   * `onProcessEnded` when the exit is observed. */
  onProcessSpawned?(pid: number, command: string): void;
  onProcessEnded?(pid: number): void;
  /** Patchbay declares fs+terminal unconditionally, so these are
   * required — a declared-but-unhandled method would be exactly the kind of
   * lie bet #2 exists to prevent. Live-buffer reads and pre-gated writes
   * live behind these hooks so the pool itself stays vscode-free. */
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
  /** The real configured agentId, for hook attribution — equals `poolKey` unless
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

/** Grace budgets for `stop`'s ladder: EOF → SIGTERM →
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

/** The child's exit code once it has actually exited, waited on for at most
 * `ms` — null when it hasn't exited in time (or died to a signal). */
function exitCodeWithin(child: ChildProcess, ms: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(child.exitCode), ms);
    t.unref?.();
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

function timeOfDay(): string {
  return new Date().toTimeString().slice(0, 5);
}

/** The one spawn-option assembly for anything launched in an agent's
 * environment — the agent itself and its launcher warmup. One spelling on
 * purpose, beyond DRY: the env merge MUST be identical in both, or the
 * warmup could warm a different package cache than the real launch reads
 * (npm/uv honor cache-location env vars). shell comes from resolveSpawn
 * (Windows .cmd shims only — stop() still reaches the whole tree there:
 * killTree is taskkill /T, wrapper included); treeSpawnOptions makes the
 * child a process-group leader on POSIX (process-tree.ts), what lets
 * stop() reach grandchildren. */
function spawnEnv(spec: LaunchSpec): NodeJS.ProcessEnv {
  return { ...process.env, ...spec.env };
}

function spawnOptions(spec: LaunchSpec, shell: boolean, stdio: "pipe" | "ignore") {
  return {
    env: spawnEnv(spec),
    cwd: spec.cwd,
    stdio: [stdio, stdio, stdio] as ["pipe", "pipe", "pipe"] | ["ignore", "ignore", "ignore"],
    shell,
    ...treeSpawnOptions,
  };
}

/** A cold launcher download can outlive any honest initialize budget; this
 * caps the warmup phase itself so a dead npm registry can't hold connect
 * hostage forever. */
const WARMUP_TIMEOUT_MS = 180_000;
/** A warm cache resolves in about a second — the "downloading" label waits
 * this long so it's only ever shown when a download is plausibly happening,
 * never as a flash of a false claim on a cache hit. */
const DOWNLOAD_LABEL_AFTER_MS = 1_500;

/** Cache-warm invocation for ecosystem launchers: a cold `npx`/`uvx`
 * downloads the whole package before the agent can say a byte — in total
 * silence (`npx -y` prints nothing while fetching; measured 20s+ on a fast
 * network), which is indistinguishable on the wire from a hung TUI. The
 * warmup runs the download as its own labeled phase: the same launcher is
 * asked to resolve the same package but run the runtime's `--version`
 * instead of the agent, and its exit is the one reliable "cache is ready"
 * signal. The real spawn then starts warm, so the initialize timeout
 * measures the agent — not npm's network. Registry arg shapes only
 * (resolveDistribution builds them); anything unrecognized gets no warmup
 * and behaves exactly as before. Exported for tests. */
export function warmupSpawn(spec: LaunchSpec): { command: string; args: string[] } | null {
  const kind = launcherKind(spec.command);
  if (kind === "npx") {
    // Registry shape only (`-y` present) — user-typed commands get no
    // warmup, a deliberate scope decision pinned by spawn-resolve tests.
    const pkg = spec.args[0] === "-y" ? npxPackageSpec(spec) : null;
    if (pkg === null) return null;
    return { command: spec.command, args: ["-y", "--package", pkg, "node", "--version"] };
  }
  if (kind === "uvx") {
    const pkg = spec.args[0];
    if (pkg === undefined || pkg.startsWith("-")) return null;
    return { command: spec.command, args: ["--from", pkg, "python", "--version"] };
  }
  return null;
}

export class AgentPool {
  private entries = new Map<string, Entry>();
  private readonly initializeTimeoutMs: number;
  private readonly runtimeResolver?: RuntimeResolver;

  constructor(
    private readonly hooks: PoolHooks,
    /** Output-channel seam (logger.ts) — argv and env values never logged. */
    private readonly log: Logger = nullLogger,
    /** `initializeTimeoutMs` applies to the initialize round-trip only:
     * cold `npx`/`uvx` package downloads happen in the labeled warmup phase
     * before the real spawn (warmupSpawn), so this budget measures the
     * agent, not the package manager's network. Tests inject a short one to
     * exercise the timeout path itself. `resolveRuntime` is the launch-phase
     * runtime seam — absent (tests, or a host without one) means specs spawn
     * exactly as given. */
    opts?: { initializeTimeoutMs?: number; resolveRuntime?: RuntimeResolver },
  ) {
    this.initializeTimeoutMs = opts?.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
    this.runtimeResolver = opts?.resolveRuntime;
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
   * `opts` backs process-policy "isolated" instances: a distinct
   * `poolKey` from `spec.agentId` so a dedicated subprocess can coexist with
   * the shared one, while `reportAs` keeps every hook call attributed to the
   * real configured agent. Declared capabilities are still recorded locally
   * (`entry.declared`, e.g. for `reopen`'s `loadSession` check) but never
   * re-broadcast via `onDeclaredCaptured` for an isolated instance — the
   * shared agent's own matrix must not reset just because a sibling process
   * connected. */
  async connect(
    spec: LaunchSpec,
    opts?: {
      poolKey?: string;
      reportAs?: string;
      isolated?: boolean;
      /** Internal: set on the one retry after a launcher-cache repair, so a
       * repair that didn't actually fix things can never loop. */
      repairAttempted?: boolean;
    },
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

    // Runtime phase, ahead of everything that spawns: the resolver hands
    // back the spec reality can run — unchanged when the system runtime
    // passes its gate, PATH-prepended when a managed runtime backs it. The
    // resolved spec replaces the connect-time snapshot and feeds warmup and
    // the real spawn alike: both MUST see the same env or the warmup would
    // warm a different package cache than the launch reads.
    if (this.runtimeResolver !== undefined) {
      try {
        spec = await this.runtimeResolver(spec, (label) =>
          this.setStatus(entry, "reconnecting", label),
        );
        entry.spec = spec;
        this.clearPhaseLabel(entry);
      } catch (err) {
        const detail = `runtime unavailable — ${(err as Error).message}`;
        this.markDead(entry, detail);
        throw new Error(detail);
      }
    }

    // Ecosystem launchers get their package cache warmed as its own phase —
    // the "run it once manually" advice, done by patchbay itself, with the
    // honest "downloading" label while it's genuinely fetching.
    const warm = warmupSpawn(spec);
    if (warm !== null) await this.warmLauncherCache(entry, warm, spec);

    this.log.info(
      `${poolKey}: spawning ${spec.command} (${spec.args.length} args${isolated ? ", isolated" : ""})`,
    );
    const launch = resolveSpawn(spec.command, spec.args, spawnEnv(spec));
    if (launch.error !== undefined) {
      this.markDead(entry, launch.error);
      throw new Error(launch.error);
    }
    const child = spawn(launch.command, launch.args, spawnOptions(spec, launch.shell, "pipe"));
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
    // name rows, and a future handler (elicitation) marks for free.
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
        // Tolerance law: one update's handling failure drops that update
        // (logged), never the stream — a throw here would bubble into the
        // SDK's dispatch and read as the whole turn dying. Frames the SDK's
        // own schema layer rejects never reach this point; they drop
        // per message upstream, and the raw line is in the wire log when
        // the tap is on.
        try {
          this.markProven(reportAs, {
            via: "sessionUpdate",
            updateKind: ctx.params.update.sessionUpdate,
          });
          this.hooks.onSessionUpdate(reportAs, ctx.params);
        } catch (err) {
          this.log.info(
            `${reportAs}: session/update (${ctx.params.update.sessionUpdate}) handling failed — update dropped: ${(err as Error).message}`,
          );
        }
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
        // TTY it doesn't have — name that instead of a bare timeout.
        // Reads as "initialize failed: timed out — …" through markDead.
        "timed out — the CLI may need interactive first-run setup; run it once manually",
      );
    } catch (err) {
      // Crash with the reason, never a silent "stopped": the stopping flag
      // used to be set here first, routing markDead to "stopped" and
      // swallowing the detail — the exact silent failure crash reporting exists to
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
      // Launcher-cache corruption chokepoint (launcher-health.ts): an npx
      // launch dying because its bin doesn't exist means a poisoned _npx
      // entry — npx treats "cache dir exists" as installed and never
      // self-heals. Purge the attributable entries and retry exactly once;
      // nothing purged (or any other death shape) rethrows untouched.
      // The stream's close rejects initialize *before* the child's 'exit'
      // event lands (observed live: exitCode still null here), so wait
      // briefly for the real code — the timeout path's SIGTERM above makes
      // an exit imminent either way.
      if (
        opts?.repairAttempted !== true &&
        isMissingBinSignature(await exitCodeWithin(child, 2_500), entry.stderrTail) &&
        (await this.repairLauncherCache(spec))
      ) {
        this.log.info(`${poolKey}: launcher cache repaired — retrying connect`);
        return this.connect(spec, { ...opts, repairAttempted: true });
      }
      throw err;
    }

    // The spec's initialization SHOULD: an agent that answers with a protocol
    // version we can't speak gets a named refusal — never undefined behavior
    // on a half-understood wire. Patchbay speaks exactly v{PROTOCOL_VERSION}.
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
      const reason =
        `agent negotiated unsupported ACP protocol v${init.protocolVersion} — ` +
        `patchbay speaks v${acp.PROTOCOL_VERSION}`;
      this.markDead(entry, reason);
      if (child.pid !== undefined) {
        const pid = child.pid;
        killTree(pid, "SIGTERM");
        setTimeout(() => killTree(pid, "SIGKILL"), 2_000).unref();
      }
      throw new Error(reason);
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
   * ladder: protocol close, stdin EOF (a well-behaved agent
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

  /** One-action recovery. Fresh connect ⇒ declared re-captured, used resets.
   * `spec`, when given, replaces the entry's connect-time snapshot — the
   * caller read current config and secrets; a restart is a spawn and must
   * not resurrect stale command/args/env. */
  async restart(poolKey: string, spec?: LaunchSpec): Promise<DeclaredCapabilities> {
    const entry = this.entries.get(poolKey);
    if (!entry) throw new Error(`unknown agent ${poolKey}`);
    const { reportAs, isolated } = entry;
    await this.stop(poolKey);
    entry.stopping = false;
    return this.connect(spec ?? entry.spec, { poolKey, reportAs, isolated });
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

  /** Stable `logout` — callers gate on the declared `auth.logout`
   * capability (spec: "Clients MUST NOT call it" when undeclared); pool.ts
   * itself just makes the round trip. */
  async logout(poolKey: string): Promise<void> {
    const entry = this.running(poolKey);
    await this.request(entry, acp.methods.agent.logout, {});
  }

  /** Also used for the automatic, ephemeral fork-verification round-trip
   * and for real user-triggered branching — `session/fork` is
   * addressed to the connection holding the parent's context (no
   * cross-process handoff exists), so a branch always
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

  /** The agent's own session history (`session/list`), cwd-filtered and
   * paginated by the caller. Only meaningful when declared.sessionList is
   * true — callers check first. A free read: no LLM turn, no session
   * mutation, so it doubles as the capability's own connectivity proof. */
  async listSessions(
    poolKey: string,
    params: acp.ListSessionsRequest = {},
  ): Promise<acp.ListSessionsResponse> {
    const entry = this.running(poolKey);
    return this.request(entry, acp.methods.agent.session.list, params);
  }

  /** Deletes a session from the agent's own history (`session/delete`).
   * Spec: idempotent — deleting an unknown/already-deleted session SHOULD
   * succeed silently. Only meaningful when declared.sessionDelete is true. */
  async deleteSession(poolKey: string, sessionId: string): Promise<void> {
    const entry = this.running(poolKey);
    await this.request(entry, acp.methods.agent.session.delete, { sessionId });
    entry.sessions.delete(sessionId);
    this.log.debug(`${poolKey}: session/delete ${sessionId}`);
  }

  /** Frees a session's agent-side resources (`session/close`): cancels any
   * in-flight work and detaches — history stays intact (`delete` is the
   * destructive sibling). Only meaningful when declared.sessionClose. */
  async closeSession(poolKey: string, sessionId: string): Promise<void> {
    const entry = this.running(poolKey);
    await this.request(entry, acp.methods.agent.session.close, { sessionId });
    entry.sessions.delete(sessionId);
    this.log.debug(`${poolKey}: session/close ${sessionId}`);
  }

  /** Re-attaches to a session *without* replay (`session/resume`): the agent
   * restores its own context and returns immediately — real memory, no
   * visible history. The attach ladder's last rung; load is preferred
   * wherever declared (what the user sees and
   * what the agent remembers must match). */
  async resumeSession(
    poolKey: string,
    sessionId: string,
    cwd: string,
    mcpServers: acp.McpServer[] = [],
    additionalDirectories: string[] = [],
  ): Promise<acp.ResumeSessionResponse> {
    const entry = this.running(poolKey);
    const response = await this.request(entry, acp.methods.agent.session.resume, {
      sessionId,
      cwd,
      mcpServers,
      additionalDirectories,
    });
    entry.sessions.add(sessionId);
    this.log.debug(`${poolKey}: session/resume ${sessionId}`);
    return response;
  }

  /** Sets a session's operational mode. Display must come only from the
   * agent's own `current_mode_update` notification, never this call's
   * response (bridges have reported success for rejected changes), so the
   * response is discarded. */
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

  /** The one untracked escape hatch for wire-extension modules:
   * sends an extension-owned method via the SDK's generic string-method
   * overload, deliberately outside the capability-tracked `request()` —
   * extension methods bear on no matrix row, and pool.ts never learns
   * their names (they arrive from orchestrator/extensions/ modules). */
  async unstableRequest(poolKey: string, method: string, params: unknown): Promise<unknown> {
    const entry = this.running(poolKey);
    return entry.connection!.agent.request<unknown>(method, params);
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
   * freed (see SessionManager.close). */
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
    const fact: WireFact = {
      via: "agentRequest",
      method,
      params,
      priorSessionCount,
      declared: entry.declared,
    };
    try {
      const result = await entry.connection!.agent.request(method, params);
      // The response trust boundary (response-guards.ts): validated and
      // degraded before "used" is marked or any caller reads it. A guard
      // throw is a structurally unusable response — it rides the same catch
      // as any RPC failure, so the rows go suspect, not used.
      const guarded = guardResponse(method, result, (m) => this.log.info(`${entry.reportAs}: ${m}`));
      this.markProven(entry.reportAs, fact);
      return guarded;
    } catch (err) {
      if (err instanceof acp.RequestError && err.code === -32000) {
        this.hooks.onAuthRequired?.(entry.reportAs, err.message.trim() === "" ? null : err.message);
      } else {
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

  /** Runs the warmup invocation to completion — best-effort by contract: a
   * failed or capped warmup never fails the connect (the real spawn tells
   * the real story with its own error surface); it only means the download
   * time counts against initialize again, exactly the pre-warmup behavior.
   * The status detail flips to "downloading…" only once the warmup outlives
   * a warm-cache resolution, and clears the moment the phase ends. */
  private warmLauncherCache(
    entry: Entry,
    warm: { command: string; args: string[] },
    spec: LaunchSpec,
  ): Promise<void> {
    const launch = resolveSpawn(warm.command, warm.args, spawnEnv(spec));
    if (launch.error !== undefined) return Promise.resolve(); // the real spawn will refuse and say why
    this.log.info(`${entry.poolKey}: warming launcher cache (${warm.command} ${warm.args.join(" ")})`);
    return new Promise<void>((resolve) => {
      const child = spawn(launch.command, launch.args, spawnOptions(spec, launch.shell, "ignore"));
      const label = setTimeout(
        () => this.setStatus(entry, "reconnecting", "downloading the agent package…"),
        DOWNLOAD_LABEL_AFTER_MS,
      );
      let capped = false;
      const cap = setTimeout(() => {
        capped = true;
        if (child.pid !== undefined) killTree(child.pid, "SIGKILL");
      }, WARMUP_TIMEOUT_MS);
      const settle = (outcome: string) => {
        clearTimeout(label);
        clearTimeout(cap);
        this.clearPhaseLabel(entry);
        this.log.debug(`${entry.poolKey}: launcher warmup ${outcome}`);
        resolve();
      };
      child.on("error", (err) => settle(`spawn failed — ${err.message}`));
      child.on("exit", (code, sig) => {
        // The cap's SIGKILL mid-install is itself the cache-poison mechanism
        // (npm doesn't roll back) — clean up the entry we just interrupted,
        // before the real spawn runs, so it never inherits a half-written
        // cache that npx would forever treat as installed.
        if (capped) {
          void this.repairLauncherCache(spec).then(() =>
            settle(`capped at ${WARMUP_TIMEOUT_MS}ms — interrupted cache entry purged`),
          );
          return;
        }
        settle(code === 0 ? "done" : `ended (code=${code}, sig=${sig})`);
      });
    });
  }

  /** Purges the npx cache entries attributable to this spec's package
   * (launcher-health.ts). True only when something was actually removed —
   * the connect retry gates on that, so a cache that wasn't the problem
   * never triggers a pointless second attempt. Non-npx specs are a no-op:
   * uvx earns a repair when a corruption signature is observed, not before. */
  private async repairLauncherCache(spec: LaunchSpec): Promise<boolean> {
    const pkg = npxPackageName(spec);
    if (pkg === null) return false;
    try {
      const npxRoot = await npmNpxRoot(spawnEnv(spec));
      if (npxRoot === null) return false;
      return (await purgeNpxEntries(npxRoot, pkg, this.log)).length > 0;
    } catch (err) {
      this.log.debug(`launcher cache repair failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Clears a transient phase label (runtime download, launcher warmup)
   * back to bare "reconnecting" — one spelling for every labeled phase. */
  private clearPhaseLabel(entry: Entry): void {
    if (entry.detail !== undefined) this.setStatus(entry, "reconnecting");
  }

  private setStatus(entry: Entry, status: AgentStatus, detail?: string): void {
    entry.status = status;
    entry.detail = detail;
    // Crash carries the process's own last words; every other status
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
