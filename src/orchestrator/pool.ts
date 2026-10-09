// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// ACP client pool: patchbayAgentId → { process, declared, used, sessions[] }.
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
import { unlessAborted } from "./abort";
import { isRefusal } from "./client-replies";
import { clientCapabilitiesWire, rowsProvenBy, type WireFact } from "./capabilities";
import { LauncherFailure, prepareLauncher } from "./launcher-health";
import { agentErrorText, authRequiredReasonOf } from "./readers/agent-error";
import {
  readFileRead,
  readFileWrite,
  readTerminalCreate,
  readTerminalRef,
  type FileReadFact,
  type FileWriteFact,
  type TerminalCreateFact,
  type TerminalRefFact,
} from "./readers/client-requests";
import { readElicitationRequest, type ElicitationRequestReading } from "./readers/elicitation";
import { readInitialize, type InitializeFact } from "./readers/initialize";
import { NoteLog, type Note } from "./readers/notes";
import { readPermissionRequest, type PermissionRequestFact } from "./readers/permission";
import {
  readConfigSet,
  readNothing,
  readSessionAttached,
  readSessionList,
  readSessionOpened,
  readTurnEnd,
  type ConfigSetFact,
  type SessionAttachedFact,
  type SessionListFact,
  type SessionOpenedFact,
  type TurnEndFact,
} from "./readers/responses";
import { readSessionUpdate, type SessionUpdateFact } from "./readers/session-update";
import { resolveSpawn } from "./spawn-resolve";
import { commandOf, killTree, treeSpawnOptions } from "./process-tree";
import type { PatchbayAgentId } from "../shared/ids";

/** Launch-phase seam (runtime-resolver.ts): given the spec about to spawn,
 * returns the spec that actually spawns — the same spec when the system
 * runtime passes its gate, a PATH-prepended copy when a managed runtime
 * backs the launch. `onPhase` surfaces a download in progress as the
 * connect's status detail; `signal` is the connect's stop, ending the
 * resolver's waits on probes. A throw is the connect failure: no runtime,
 * no agent. */
export type LaunchResolver = (
  spec: LaunchSpec,
  onPhase: (label: string) => void,
  signal?: AbortSignal,
) => Promise<LaunchSpec>;

export interface LaunchSpec {
  patchbayAgentId: PatchbayAgentId;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Per-agent knob defaults, applied post-create — the folded,
   * knob-id-keyed seed (knobs.ts; category is UX-only per ACP). */
  defaults?: KnobSeed;
  /** A registry `binary` distribution: the archive that provides `command`
   * (`cmd` is the executable's path inside it). The launch phase
   * (runtime-resolver.ts resolveBinaryLaunch) resolves `command` to the
   * cached absolute path, downloading first when this version isn't cached
   * — a spec without this spawns `command` as given. `distribution`: the
   * registry entry it comes from — the cache directory it lands in, and
   * what its digest is looked up by. `sha256`: the digest pinned with this
   * version, when its registry entry published one. */
  binary?: { distribution: string; archiveUrl: string; version: string; cmd: string; sha256?: string };
}

