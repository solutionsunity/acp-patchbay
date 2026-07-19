// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Bridges the ACP client pool to the Agent View's chat state. Owns the render
// cache in the sense of deciding *when* it must be rebuilt wholesale — the
// cache itself lives in AgentViewState, updated only through the shared
// reducer (render cache is disposable, replay
// always wins, never merged).
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ContentBlock,
  McpServer,
  SessionInfo,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  isToolCallOpen,
  type AgentViewEvent,
  type ChatBlock,
  type ContextChip,
  type KnobSeed,
  type PlanEntry,
  type PromptPart,
  type QueuedPrompt,
  type SessionSummary,
  type ToolCallStatus,
  type TurnUsage,
  type UserPart,
  userPartsText,
} from "../shared/protocol";
import { imageFileName, stashImage } from "./attachments";
import {
  applyConfigUpdate,
  applyModeUpdate,
  confirmedFromKnobs,
  NO_KNOBS,
  normalizeKnobs,
  routeKnobSet,
  type KnobExecuteDeps,
  type NormalizedKnobs,
} from "./knobs";
import { createProseRewriter, sessionKnobExtras, type ProseRewriter } from "./extensions";
import { planUsageOf } from "./meta";
import { computeLineDiff } from "./diff";
import { nullLogger, type Logger } from "./logger";
import type { AgentPool } from "./pool";

export interface SessionManagerHooks {
  emit(...events: AgentViewEvent[]): void;
  /** Advance canonical render state without a webview patch — the
   * session/load replay window. Absent → falls back to `emit` (tests,
   * patch-per-event). */
  emitSilent?(...events: AgentViewEvent[]): void;
  /** Closes a silent window: one wholesale webview sync from canonical
   * state — the replay lands as a single swap, never a patch flood. */
  resyncView?(): void;
  /** The local MCP server is spawned with `contextToken` as its correlation
   * id (the real ACP sessionId doesn't exist yet when mcpServers must be
   * built — session/new hasn't returned). Lets the orchestrator's IPC host
   * translate that token back to the real session once it's known. */
  mapContextToken?(token: string, sessionId: string): void;
  /** Process-policy decision for a *new top-level* session: returns the
   * poolKey to create it on — the agentId
   * itself when sharing, or a fresh isolated poolKey (having already
   * connected a dedicated subprocess for it) when isolating. Absent → always
   * share (the pre-policy default — fine for tests that don't exercise policy). */
  resolveProcessFor?(agentId: string): Promise<string>;
  /** The knob seed a session starts from on *entry* — a fresh session, or a
   * history session attached with no live combination in hand (folded,
   * knob-id-keyed — knobs.ts foldSeed). Which seed that is — the agent
   * config's defaults or the composer's per-agent combination — is the
   * orchestrator's policy (Preferences knobSource), not knowledge held here. */
  seedFor?(agentId: string): KnobSeed | undefined;
  /** Fires when the *user* sets a knob and the agent confirms it — the
   * composer-knobs record behind the last-session knobSource preference
   * (stores/composer-knobs.ts). Deliberately not wired to publishKnobs:
   * attach-time publishes carry agent-reset state, and recording those made
   * "last used" mean "last attached". */
  onKnobsConfirmed?(agentId: string, seed: KnobSeed): void;
  /** Fires when a real session attaches on an agent (new/load/resume, at
   * the one attach ceremony) — the deferred-probe trigger for latched
   * agents (capability-tracker.noteRealSessionOpened via the orchestrator;
   * extensions/first-session-mcp-latch). Probe sessions never pass through
   * here, which is exactly what makes this the honest "real session" fact. */
  onRealSessionAttached?(agentId: string): void;
  /** Canonical (AgentViewState-held) external context roots for a session —
   * read back on reopen/branch since ACP has no live-update request for
   * `additionalDirectories`; a fresh `LiveSession` needs the durable copy,
   * not a SessionManager-local one that would vanish with it. */
  contextRootsFor?(sessionId: string): readonly string[];
  /** The render cache as it currently stands (AgentViewState-held) — the
   * resume rung shows it behind the seam notice: it's the only history
   * there is (patchbay persists no transcripts). */
  currentTranscript?(sessionId: string): readonly ChatBlock[];
  /** Whether `session.delete` is declared *and used* — gates the agent-side
   * delete on close (features gate on used). */
  isDeleteUsed?(agentId: string): boolean;
  /** Whether this session is the one currently open in the view — the idle
   * reaper exempts it: the visible chat's state never changes under the
   * user, and the composer (whose draft must block a close) only exists
   * for the active session. */
  isActiveSession?(sessionId: string): boolean;
  /** The blue mark: a turn completed while the session wasn't open in the
   * view and the user hasn't looked yet — the reaper must not close under
   * an unseen result (reducer-derived `unseen` on the session summary). */
  isUnseen?(sessionId: string): boolean;
}

/** session/list pagination guard: 50 pages of history for one workspace is
 * beyond any honest agent — past it, merge what arrived but never prune. */
const MAX_LIST_PAGES = 50;

/** How long an honest close/reload waits for a cancelled turn to settle
 * before proceeding anyway (interruptTurn). */
const CANCEL_SETTLE_MS = 3000;

/** Attached-but-idle sessions release their agent-side resources after an
 * hour — the row stays listed and re-attaches on the next open/prompt. */
const DEFAULT_IDLE_CLOSE_MS = 60 * 60_000;

let blockCounter = 0;
function newBlockId(prefix: string): string {
  return `${prefix}-${++blockCounter}`;
}

/** One XML-ish element (open…close on the same tag, first close wins — the
 * harness envelopes never nest their own tag) or a self-closing one. */
