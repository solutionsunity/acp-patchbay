// Bridges the ACP client pool to the Agent View's chat state. Owns the render
// cache in the sense of deciding *when* it must be rebuilt wholesale — the
// cache itself lives in AgentViewState, updated only through the shared
// reducer (architecture.md § State: render cache is disposable, replay
// always wins, never merged).
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
  type SessionSummary,
  type ToolCallStatus,
  type TurnUsage,
} from "../shared/protocol";
import {
  applyConfigUpdate,
  applyModeUpdate,
  confirmedFromKnobs,
  NO_KNOBS,
  normalizeKnobs,
  routeKnobSet,
  type NormalizedKnobs,
} from "./knobs";
import { nullLogger, type Logger } from "./logger";
import type { AgentPool } from "./pool";

export interface SessionManagerHooks {
  emit(...events: AgentViewEvent[]): void;
  /** Advance canonical render state without a webview patch — the
   * session/load replay window (ui-rendering-strategy.md § Hydration
   * delivery). Absent → falls back to `emit` (tests, patch-per-event). */
  emitSilent?(...events: AgentViewEvent[]): void;
  /** Closes a silent window: one wholesale webview sync from canonical
   * state — the replay lands as a single swap, never a patch flood. */
  resyncView?(): void;
  /** The local MCP server is spawned with `contextToken` as its correlation
   * id (the real ACP sessionId doesn't exist yet when mcpServers must be
   * built — session/new hasn't returned). Lets the orchestrator's IPC host
   * translate that token back to the real session once it's known. */
  mapContextToken?(token: string, sessionId: string): void;
  /** Process-policy decision for a *new top-level* session (architecture.md
   * § process model): returns the poolKey to create it on — the agentId
   * itself when sharing, or a fresh isolated poolKey (having already
   * connected a dedicated subprocess for it) when isolating. Absent → always
   * share (pre-P8 behavior — fine for tests that don't exercise policy). */
  resolveProcessFor?(agentId: string): Promise<string>;
  /** The knob seed a *fresh* session starts from (folded, knob-id-keyed —
   * knobs.ts foldSeed), applied once, post-create. Which seed that is —
   * the agent config's defaults or the last confirmed combination — is the
   * orchestrator's policy (Preferences knobSource), not knowledge held here. */
  seedFor?(agentId: string): KnobSeed | undefined;
  /** Fires at the one knob-state exit (publishKnobs) with the agent-confirmed
   * combination — the "last used" record behind the last-session knobSource
   * preference (stores/last-knobs.ts). */
  onKnobsConfirmed?(agentId: string, seed: KnobSeed): void;
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
   * delete on close (capability-verification.md: features gate on used). */
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

/** Attached-but-idle sessions release their agent-side resources after an
 * hour — the row stays listed and re-attaches on the next open/prompt. */
const DEFAULT_IDLE_CLOSE_MS = 60 * 60_000;

let blockCounter = 0;
function newBlockId(prefix: string): string {
  return `${prefix}-${++blockCounter}`;
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
}

interface LiveSession {
  agentId: string;
  /** Which pool connection this session's requests ride — the agentId
   * itself when sharing, a synthetic instance id when process-policy
   * isolated it (P8). */
  poolKey: string;
  /** True once auto-derived from the first prompt, or explicitly renamed —
   * either way, later auto-titling must not clobber it again. */
  titled: boolean;
  activeTextBlockId: string | null;
  activeThoughtBlockId: string | null;
  /** The replayed-user-prose run (session/load `user_message_chunk`) —
   * live sends never use it (sendPrompt appends its own whole block). */
  activeUserBlockId: string | null;
  pendingContext: ContextChip[];
  /** Normalized knob state (knobs.ts) — carries the wire surface that
   * drives set routing; the view side only ever sees the knob list. */
  knobs: NormalizedKnobs;
  /** A prompt turn is in flight — release/reap must never close under it. */
  inFlight: boolean;
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
}

function liveSession(agentId: string, poolKey: string, titled: boolean): LiveSession {
  return {
    agentId,
    poolKey,
    titled,
    activeTextBlockId: null,
    activeThoughtBlockId: null,
    activeUserBlockId: null,
    pendingContext: [],
    knobs: NO_KNOBS,
    inFlight: false,
    rootsDirty: false,
    everPrompted: false,
    lastActivityAt: Date.now(),
    openToolCalls: new Set(),
    replayTurnDirty: false,
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
  private contextTokenCounter = 0;
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
      return { sessionId: r.sessionId, knobs: normalizeKnobs(r.modes, r.configOptions) };
    }
    this.hooks.mapContextToken?.(contextToken, target.sessionId);
    const r =
      target.via === "load"
        ? await this.pool.loadSession(poolKey, target.sessionId, cwd, mcpServers, roots)
        : await this.pool.resumeSession(poolKey, target.sessionId, cwd, mcpServers, roots);
    return { sessionId: target.sessionId, knobs: normalizeKnobs(r.modes, r.configOptions) };
  }