export interface PoolHooks {
  /** The process's own last words stay readable on the entry
   * (`stderrTail`), so a failure's reason needs no Output panel. */
  onStatusChanged(patchbayAgentId: PatchbayAgentId, status: AgentStatus, detail?: string): void;
  /** A fresh connection's `initialize` answer is in — readable from `get`. */
  onDeclaredCaptured(patchbayAgentId: PatchbayAgentId): void;
  /** A `session/update`, read: what the agent said, as patchbay takes it,
   * for the session it named its own way. */
  onSessionUpdate(patchbayAgentId: PatchbayAgentId, sessionId: string, update: SessionUpdateFact): void;
  /** The permission broker replaces this; absent → reject-by-cancel.
   * `signal` aborts when the agent withdraws the request. */
  onPermissionRequest?(
    patchbayAgentId: PatchbayAgentId,
    request: PermissionRequestFact,
    signal: AbortSignal,
  ): Promise<{ optionId: string } | { cancelled: true }>;
  /** The agent asks the user for structured input; absent → cancelled,
   * which is the honest answer when no surface exists to show it.
   * `signal` aborts when the agent withdraws the request. */
  onElicitation?(
    patchbayAgentId: PatchbayAgentId,
    request: ElicitationRequestReading,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse>;
  /** The agent reports a page it sent the user to is done. */
  onElicitationComplete?(patchbayAgentId: PatchbayAgentId, elicitationId: string): void;
  /** Fired the instant a wire fact bears on a capability row: "used" when
   * the fact rode a request that succeeded (or, incoming, one patchbay
   * deliberately refused), "suspect" when it rode one that
   * failed (suspicion, not conviction — the failure may not be the row's
   * fault). Which fact bears on which row lives in one place —
   * capabilities.ts's CAPABILITY_PROOFS table — consulted at pool.ts's
   * three chokepoints (agent RPC settled, incoming client request handled,
   * session/update kind tag arrived); no call site ever names a row itself
   * (declared ≠ used). Only the outgoing
   * chokepoint can report "suspect": a client-side handler throwing is
   * patchbay's own side answering or failing, never the agent. Called
   * synchronously and never awaited so it can't block the RPC it's
   * reporting on. */
  onCapabilityEvidence?(patchbayAgentId: PatchbayAgentId, row: CapabilityRowId, evidence: "used" | "suspect"): void;
  /** Every outgoing agent RPC's auth bearing, fired however the call
   * settles: "ok" on success, "auth_required" on -32000 — or on a
   * rejection the extensions door reads as an auth failure. What either fact
   * *means* for auth state is decided nowhere in pool.ts — the receiver
   * runs it through the one authority table (auth-evidence.ts), the auth
   * sibling of the capability proof table, so "prompt the user to
   * authenticate again" (per the spec) keeps one writer and a success can
   * only clear a lock it actually contradicts. `reason` is the -32000
   * error's own message — the agent's login instruction, and the only
   * guidance on the wire when `authMethods` is empty (Auggie); null when
   * blank, absent on "ok". `startedAt` is when the call left: a success is
   * evidence about the credentials at that moment, and the table orders it
   * against the lock it would clear. Like onCapabilityEvidence:
   * synchronous, never awaited. */
  onAuthWireFact?(
    patchbayAgentId: PatchbayAgentId,
    method: string,
    settled: "ok" | "auth_required",
    startedAt: string,
    reason?: string | null,
  ): void;
  /** Wire-log tap (Audit page, opt-in): gates the tap's per-chunk work —
   * while false, chunks are dropped without even being decoded. */
  wireLogActive?(): boolean;
  /** One complete ndjson frame, already line-assembled. Redaction is the
   * receiver's job (wire-log.ts) — pool.ts hands over the raw line. */
  onWireFrame?(patchbayAgentId: PatchbayAgentId, direction: "→" | "←", line: string): void;
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
  onReadTextFile(patchbayAgentId: PatchbayAgentId, request: FileReadFact): Promise<acp.ReadTextFileResponse>;
  onWriteTextFile(patchbayAgentId: PatchbayAgentId, request: FileWriteFact): Promise<acp.WriteTextFileResponse>;
  /** `sessionCwd`: the cwd the requesting session was opened with on this
   * connection — null when this connection never opened it. */
  onCreateTerminal(
    patchbayAgentId: PatchbayAgentId,
    request: TerminalCreateFact,
    sessionCwd: string | null,
  ): Promise<acp.CreateTerminalResponse>;
  onTerminalOutput(patchbayAgentId: PatchbayAgentId, request: TerminalRefFact): Promise<acp.TerminalOutputResponse>;
  onWaitForTerminalExit(patchbayAgentId: PatchbayAgentId, request: TerminalRefFact): Promise<acp.WaitForTerminalExitResponse>;
  onKillTerminal(patchbayAgentId: PatchbayAgentId, request: TerminalRefFact): Promise<acp.KillTerminalResponse>;
  onReleaseTerminal(patchbayAgentId: PatchbayAgentId, request: TerminalRefFact): Promise<acp.ReleaseTerminalResponse>;
}

interface Entry {
  spec: LaunchSpec;
  process: ChildProcess | null;
  connection: acp.ClientConnection | null;
  declared: DeclaredCapabilities | null;
  initialize: InitializeFact | null;
  /** When `initialize` answered — the start of what this connection
   * declared. */
  initializedAt: string | null;
  status: AgentStatus;
  detail?: string;
  /** The sessions this connection opened, each with the cwd it was opened
   * with — what the agent was told is its working directory there. Set
   * once the open succeeds: a new or forked session has no id before its
   * response, and a failed load or resume opened nothing. So a request an
   * agent sends from inside its own open finds no session here. */
  sessions: Map<string, string>;
  stopping: boolean;
  /** The process's stop, once one was asked — every later request waits
   * for the same end. */
  stopped: Promise<void> | null;
  stderrTail: string[];
  /** The readers' notes for this connection — each said once. */
  notes: NoteLog;
}

export interface PooledAgentView {
  spec: LaunchSpec;
  status: AgentStatus;
  detail?: string;
  declared: DeclaredCapabilities | null;
  /** The connection's `initialize` answer, read — its version, protocol
   * version and how each log-in method runs — and when it came. Kept past a
   * stop, like `declared`. */
  initialize: InitializeFact | null;
  initializedAt: string | null;
  sessions: readonly string[];
  stderrTail: readonly string[];
}

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

function timeOfDay(): string {
  return new Date().toTimeString().slice(0, 5);
}

/** The one env merge for anything launched in an agent's environment — the
 * agent itself and its launcher package's install. One spelling on purpose,
 * beyond DRY: both MUST see the same env, or the install could fill a
 * different package cache than the real launch reads (npm/uv honor
 * cache-location env vars). */
function spawnEnv(spec: LaunchSpec): NodeJS.ProcessEnv {
  return { ...process.env, ...spec.env };
}

/** shell comes from resolveSpawn (Windows .cmd shims only — stop() still
 * reaches the whole tree there: killTree is taskkill /T, wrapper included);
 * treeSpawnOptions makes the child a process-group leader on POSIX
 * (process-tree.ts), what lets stop() reach grandchildren. */
function spawnOptions(spec: LaunchSpec, shell: boolean) {
  return {
    env: spawnEnv(spec),
    cwd: spec.cwd,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    shell,
    ...treeSpawnOptions,
  };
}

/** A launch that failed — its process has nothing to wind down, so its
 * whole tree (npx → node → …) goes at once. */
function killFailedLaunch(child: ChildProcess): void {
  if (child.pid !== undefined) killTree(child.pid, "SIGKILL");
}

export class AgentPool {
  private entries = new Map<PatchbayAgentId, Entry>();
  private readonly launchResolver?: LaunchResolver;