const ENVELOPE_ELEMENT = /^<([a-z][a-z0-9-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>|^<([a-z][a-z0-9-]*)(?:\s[^>]*)?\/>/;

/** Agent harnesses inject machine messages into the conversation on the
 * *user* role — task notifications, system reminders, slash-command echoes
 * (observed: claude-agent-acp session/load replay). Their common shape: the
 * entire message is
 * one or more XML-ish envelope elements, nothing else — no human prompt
 * looks like that end-to-end. Returns the first tag name for a matching
 * text, null otherwise; anything unparseable renders as the ordinary user
 * message the wire claims it is (conservative: misclassifying a real prompt
 * dim is worse than showing an envelope as a bubble). */
export function harnessEnvelopeTag(text: string): string | null {
  let rest = text.trim();
  if (!rest.startsWith("<")) return null;
  let first: string | null = null;
  while (rest.length > 0) {
    const m = ENVELOPE_ELEMENT.exec(rest);
    if (m === null) return null;
    first ??= m[1] ?? m[2] ?? null;
    rest = rest.slice(m[0].length).trimStart();
  }
  return first;
}

function deriveTitle(promptText: string): string {
  const flat = promptText.trim().replace(/\s+/g, " ");
  if (flat === "") return "Untitled session";
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}

/** One session patchbay currently knows to exist — created here this
 * window, or reported by the agent's own `session/list`. In-memory only,
 * deliberately: the agent is the source of truth for sessions; this is the
 * mirror of the last read, repopulated from the wire every connect, never
 * persisted (no-session-history — patchbay stores no transcripts, no index). */
interface KnownSession {
  agentId: string;
  title: string;
  createdAt: string; // ISO — session/list rows carry only updatedAt; used for it there
  updatedAt: string; // ISO — the drawer's sort key
  /** The session's last agent-confirmed knob combination — written at every
   * publishKnobs, so it outlives the LiveSession (detach on connection
   * death, idle release, reload) and re-seeds any *involuntary* re-attach:
   * the user asked to change nothing, so the session's combination must
   * survive the agent resetting knob state on session/load. In-memory like
   * the rest of this row — after a window reload the session re-enters as a
   * deliberate open and the composer combination wins instead
   * (reseedAfterAttach). */
  knobs?: KnobSeed;
}

interface LiveSession {
  agentId: string;
  /** Which pool connection this session's requests ride — the agentId
   * itself when sharing, a synthetic instance id when process-policy
   * isolated it. */
  poolKey: string;
  /** True once auto-derived from the first prompt, or explicitly renamed —
   * either way, later auto-titling must not clobber it again. */
  titled: boolean;
  /** The at-most-one open prose run — every chunk arm continues or replaces
   * it through `runBlockFor` (the one place the continuation rule lives);
   * everything that interrupts prose (a tool call, a placeholder, a prompt
   * send, a re-attach) closes it through `sealRun` (the close-side twin).
   * `messageId` is the ACP ContentChunk id the run belongs to (null =
   * opened by an id-less chunk). `rewriter` is the wire-extension prose
   * filter the run's agent-text deltas pass through (extensions/index.ts —
   * opaque to this file); it may withhold a tail that sealRun flushes. */
  openRun: {
    channel: RunChannel;
    blockId: string;
    messageId: string | null;
    rewriter?: ProseRewriter;
  } | null;
  pendingContext: ContextChip[];
  /** Normalized knob state (knobs.ts) — carries the wire surface that
   * drives set routing; the view side only ever sees the knob list. */
  knobs: NormalizedKnobs;
  /** A prompt turn is in flight — release/reap must never close under it. */
  inFlight: boolean;
  /** Settles when the in-flight prompt resolves, any stop reason — what an
   * honest close/reload awaits after cancelling, so the turn's own end
   * (turnEnded, the tool-call sweep) lands before the session is ripped
   * out from under it. Null between turns. */
  turnSettled: Promise<void> | null;
  /** A root change landed mid-turn — re-applied (reapplyRoots) on turn end
   * instead of yanking the attachment under the in-flight prompt. */
  rootsDirty: boolean;
  /** At least one prompt has been sent on this attachment (or it came back
   * from history — load and resume both imply prior turns). This is the
   * "new session" fact: `!everPrompted` blocks the reaper (a new session
   * never auto-closes) and makes "add session" focus this one instead of
   * minting a sibling. Until it's set the agent may have persisted nothing:
   * session/load has been observed to 404 *and kill the live session* on a
   * never-prompted id (claude-agent-acp), so zero-turn root changes
   * recreate instead. */
  everPrompted: boolean;
  /** Epoch ms of the last prompt or session/update — the idle reaper's basis. */
  lastActivityAt: number;
  /** toolCallIds seen pending/in_progress and not yet resolved — the turn-end
   * sweep's worklist (tool-call analogue of broker.cancelPending). Cleared
   * per id on a terminal status, swept wholesale when the turn ends any way
   * but end_turn. */
  openToolCalls: Set<string>;
  /** Replay-window only: agent activity observed since the last turn
   * boundary. A replayed user message arriving with this set means a turn
   * just ended structurally — synthesize its TurnEndBlock (nullable timing;
   * see protocol.ts) so loaded history keeps its per-turn rollup lines.
   * Live turns never touch it: their boundary is the real turnEnded. */
  replayTurnDirty: boolean;
  /** A user knob set went out via session/set_mode and its confirmation —
   * the agent's own current_mode_update — hasn't arrived yet. That
   * notification is when the composer-knobs record fires for the modes
   * surface (set_mode's response carries no state, and bridges have
   * reported rejected changes as succeeded — the notification is the only
   * honest confirmation). The config surface records straight off the
   * set_config_option response and never sets this. */
  userModeSetPending: boolean;
}

/** The chunk families that render as prose runs — doubles as the block-id
 * prefix each family's blocks carry. */
type RunChannel = "user" | "text" | "thought";

function liveSession(agentId: string, poolKey: string, titled: boolean): LiveSession {
  return {
    agentId,
    poolKey,
    titled,
    openRun: null,
    pendingContext: [],
    knobs: NO_KNOBS,
    inFlight: false,
    turnSettled: null,
    rootsDirty: false,
    everPrompted: false,
    lastActivityAt: Date.now(),
    openToolCalls: new Set(),
    replayTurnDirty: false,
    userModeSetPending: false,
  };
}

export class SessionManager {
  private sessions = new Map<string, LiveSession>();
  /** Every session known to exist right now (see KnownSession). */
  private known = new Map<string, KnownSession>();
  /** Agent-reported diff content per tool call (ToolCallContent "diff") —
   * the texts stay here, never in webview state (they can be whole files);
   * the block carries only the openable paths, and openToolCallDiff reads
   * back through `toolCallDiff`. Cleared with the session; a replay
   * re-sends tool_call content, so it repopulates itself. */
  private toolDiffs = new Map<string, Map<string, Map<string, { oldText: string; newText: string }>>>();
  /** Per session: each agent-touched path's content before the FIRST touch
   * — the baseline for the files panel's "since first agent touch" diff.
   * Fed by both diff sources (agent-reported tool_call diffs here via
   * stashToolDiffs; the fs/write gate notes its pre-image at the
   * orchestrator chokepoint); first note wins. Same lifecycle as toolDiffs:
   * dies with the session, never persisted — after a cold load only what
   * the agent's replay re-reports comes back, by design (a loaded session
   * must not look like it remembers more than the wire told it). */
  private fileBaselines = new Map<string, Map<string, string>>();
  /** Cumulative +/- since the baseline, per session/path — the same numbers
   * the files panel's ± opens to, kept alongside the texts so the badge
   * next to the filename never has to guess. Same lifecycle as
   * fileBaselines (dies with the session). */
  private fileStats = new Map<string, Map<string, { additions: number; deletions: number }>>();
  private contextTokenCounter = 0;
  /** Prompts accepted while a turn was in flight (QueuedPrompt) — drained
   * one per turn end. Ephemeral bookkeeping like everything here: Stop and
   * close clear it, a crash loses it, said as such — never persisted. */
  private promptQueues = new Map<string, QueuedPrompt[]>();
  /** Rapid re-clicks must not stack replays — one hydration per session. */
  private hydrating = new Set<string>();
  /** Sessions inside a session/load replay window: their transcript events
   * reduce into canonical state silently; `loadSilently` closes the window
   * with one wholesale resync. */
  private replaying = new Set<string>();

  constructor(
    private readonly pool: AgentPool,
    private readonly hooks: SessionManagerHooks,
    /** cwd for (re)connecting a session — v1 has one cwd per workspace. */
    private readonly cwd: () => string,
    /** Builds the local MCP server's mcpServers entry for a fresh session,
     * given the correlation token to spawn it with. `[]` (the default) when
     * no MCP integration is wired — tests mostly don't need it. */
    private readonly mcpServersFor: (contextToken: string, agentId: string) => Promise<McpServer[]> = async () => [],
    /** Output-channel seam (logger.ts). */
    private readonly log: Logger = nullLogger,
    /** `idleCloseMs`: attached sessions idle past this are released
     * (session/close) by the reaper — null disables it entirely. A getter
     * is read fresh on every sweep (store-truth: the orchestrator hands in
     * the Preferences read, so an edit applies to the very next sweep,
     * no reconstruction). */
    opts?: { idleCloseMs?: number | null | (() => number | null) },
  ) {
    const idle = opts?.idleCloseMs === undefined ? DEFAULT_IDLE_CLOSE_MS : opts.idleCloseMs;
    this.idleCloseMs = typeof idle === "function" ? idle : () => idle;
    if (idle !== null) {
      // Static values keep their own cadence (tests run ms-scale timers);
      // a getter sweeps every minute — the setting is minute-grained.
      this.idleTimer = setInterval(
        () => void this.reapIdle(),
        typeof idle === "number" ? Math.min(60_000, idle) : 60_000,
      );
      this.idleTimer.unref?.();
    }
  }

  private readonly idleCloseMs: () => number | null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  dispose(): void {
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
  }

  isLive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Whether this session exists as far as patchbay can tell — created this
   * window, or present in the agent's own list. The last-active-session
   * restore is exactly "found or not": found activates, not-found lands on
   * the default screen, regardless of why. */
  knows(sessionId: string): boolean {
    return this.known.has(sessionId);
  }

  agentFor(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.agentId ?? this.known.get(sessionId)?.agentId;
  }

  /** The still-new (never-prompted) live session for an agent, if one
   * exists — "add session" focuses it instead of minting a sibling: a new
   * session is unclosable and unreopenable (agents 404 load/resume on a
   * zero-turn id), so stacking blank shells helps no one. */
  findNeverPrompted(agentId: string): string | undefined {
    for (const [sessionId, session] of this.sessions) {
      if (session.agentId === agentId && !session.everPrompted) return sessionId;
    }
    return undefined;
  }

  /** Sessions created today, as currently known — the Settings stat tile.
   * Wire-listed rows carry only updatedAt; for them createdAt is that stamp
   * (honest as ordering, nothing more). */
  createdTodayCount(): number {
    const today = new Date().toDateString();
    let count = 0;
    for (const entry of this.known.values()) {
      if (new Date(entry.createdAt).toDateString() === today) count++;
    }
    return count;
  }

  /** Frees an idle session's agent-side resources: `session/close` on the
   * wire, local bookkeeping dropped, the row untouched — it re-attaches on
   * the next open/prompt. Refuses when a turn is in flight, and requires
   * declared `session/load` — not load-or-resume: patchbay persists no
   * transcripts, so closing anything less than fully-replayable would
   * destroy the only history there is. That one condition is what makes
   * "no saved history" safe — do not relax it to `load || resume`. */
  async release(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.inFlight) return;
    const agent = this.pool.get(session.poolKey);
    if (agent?.status !== "running") return; // nothing attached to free
    const declared = agent.declared;
    if (declared?.sessionClose !== true) return;
    if (declared.loadSession !== true) return;
    this.sessions.delete(sessionId);
    try {
      await this.pool.closeSession(session.poolKey, sessionId);
      this.log.info(`session ${sessionId}: released (${reason})`);
    } catch (err) {
      // Failure means the agent still holds it — the next open re-attaches
      // either way; the suspect mark already landed at the chokepoint.
      this.log.info(`session ${sessionId}: release failed — ${(err as Error).message}`);
    }
    // An isolated instance whose last session was just released has nothing
    // left to host — same rule as close().
    if (session.poolKey === session.agentId) return;
    if ((this.pool.get(session.poolKey)?.sessions.length ?? 0) === 0) {
      await this.pool.stop(session.poolKey);
    }
  }

  /** The resource timer — the ONLY thing that ever closes an attached
   * session (switching chats never does). Auto-close requires ALL of:
   *
   * 1. not new — `everPrompted`: a never-prompted session never closes,
   *    period (nothing persisted agent-side; load/resume would 404);
   * 2. nothing in flight (green mark) — re-checked inside `release`;
   * 3. not unseen (blue mark) — a completed-but-unviewed result stays;
   * 4. prompt box empty — structurally: the composer only exists for the
   *    active session, which is exempt below;
   * 5. idle past `idleCloseMs` (default 60 min — Preferences
   *    idleCloseMinutes, read fresh each sweep; 0 there disables);
   * 6. agent declares `session/load` — checked inside `release`; see its
   *    header for why resume is not enough.
   *
   * The active-in-view session is always exempt: visible chat state never
   * changes under the user. */
  private async reapIdle(): Promise<void> {
    const idleCloseMs = this.idleCloseMs();
    if (idleCloseMs === null) return;
    const cutoff = Date.now() - idleCloseMs;
    for (const [sessionId, session] of [...this.sessions]) {
      if (!session.everPrompted) continue;
      if (session.lastActivityAt > cutoff) continue;
      if (this.hooks.isActiveSession?.(sessionId) ?? false) continue;
      if (this.hooks.isUnseen?.(sessionId) ?? false) continue;
      await this.release(sessionId, "idle");
    }
  }

  /** The one attach chokepoint: every wire call that binds a session to a
   * connection (`session/new`, `session/load`, `session/resume`) rides
   * through here, so the ceremony — context-token mint + IPC mapping, local
   * MCP server list, canonical roots, knob normalization — exists exactly
   * once. Callers own *policy*: which rung, LiveSession bookkeeping, what
   * the transcript shows, and where the returned knob state is published
   * (event order is theirs, not this method's). */
  private async attachSession(
    target: { via: "new" } | { via: "load" | "resume"; sessionId: string },
    poolKey: string,
    agentId: string,
    opts: { cwd?: string; roots?: readonly string[] } = {},
  ): Promise<{ sessionId: string; knobs: NormalizedKnobs }> {
    const contextToken = `ctx-${++this.contextTokenCounter}`;
    const mcpServers = await this.mcpServersFor(contextToken, agentId);
    const cwd = opts.cwd ?? this.cwd();
    // Roots: an explicit override wins (recreate paths); a known session
    // defaults to its canonical list (AgentViewState-held); a fresh
    // session has none yet.
    const roots = [
      ...(opts.roots ??
        (target.via !== "new" ? (this.hooks.contextRootsFor?.(target.sessionId) ?? []) : [])),
    ];
    if (target.via === "new") {
      const r = await this.pool.newSession(poolKey, cwd, mcpServers, roots);
      this.hooks.mapContextToken?.(contextToken, r.sessionId);
      this.hooks.onRealSessionAttached?.(agentId);
      return {
        sessionId: r.sessionId,
        knobs: normalizeKnobs(r.modes, r.configOptions, sessionKnobExtras(r), this.knobDropLog),
      };
    }
    this.hooks.mapContextToken?.(contextToken, target.sessionId);
    const r =
      target.via === "load"
        ? await this.pool.loadSession(poolKey, target.sessionId, cwd, mcpServers, roots)
        : await this.pool.resumeSession(poolKey, target.sessionId, cwd, mcpServers, roots);
    this.hooks.onRealSessionAttached?.(agentId);
    return {
      sessionId: target.sessionId,
      knobs: normalizeKnobs(r.modes, r.configOptions, sessionKnobExtras(r), this.knobDropLog),
    };
  }

  /** Sanitizer report channel (knobs.ts guards) — dropped wire entries land
   * in the Output channel, never a crash. */
  private readonly knobDropLog = (message: string): void => this.log.info(message);

  /** A `session/load` with its replay window silenced: the reset and every replayed update
   * reduce into canonical state only — the old pane content stays up (no
   * blank flash, no patch flood) until the closing resync swaps the webview
   * wholesale. The window closes on failure too: canonical was reset, and
   * the webview must not keep showing blocks canonical no longer holds. */
  private async loadSilently(sessionId: string, poolKey: string, agentId: string): Promise<NormalizedKnobs> {
    this.replaying.add(sessionId);
    try {
      this.emitterFor(sessionId)({ kind: "transcriptReset", sessionId });
      const { knobs } = await this.attachSession({ via: "load", sessionId }, poolKey, agentId);
      // A finished replay is the same quiet point as a turn end: nothing is
      // in flight, so history that stops on a still-open call is stranded —
      // without this, a replayed cancelled turn would spin forever (live
      // cancel and its later replay must render identically).
      const session = this.sessions.get(sessionId);
      if (session !== undefined) {
        this.sweepOpenToolCalls(sessionId, session);
        // end of replay = end of the trailing prose run: its rewriter tail
        // lands in canonical state before the closing resync ships it
        this.sealRun(sessionId, session);
        // The trailing turn has no next user message to flush it — the end
        // of the replay is its boundary (sweep first: same live rule, the
        // stranded calls' fate lands before the turnEnd block). Skipped when
        // a turn is genuinely in flight (mid-turn reload): that turn's real
        // turnEnded is still coming, and one honest line beats two — the
        // flag is dropped instead, never leaking past the window.
        if (session.inFlight) session.replayTurnDirty = false;
        else this.flushReplayBoundary(sessionId, session, this.emitterFor(sessionId));
      }
      return knobs;
    } finally {
      this.replaying.delete(sessionId);
      this.hooks.resyncView?.();
    }
  }

  /** Emits the replay-synthesized turn boundary (nullable timing/stop/usage
   * — see TurnEndBlock) if agent activity is pending, else no-ops. The flag
   * is only ever set inside a replay window, so this can never fire on a
   * live turn. */
  private flushReplayBoundary(
    sessionId: string,
    session: LiveSession,
    emit: (...events: AgentViewEvent[]) => void,
  ): void {
    if (!session.replayTurnDirty) return;
    session.replayTurnDirty = false;
    emit({
      kind: "turnEnded",
      sessionId,
      blockId: newBlockId("turn"),
      startedAt: null,
      at: null,
      stopReason: null,
      usage: null,
    });
  }

  /** Replay-window channel pick: inside a session's replay window events reduce silently into
   * canonical state — the closing resync delivers them wholesale; everywhere
   * else they patch the webview live. */
  private emitterFor(sessionId: string): (...events: AgentViewEvent[]) => void {
    return this.replaying.has(sessionId) && this.hooks.emitSilent !== undefined
      ? this.hooks.emitSilent.bind(this.hooks)
      : this.hooks.emit.bind(this.hooks);
  }

  async createSession(
    agentId: string,
    agentName: string,
    cwd: string,
  ): Promise<string> {
    const poolKey = (await this.hooks.resolveProcessFor?.(agentId)) ?? agentId;
    const { sessionId, knobs } = await this.attachSession({ via: "new" }, poolKey, agentId, { cwd });
    this.sessions.set(sessionId, liveSession(agentId, poolKey, false));
    const now = new Date().toISOString();
    const title = `${agentName} session`;
    this.known.set(sessionId, { agentId, title, createdAt: now, updatedAt: now });
    const summary: SessionSummary = {
      id: sessionId,
      agentId,
      title,
      live: false,
      updatedAt: now,
    };
    this.hooks.emit({ kind: "sessionCreated", session: summary });
    this.log.info(`session ${sessionId} created with ${agentId} (poolKey ${poolKey})`);
    this.publishKnobs(sessionId, knobs);
    await this.applySeedFor(agentId, sessionId);
    return sessionId;
  }

  activate(sessionId: string): void {
    this.hooks.emit({ kind: "sessionActivated", sessionId });
    void this.hydrate(sessionId).catch((err: Error) => {
      // Blank pane + working Reload button is the honest degraded state.
      this.log.info(`session ${sessionId}: hydrate on open failed — ${err.message}`);
    });
  }

  /** Opening a closed session: the one attach ladder, with open's
   * exhaustion policy — a failed rung is logged (blank pane + retry is the
   * honest degraded state), and no rung at all says so with an inline
   * notice: there is nothing in hand and nothing to fetch (patchbay
   * persists no transcripts) — said as such, never faked. Both wire paths
   * are free (no LLM turn). Open never mints a session. */
  async hydrate(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId) || this.hydrating.has(sessionId)) return;
    this.hydrating.add(sessionId);
    // The loading-page signal — live patch on purpose (never the silent
    // replay channel): it must show while the replay is still reducing.
    this.hooks.emit({ kind: "sessionHydrating", sessionId, hydrating: true });
    try {
      const agentId = this.known.get(sessionId)?.agentId;
      if (agentId === undefined) return;
      if (this.pool.get(agentId)?.status !== "running") return; // connect-on-demand re-hydrates after
      const outcome = await this.attach(sessionId, agentId);
      if (outcome.attached || outcome.reason === "failed") return;
      // No rung declared: this session cannot be reopened. Reachable only
      // after a crash/reload (the reaper never closes these).
      if ((this.hooks.currentTranscript?.(sessionId) ?? []).length > 0) return;
      this.hooks.emit({
        kind: "transcriptSeeded",
        sessionId,
        blocks: [{
          kind: "notice",
          id: newBlockId("notice"),
          text: "This agent supports neither session/load nor session/resume — this session's history lives only in the agent and can't be reopened here.",
        }],
      });
    } finally {
      this.hydrating.delete(sessionId);
      this.hooks.emit({ kind: "sessionHydrating", sessionId, hydrating: false });
    }
  }

  async close(sessionId: string): Promise<void> {
    // Closing while streaming means stop, then close — never a session/delete
    // fired under a live turn.
    await this.interruptTurn(sessionId);
    const session = this.sessions.get(sessionId);
    const agentId = session?.agentId ?? this.known.get(sessionId)?.agentId;
    this.sessions.delete(sessionId);
    this.toolDiffs.delete(sessionId);
    this.fileBaselines.delete(sessionId);
    this.fileStats.delete(sessionId);
    this.known.delete(sessionId);
    this.promptQueues.delete(sessionId); // view-side queue leaves with sessionClosed
    this.hooks.emit({ kind: "sessionClosed", sessionId });
    // Honest close: forgetting a session locally while a delete-capable
    // agent keeps it would just resurrect it on the next session/list sync.
    // Gated on used, not declared; spec makes delete idempotent, and a
    // failure only means the agent still has it — the sync stays truthful.
    if (agentId !== undefined && (this.hooks.isDeleteUsed?.(agentId) ?? false)) {
      await this.pool.deleteSession(agentId, sessionId).catch((err: Error) => {
        this.log.info(`session ${sessionId}: agent-side delete failed — ${err.message}`);
      });
    }
    if (session === undefined || session.poolKey === session.agentId) return;
    // An isolated instance's dedicated subprocess is only worth keeping
    // alive while it still hosts a session (its own, or a fork of it).
    this.pool.forgetSession(session.poolKey, sessionId);
    if ((this.pool.get(session.poolKey)?.sessions.length ?? 0) === 0) {
      await this.pool.stop(session.poolKey);
    }
  }

  /** "Disconnect & erase all data": every session's bookkeeping goes
   * at once — the processes are already down; the UI rows leave via the
   * orchestrator's sessionClosed events. */
  reset(): void {
    this.sessions.clear();
    this.known.clear();
    this.toolDiffs.clear();
    this.fileBaselines.clear();
    this.fileStats.clear();
    this.promptQueues.clear();
  }

  /** A removed agent's session rows leave the view — nothing of them is
   * stored anywhere (agent removal removes only patchbay's config; the
   * sessions live on in the agent and reappear via `session/list` on a
   * re-add). No agent-side delete: the process is already gone. */
  forgetAgentSessions(agentId: string): void {
    for (const [sessionId, entry] of [...this.known]) {
      if (entry.agentId !== agentId) continue;
      this.sessions.delete(sessionId);
      this.toolDiffs.delete(sessionId);
      this.fileBaselines.delete(sessionId);
      this.fileStats.delete(sessionId);
      this.known.delete(sessionId);
      this.promptQueues.delete(sessionId);
      this.hooks.emit({ kind: "sessionClosed", sessionId });
    }
  }

  /** Drops bookkeeping for sessions whose connection just died — a stale
   * sessionId cannot be used on a new connection until reopened. */
  invalidateAgent(agentId: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.agentId !== agentId) continue;
      this.sessions.delete(sessionId);
      this.hooks.emit({ kind: "sessionLiveChanged", sessionId, live: false });
    }
  }

  /** Same as `invalidateAgent`, scoped to one process-policy isolated
   * instance — its subprocess dying must not touch any other session
   * of the same agent living elsewhere. */
  invalidatePoolKey(poolKey: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.poolKey !== poolKey) continue;
      this.sessions.delete(sessionId);
      this.hooks.emit({ kind: "sessionLiveChanged", sessionId, live: false });
    }
  }

  /** Reads the agent's own session history (`session/list`, cwd-filtered
   * to this workspace) into the view — run on every connect of a
   * list-capable agent. The wire list is the ONLY list (patchbay persists
   * no session records): agents without the capability show just their
   * currently-open sessions — a deliberate scope decision. Pruning —
   * dropping known rows the agent no longer reports — only happens after a
   * *complete* pagination walk: a truncated read must never erase. */
  async syncAgentSessions(agentId: string): Promise<void> {
    if (this.pool.get(agentId)?.declared?.sessionList !== true) return;
    const cwd = this.cwd();
    const seen = new Set<string>();
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const response = await this.pool.listSessions(agentId, {
        cwd,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      // Rows arrive through the response trust boundary (pool's chokepoint):
      // identity-less rows are already dropped, bad sort keys degraded.
      for (const info of response.sessions) {
        // Re-filter defensively: the cwd param is a request, not a contract.
        if (info.cwd !== cwd) continue;
        seen.add(info.sessionId);
        this.noteListedSession(agentId, info);
      }
      if (response.nextCursor == null) {
        complete = true;
        break;
      }
      if (typeof response.nextCursor !== "string") {
        // A cursor that can't be sent back truncates the walk — same rule as
        // the page cap: merge what arrived, never prune on a partial read.
        // Deliberately judged here, not at the response boundary: degrading
        // the cursor to absent there would read as "complete" and license a
        // wrongful prune — pagination policy is this walk's, not the wire's.
        this.log.info(`${agentId}: session/list nextCursor is malformed — sync merged, prune skipped`);
        return;
      }
      cursor = response.nextCursor;
    }
    if (!complete) {
      this.log.info(`${agentId}: session/list still paging after ${MAX_LIST_PAGES} pages — sync merged, prune skipped`);
      return;
    }
    for (const [sessionId, entry] of [...this.known]) {
      if (entry.agentId !== agentId || seen.has(sessionId) || this.sessions.has(sessionId)) continue;
      // The wire is the truth for who exists — a session the agent no
      // longer reports (deleted externally, or a zero-turn shell it never
      // persisted) is gone; live sessions are exempt (a just-created id may
      // trail the agent's own list).
      this.known.delete(sessionId);
      this.toolDiffs.delete(sessionId);
      this.fileBaselines.delete(sessionId);
      this.fileStats.delete(sessionId);
      this.hooks.emit({ kind: "sessionClosed", sessionId });
      this.log.info(`session ${sessionId}: gone from ${agentId}'s own list — dropped`);
    }
  }

  /** One listed session into the view. Title rule: the agent's title wins
   * (patchbay-side rename is gone — ACP has no rename request; in-chat
   * agent commands like /rename round-trip through the agent's own list
   * and session_info_update). */
  private noteListedSession(agentId: string, info: SessionInfo): void {
    const existing = this.known.get(info.sessionId);
    const now = new Date().toISOString();
    if (existing === undefined) {
      // A session patchbay never saw — created externally (CLI, another
      // editor) or in a previous window. updatedAt is the only timestamp
      // the wire offers; honest as createdAt-for-ordering, nothing more.
      const title = info.title ?? "Untitled session";
      const at = info.updatedAt ?? now;
      this.known.set(info.sessionId, { agentId, title, createdAt: at, updatedAt: at });
      this.hooks.emit({
        kind: "sessionListed",
        session: { id: info.sessionId, agentId, title, live: false, updatedAt: at },
      });
      return;
    }
    const title = info.title ?? existing.title;
    const updatedAt = info.updatedAt ?? existing.updatedAt;
    this.known.set(info.sessionId, { ...existing, title, updatedAt });
    this.hooks.emit({
      kind: "sessionListed",
      session: {
        id: info.sessionId,
        agentId,
        title,
        live: this.sessions.has(info.sessionId),
        updatedAt,
      },
    });
  }

  /** One-click reload: re-attach on demand, even when the session
   * isn't currently invalidated — the same ladder as every attach
   * (load > resume), so a resume-only agent's reload works too. */
  async reload(sessionId: string): Promise<void> {
    // Reload discards the render cache and replays from the agent — a turn
    // still streaming into that cache is stopped first, so replay and live
    // stream never interleave.
    await this.interruptTurn(sessionId);
    this.sessions.delete(sessionId);
    const agentId = this.known.get(sessionId)?.agentId;
    if (agentId === undefined) return;
    await this.ensureAttached(sessionId, agentId);
  }

  /** Re-attaches a session after its connection died, via `session/load`
   * replay — the render cache is discarded and rebuilt wholesale, never
   * merged with what patchbay had. A sessionId is connection-scoped: without
   * replay there is no protocol-legal way to resume it on the new
   * connection. */
  private async reopen(sessionId: string, agentId: string): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    const declared = this.pool.get(agentId)?.declared;
    if (!declared?.loadSession) {
      throw new Error(
        `session ${sessionId} is no longer live and ${agentId} does not support session/load`,
      );
    }
    const poolKey = (await this.hooks.resolveProcessFor?.(agentId)) ?? agentId;
    // reopened sessions keep whatever title they already have
    this.sessions.set(sessionId, liveSession(agentId, poolKey, true));
    this.sessions.get(sessionId)!.everPrompted = true; // came back from history
    let knobs: NormalizedKnobs;
    try {
      knobs = await this.loadSilently(sessionId, poolKey, agentId);
    } catch (err) {
      // A failed load must not leave a phantom attachment — callers decide
      // the fallback (the next ladder rung, or an honest failure), and a lingering
      // map entry would make every later prompt hit a session that isn't there.
      this.sessions.delete(sessionId);
      throw err;
    }
    // pool.ts's loadSession already marked "session.load" used the instant
    // the RPC succeeded — this only has to update the render state.
    this.log.info(`session ${sessionId} reopened via session/load on ${agentId}`);
    this.publishKnobs(sessionId, knobs);
  }

  /** THE attach ladder — the rung order exists here and nowhere else:
   * `session/load` wherever declared (the only path where what the user
   * sees and what the agent remembers are provably the same), else
   * `session/resume` (the agent's real memory behind an honest seam
   * notice). Nothing below: patchbay never mints a session and calls it a
   * continuation, and the session id never changes out from under the
   * caller. Exhaustion is the caller's policy, so the outcome is returned,
   * not thrown: `failed` = a declared rung broke (logged here, suspect mark
   * already landed at the wire chokepoint); `no-rung` = the agent declares
   * neither. */
  private async attach(
    sessionId: string,
    agentId: string,
  ): Promise<
    | { attached: true }
    | { attached: false; reason: "failed"; error: Error }
    | { attached: false; reason: "no-rung" }
  > {
    if (this.sessions.has(sessionId)) return { attached: true };
    const declared = this.pool.get(agentId)?.declared;
    // Read before any rung publishes: the attach's own publishKnobs
    // overwrites this snapshot with the agent's reset state.
    const remembered = this.known.get(sessionId)?.knobs;
    let error: Error | undefined;
    if (declared?.loadSession) {
      try {
        await this.reopen(sessionId, agentId);
        await this.reseedAfterAttach(sessionId, agentId, remembered);
        return { attached: true };
      } catch (err) {
        // The agent may no longer hold this session — descend to resume
        // rather than erroring forever.
        error = err as Error;
        this.log.info(`session ${sessionId}: load failed, descending the ladder — ${error.message}`);
      }
    }
    if (declared?.sessionResume) {
      try {
        await this.resumeReattach(sessionId, agentId);
        await this.reseedAfterAttach(sessionId, agentId, remembered);
        return { attached: true };
      } catch (err) {
        this.sessions.delete(sessionId);
        error = err as Error;
        this.log.info(`session ${sessionId}: resume failed — ${error.message}`);
      }
    }
    if (error !== undefined) return { attached: false, reason: "failed", error };
    return { attached: false, reason: "no-rung" };
  }

  /** The prompt/reload exhaustion policy: attach or throw — a prompt with
   * no session behind it must fail loudly on the caller's error channel. */
  private async ensureAttached(sessionId: string, agentId: string): Promise<void> {
    const outcome = await this.attach(sessionId, agentId);
    if (outcome.attached) return;
    throw outcome.reason === "failed"
      ? outcome.error
      : new Error(`session ${sessionId} is not live and ${agentId} declares neither session/load nor session/resume`);
  }

  /** The resume rung: re-attaches via `session/resume` — no replay, so the
   * displayed history is whatever the in-memory render cache still holds
   * (patchbay persists no transcripts), closed with a seam notice marking
   * where it ends and the agent's unreplayed memory continues. Never merged
   * with replay — there is none. */
  private async resumeReattach(sessionId: string, agentId: string): Promise<void> {
    const poolKey = (await this.hooks.resolveProcessFor?.(agentId)) ?? agentId;
    this.sessions.set(sessionId, liveSession(agentId, poolKey, true));
    this.sessions.get(sessionId)!.everPrompted = true; // came back from history
    const { knobs } = await this.attachSession({ via: "resume", sessionId }, poolKey, agentId);
    const blocks = this.hooks.currentTranscript?.(sessionId) ?? [];
    const notice: ChatBlock = {
      kind: "notice",
      id: newBlockId("notice"),
      text:
        blocks.length > 0
          ? "This agent doesn't support replaying history (session/load) — the conversation above is patchbay's view. The session is resumed: its context is ready and continues from here."
          : "This agent doesn't support replaying history (session/load), so earlier turns can't be shown. The session is resumed: its context is ready and continues from here.",
    };
    this.hooks.emit({ kind: "transcriptSeeded", sessionId, blocks: [...blocks, notice] });
    this.log.info(`session ${sessionId} resumed (no replay) on ${agentId}`);
    this.publishKnobs(sessionId, knobs);
  }

  /** The one knob-set entry point (knobs.ts routes it to the wire). A knob
   * or value the session doesn't offer is a silent no-op — patchbay never
   * invents a knob. Display honesty per route: set_config_option's response
   * is spec-required complete state and is consumed; set_mode's response
   * carries no state and display waits for the agent's own
   * current_mode_update (bridges have returned success for rejected
   * changes). */
  async setKnob(sessionId: string, knobId: string, value: string | boolean): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const route = routeKnobSet(session.knobs, knobId, value);
    if (route === null) return;
    if (route.via === "setMode") {
      // Composer recording waits for the agent's current_mode_update — the
      // response carries no state (see userModeSetPending). Flag first: the
      // notification may land before the response resolves.
      session.userModeSetPending = true;
      try {
        await this.pool.setSessionMode(session.poolKey, sessionId, route.modeId);
      } catch (err) {
        session.userModeSetPending = false;
        throw err;
      }
      return;
    }
    if (route.via === "extension") {
      // Extension routes execute themselves: the module
      // owns the wire method and the display policy; this branch only
      // supplies the wire and publishes whatever state the executor returns
      // (null = the agent's own notification will confirm). A throw
      // propagates (the caller shows the error); a published state is what
      // the composer records and reseeds, same as a config response.
      const next = await route.extra.execute(this.knobExecuteDeps(sessionId, session), value);
      if (next !== null) {
        this.publishKnobs(sessionId, next);
        this.hooks.onKnobsConfirmed?.(session.agentId, confirmedFromKnobs(next));
      }
      return;
    }
    const response = await this.pool.setSessionConfigOption(session.poolKey, sessionId, route.configId, value);
    const next = applyConfigUpdate(response.configOptions, session.knobs, this.knobDropLog);
    this.publishKnobs(sessionId, next);
    // A user set, agent-confirmed: this — and only this — is what the
    // composer's per-agent combination records. Attach-time publishes never
    // do (they carry agent-reset state).
    this.hooks.onKnobsConfirmed?.(session.agentId, confirmedFromKnobs(next));
  }

  /** The deps an extension route's executor receives: the
   * wire — pool's untracked escape hatch bound to this session's connection
   * — and the standing knob state. Built at execute time, not route time:
   * `current` must be the state the executor advances from. */
  private knobExecuteDeps(
    sessionId: string,
    session: { poolKey: string; knobs: NormalizedKnobs },
  ): KnobExecuteDeps {
    return {
      sessionId,
      send: (method, params) => this.pool.unstableRequest(session.poolKey, method, params),
      current: session.knobs,
    };
  }

  /** The one exit for knob state: stores the normalized truth on the
   * session (set routing reads the surface from it), snapshots the
   * combination on the KnownSession row (what reseedAfterAttach restores),
   * and emits the full view replace. */
  private publishKnobs(sessionId: string, knobs: NormalizedKnobs): void {
    const session = this.sessions.get(sessionId);
    if (session) session.knobs = knobs;
    // An empty surface is not a combination — snapshotting it would erase a
    // real one with "this agent offered nothing this time".
    if (knobs.knobs.length > 0) {
      const entry = this.known.get(sessionId);
      if (entry !== undefined) entry.knobs = confirmedFromKnobs(knobs);
    }
    this.hooks.emit({ kind: "sessionKnobsSet", sessionId, knobs: knobs.knobs });
  }

  /** Entry seed: applied
   * post-create on a fresh session, and by reseedAfterAttach on a history
   * session entered with no combination in hand. */
  private async applySeedFor(agentId: string, sessionId: string): Promise<void> {
    const seed = this.hooks.seedFor?.(agentId);
    if (seed === undefined) return;
    await this.applySeed(sessionId, seed);
  }

  /** The post-attach knob policy — the two-fold rule in one place.
   * Agents reset knob state to their defaults on session/load (observed:
   * claude-agent-acp rebuilds session config), so every attach of an
   * existing session decides whose combination stands:
   *
   * - **Involuntary re-attach** (reload, connection death, idle release —
   *   anything where this window already held the session's combination,
   *   snapshotted on the KnownSession row): the session's own knobs win.
   *   The user asked to change nothing.
   * - **Deliberate entry** (opened from history — no combination in hand,
   *   including after a window reload): the entry seed wins, same as a
   *   fresh session (seedFor: agent defaults or the composer's per-agent
   *   combination, by the knobSource preference). This knowingly overrides
   *   an agent that honestly restores per-session knob state on load —
   *   entry is deliberate, the user's current combination wins.
   *
   * Both routes ride applySeed: agent-confirmed responses stay the
   * displayed truth, and entries the session no longer offers are silently
   * skipped. */
  private async reseedAfterAttach(
    sessionId: string,
    agentId: string,
    remembered: KnobSeed | undefined,
  ): Promise<void> {
    if (remembered !== undefined) await this.applySeed(sessionId, remembered);
    else await this.applySeedFor(agentId, sessionId);
  }

  /** Issues the set requests for a knob seed, each routed and guarded by
   * knobs.ts against what this session actually offers — silently skipped
   * otherwise. Rejections are swallowed: the honest displayed state comes
   * from the agent's own responses/notifications either way. */
  private async applySeed(sessionId: string, seed: KnobSeed): Promise<void> {
    for (const [knobId, value] of Object.entries(seed)) {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      const route = routeKnobSet(session.knobs, knobId, value);
      if (route === null) continue;
      if (route.via === "setMode") {
        await this.pool.setSessionMode(session.poolKey, sessionId, route.modeId).catch(() => {});
        continue;
      }
      if (route.via === "extension") {
        try {
          const next = await route.extra.execute(this.knobExecuteDeps(sessionId, session), value);
          if (next !== null) this.publishKnobs(sessionId, next);
        } catch {
          // rejected seed entry — the extension's axis stands, nothing to repair
        }
        continue;
      }
      try {
        const response = await this.pool.setSessionConfigOption(session.poolKey, sessionId, route.configId, value);
        this.publishKnobs(
          sessionId,
          applyConfigUpdate(response.configOptions, session.knobs, this.knobDropLog),
        );
      } catch {
        // rejected seed entry — the agent's state stands, nothing to repair
      }
    }
  }

  addContext(sessionId: string, chip: ContextChip): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.pendingContext.push(chip);
    this.hooks.emit({ kind: "contextChipAdded", sessionId, chip });
  }

  removeContext(sessionId: string, chipId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.pendingContext = session.pendingContext.filter((c) => c.id !== chipId);
    this.hooks.emit({ kind: "contextChipRemoved", sessionId, chipId });
  }

  /** External context roots: patchbay holds no local
   * copy — the canonical list lives in AgentViewState, read back via
   * `contextRootsFor` so this stays "append/remove, republish, re-apply."
   * ACP has no live-update request for `additionalDirectories`, but
   * `session/load` and `session/resume` both "set the complete list" — so
   * a change re-applies to the live attachment immediately (reapplyRoots);
   * only an agent declaring neither waits for the next reload/branch. */
  async addRoot(sessionId: string, path: string): Promise<void> {
    // Folder pickers hand back "/x/y/" — normalize at the one chokepoint;
    // agents receive directory paths, never path-with-separator spellings.
    const normalized = path.replace(/(?<=.)[\\/]+$/, "");
    const current = this.hooks.contextRootsFor?.(sessionId) ?? [];
    if (current.includes(normalized)) return;
    this.hooks.emit({ kind: "contextRootsChanged", sessionId, roots: [...current, normalized] });
    await this.reapplyRoots(sessionId);
  }

  async removeRoot(sessionId: string, path: string): Promise<void> {
    const current = this.hooks.contextRootsFor?.(sessionId) ?? [];
    this.hooks.emit({
      kind: "contextRootsChanged",
      sessionId,
      roots: current.filter((p) => p !== path),
    });
    await this.reapplyRoots(sessionId);
  }

  /** Pushes the canonical root list to a *live* attachment. Three cases:
   *
   * - **Never prompted, nothing shown**: recreate — `session/new` with the
   *   complete list, same row/title/knobs, old shell closed. The one
   *   universally safe scope change: the agent may have persisted nothing
   *   yet, and `session/load` on a never-prompted id has been observed to
   *   404 *and kill the live session* (claude-agent-acp 0.57). Free by
   *   construction — there is no history to carry — and it covers every
   *   agent, load/resume declared or not.
   * - **Has turns**: in place on the same connection — `session/load`
   *   where declared (replay rebuilds the render cache wholesale — the
   *   standing rule), else `session/resume` (real memory, no replay,
   *   transcript untouched); both "set the complete list". Neither
   *   declared → nothing to do; the next attach reads the canonical list
   *   anyway, and the roots chip says so for exactly that rung.
   * - **Turn in flight**: deferred to turn end (`rootsDirty`).
   *
   * Failure is logged, never thrown — but the local attachment is dropped:
   * a failed re-attach may have taken the agent-side session with it, and
   * the next prompt must re-enter the continuation ladder, not hit a
   * corpse. */
  private async reapplyRoots(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return; // not attached — next attach picks the list up
    if (session.inFlight) {
      session.rootsDirty = true;
      return;
    }
    if (!session.everPrompted && (this.hooks.currentTranscript?.(sessionId) ?? []).length === 0) {
      await this.recreateEmpty(sessionId, session);
      return;
    }
    const declared = this.pool.get(session.poolKey)?.declared;
    const via = declared?.loadSession === true ? ("load" as const) : ("resume" as const);
    if (via === "resume" && declared?.sessionResume !== true) return;
    // The re-attach resets agent-side knob state to its defaults (observed:
    // claude-agent-acp rebuilds session config on load) — but the user asked
    // to change *roots*, nothing else. Re-seed the confirmed combination
    // after, same as recreateEmpty; display stays honest either way, since
    // applySeed routes through set requests whose responses are the truth.
    const seed = confirmedFromKnobs(session.knobs);
    try {
      let knobs: NormalizedKnobs;
      if (via === "load") {
        // plain null, not sealRun: the replay rebuilds the transcript
        // wholesale and re-delivers the run's text — a flushed tail here
        // would land on a block the reset is about to erase
        session.openRun = null;
        knobs = await this.loadSilently(sessionId, session.poolKey, session.agentId);
      } else {
        ({ knobs } = await this.attachSession({ via, sessionId }, session.poolKey, session.agentId));
      }
      this.publishKnobs(sessionId, knobs);
      await this.applySeed(sessionId, seed);
      this.log.info(`session ${sessionId}: roots re-applied via session/${via}`);
    } catch (err) {
      this.sessions.delete(sessionId);
      this.log.info(
        `session ${sessionId}: root re-apply failed (${(err as Error).message}) — detached; next prompt re-enters the continuation ladder`,
      );
    }
  }

  /** The zero-turn rung of reapplyRoots: mint the session again with the
   * complete root list and retire the empty shell. Everything the user has
   * already invested carries over — title/index row, pending context chips,
   * user-steered knob values (re-seeded via applySeed, silently skipped
   * where the fresh session doesn't offer them). */
  private async recreateEmpty(oldId: string, old: LiveSession): Promise<void> {
    const roots = this.hooks.contextRootsFor?.(oldId) ?? [];
    const { sessionId, knobs } = await this.attachSession({ via: "new" }, old.poolKey, old.agentId, {
      roots,
    });
    const wasActive = this.hooks.isActiveSession?.(oldId) ?? false;
    const seed = confirmedFromKnobs(old.knobs);
    const fresh = liveSession(old.agentId, old.poolKey, old.titled);
    fresh.pendingContext = old.pendingContext;
    this.sessions.set(sessionId, fresh);
    this.sessions.delete(oldId);
    const entry = this.known.get(oldId);
    const now = new Date().toISOString();
    const title = entry?.title ?? "Untitled session";
    this.known.set(sessionId, {
      agentId: old.agentId,
      title,
      createdAt: entry?.createdAt ?? now,
      updatedAt: now,
    });
    this.known.delete(oldId);
    this.hooks.emit(
      { kind: "sessionClosed", sessionId: oldId },
      {
        kind: "sessionCreated",
        session: {
          id: sessionId,
          agentId: old.agentId,
          title,
          live: false,
          updatedAt: now,
        },
      },
      ...(roots.length > 0
        ? [{ kind: "contextRootsChanged", sessionId, roots } as const]
        : []),
      ...fresh.pendingContext.map(
        (chip) => ({ kind: "contextChipAdded", sessionId, chip }) as const,
      ),
    );
    if (wasActive) this.hooks.emit({ kind: "sessionActivated", sessionId });
    // the empty shell: freed agent-side where possible, forgotten either way
    if (this.pool.get(old.poolKey)?.declared?.sessionClose === true) {
      void this.pool.closeSession(old.poolKey, oldId).catch(() => {});
    } else {
      this.pool.forgetSession(old.poolKey, oldId);
    }
    this.publishKnobs(sessionId, knobs);
    await this.applySeed(sessionId, seed);
    this.log.info(`session ${oldId}: zero-turn — recreated as ${sessionId} to apply context roots`);
  }

  async sendPrompt(sessionId: string, text: string, parts?: readonly PromptPart[]): Promise<void> {
    // A prompt landing mid-turn queues instead of refusing (ACP is one
    // prompt per turn) — drained at turn end, cleared by Stop/close.
    if (this.sessions.get(sessionId)?.inFlight === true) {
      const queued: QueuedPrompt = {
        id: newBlockId("queued"),
        text,
        ...(parts !== undefined ? { parts } : {}),
      };
      let queue = this.promptQueues.get(sessionId);
      if (queue === undefined) {
        queue = [];
        this.promptQueues.set(sessionId, queue);
      }
      queue.push(queued);
      this.hooks.emit({ kind: "promptQueued", sessionId, prompt: queued });
      return;
    }
    const agentId = this.sessions.get(sessionId)?.agentId ?? this.known.get(sessionId)?.agentId;
    if (agentId === undefined) throw new Error(`unknown session ${sessionId}`);
    await this.ensureAttached(sessionId, agentId);
    const session = this.sessions.get(sessionId)!;
    this.sealRun(sessionId, session);
    session.inFlight = true;
    session.everPrompted = true;
    session.lastActivityAt = Date.now();
    let settleTurn!: () => void;
    const turnSettled = new Promise<void>((resolve) => (settleTurn = resolve));
    session.turnSettled = turnSettled;

    const events: AgentViewEvent[] = [];
    if (!session.titled) {
      session.titled = true;
      const title = deriveTitle(text);
      this.retitle(sessionId, title);
      events.push({ kind: "sessionRenamed", sessionId, title });
    }
    // Duration basis is send→stop, deliberately not first-chunk→stop: the
    // live ticker exists so a slow response has visible feedback instead of
    // silence, and the silence starts at send.
    const startedAt = new Date().toISOString();
    // Activity stamp — the drawer's sort key. In-memory only; across a
    // restart the agent's own session/list stamp is the truth.
    const entry = this.known.get(sessionId);
    if (entry !== undefined) this.known.set(sessionId, { ...entry, updatedAt: startedAt });
    // Attached context rides in as its own labeled blocks, ahead of the
    // user's words — distinguishable to the agent, not merged into prose
    // (explicitly add editor state to the prompt).
    const chips = session.pendingContext;
    session.pendingContext = [];
    for (const chip of chips) {
      events.push({ kind: "contextChipRemoved", sessionId, chipId: chip.id });
    }
    // The transcript's copy of the prompt, in the part vocabulary — chips
    // first, then prose, the same order the wire blocks below carry. Image
    // bytes stash to the attachments dir (fire-and-forget: the part names
    // its file up front; a failed write degrades to a label chip at render).
    const userParts: UserPart[] = chips.map((c): UserPart => {
      if (c.kind === "image") {
        const file = imageFileName(c.id, c.mimeType);
        void stashImage(file, c.content).catch((err: Error) => {
          this.log.info(`session ${sessionId}: image stash failed — ${err.message}`);
        });
        return { kind: "image", mimeType: c.mimeType, file };
      }
      if (c.kind === "attachment") {
        return { kind: "attachment", name: basename(c.path), path: c.path };
      }
      return { kind: "context", label: c.label, text: boundedText(c.content) };
    });
    if (parts !== undefined && parts.length > 0) {
      for (const p of parts) {
        if (p.kind === "text") userParts.push({ kind: "text", text: p.text });
        else
          userParts.push({
            kind: "mention",
            name: basename(p.path),
            uri: pathToFileURL(p.path).toString(),
          });
      }
    } else {
      userParts.push({ kind: "text", text });
    }
    events.push(
      { kind: "userMessageAppended", sessionId, blockId: newBlockId("user"), parts: userParts },
      { kind: "sessionLiveChanged", sessionId, live: true },
      { kind: "turnStarted", sessionId, at: startedAt },
    );
    this.hooks.emit(...events);

    // Chips ride in the best form the agent accepts — capability first,
    // fallback second, switch at this one chokepoint (the house pattern):
    // images as ImageContent where `promptCapabilities.image` is declared,
    // else bytes to a temp file as a ResourceLink; attachment chips as the
    // resource_link they already are (a real file the agent reads itself —
    // baseline, no capability to consult); text chips as embedded
    // `resource` blocks where `promptCapabilities.embeddedContext` is
    // declared (a chip IS a snapshot the user took — typed, uri-attributed,
    // the agent weighs it correctly), else the labeled-text fallback that
    // every agent MUST accept. mimeTypes come with the chip or not at all —
    // the ingress that produced the bytes was the last honest source, so
    // nothing here ever defaults one.
    const declared = this.pool.get(session.poolKey)?.declared;
    const acceptsImages = declared?.promptImage ?? false;
    const acceptsEmbedded = declared?.promptEmbeddedContext ?? false;
    const prompt: ContentBlock[] = [];
    for (const c of chips) {
      if (c.kind === "image") {
        if (acceptsImages) {
          prompt.push({ type: "image", data: c.content, mimeType: c.mimeType });
        } else {
          prompt.push(await imageAsResourceLink(c));
        }
      } else if (c.kind === "attachment") {
        prompt.push({
          type: "resource_link",
          uri: pathToFileURL(c.path).toString(),
          name: basename(c.path),
          ...(c.mimeType !== undefined ? { mimeType: c.mimeType } : {}),
        });
      } else if (acceptsEmbedded) {
        prompt.push({
          type: "resource",
          // Aggregates without a single source (diagnostics) name the
          // chip itself — the uri field is required on the wire.
          resource: { uri: c.sourceUri ?? `patchbay://context/${c.kind}/${c.id}`, text: c.content },
        });
      } else {
        prompt.push({ type: "text", text: `[${c.label}]\n${c.content}` });
      }
    }
    // Positional prompt parts (composer mentions): each inline `@file`
    // becomes a resource_link *at its place in the prose* — the baseline
    // block every agent MUST accept; the agent reads the content itself
    // through the brokered fs path. Plain prompts ride as one text block.
    if (parts !== undefined && parts.length > 0) {
      for (const part of parts) {
        if (part.kind === "text") {
          if (part.text !== "") prompt.push({ type: "text", text: part.text });
        } else {
          prompt.push({
            type: "resource_link",
            uri: pathToFileURL(part.path).toString(),
            name: basename(part.path),
          });
        }
      }
    } else {
      prompt.push({ type: "text", text });
    }
    const endTurn = (stopReason: string, usage: TurnUsage | null) => {
      // Whatever the stop reason — cancelled, error, even a claimed clean
      // end_turn — the turn is over and nothing runs on: any still-open
      // call is stranded. Sweep before the turnEnd block lands, so the
      // turn's stop reason and its calls' fate are never a render apart.
      // Current session, not the capture (same rule as the finally below):
      // a mid-turn reload replaces the object, and its replay repopulates
      // the fresh worklist — the stale one must not speak for it.
      const current = this.sessions.get(sessionId);
      if (current !== undefined) {
        this.sweepOpenToolCalls(sessionId, current);
        // turn end interrupts prose like anything else — and the run's
        // rewriter tail must land before the turnEnd block, not after
        this.sealRun(sessionId, current);
      }
      this.hooks.emit({
        kind: "turnEnded",
        sessionId,
        blockId: newBlockId("turn"),
        startedAt,
        at: new Date().toISOString(),
        stopReason,
        usage,
      });
    };
    try {
      const response = await this.pool.prompt(session.poolKey, sessionId, prompt);
      // end_turn is the unremarkable outcome; anything else is worth a line.
      if (response.stopReason === "end_turn") {
        this.log.debug(`session ${sessionId}: turn ended`);
      } else {
        this.log.info(`session ${sessionId}: turn stopped — ${response.stopReason}`);
      }
      endTurn(response.stopReason, toTurnUsage(response.usage));
    } catch (err) {
      // The turn still ended — as an error, said as such, never silently.
      endTurn("error", null);
      throw err;
    } finally {
      // The session object may have been replaced under this turn (a
      // reload's fresh LiveSession) — flag the current one, not the capture.
      const current = this.sessions.get(sessionId);
      if (current !== undefined) {
        current.inFlight = false;
        current.lastActivityAt = Date.now();
        if (current.turnSettled === turnSettled) current.turnSettled = null;
        if (current.rootsDirty) {
          current.rootsDirty = false;
          void this.reapplyRoots(sessionId);
        }
      }
      this.hooks.emit({ kind: "sessionLiveChanged", sessionId, live: false });
      settleTurn();
      // Drain: one queued prompt per turn end. Stop/close/reload cleared the
      // queue before their cancel went out, so a non-empty queue here means
      // the turn ended on its own and the next send is still wanted.
      const next = this.promptQueues.get(sessionId)?.shift();
      if (next !== undefined && this.sessions.has(sessionId)) {
        this.hooks.emit({ kind: "promptUnqueued", sessionId, promptId: next.id });
        void this.sendPrompt(sessionId, next.text, next.parts).catch((err: Error) => {
          // A failed drain ends the drain: nothing is left to fire the rest,
          // so holding them would show rows that can never send.
          this.log.info(`session ${sessionId}: queued prompt failed — ${err.message}`);
          this.clearPromptQueue(sessionId);
        });
      }
    }
  }

  async stopTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Stop means stop: queued prompts go with the cancelled turn — draining
    // them after a deliberate stop would restart what the user just ended.
    this.clearPromptQueue(sessionId);
    await this.pool.cancel(session.poolKey, sessionId);
  }

  /** Drops one still-queued prompt (composer row × button). */
  removeQueuedPrompt(sessionId: string, promptId: string): void {
    const queue = this.promptQueues.get(sessionId);
    const index = queue?.findIndex((q) => q.id === promptId) ?? -1;
    if (queue === undefined || index === -1) return;
    queue.splice(index, 1);
    this.hooks.emit({ kind: "promptUnqueued", sessionId, promptId });
  }

  private clearPromptQueue(sessionId: string): void {
    if ((this.promptQueues.get(sessionId)?.length ?? 0) > 0) {
      this.hooks.emit({ kind: "promptQueueCleared", sessionId });
    }
    this.promptQueues.delete(sessionId);
  }

  /** Honest interruption: a live turn is cancelled (per the spec)
   * and awaited to settle before the caller rips the session out from under
   * it — the turn's own end (turnEnded, the tool-call sweep) must land
   * first, or it would write into a session that no longer exists. Bounded:
   * a hung agent gets CANCEL_SETTLE_MS, then the caller proceeds anyway —
   * a wedged process must not make a session unclosable. */
  private async interruptTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || !session.inFlight) return;
    await this.stopTurn(sessionId).catch(() => {}); // a dead connection stops nothing — proceed
    const settled = session.turnSettled;
    if (settled === null) return;
    await Promise.race([
      settled,
      new Promise<void>((resolve) => setTimeout(resolve, CANCEL_SETTLE_MS).unref()),
    ]);
  }

  /** Pulls type:"diff" entries out of a tool call's content: texts stashed
   * here, paths returned for the event (spread-friendly; absent when the
   * update carried no content, so "keep existing" merge semantics hold —
   * present content replaces the collection, per ACP). */
  private stashToolDiffs(
    sessionId: string,
    toolCallId: string,
    content: readonly { type: string; path?: string; oldText?: string | null; newText?: string }[] | null | undefined,
    emit: (...events: AgentViewEvent[]) => void,
  ): { diffFiles: readonly string[] } | Record<string, never> {
    if (content == null) return {};
    const diffs = new Map<string, { oldText: string; newText: string }>();
    for (const c of content) {
      if (c.type !== "diff" || c.path === undefined || c.newText === undefined) continue;
      diffs.set(c.path, { oldText: c.oldText ?? "", newText: c.newText });
    }
    if (diffs.size === 0) return {}; // content present but no diffs — not a replacement signal for diffs
    let perSession = this.toolDiffs.get(sessionId);
    if (perSession === undefined) {
      perSession = new Map();
      this.toolDiffs.set(sessionId, perSession);
    }
    perSession.set(toolCallId, diffs);
    for (const [path, d] of diffs) {
      this.noteFileBaseline(sessionId, path, d.oldText);
      this.noteFileChange(sessionId, path, d.newText, emit);
    }
    return { diffFiles: [...diffs.keys()] };
  }

  /** First note wins: the earliest known pre-image IS the session baseline
   * for that path — later writes only move the file further from it. Both
   * diff sources call in (agent-reported diffs above, the fs/write gate via
   * the orchestrator); on replay the same route repopulates in wire order. */
  noteFileBaseline(sessionId: string, path: string, oldText: string): void {
    let perSession = this.fileBaselines.get(sessionId);
    if (perSession === undefined) {
      perSession = new Map();
      this.fileBaselines.set(sessionId, perSession);
    }
    if (!perSession.has(path)) perSession.set(path, oldText);
  }

  /** The "since first agent touch" left side for one files-panel diff —
   * null when no pre-image is known (locations-only path, or a cold-loaded
   * session whose replay carried no diff content; the ± never rendered). */
  fileBaseline(sessionId: string, path: string): string | null {
    return this.fileBaselines.get(sessionId)?.get(path) ?? null;
  }

  /** Recomputes the cumulative +/- (baseline vs newText) and emits it —
   * called wherever a path's applied content actually advances: an
   * agent-reported diff (below) or an accepted gate write (orchestrator's
   * noteFileWrite). Baseline must already be noted (noteFileBaseline runs
   * first at both call sites) — falls back to "" only for the pathological
   * case of a stat computed before any baseline, which never happens on
   * either call path today. */
  private noteFileChange(
    sessionId: string,
    path: string,
    newText: string,
    emit: (...events: AgentViewEvent[]) => void,
  ): void {
    const baseline = this.fileBaselines.get(sessionId)?.get(path) ?? "";
    const { additions, deletions } = computeLineDiff(baseline, newText);
    let perSession = this.fileStats.get(sessionId);
    if (perSession === undefined) {
      perSession = new Map();
      this.fileStats.set(sessionId, perSession);
    }
    perSession.set(path, { additions, deletions });
    emit({ kind: "fileDiffStatChanged", sessionId, path, additions, deletions });
  }

  /** Gate-write counterpart of stashToolDiffs' per-diff noteFileChange calls
   * — orchestrator calls this once a write is accepted and applied. Direct
   * hooks.emit: a gate write only ever happens live, never inside a replay
   * window, so the emitterFor silence logic doesn't apply. */
  noteFileWrite(sessionId: string, path: string, content: string): void {
    this.noteFileChange(sessionId, path, content, this.hooks.emit.bind(this.hooks));
  }

  /** Worklist maintenance for the sweep (tool-call analogue of
   * broker.cancelPending) — an open status adds, a terminal one removes. */
  private trackOpenToolCall(session: LiveSession, toolCallId: string, status: ToolCallStatus): void {
    if (isToolCallOpen(status)) session.openToolCalls.add(toolCallId);
    else session.openToolCalls.delete(toolCallId);
  }

  /** Nothing is in flight anymore (a turn resolved — any stop reason — or a
   * replay finished) yet these calls never reached a terminal status: they
   * are stranded, and a spinner would be a false claim. Marked once, at the
   * real event, never re-derived from "is a turn active right now" (a later
   * turn in the same session must not resurrect an old turn's stalled
   * call). A trailing tool_call_update still wins — any fresh upsert clears
   * the mark. */
  private sweepOpenToolCalls(sessionId: string, session: LiveSession): void {
    if (session.openToolCalls.size === 0) return;
    const emit = this.emitterFor(sessionId);
    const ids = [...session.openToolCalls];
    session.openToolCalls.clear();
    for (const blockId of ids) {
      emit({ kind: "toolCallInterrupted", sessionId, blockId });
    }
  }

  /** The stashed texts for one openToolCallDiff action — null when unknown
   * (stale id after a close; the action is simply a no-op then). */
  toolCallDiff(sessionId: string, toolCallId: string, path: string): { oldText: string; newText: string } | null {
    return this.toolDiffs.get(sessionId)?.get(toolCallId)?.get(path) ?? null;
  }

  /** The one prose-run gate: every chunk arm asks it where its text lands.
   * Returns the block id to append to, or null for a whitespace-only chunk
   * with no run to continue — dropped, deliberately without touching the
   * open run (a no-op chunk never severs neighboring prose, and never OPENS
   * a run either: replayed thinking arrives as empty chunks — a blank
   * Thought accordion otherwise; an already-open run still takes it,
   * mid-stream spacing is real content).
   *
   * A chunk continues the open run iff the channel matches and message
   * identity continues (ACP ContentChunk.messageId: chunks of one message
   * share it, a change means a new message — wire-verified 2026-07-12).
   * Two non-null ids decide alone: equal continues, different splits — a
   * fused boundary corrupts markdown (message N ending ``` glued to message
   * N+1's heading un-closes the fence). With an id missing on either side
   * the channels honestly differ:
   * - user: never continues. Every user chunk that reaches its arm is a
   *   whole message — live sends render via sendPrompt, live echoes die at
   *   the inFlight guard, and id-less replay is whole-message-per-chunk
   *   (auggie, wire-verified: merging fused adjacent cancelled prompts).
   * - text/thought: always continues. An id-less agent wire carries no
   *   boundary at all, and both of its realities demand merging: live
   *   chunks are stream deltas of the in-flight turn, and an id-less
   *   replay may lawfully be the recorded chunk log played back (our own
   *   fake agent does exactly that) — splitting on a guess shreds prose
   *   mid-fence, strictly worse than fusing. The cost is honest and open:
   *   an id-less agent's real message boundaries stay invisible until a
   *   wire capture proves its replay granularity (auggie's agent-chunk
   *   side is uncaptured — dossier note when it lands). */
  /** Replay counterpart of sendPrompt's part building: one wire content
   * block of a replayed user message → its UserPart. The whole content
   * vocabulary maps — text stays literal, resource_link becomes a mention,
   * image bytes stash to the attachments dir for preview (fire-and-forget;
   * a failed write degrades to a label chip), embedded text resources
   * become bounded context snapshots — and only genuinely unrenderable
   * kinds (audio, blob resources) fall to the honesty placeholder. */
  private userPartOf(sessionId: string, content: ContentBlock): UserPart {
    switch (content.type) {
      case "text":
        return { kind: "text", text: content.text };
      case "resource_link":
        return { kind: "mention", name: content.name, uri: content.uri };
      case "image": {
        if (content.data === "") return { kind: "image", mimeType: content.mimeType };
        const file = imageFileName(`replay-${++blockCounter}`, content.mimeType);
        void stashImage(file, content.data).catch((err: Error) => {
          this.log.info(`session ${sessionId}: replay image stash failed — ${err.message}`);
        });
        return { kind: "image", mimeType: content.mimeType, file };
      }
      case "resource":
        if ("text" in content.resource) {
          return {
            kind: "context",
            label: content.resource.uri,
            text: boundedText(content.resource.text),
          };
        }
        return { kind: "unrendered", type: "blob resource" };
      default:
        return { kind: "unrendered", type: content.type };
    }
  }

  private runBlockFor(
    sessionId: string,
    session: LiveSession,
    channel: RunChannel,
    messageId: string | null,
    text: string,
  ): string | null {
    const run = session.openRun;
    if (run !== null && run.channel === channel) {
      const continues =
        run.messageId !== null && messageId !== null
          ? run.messageId === messageId
          : channel !== "user";
      if (continues) {
        // an id arriving mid-run pins the run to it (id-less opener, ids
        // later) so the NEXT id change still splits
        if (messageId !== null) run.messageId = messageId;
        return run.blockId;
      }
    }
    if (text.trim() === "") return null;
    this.sealRun(sessionId, session);
    session.openRun = { channel, blockId: newBlockId(channel), messageId };
    return session.openRun.blockId;
  }

  /** The close-side twin of runBlockFor — the ONE place an open prose run
   * ends. A run's rewriter may be withholding a tail mid-shape; it lands
   * here (raw, honestly) before the run closes, so no close path can make
   * wire text vanish. Every site that used to null openRun directly routes
   * through this, except the pre-replay reset (reapplyRoots), where the
   * transcript is about to be rebuilt wholesale and the replay re-delivers
   * the same text. */
  private sealRun(sessionId: string, session: LiveSession): void {
    const run = session.openRun;
    session.openRun = null;
    if (run === null) return;
    const tail = run.rewriter?.flush() ?? "";
    if (tail === "") return;
    // rewriter rides only agent-text runs (the one arm that attaches it)
    this.emitterFor(sessionId)({
      kind: "agentTextDelta",
      sessionId,
      blockId: run.blockId,
      text: tail,
    });
  }

  /** Agent prose delta → its run's block, through the run's wire-extension
   * rewriter (attached lazily on first prose; extensions/index.ts). May
   * emit nothing when the rewriter withholds the whole delta mid-shape —
   * sealRun flushes the tail wherever the run ends. */
  private emitAgentProse(
    sessionId: string,
    session: LiveSession,
    messageId: string | null,
    raw: string,
    emit: (...events: AgentViewEvent[]) => void,
  ): void {
    const blockId = this.runBlockFor(sessionId, session, "text", messageId, raw);
    if (blockId === null) return;
    const run = session.openRun!; // runBlockFor just returned this run's id
    run.rewriter ??= createProseRewriter();
    const text = run.rewriter.push(raw);
    if (text !== "") emit({ kind: "agentTextDelta", sessionId, blockId, text });
  }

  /** Routed from AgentPool's onSessionUpdate hook — handles both live
   * streaming and session/load replay identically (same notification shape). */
  handleUpdate(_agentId: string, notification: SessionNotification): void {
    const { sessionId, update } = notification;
    // Session metadata, not transcript — handled before the live guard: the
    // agent may retitle any session it knows, live in patchbay or not.
    if (update.sessionUpdate === "session_info_update") {
      void this.noteInfoUpdate(sessionId, update);
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) return; // update for a session patchbay isn't tracking
    session.lastActivityAt = Date.now(); // any update is activity — the reaper's basis
    // Replay window (loadSilently): canonical state advances, the webview
    // waits for the closing wholesale resync instead of a patch flood.
    const emit = this.emitterFor(sessionId);

    // Replay boundary tracking: the replay wire carries no turn-resolution
    // events, so turn structure is reconstructed here — agent activity marks
    // the segment dirty, and the next user message (or the end of the replay,
    // in loadSilently) flushes it as a synthesized TurnEndBlock. Only ever
    // set inside the window: live turns get their real turnEnded (sendPrompt).
    if (
      this.replaying.has(sessionId) &&
      (update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk" ||
        update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update")
    ) {
      session.replayTurnDirty = true;
    }

    switch (update.sessionUpdate) {
      // Block-model rule for all three chunk
      // arms: runBlockFor above is the one place a chunk's block is decided.
      // This arm is replay-only by design: a live send appends its own whole
      // user block (sendPrompt), and some agents echo the in-flight prompt
      // back as a user_message_chunk (observed: slash-command expansion) —
      // consuming that would duplicate it, hence the inFlight guard. During
      // session/load replay nothing is in flight, so every historical user
      // message lands.
      case "user_message_chunk": {
        if (session.inFlight) return;
        // Interruption marker riding the user role (shape-gated: the whole
        // message is exactly the bracketed marker — no human prompt looks
        // like that; observed: claude-agent-acp replay). It is the replay
        // wire's only record that the turn was cancelled, so render the
        // fact, not the artifact: the segment closes as a cancelled turn —
        // the same line a live cancel leaves — and the marker text never
        // becomes a bubble. Outside a replay window there is nothing to
        // add: the live turn's own turnEnded already said cancelled.
        if (
          update.content.type === "text" &&
          /^\[Request interrupted by user( for tool use)?\]$/.test(update.content.text.trim())
        ) {
          this.sealRun(sessionId, session);
          if (this.replaying.has(sessionId)) {
            session.replayTurnDirty = false;
            emit({
              kind: "turnEnded",
              sessionId,
              blockId: newBlockId("turn"),
              startedAt: null,
              at: null,
              stopReason: "cancelled",
              usage: null,
            });
          }
          break;
        }
        // A replayed user message with agent activity pending = the previous
        // turn just ended structurally — its boundary lands first, so the
        // rollup derivation sees the same shape a live turn left behind.
        this.flushReplayBoundary(sessionId, session, emit);
        const messageId = update.messageId ?? null;
        if (update.content.type === "text" && harnessEnvelopeTag(update.content.text) !== null) {
          // Harness-injected envelope riding the user role: its own closed,
          // flagged block — never merged into the prose run (an injection
          // between two real messages must not fuse them into one bubble,
          // and the injection itself is not the user's prompt).
          this.sealRun(sessionId, session);
          emit({
            kind: "userPartAppended",
            sessionId,
            blockId: newBlockId("user"),
            part: { kind: "text", text: update.content.text },
            injected: true,
          });
          break;
        }
        // Every other content kind maps to its user part and joins the SAME
        // prose run (userPartOf) — one wire message, one bubble: mentions,
        // images and context render in place instead of severing the prompt
        // into bubble + placeholder + bubble.
        const part = this.userPartOf(sessionId, update.content);
        // Non-text parts pass their non-empty flat preview, so the
        // whitespace-only guard in runBlockFor can never swallow them.
        const blockId = this.runBlockFor(sessionId, session, "user", messageId, userPartsText([part]));
        if (blockId === null) break;
        emit({ kind: "userPartAppended", sessionId, blockId, part });
        break;
      }
      case "agent_message_chunk": {
        const messageId = update.messageId ?? null;
        if (update.content.type === "resource_link") {
          // Renderable, so render it (G10b): a markdown link into the prose
          // run — never a placeholder for content the reader can use. Rides
          // through the run's rewriter like any prose delta: a bypass would
          // reorder it ahead of text the rewriter is still withholding.
          this.emitAgentProse(
            sessionId,
            session,
            messageId,
            `[${update.content.name}](${update.content.uri})`,
            emit,
          );
          break;
        }
        if (update.content.type !== "text") {
          // Same honesty placeholder as the user chunk above (G4).
          this.sealRun(sessionId, session);
          emit({
            kind: "agentTextDelta",
            sessionId,
            blockId: newBlockId("text"),
            text: `*[${update.content.type} content — not rendered]*`,
          });
          break;
        }
        this.emitAgentProse(sessionId, session, messageId, update.content.text, emit);
        break;
      }
      case "agent_thought_chunk": {
        if (update.content.type !== "text") {
          // Same honesty placeholder as the message chunks (G4) — this was
          // a silent drop once, the one chunk path that didn't say so.
          this.sealRun(sessionId, session);
          emit({
            kind: "agentThoughtDelta",
            sessionId,
            blockId: newBlockId("thought"),
            text: `*[${update.content.type} content — not rendered]*`,
          });
          break;
        }
        const blockId = this.runBlockFor(
          sessionId,
          session,
          "thought",
          update.messageId ?? null,
          update.content.text,
        );
        if (blockId === null) break;
        emit({ kind: "agentThoughtDelta", sessionId, blockId, text: update.content.text });
        break;
      }
      case "tool_call": {
        this.sealRun(sessionId, session); // the agent paused to act
        const status = update.status ?? "pending";
        this.trackOpenToolCall(session, update.toolCallId, status);
        emit({
          kind: "toolCallUpserted",
          sessionId,
          blockId: update.toolCallId,
          title: update.title,
          status,
          toolKind: update.kind ?? "other",
          ...boundedRaw("input", update.rawInput),
          ...boundedRaw("output", update.rawOutput),
          ...(update.locations != null
            ? { locations: update.locations.map((l) => l.path) }
            : {}),
          ...this.stashToolDiffs(sessionId, update.toolCallId, update.content, emit),
        });
        break;
      }
      case "tool_call_update": {
        const status = update.status ?? "completed";
        this.trackOpenToolCall(session, update.toolCallId, status);
        emit({
          kind: "toolCallUpserted",
          sessionId,
          blockId: update.toolCallId,
          title: update.title ?? "",
          status,
          ...(update.kind != null ? { toolKind: update.kind } : {}),
          ...boundedRaw("input", update.rawInput),
          ...boundedRaw("output", update.rawOutput),
          ...(update.locations != null
            ? { locations: update.locations.map((l) => l.path) }
            : {}),
          ...this.stashToolDiffs(sessionId, update.toolCallId, update.content, emit),
        });
        break;
      }
      case "plan":
        // Session-level state, not a transcript event — replaces the pinned
        // widget's snapshot; it neither appends a block nor interrupts a run.
        emit({
          kind: "planUpdated",
          sessionId,
          entries: toPlanEntries(update.entries),
        });
        break;
      case "available_commands_update":
        emit({
          kind: "commandsAdvertised",
          sessionId,
          commands: update.availableCommands.map((c) => ({
            name: c.name,
            description: c.description,
            ...(c.input?.hint !== undefined ? { inputHint: c.input.hint } : {}),
          })),
        });
        break;
      case "current_mode_update": {
        // Meaningful only on the modes surface; on the config surface it's
        // dropped by the normalizer (knobs.ts: mapping it onto an option
        // would need category as a correctness key — spec-forbidden; the
        // agent's transition duty confirms via config_option_update).
        const next = applyModeUpdate(session.knobs, update.currentModeId);
        if (next !== null) {
          this.publishKnobs(sessionId, next);
          // The confirmation a user set_mode was waiting on (setKnob) —
          // record the composer combination now, from the agent's own
          // notification, never from set_mode's stateless response.
          if (session.userModeSetPending) {
            session.userModeSetPending = false;
            this.hooks.onKnobsConfirmed?.(session.agentId, confirmedFromKnobs(next));
          }
        } else {
          this.log.debug(`session ${sessionId}: current_mode_update dropped (config surface owns the knob state)`);
        }
        break;
      }
      case "config_option_update":
        // Spec: the notification carries the complete configuration state.
        // (`session.knobs` prior keeps accepted extension extras — they ride
        // the session response, not config updates.)
        this.publishKnobs(
          sessionId,
          applyConfigUpdate(update.configOptions, session.knobs, this.knobDropLog),
        );
        break;
      case "usage_update":
        // Capability marking (declared+used together, on first sight — no
        // initialize-time claim exists for usage reporting) already happened
        // in pool.ts's notification handler, right where this same
        // usage_update tag was first seen; this only renders it. The
        // update's `_meta` goes through meta.ts's usageUpdate site — a
        // recognized extension (plan-usage reading) rides along; anything
        // else degrades to absent.
        emit({
          kind: "usageReported",
          sessionId,
          used: update.used,
          size: update.size,
          cost: update.cost ?? undefined,
          plan: planUsageOf((update as { _meta?: unknown })._meta) ?? undefined,
        });
        break;
      case "plan_update":
      case "plan_removed":
        // Declined: gated behind a client capability
        // patchbay does not declare, so a conforming agent never sends them;
        // the whole-replace `plan` model already covers the feature.
        break;
      default:
        // Compile-time exhaustive over the SDK's SessionUpdate union: a new
        // kind on an SDK upgrade fails typecheck here and demands a verdict
        // — consumed or declined, never silent. Runtime
        // stays a no-op for kinds newer than the SDK, the spec's own rule
        // for unrecognized notifications.
        assertUnconsumed(update);
    }
  }

  /** Title bookkeeping shared by auto-titling and the agent's own pushes —
   * the known map mirrors what the view shows. */
  private retitle(sessionId: string, title: string): void {
    const entry = this.known.get(sessionId);
    if (entry !== undefined) this.known.set(sessionId, { ...entry, title });
  }

  /** `session_info_update`: the agent pushed new title/updatedAt. The
   * agent's title always wins (there is no patchbay-side rename). A null
   * title is a clear, not a rename: patchbay keeps its own (a session list
   * with blank rows helps no one). */
  private async noteInfoUpdate(
    sessionId: string,
    update: { title?: string | null; updatedAt?: string | null },
  ): Promise<void> {
    const entry = this.known.get(sessionId);
    if (entry === undefined) return;
    if (update.title == null || update.title === entry.title) return;
    this.retitle(sessionId, update.title);
    this.hooks.emit({ kind: "sessionRenamed", sessionId, title: update.title });
  }
}