  /** A `session/load` with its replay window silenced (ui-rendering-
   * strategy.md § Hydration delivery): the reset and every replayed update
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

  /** Replay-window channel pick (ui-rendering-strategy § Hydration
   * delivery): inside a session's replay window events reduce silently into
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
    }
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const agentId = session?.agentId ?? this.known.get(sessionId)?.agentId;
    this.sessions.delete(sessionId);
    this.toolDiffs.delete(sessionId);
    this.known.delete(sessionId);
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

  /** "Disconnect & erase all data" (P18): every session's bookkeeping goes
   * at once — the processes are already down; the UI rows leave via the
   * orchestrator's sessionClosed events. */
  reset(): void {
    this.sessions.clear();
    this.known.clear();
    this.toolDiffs.clear();
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
      this.known.delete(sessionId);
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
   * instance (P8) — its subprocess dying must not touch any other session
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

  /** One-click reload (P8): re-attach on demand, even when the session
   * isn't currently invalidated — the same ladder as every attach
   * (load > resume), so a resume-only agent's reload works too. */
  async reload(sessionId: string): Promise<void> {
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
    let error: Error | undefined;
    if (declared?.loadSession) {
      try {
        await this.reopen(sessionId, agentId);
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
      await this.pool.setSessionMode(session.poolKey, sessionId, route.modeId);
      return;
    }
    const response = await this.pool.setSessionConfigOption(session.poolKey, sessionId, route.configId, value);
    this.publishKnobs(sessionId, applyConfigUpdate(response.configOptions));
  }

  /** The one exit for knob state: stores the normalized truth on the
   * session (set routing reads the surface from it) and emits the full
   * view replace. */
  private publishKnobs(sessionId: string, knobs: NormalizedKnobs): void {
    const session = this.sessions.get(sessionId);
    if (session) session.knobs = knobs;
    // An empty surface is not a combination — recording it would erase a
    // real one with "this agent offered nothing this time".
    if (session && knobs.knobs.length > 0) {
      this.hooks.onKnobsConfirmed?.(session.agentId, confirmedFromKnobs(knobs));
    }
    this.hooks.emit({ kind: "sessionKnobsSet", sessionId, knobs: knobs.knobs });
  }

  /** Fresh-session seed (architecture.md § Session model, mode, effort):
   * applied once, post-create on a *fresh* session only — never on
   * reopen/reload (the agent's own resumed state is the truth). */
  private async applySeedFor(agentId: string, sessionId: string): Promise<void> {
    const seed = this.hooks.seedFor?.(agentId);
    if (seed === undefined) return;
    await this.applySeed(sessionId, seed);
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
      try {
        const response = await this.pool.setSessionConfigOption(session.poolKey, sessionId, route.configId, value);
        this.publishKnobs(sessionId, applyConfigUpdate(response.configOptions));
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

  /** External context roots (features.md § Chat): patchbay holds no local
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
        session.activeTextBlockId = null;
        session.activeThoughtBlockId = null;
        session.activeUserBlockId = null;
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
    const agentId = this.sessions.get(sessionId)?.agentId ?? this.known.get(sessionId)?.agentId;
    if (agentId === undefined) throw new Error(`unknown session ${sessionId}`);
    await this.ensureAttached(sessionId, agentId);
    const session = this.sessions.get(sessionId)!;
    session.activeTextBlockId = null;
    session.activeThoughtBlockId = null;
    session.activeUserBlockId = null;
    session.inFlight = true;
    session.everPrompted = true;
    session.lastActivityAt = Date.now();

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
    events.push(
      { kind: "userMessageAppended", sessionId, blockId: newBlockId("user"), text },
      { kind: "sessionLiveChanged", sessionId, live: true },
      { kind: "turnStarted", sessionId, at: startedAt },
    );
    // Attached context rides in as its own labeled blocks, ahead of the
    // user's words — distinguishable to the agent, not merged into prose
    // (features.md § Chat: "explicitly add editor state to the prompt").
    const chips = session.pendingContext;
    session.pendingContext = [];
    for (const chip of chips) {
      events.push({ kind: "contextChipRemoved", sessionId, chipId: chip.id });
    }
    this.hooks.emit(...events);

    // Chips ride in the best form the agent accepts — capability first,
    // fallback second, switch at this one chokepoint (the house pattern):
    // images as ImageContent where `promptCapabilities.image` is declared,
    // else bytes to a temp file as a ResourceLink; text chips as embedded
    // `resource` blocks where `promptCapabilities.embeddedContext` is
    // declared (a chip IS a snapshot the user took — typed, uri-attributed,
    // the agent weighs it correctly), else the labeled-text fallback that
    // every agent MUST accept.
    const declared = this.pool.get(session.poolKey)?.declared;
    const acceptsImages = declared?.promptImage ?? false;
    const acceptsEmbedded = declared?.promptEmbeddedContext ?? false;
    const prompt: ContentBlock[] = [];
    for (const c of chips) {
      if (c.kind !== "image") {
        if (acceptsEmbedded) {
          prompt.push({
            type: "resource",
            // Aggregates without a single source (diagnostics) name the
            // chip itself — the uri field is required on the wire.
            resource: { uri: c.sourceUri ?? `patchbay://context/${c.kind}/${c.id}`, text: c.content },
          });
        } else {
          prompt.push({ type: "text", text: `[${c.label}]\n${c.content}` });
        }
      } else if (acceptsImages) {
        prompt.push({ type: "image", data: c.content, mimeType: c.mimeType ?? "image/png" });
      } else {
        prompt.push(await imageAsResourceLink(c));
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
      if (current !== undefined) this.sweepOpenToolCalls(sessionId, current);
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
        if (current.rootsDirty) {
          current.rootsDirty = false;
          void this.reapplyRoots(sessionId);
        }
      }
      this.hooks.emit({ kind: "sessionLiveChanged", sessionId, live: false });
    }
  }

  async stopTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await this.pool.cancel(session.poolKey, sessionId);
  }

  /** Pulls type:"diff" entries out of a tool call's content: texts stashed
   * here, paths returned for the event (spread-friendly; absent when the
   * update carried no content, so "keep existing" merge semantics hold —
   * present content replaces the collection, per ACP). */
  private stashToolDiffs(
    sessionId: string,
    toolCallId: string,
    content: readonly { type: string; path?: string; oldText?: string | null; newText?: string }[] | null | undefined,
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
    return { diffFiles: [...diffs.keys()] };
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
      // Block-model interruption rule (ui-rendering-strategy.md): a chunk
      // merges into the *last* block only if it's the same type — any other
      // block landing in between (the other chunk type, a tool call, a plan)
      // closes it, and a later chunk of the old type starts a fresh block.
      // Replay-only by design: a live send appends its own whole user block
      // (sendPrompt), and some agents echo the in-flight prompt back as a
      // user_message_chunk (observed: slash-command expansion) — consuming
      // that would duplicate it, hence the inFlight guard. During session/load
      // replay nothing is in flight, so every historical user message lands.
      case "user_message_chunk": {
        if (session.inFlight) return;
        // A replayed user message with agent activity pending = the previous
        // turn just ended structurally — its boundary lands first, so the
        // rollup derivation sees the same shape a live turn left behind.
        this.flushReplayBoundary(sessionId, session, emit);
        session.activeTextBlockId = null;
        session.activeThoughtBlockId = null;
        if (update.content.type !== "text") {
          // Honesty placeholder (acp-compliance.md G4): unrendered content
          // says so in place — its own closed block, never a silent drop.
          session.activeUserBlockId = null;
          emit({
            kind: "userTextDelta",
            sessionId,
            blockId: newBlockId("user"),
            text: `*[${update.content.type} content — not rendered]*`,
          });
          break;
        }
        session.activeUserBlockId ??= newBlockId("user");
        emit({
          kind: "userTextDelta",
          sessionId,
          blockId: session.activeUserBlockId,
          text: update.content.text,
        });
        break;
      }
      case "agent_message_chunk": {
        session.activeThoughtBlockId = null; // prose interrupts the thought run
        session.activeUserBlockId = null; // …and closes a replayed user run
        if (update.content.type !== "text") {
          // Same honesty placeholder as the user chunk above (G4).
          session.activeTextBlockId = null;
          emit({
            kind: "agentTextDelta",
            sessionId,
            blockId: newBlockId("text"),
            text: `*[${update.content.type} content — not rendered]*`,
          });
          break;
        }
        session.activeTextBlockId ??= newBlockId("text");
        emit({
          kind: "agentTextDelta",
          sessionId,
          blockId: session.activeTextBlockId,
          text: update.content.text,
        });
        break;
      }
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return;
        session.activeTextBlockId = null; // thinking interrupts the prose run
        session.activeUserBlockId = null;
        session.activeThoughtBlockId ??= newBlockId("thought");
        emit({
          kind: "agentThoughtDelta",
          sessionId,
          blockId: session.activeThoughtBlockId,
          text: update.content.text,
        });
        break;
      }
      case "tool_call": {
        session.activeTextBlockId = null; // the agent paused to act
        session.activeThoughtBlockId = null;
        session.activeUserBlockId = null;
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
          ...this.stashToolDiffs(sessionId, update.toolCallId, update.content),
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
          ...this.stashToolDiffs(sessionId, update.toolCallId, update.content),
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
        if (next !== null) this.publishKnobs(sessionId, next);
        else this.log.debug(`session ${sessionId}: current_mode_update dropped (config surface owns the knob state)`);
        break;
      }
      case "config_option_update":
        // Spec: the notification carries the complete configuration state.
        this.publishKnobs(sessionId, applyConfigUpdate(update.configOptions));
        break;
      case "usage_update":
        // Capability marking (declared+used together, on first sight — no
        // initialize-time claim exists for usage reporting) already happened
        // in pool.ts's notification handler, right where this same
        // usage_update tag was first seen; this only renders it.
        emit({
          kind: "usageReported",
          sessionId,
          used: update.used,
          size: update.size,
          cost: update.cost ?? undefined,
        });
        break;
      case "plan_update":
      case "plan_removed":
        // Declined (acp-compliance.md § 9): gated behind a client capability
        // patchbay does not declare, so a conforming agent never sends them;
        // the whole-replace `plan` model already covers the feature.
        break;
      default:
        // Compile-time exhaustive over the SDK's SessionUpdate union: a new
        // kind on an SDK upgrade fails typecheck here and demands a verdict
        // in acp-compliance.md — consumed or declined, never silent. Runtime
        // stays a no-op for kinds newer than the SDK, the spec's own rule
        // for unrecognized notifications (§ Extensibility).
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

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** The image-paste fallback for agents that never declared
 * `promptCapabilities.image`: bytes to a temp file, sent as a ResourceLink
 * (with ContentBlock::Text, the baseline every agent must accept). */
async function imageAsResourceLink(chip: ContextChip): Promise<ContentBlock> {
  const mimeType = chip.mimeType ?? "image/png";
  const dir = join(tmpdir(), "acp-patchbay-attachments");
  await mkdir(dir, { recursive: true });
  const name = `${chip.id}.${IMAGE_EXTENSIONS[mimeType] ?? "img"}`;
  const file = join(dir, name);
  await writeFile(file, Buffer.from(chip.content, "base64"));
  return { type: "resource_link", uri: pathToFileURL(file).toString(), name, mimeType };
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
  if (text.length > RAW_CAP) {
    text = `${text.slice(0, RAW_CAP)}\n… truncated (${text.length.toLocaleString()} chars total)`;
  }
  return { [key]: text } as { input: string } | { output: string };
}

/** Exhaustiveness backstop for handleUpdate's switch — see its default arm. */
function assertUnconsumed(_update: never): void {}

function toPlanEntries(
  entries: readonly { content: string; status: "pending" | "in_progress" | "completed" }[],
): PlanEntry[] {
  return entries.map((e) => ({ content: e.content, status: e.status }));
}