  constructor(
    private readonly hooks: PoolHooks,
    /** Output-channel seam (logger.ts) — argv and env values never logged. */
    private readonly log: Logger = nullLogger,
    /** `resolveLaunch` is the launch-phase prerequisite seam (the agent's
     * own binary, the launcher's runtime) — absent (tests, or a host without
     * one) means specs spawn exactly as given. */
    opts?: { resolveLaunch?: LaunchResolver },
  ) {
    this.launchResolver = opts?.resolveLaunch;
  }

  get(patchbayAgentId: PatchbayAgentId): PooledAgentView | undefined {
    const e = this.entries.get(patchbayAgentId);
    if (!e) return undefined;
    return {
      spec: e.spec,
      status: e.status,
      detail: e.detail,
      declared: e.declared,
      initialize: e.initialize,
      initializedAt: e.initializedAt,
      sessions: [...e.sessions.keys()],
      stderrTail: [...e.stderrTail],
    };
  }

  list(): PooledAgentView[] {
    return [...this.entries.keys()].map((patchbayAgentId) => this.get(patchbayAgentId)!);
  }

  /** Spawn + initialize — the agent's one process in this window, carrying
   * every session opened with it. Declared table is captured fresh on every
   * connect. `signal` stops the launch before anything spawns — the launch
   * phase and the warmup — and the entry reads stopped; once the process
   * exists, a stop reaches the process itself. */
  async connect(spec: LaunchSpec, opts?: { signal?: AbortSignal }): Promise<DeclaredCapabilities> {
    const patchbayAgentId = spec.patchbayAgentId;
    const signal = opts?.signal;
    signal?.throwIfAborted();
    const existing = this.entries.get(patchbayAgentId);
    if (existing && (existing.status === "running" || existing.status === "reconnecting")) {
      throw new Error(`agent ${patchbayAgentId} is already connected`);
    }

    const entry: Entry = {
      spec,
      process: null,
      connection: null,
      declared: null,
      initialize: null,
      initializedAt: null,
      status: "reconnecting",
      sessions: new Map(),
      stopping: false,
      stopped: null,
      stderrTail: [],
      notes: new NoteLog(this.log),
    };
    this.entries.set(patchbayAgentId, entry);
    this.setStatus(entry, "reconnecting");

    // Launch phase, ahead of everything that spawns: the resolver hands
    // back the spec reality can run — the agent's own binary resolved to
    // its cached path, and unchanged when the system runtime passes its
    // gate, PATH-prepended when a managed runtime backs it. Downloads
    // happen here, labeled on this entry's status. The resolved spec
    // replaces the connect-time snapshot and feeds warmup and the real
    // spawn alike: both MUST see the same env or the warmup would warm a
    // different package cache than the launch reads. A stop stops the
    // waiting, not the resolver: a download it started is the cache's,
    // which other launches may share, and lands there for the next one.
    if (this.launchResolver !== undefined) {
      try {
        spec = await unlessAborted(
          this.launchResolver(
            spec,
            (label) => {
              if (!signal?.aborted) this.setStatus(entry, "reconnecting", label);
            },
            signal,
          ),
          signal,
        );
        entry.spec = spec;
        this.clearPhaseLabel(entry);
      } catch (err) {
        if (signal?.aborted) throw this.stoppedBeforeSpawn(entry, signal);
        const detail = `launch prerequisite unavailable — ${(err as Error).message}`;
        this.markDead(entry, detail);
        throw new Error(detail);
      }
    }

    // A launcher package is made ready as its own phase (launcher-health.ts):
    // an npx entry that never finished or came up short healed, then the
    // package installed to its exit and tried again while it doesn't
    // complete — the "run it once manually" advice, done by patchbay itself,
    // with the honest "downloading" label while it's genuinely fetching. The
    // last failed try is the connect failure, in the launcher's own words or
    // naming what npm left out.
    try {
      await prepareLauncher(spec, spawnEnv(spec), {
        signal,
        log: this.log,
        who: patchbayAgentId,
        onPhase: (label) => {
          if (!signal?.aborted) this.setStatus(entry, "reconnecting", label);
        },
      });
      this.clearPhaseLabel(entry);
    } catch (err) {
      if (signal?.aborted) throw this.stoppedBeforeSpawn(entry, signal);
      if (err instanceof LauncherFailure) {
        entry.stderrTail.push(...err.output.slice(-STDERR_TAIL_LINES));
        this.markDead(entry, err.detail);
        throw err;
      }
      const detail = `launcher package unavailable — ${(err as Error).message}`;
      this.markDead(entry, detail);
      throw new Error(detail);
    }
    // The last moment the signal reaches the launch: from the spawn on, a
    // stop reaches the process.
    if (signal?.aborted) throw this.stoppedBeforeSpawn(entry, signal);

    this.log.info(`${patchbayAgentId}: spawning ${spec.command} (${spec.args.length} args)`);
    const launch = resolveSpawn(spec.command, spec.args, spawnEnv(spec));
    if (launch.error !== undefined) {
      this.markDead(entry, launch.error);
      throw new Error(launch.error);
    }
    const child = spawn(launch.command, launch.args, spawnOptions(spec, launch.shell));
    entry.process = child;

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() === "") continue;
        entry.stderrTail.push(line);
        if (entry.stderrTail.length > STDERR_TAIL_LINES) entry.stderrTail.shift();
        // The agent's own stderr, otherwise invisible until a crash —
        // debug level so the Output panel's level switch controls the noise.
        this.log.debug(`${patchbayAgentId} stderr: ${line}`);
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
    this.tapLines(patchbayAgentId, "→", toAgent);
    const fromAgent = new PassThrough();
    child.stdout!.pipe(fromAgent);
    // Before its first answer, an agent writing something other than ACP is
    // most likely a CLI asking for first-run setup that a terminal would
    // answer (a TTY it doesn't have here) — the card says so while it waits.
    this.tapLines(patchbayAgentId, "←", child.stdout!, () => {
      if (entry.initialize === null && entry.status === "reconnecting") {
        this.setStatus(
          entry,
          "reconnecting",
          "the agent wrote something other than ACP before answering — if it asks for first-run setup, run it once in a terminal",
        );
      }
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(toAgent),
      Readable.toWeb(fromAgent) as ReadableStream<Uint8Array>,
    );

    // Chokepoint: every incoming request registers through `proven`, so a
    // handler answering marks whatever row the proof table ties to its
    // method (capabilities.ts CAPABILITY_PROOFS) — registration sites never
    // name rows, and a future handler (elicitation) marks for free. A
    // refusal is an answer too: a rejected write is the gate working, a
    // missing file is fs reporting truthfully — the agent routed the call
    // through patchbay either way. Only a fault proves nothing.
    const proven = <M extends acp.ClientRequestMethod>(
      method: M,
      handler: acp.ClientRequestHandlersByMethod[M],
    ): [M, acp.ClientRequestHandlersByMethod[M]] => {
      const prove = () => this.markProven(patchbayAgentId, { via: "clientRequest", method });
      return [
        method,
        (async (ctx: never) => {
          try {
            const result = await (handler as (ctx: never) => Promise<unknown>)(ctx);
            prove();
            return result;
          } catch (err) {
            if (isRefusal(err)) prove();
            throw err;
          }
        }) as acp.ClientRequestHandlersByMethod[M],
      ];
    };
    const connection = acp
      .client({ name: "acp-patchbay" })
      .onRequest(
        ...proven(acp.methods.client.session.requestPermission, async (ctx): Promise<acp.RequestPermissionResponse> => {
          const answer = (await this.hooks.onPermissionRequest?.(patchbayAgentId, readPermissionRequest(ctx.params), ctx.signal)) ?? {
            cancelled: true,
          };
          // A request the agent took back is owed the request-cancelled
          // error, not an answer.
          if (ctx.signal.aborted) throw new DOMException("the agent withdrew the request", "AbortError");
          return "cancelled" in answer
            ? { outcome: { outcome: "cancelled" } }
            : { outcome: { outcome: "selected", optionId: answer.optionId } };
        }),
      )
      .onRequest(
        ...proven(acp.methods.client.elicitation.create, (ctx) => {
          const handler = this.hooks.onElicitation;
          if (handler) return handler(patchbayAgentId, readElicitationRequest(ctx.params), ctx.signal);
          return Promise.resolve<acp.CreateElicitationResponse>({ action: "cancel" });
        }),
      )
      .onNotification(acp.methods.client.elicitation.complete, (ctx) => {
        this.hooks.onElicitationComplete?.(patchbayAgentId, ctx.params.elicitationId);
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        // Chokepoint: the kind tag is the wire fact (e.g. usage_update has
        // no initialize-time claim — its arrival is the only signal), so it
        // goes through the table before sessions-store decodes the payload.
        // Tolerance law: one update's handling failure drops that update
        // (logged), never the stream — a throw here would bubble into the
        // SDK's dispatch and read as the whole turn dying. Frames the SDK's
        // own schema layer rejects never reach this point; they drop
        // per message upstream, and the raw line is in the wire log when
        // the tap is on.
        try {
          this.markProven(patchbayAgentId, { via: "sessionUpdate", updateKind: ctx.params.update.sessionUpdate });
          this.hooks.onSessionUpdate(
            patchbayAgentId,
            ctx.params.sessionId,
            readSessionUpdate(ctx.params.update, entry.notes.at(patchbayAgentId, "session/update")),
          );
        } catch (err) {
          this.log.info(
            `${patchbayAgentId}: session/update (${ctx.params.update.sessionUpdate}) handling failed — update dropped: ${(err as Error).message}`,
          );
        }
      })
      .onRequest(
        ...proven(acp.methods.client.fs.readTextFile, (ctx) =>
          this.hooks.onReadTextFile(patchbayAgentId, readFileRead(ctx.params)),
        ),
      )
      .onRequest(
        ...proven(acp.methods.client.fs.writeTextFile, (ctx) =>
          this.hooks.onWriteTextFile(patchbayAgentId, readFileWrite(ctx.params)),
        ),
      )
      .onRequest(
        ...proven(acp.methods.client.terminal.create, (ctx) =>
          this.hooks.onCreateTerminal(patchbayAgentId, readTerminalCreate(ctx.params), entry.sessions.get(ctx.params.sessionId) ?? null),
        ),
      )
      .onRequest(
        ...proven(acp.methods.client.terminal.output, (ctx) =>
          this.hooks.onTerminalOutput(patchbayAgentId, readTerminalRef(ctx.params)),
        ),
      )
      .onRequest(
        ...proven(acp.methods.client.terminal.waitForExit, (ctx) =>
          this.hooks.onWaitForTerminalExit(patchbayAgentId, readTerminalRef(ctx.params)),
        ),
      )
      .onRequest(
        ...proven(acp.methods.client.terminal.kill, (ctx) =>
          this.hooks.onKillTerminal(patchbayAgentId, readTerminalRef(ctx.params)),
        ),
      )
      .onRequest(
        ...proven(acp.methods.client.terminal.release, (ctx) =>
          this.hooks.onReleaseTerminal(patchbayAgentId, readTerminalRef(ctx.params)),
        ),
      )
      .connect(stream);
    entry.connection = connection;

    let init: InitializeFact;
    try {
      // Waited on until the agent answers or its process ends (the stream's
      // close rejects it) — however long its start takes. An agent that
      // stays alive and silent is stopped by the user; one that writes
      // something other than ACP meanwhile says so on its card.
      init = await this.request(
        entry,
        acp.methods.agent.initialize,
        {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: { name: "acp-patchbay", version: "0.0.1" },
          clientCapabilities: clientCapabilitiesWire(),
        },
        readInitialize,
      );
    } catch (err) {
      // Crash with the reason, never a silent "stopped": the stopping flag
      // used to be set here first, routing markDead to "stopped" and
      // swallowing the detail — the exact silent failure crash reporting exists to
      // kill. markDead runs before the kill so the 'exit' handler can't
      // relabel it "exited N" either.
      this.markDead(entry, `initialize failed: ${agentErrorText(err)}`);
      killFailedLaunch(child);
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
      killFailedLaunch(child);
      throw new Error(reason);
    }

    entry.initialize = init;
    entry.initializedAt = new Date().toISOString();
    entry.declared = init.declared;
    this.log.info(
      `${patchbayAgentId}: initialized — ${init.agentInfo.name ?? "unnamed"}` +
        `${init.agentInfo.version !== undefined ? ` v${init.agentInfo.version}` : ""}` +
        `, protocol ${init.protocolVersion}`,
    );
    this.hooks.onDeclaredCaptured(patchbayAgentId);
    this.setStatus(entry, "running");
    return entry.declared;
  }