/** The image-paste fallback for agents that never declared
 * `promptCapabilities.image`: bytes to the attachments stash, sent as a
 * ResourceLink (with ContentBlock::Text, the baseline every agent must
 * accept). The same stash file backs the transcript's preview. */
async function imageAsResourceLink(
  chip: Extract<ContextChip, { kind: "image" }>,
): Promise<ContentBlock> {
  const name = imageFileName(chip.id, chip.mimeType);
  const file = await stashImage(name, chip.content);
  return { type: "resource_link", uri: pathToFileURL(file).toString(), name, mimeType: chip.mimeType };
}

/** PromptResponse.usage (UNSTABLE in ACP, optional per agent) → the view's
 * TurnUsage — null when unreported, so the UI omits the row entirely
 * (absence over fake). */
function toTurnUsage(usage: { totalTokens: number; inputTokens: number; outputTokens: number; cachedReadTokens?: number | null } | null | undefined): TurnUsage | null {
  if (usage == null) return null;
  return {
    total: usage.totalTokens,
    input: usage.inputTokens,
    output: usage.outputTokens,
    ...(usage.cachedReadTokens != null ? { cached: usage.cachedReadTokens } : {}),
  };
}

/** A tool call's rawInput/rawOutput can be arbitrarily large (a full file
 * read, a long command's stdout) — bound it before it rides every state
 * snapshot, with an honest marker, never a silent cut. Absent stays absent:
 * the spread-friendly shape keeps `undefined` out of the event entirely so
 * the reducer's "absent = keep existing" merge rule holds. */
const RAW_CAP = 4_000;

/** The bound itself, reusable for any agent-sized text that rides state
 * snapshots (context-chip snapshots on user blocks share the rule). */
function boundedText(text: string): string {
  if (text.length <= RAW_CAP) return text;
  return `${text.slice(0, RAW_CAP)}\n… truncated (${text.length.toLocaleString()} chars total)`;
}

function boundedRaw(
  key: "input" | "output",
  raw: unknown,
): { input: string } | { output: string } | Record<string, never> {
  if (raw === undefined || raw === null) return {};
  let text: string;
  if (typeof raw === "string") text = raw;
  else {
    try {
      text = JSON.stringify(raw, null, 2);
    } catch {
      text = String(raw);
    }
  }
  return { [key]: boundedText(text) } as { input: string } | { output: string };
}

/** Exhaustiveness backstop for handleUpdate's switch — see its default arm. */
function assertUnconsumed(_update: never): void {}

function toPlanEntries(
  entries: readonly { content: string; status: "pending" | "in_progress" | "completed" }[],
): PlanEntry[] {
  return entries.map((e) => ({ content: e.content, status: e.status }));
}