  /** Intentional stop — reads as "stopped", never "crashed". The graceful
   * ladder: protocol close, stdin EOF (a well-behaved agent
   * exits on its own — `connection.close()` never ends the pipe), grace,
   * SIGTERM the tree, grace, SIGKILL the tree — then a final group sweep,
   * because a leader that exited cleanly can still leave grandchildren
   * behind. A process stops once: asked again while it goes down, or after,
   * the request gets that same stop. */
  stop(patchbayAgentId: PatchbayAgentId, budget: StopBudget = INTERACTIVE_STOP): Promise<void> {
    const entry = this.entries.get(patchbayAgentId);
    // Pre-spawn (runtime resolve / warmup) there is no process to stop, and
    // the entry is not this call's to write: the in-flight connect() owns
    // it — flipped to "stopped" from here, a second connect could install a
    // fresh entry while the first spawns onto the orphaned one (two live
    // processes, one unreachable). A launch that far is stopped through its
    // connect's signal, and marks its own entry stopped.
    if (!entry || entry.process === null) return Promise.resolve();
    entry.stopped ??= this.end(entry, entry.process, budget);
    return entry.stopped;
  }

  private async end(entry: Entry, proc: ChildProcess, budget: StopBudget): Promise<void> {
    entry.stopping = true;
    entry.connection?.close();
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

  /** A removed agent's entry goes — kept past a stop so far, for what the
   * views show of its last connection. Only once its process is down: a
   * live process is never let go of. */
  forget(patchbayAgentId: PatchbayAgentId): void {
    const status = this.entries.get(patchbayAgentId)?.status;
    if (status === "running" || status === "reconnecting") return;
    this.entries.delete(patchbayAgentId);
  }

  /** One-action recovery. Fresh connect ⇒ declared re-captured; used carries over at the same agent version.
   * `spec`, when given, replaces the entry's connect-time snapshot — the
   * caller read current config and secrets; a restart is a spawn and must
   * not resurrect stale command/args/env. `signal` is the connect's. */
  async restart(
    patchbayAgentId: PatchbayAgentId,
    opts?: { spec?: LaunchSpec; signal?: AbortSignal },
  ): Promise<DeclaredCapabilities> {
    const entry = this.entries.get(patchbayAgentId);
    if (!entry) throw new Error(`unknown agent ${patchbayAgentId}`);
    await this.stop(patchbayAgentId);
    entry.stopping = false;
    return this.connect(opts?.spec ?? entry.spec, { signal: opts?.signal });
  }

  /** `additionalDirectories` crosses the wire only when the agent advertises
   * the session capability — the spec's MUST for clients. A non-advertising
   * agent gets no field at all, never an empty list; the roots the caller
   * composed simply do not travel, and the capability row says so. */
  private dirsIfAdvertised(
    declared: DeclaredCapabilities | null,
    additionalDirectories: string[],
  ): { additionalDirectories?: string[] } {
    return declared?.sessionAdditionalDirectories === true ? { additionalDirectories } : {};
  }

  async newSession(
    patchbayAgentId: PatchbayAgentId,
    cwd: string,
    mcpServers: acp.McpServer[] = [],
    additionalDirectories: string[] = [],
  ): Promise<SessionOpenedFact> {
    const entry = this.running(patchbayAgentId);
    const response = await this.request(
      entry,
      acp.methods.agent.session.new,
      { cwd, mcpServers, ...this.dirsIfAdvertised(entry.declared, additionalDirectories) },
      readSessionOpened("session/new"),
    );
    entry.sessions.set(response.sessionId, cwd);
    this.log.debug(`${patchbayAgentId}: session/new -> ${response.sessionId}`);
    return response;
  }

  /** Stable ACP call (`authenticate`, not the unstable terminal-auth
   * extension): the agent handles whatever interactive flow its method
   * needs (browser, device code, ...) — patchbay only picks the methodId
   * and awaits the round trip. Callers retry whatever hit `auth_required`
   * once this resolves. */
  async authenticate(patchbayAgentId: PatchbayAgentId, methodId: string): Promise<void> {
    const entry = this.running(patchbayAgentId);
    await this.request(entry, acp.methods.agent.authenticate, { methodId }, readNothing);
  }

  /** Stable `logout` — callers gate on the declared `auth.logout`
   * capability (spec: "Clients MUST NOT call it" when undeclared); pool.ts
   * itself just makes the round trip. */
  async logout(patchbayAgentId: PatchbayAgentId): Promise<void> {
    const entry = this.running(patchbayAgentId);
    await this.request(entry, acp.methods.agent.logout, {}, readNothing);
  }

  /** Also used for the automatic, ephemeral fork-verification round-trip
   * and for real user-triggered branching — `session/fork` is
   * addressed to the connection holding the parent's context. */
  async fork(
    patchbayAgentId: PatchbayAgentId,
    sessionId: string,
    cwd: string,
    mcpServers: acp.McpServer[] = [],
    additionalDirectories: string[] = [],
  ): Promise<SessionOpenedFact> {
    const entry = this.running(patchbayAgentId);
    const response = await this.request(
      entry,
      acp.methods.agent.session.fork,
      { sessionId, cwd, mcpServers, ...this.dirsIfAdvertised(entry.declared, additionalDirectories) },
      readSessionOpened("session/fork"),
    );
    entry.sessions.set(response.sessionId, cwd);
    this.log.debug(`${patchbayAgentId}: session/fork ${sessionId} -> ${response.sessionId}`);
    return response;
  }

  async prompt(
    patchbayAgentId: PatchbayAgentId,
    sessionId: string,
    prompt: acp.ContentBlock[],
  ): Promise<TurnEndFact> {
    const entry = this.running(patchbayAgentId);
    // A cancelled prompt is auth-non-bearing: a bridge may short-circuit
    // cancellation before its backend ever touches credentials, so the
    // resolved RPC proves nothing a lock should clear on.
    return this.request(entry, acp.methods.agent.session.prompt, { sessionId, prompt }, readTurnEnd, {
      authBearing: (turn) => turn.stopReason !== "cancelled",
    });
  }

  async cancel(patchbayAgentId: PatchbayAgentId, sessionId: string): Promise<void> {
    const entry = this.running(patchbayAgentId);
    await entry.connection!.agent.notify(acp.methods.agent.session.cancel, {
      sessionId,
    });
  }

  /** Re-attaches to a session on a fresh connection; the agent replays its
   * own history as session/update notifications before this resolves. Only
   * meaningful when declared.loadSession is true — callers check first.
   * Failure is routine (suspect-exempt): the attach ladder calls this on
   * ids the agent may legally no longer hold — an unknown-session error
   * bears nothing on whether the capability works. */
  async loadSession(
    patchbayAgentId: PatchbayAgentId,
    sessionId: string,
    cwd: string,
    mcpServers: acp.McpServer[] = [],
    additionalDirectories: string[] = [],
  ): Promise<SessionAttachedFact> {
    const entry = this.running(patchbayAgentId);
    const response = await this.request(
      entry,
      acp.methods.agent.session.load,
      { sessionId, cwd, mcpServers, ...this.dirsIfAdvertised(entry.declared, additionalDirectories) },
      readSessionAttached("session/load"),
      { failureIsRoutine: true },
    );
    entry.sessions.set(sessionId, cwd);
    this.log.debug(`${patchbayAgentId}: session/load ${sessionId} replayed`);
    return response;
  }

  /** The agent's own session history (`session/list`), cwd-filtered and
   * paginated by the caller. Only meaningful when declared.sessionList is
   * true — callers check first. A free read: no LLM turn, no session
   * mutation, so it doubles as the capability's own connectivity proof. */
  async listSessions(
    patchbayAgentId: PatchbayAgentId,
    params: acp.ListSessionsRequest = {},
  ): Promise<SessionListFact> {
    const entry = this.running(patchbayAgentId);
    return this.request(entry, acp.methods.agent.session.list, params, readSessionList);
  }

  /** Deletes a session from the agent's own history (`session/delete`).
   * Spec: idempotent — deleting an unknown/already-deleted session SHOULD
   * succeed silently. Only meaningful when declared.sessionDelete is true. */
  async deleteSession(patchbayAgentId: PatchbayAgentId, sessionId: string): Promise<void> {
    const entry = this.running(patchbayAgentId);
    await this.request(entry, acp.methods.agent.session.delete, { sessionId }, readNothing);
    entry.sessions.delete(sessionId);
    this.log.debug(`${patchbayAgentId}: session/delete ${sessionId}`);
  }

  /** Frees a session's agent-side resources (`session/close`): cancels any
   * in-flight work and detaches — history stays intact (`delete` is the
   * destructive sibling). Only meaningful when declared.sessionClose. */
  async closeSession(patchbayAgentId: PatchbayAgentId, sessionId: string): Promise<void> {
    const entry = this.running(patchbayAgentId);
    await this.request(entry, acp.methods.agent.session.close, { sessionId }, readNothing);
    entry.sessions.delete(sessionId);
    this.log.debug(`${patchbayAgentId}: session/close ${sessionId}`);
  }

  /** Re-attaches to a session *without* replay (`session/resume`): the agent
   * restores its own context and returns immediately — real memory, no
   * visible history. The attach ladder's last rung; load is preferred
   * wherever declared (what the user sees and
   * what the agent remembers must match). Failure is routine
   * (suspect-exempt), same as loadSession: stale ids are the ladder's
   * normal weather. */
  async resumeSession(
    patchbayAgentId: PatchbayAgentId,
    sessionId: string,
    cwd: string,
    mcpServers: acp.McpServer[] = [],
    additionalDirectories: string[] = [],
  ): Promise<SessionAttachedFact> {
    const entry = this.running(patchbayAgentId);
    const response = await this.request(
      entry,
      acp.methods.agent.session.resume,
      { sessionId, cwd, mcpServers, ...this.dirsIfAdvertised(entry.declared, additionalDirectories) },
      readSessionAttached("session/resume"),
      { failureIsRoutine: true },
    );
    entry.sessions.set(sessionId, cwd);
    this.log.debug(`${patchbayAgentId}: session/resume ${sessionId}`);
    return response;
  }

  /** Sets a session's operational mode. Display must come only from the
   * agent's own `current_mode_update` notification, never this call's
   * response (bridges have reported success for rejected changes), so the
   * response is discarded. */
  async setSessionMode(patchbayAgentId: PatchbayAgentId, sessionId: string, modeId: string): Promise<void> {
    const entry = this.running(patchbayAgentId);
    await this.request(entry, acp.methods.agent.session.setMode, { sessionId, modeId }, readNothing);
  }

  /** Unlike `setSessionMode` (whose response carries no state), the spec
   * makes this response's `configOptions` required — "the full set of
   * configuration options and their current values" — and agents are not
   * obliged to echo a `config_option_update` notification at the client
   * that initiated the change (claude-agent-acp doesn't). The response is
   * agent-authored state, not an echo of the request, so callers consume it. */
  async setSessionConfigOption(
    patchbayAgentId: PatchbayAgentId,
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<ConfigSetFact> {
    const entry = this.running(patchbayAgentId);
    const params: acp.SetSessionConfigOptionRequest =
      typeof value === "boolean" ? { sessionId, configId, type: "boolean", value } : { sessionId, configId, value };
    return this.request(entry, acp.methods.agent.session.setConfigOption, params, readConfigSet);
  }

  /** The one untracked escape hatch for wire-extension modules:
   * sends an extension-owned method via the SDK's generic string-method
   * overload, deliberately outside the capability-tracked `request()` —
   * extension methods bear on no matrix row, and pool.ts never learns
   * their names (they arrive from orchestrator/extensions/ modules). */
  async unstableRequest(patchbayAgentId: PatchbayAgentId, method: string, params: unknown): Promise<unknown> {
    const entry = this.running(patchbayAgentId);
    const startedAt = new Date().toISOString();
    try {
      const result = await entry.connection!.agent.request<unknown>(method, params);
      this.hooks.onAuthWireFact?.(patchbayAgentId, method, "ok", startedAt);
      return result;
    } catch (err) {
      // Untracked for capabilities by design — but auth is orthogonal: an
      // extension RPC hitting auth_required is the same locked agent, and
      // swallowing it would leave the card claiming otherwise.
      const auth = authRequiredReasonOf(err);
      if (auth !== null) {
        this.hooks.onAuthWireFact?.(patchbayAgentId, method, "auth_required", startedAt, auth.reason);
      }
      throw err;
    }
  }

  /** Attaches the wire-log tap to one direction of a connection's stdio.
   * Outgoing is zero-cost while the log is off: chunks are dropped before
   * decode. Incoming is always line-assembled, for one more reader: an
   * agent writing lines that aren't protocol messages (a banner, a debug
   * print) is named once per connection in the log — never the content,
   * which may carry anything; the wire log shows every case. The SDK
   * answers each such line with a parse error and the session goes on.
   * Only the first character is tested — a line that doesn't open a JSON
   * object or array can't be a message; malformed JSON that does is left
   * to the wire log. Whenever nothing reads a direction, its partial-line
   * buffer resets, as for the log being off. `onNoise` hears that first
   * non-protocol line too. */
  private tapLines(
    patchbayAgentId: PatchbayAgentId,
    direction: "→" | "←",
    stream: NodeJS.ReadableStream,
    onNoise?: () => void,
  ): void {
    const { onWireFrame, wireLogActive } = this.hooks;
    const watchNoise = direction === "←";
    if (onWireFrame === undefined && !watchNoise) return;
    let buffer = "";
    let noted = false;
    stream.on("data", (chunk: Buffer | string) => {
      const logging = onWireFrame !== undefined && wireLogActive?.() === true;
      if (!logging && (!watchNoise || noted)) {
        buffer = "";
        return;
      }
      buffer += chunk.toString();
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line === "") continue;
        if (logging) onWireFrame(patchbayAgentId, direction, line);
        if (watchNoise && !noted && line[0] !== "{" && line[0] !== "[") {
          noted = true;
          this.log.warn(
            `${patchbayAgentId}: the agent wrote output that isn't a protocol message — ignored, the session goes on. Turn on the wire log to see it.`,
          );
          onNoise?.();
        }
      }
      // A runaway partial line (a frame far beyond any sane size) is not
      // worth holding — this is a debug tap, never the protocol path.
      if (buffer.length > 1_000_000) buffer = "";
    });
  }

  /** Local-only bookkeeping for a session patchbay is done with but did not
   * end agent-side (a throwaway, a retired shell): it stops counting as a
   * session this connection serves — the count the concurrent-sessions
   * proof reads. */
  forgetSession(patchbayAgentId: PatchbayAgentId, sessionId: string): void {
    this.entries.get(patchbayAgentId)?.sessions.delete(sessionId);
  }

  /** The deactivate path: every connection down on the tight budget, in
   * parallel — the whole sweep has to fit VS Code's ~2s shutdown window. */
  async disposeAll(budget: StopBudget = SHUTDOWN_STOP): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((patchbayAgentId) => this.stop(patchbayAgentId, budget)));
  }

  /** Chokepoint: every outgoing agent RPC goes through here, so however the
   * call settles, whatever rows the proof table ties to its method + params
   * (capabilities.ts CAPABILITY_PROOFS) get their evidence — "used" on
   * success, "suspect" on failure — and no other place in pool.ts decides
   * what a wire fact means. Two failures are exempt from suspicion:
   * auth_required (-32000) is the honest pre-login state, already surfaced
   * as its own condition, not a capability misbehaving; and a call cut off
   * by its connection's own stop failed by patchbay's hand. `priorSessionCount`
   * is captured before the await: "a second session on a connection already
   * serving one" must count the sessions as they stood when the call was
   * made. */
  private async request<M extends acp.AgentRequestMethod, T>(
    entry: Entry,
    method: M,
    params: acp.AgentRequestParamsByMethod[M],
    /** The answer's reader (readers/) — what leaves here is its fact. */
    read: (raw: unknown, note: Note) => T,
    opts?: {
      /** This call fails as part of normal operation (the attach ladder's
       * stale-id descent) — its failure bears nothing on the capability,
       * so no suspect is raised. Success still proves, auth facts still
       * flow. */
      failureIsRoutine?: boolean;
      /** Whether this answer bears on the agent's credentials — every
       * success does, unless this says otherwise. */
      authBearing?: (fact: T) => boolean;
    },
  ): Promise<T> {
    const patchbayAgentId = entry.spec.patchbayAgentId;
    const priorSessionCount = entry.sessions.size;
    const fact: WireFact = {
      via: "agentRequest",
      method,
      params,
      priorSessionCount,
      declared: entry.declared,
    };
    const startedAt = new Date().toISOString();
    try {
      const result: unknown = await entry.connection!.agent.request(method, params);
      // The response trust boundary: read before "used" is marked or any
      // caller sees it. A reader's throw is a structurally unusable answer —
      // it rides the same catch as any RPC failure, so the rows go suspect,
      // not used.
      const answer = read(result, entry.notes.at(patchbayAgentId, method));
      this.markProven(patchbayAgentId, fact);
      if (opts?.authBearing?.(answer) !== false) this.hooks.onAuthWireFact?.(patchbayAgentId, method, "ok", startedAt);
      return answer;
    } catch (err) {
      const auth = authRequiredReasonOf(err);
      if (auth !== null) {
        this.hooks.onAuthWireFact?.(patchbayAgentId, method, "auth_required", startedAt, auth.reason);
      } else if (opts?.failureIsRoutine !== true && !entry.stopping) {
        for (const row of rowsProvenBy(fact)) {
          this.hooks.onCapabilityEvidence?.(patchbayAgentId, row, "suspect");
        }
      }
      throw err;
    }
  }

  private markProven(patchbayAgentId: PatchbayAgentId, fact: WireFact): void {
    for (const row of rowsProvenBy(fact)) this.hooks.onCapabilityEvidence?.(patchbayAgentId, row, "used");
  }

  private running(patchbayAgentId: PatchbayAgentId): Entry {
    const entry = this.entries.get(patchbayAgentId);
    if (!entry || entry.status !== "running" || entry.connection === null) {
      throw new Error(`agent ${patchbayAgentId} is not running`);
    }
    return entry;
  }

  /** A launch its signal stopped before anything spawned: the entry reads
   * stopped, and the signal's reason is what the connect throws. */
  private stoppedBeforeSpawn(entry: Entry, signal: AbortSignal): unknown {
    entry.stopping = true;
    this.setStatus(entry, "stopped");
    return signal.reason;
  }

  /** Clears a transient phase label (binary or runtime download, launcher warmup)
   * back to bare "reconnecting" — one spelling for every labeled phase. */
  private clearPhaseLabel(entry: Entry): void {
    if (entry.detail !== undefined) this.setStatus(entry, "reconnecting");
  }

  private setStatus(entry: Entry, status: AgentStatus, detail?: string): void {
    entry.status = status;
    entry.detail = detail;
    this.hooks.onStatusChanged(entry.spec.patchbayAgentId, status, detail);
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
