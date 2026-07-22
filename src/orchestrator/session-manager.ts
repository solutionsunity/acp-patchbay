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
  type PersistedChip,
  type PlanEntry,
  type PromptPart,
  type QueuedPrompt,
  type SessionContinuity,
  type SessionSummary,
  type ToolCallStatus,
  type TurnUsage,
  type UserPart,
  userPartsText,
} from "../shared/protocol";
import { imageFileName, readStashedImage, stashImage } from "./attachments";
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
  /** The session's durable continuity row (stores/session-continuity.ts):
   * knobs, roots, held queue, prepared chips, composer draft — everything
   * a window reload would otherwise lose and the wire cannot re-report.
   * Read once, when a listed session enters with nothing in memory; for
   * knobs this is what keeps a restored session in the involuntary arm of
   * the reattach rule instead of misfiling as a deliberate fresh entry. */
  continuityFor?(sessionId: string, agentId: string): SessionContinuity | undefined;
  /** Write-through for the same row: a patch merges the named fields
   * (empty array/string deletes a field); `null` forgets the whole row —
   * fired when the session leaves for good (closed, pruned from the
   * agent's own list, its agent removed, zero-turn recreate). */
  onContinuity?(sessionId: string, agentId: string, patch: SessionContinuity | null): void;
  /** Fires when a real session attaches on an agent (new/load/resume, at
   * the one attach ceremony) — the deferred-probe trigger for latched
   * agents (capability-tracker.noteRealSessionOpened via the orchestrator;
   * extensions/first-session-mcp-latch). Probe sessions never pass through
   * here, which is exactly what makes this the honest "real session" fact. */
  onRealSessionAttached?(agentId: string, sessionId: string): void;
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
  /** Narrower than isActiveSession: true only when this session owns the
   * sidebar's active pointer (pinned panels excluded) — recreateEmpty's
   * re-activation predicate. */
  isPointerActive?(sessionId: string): boolean;
  /** The blue mark: a turn completed while the session wasn't open in the
   * view and the user hasn't looked yet — the reaper must not close under
   * an unseen result (reducer-derived `unseen` on the session summary). */
  isUnseen?(sessionId: string): boolean;
  /** Buffer-truth read of a workspace file (the orchestrator's live-buffer
   * lookup — dirty editors included). The baseline capture uses it when an
   * agent's diff omits its pre-image: reality is read, never a silent
   * claim latched. */
  readFileLive?(path: string): Promise<string>;
  /** Standing auth lock on this agent (the orchestrator's persisted,
   * evidence-gated auth state). While it holds, no turn may start: the
   * turn-start door queues the words instead of firing them into a wire
   * already witnessed to refuse — and the drain holds until the lock's
   * clearing releases it. */
  authLocked?(agentId: string): boolean;
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

/** Thrown by sendPromptNow when the turn never started (attach failed or
 * the session vanished under it): nothing was rendered and nothing reached
 * the wire, so the caller may safely re-hold the words. Past that point a
 * failure means the words were spent — a rendered user message with an
 * honest error turn. */
class TurnNotStartedError extends Error {
  constructor(readonly reason: Error) {
    super(reason.message);
  }
}

/** ContextChip → its durable encoding: image bytes stay in the stash (the
 * chip's deterministic file name), everything else rides the row as-is. */
function persistChip(chip: ContextChip): PersistedChip {
  if (chip.kind === "image") {
    return {
      kind: "image",
      id: chip.id,
      label: chip.label,
      mimeType: chip.mimeType,
      file: imageFileName(chip.id, chip.mimeType),
    };
  }
  if (chip.kind === "attachment") {
    return {
      kind: "attachment",
      id: chip.id,
      label: chip.label,
      path: chip.path,
      ...(chip.mimeType !== undefined ? { mimeType: chip.mimeType } : {}),
    };
  }
  return {
    kind: chip.kind,
    id: chip.id,
    label: chip.label,
    content: chip.content,
    ...(chip.sourceUri !== undefined ? { sourceUri: chip.sourceUri } : {}),
  };
}

/** One session patchbay currently knows to exist — created here this
 * window, or reported by the agent's own `session/list`. The identity
 * facts (title, timestamps) are in-memory, deliberately: the agent is the
 * source of truth for sessions and this is the mirror of the last wire
 * read, repopulated every connect (patchbay stores no transcripts, no
 * index). The knob snapshot is the one exception — mirrored to the
 * durable continuity row, because the wire cannot re-report it. */
interface KnownSession {
  agentId: string;
  title: string;
  createdAt: string; // ISO — session/list rows carry only updatedAt; used for it there
  updatedAt: string; // ISO — the drawer's sort key
  /** The session's last agent-confirmed knob combination — written at every
   * publishKnobs, so it outlives the LiveSession (detach on connection
   * death, idle release) and re-seeds any *involuntary* re-attach: the
   * user asked to change nothing, so the session's combination must
   * survive the agent resetting knob state on session/load. Unlike the
   * rest of this row it also survives a window reload: the wire cannot
   * re-report it, so the durable continuity row (continuityFor/onContinuity
   * hooks) rehydrates it when the listed session re-enters — a restored
   * window is not a deliberate fresh entry. */
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
  private toolDiffs = new Map<string, Map<string, Map<string, { oldText: string; newText: string; saidOld: boolean }>>>();
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
  /** Held words, per session — the turn-start door's queue. Mirrored to the
   * durable continuity row at every mutation, so a window reload or an
   * agent crash never discards them; only the user does (Stop, the row's
   * ×, close). The drain releases one per *completed* turn, on login, on
   * opening the session, or after a reload's re-attach — an errored turn
   * holds the words instead of retrying into whatever just failed. */
    private promptQueues = new Map<string, QueuedPrompt[]>();
  /** Sessions with a turn being started right now — the synchronous claim
   * that closes the door↔drain race across sendPromptNow's attach await:
   * checked beside inFlight at every adjudication, taken before any await,
   * released the moment inFlight takes over or the start fails. Without
   * it, an unlock poke and a turn-end drain landing in the same window
   * would both pass the gates and fire two concurrent turns. */
  private turnStarting = new Set<string>();
  /** Per-session diff-accounting generation — bumped by resetDiffAccounting
   * so an async baseline capture started before a reset discards itself
   * instead of resurrecting wiped accounting into the replay's fresh maps. */
  private diffEpoch = new Map<string, number>();
  /** Pending context chips carried across an involuntary LiveSession drop
   * (connection death, isolated-instance death, idle release, reload) —
   * the view keeps rendering them, so the truth they mirror must survive
   * too, or the next prompt would silently go out without them. The
   * voluntary path (recreateEmpty) already carries them by hand; restored
   * at the next attach, dropped with the session at close. */
  private contextStash = new Map<string, ContextChip[]>();
  /** Per agent: session ids closed while a session/list walk may be in
   * flight — a page fetched before the close would otherwise resurrect
   * the row with an empty transcript. Each new walk clears its agent's
   * set first: that walk's pages are post-close truth (a failed agent-side
   * delete resurrecting the row then is honest, not stale). */
  private closedDuringSync = new Map<string, Set<string>>();
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
    // The chips survive the release like everything else the view keeps
    // showing — the reaper's "prompt box empty" condition doesn't cover
    // them, and a background session must not shed context it displays.
    if (session.pendingContext.length > 0) {
      this.contextStash.set(sessionId, session.pendingContext);
    }
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
   * 7. no held prompts — words queued at the turn-start door (mid-turn or
   *    auth-held) are unfinished user work, the same class as an unseen
   *    result.
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
      if ((this.promptQueues.get(sessionId)?.length ?? 0) > 0) continue;
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
      this.hooks.onRealSessionAttached?.(agentId, r.sessionId);
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
    this.hooks.onRealSessionAttached?.(agentId, target.sessionId);
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
      this.resetDiffAccounting(sessionId);
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
      if (outcome.attached) {
        // Held words whose firing trigger died with the old window:
        // opening the session is their release (locks still hold them).
        this.drainQueue(sessionId);
        return;
      }
      if (outcome.reason === "failed") return;
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
    this.contextStash.delete(sessionId);
    this.diffEpoch.delete(sessionId);
    if (agentId !== undefined) {
      this.hooks.onContinuity?.(sessionId, agentId, null);
      // Shield against a session/list walk already in flight: its earlier
      // pages predate this close and must not resurrect the row.
      let tombs = this.closedDuringSync.get(agentId);
      if (tombs === undefined) this.closedDuringSync.set(agentId, (tombs = new Set()));
      tombs.add(sessionId);
    }
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
    this.contextStash.clear();
    this.diffEpoch.clear();
    this.closedDuringSync.clear();
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
      this.contextStash.delete(sessionId);
      this.diffEpoch.delete(sessionId);
      // Same contract as the auth lock: cleared with the agent's config —
      // a removed agent's rows have no sync left to prune them.
      this.hooks.onContinuity?.(sessionId, agentId, null);
      this.hooks.emit({ kind: "sessionClosed", sessionId });
    }
    this.closedDuringSync.delete(agentId);
  }

  /** Drops bookkeeping for sessions whose connection just died — a stale
   * sessionId cannot be used on a new connection until reopened. */
  invalidateAgent(agentId: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.agentId !== agentId) continue;
      this.dropLiveSession(sessionId, session);
    }
  }

  /** Same as `invalidateAgent`, scoped to one process-policy isolated
   * instance — its subprocess dying must not touch any other session
   * of the same agent living elsewhere. */
  invalidatePoolKey(poolKey: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.poolKey !== poolKey) continue;
      this.dropLiveSession(sessionId, session);
    }
  }

  /** Shared teardown for an involuntary live-session drop. Order matters,
   * because this runs synchronously inside the process's exit handler
   * while the dying prompt's rejection lands a microtask later: the sweep
   * and seal must happen HERE, on the session that still holds the open
   * tool calls and the rewriter tail — endTurn will find the session gone
   * and can only place the turn-end block. Queued prompts SURVIVE an
   * involuntary drop (only the user discards words — Stop, the row's ×,
   * close): the rows stay backed by the in-memory queue and its durable
   * copy, and the drain's running-agent gate holds them until a reattach
   * can actually send. Pending chips stash for the next attach so the
   * rendered chips stay backed by truth. */
  private dropLiveSession(sessionId: string, session: LiveSession): void {
    if (session.inFlight) {
      this.sweepOpenToolCalls(sessionId, session);
      this.sealRun(sessionId, session);
    }
    if (session.pendingContext.length > 0) {
      this.contextStash.set(sessionId, session.pendingContext);
    }
    this.sessions.delete(sessionId);
    this.hooks.emit({ kind: "sessionLiveChanged", sessionId, live: false });
  }

  /** A transcript reset's other half, orchestrator-side: the reducer just
   * wiped the view's ± rows, so the baselines and stats they derived from
   * go too — a retained pre-reset baseline would resurrect the "wiped"
   * accounting at the next write to the same path. The replay re-reports
   * what is real (stashToolDiffs re-notes; the write gate re-baselines). */
  private resetDiffAccounting(sessionId: string): void {
    this.toolDiffs.delete(sessionId);
    this.fileBaselines.delete(sessionId);
    this.fileStats.delete(sessionId);
    this.diffEpoch.set(sessionId, (this.diffEpoch.get(sessionId) ?? 0) + 1);
  }

  /** The stash's other half — called only AFTER an attach rung succeeded:
   * consuming the stash before the RPC settles would destroy the only
   * copy on every failed rung (a transient load failure descending the
   * ladder would silently shed chips the view keeps rendering). */
  private restoreStashedContext(sessionId: string): void {
    const stashed = this.contextStash.get(sessionId);
    if (stashed === undefined) return;
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.contextStash.delete(sessionId);
    session.pendingContext = stashed;
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
    this.closedDuringSync.delete(agentId);
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
      // The stash too — a pruned id can never re-attach, and an image
      // chip's payload must not sit orphaned until erase-all.
      this.contextStash.delete(sessionId);
      this.promptQueues.delete(sessionId);
      this.diffEpoch.delete(sessionId);
      this.hooks.onContinuity?.(sessionId, agentId, null);
      this.hooks.emit({ kind: "sessionClosed", sessionId });
      this.log.info(`session ${sessionId}: gone from ${agentId}'s own list — dropped`);
    }
  }

  /** One listed session into the view. Title rule: the agent's title wins
   * (patchbay-side rename is gone — ACP has no rename request; in-chat
   * agent commands like /rename round-trip through the agent's own list
   * and session_info_update). */
  private noteListedSession(agentId: string, info: SessionInfo): void {
    if (this.closedDuringSync.get(agentId)?.has(info.sessionId) === true) return;
    const existing = this.known.get(info.sessionId);
    const now = new Date().toISOString();
    if (existing === undefined) {
      // A session patchbay never saw — created externally (CLI, another
      // editor) or in a previous window. updatedAt is the only timestamp
      // the wire offers; honest as createdAt-for-ordering, nothing more.
      const title = info.title ?? "Untitled session";
      const at = info.updatedAt ?? now;
      // The durable continuity row re-enters with the session — the fields
      // the wire list cannot carry. Knobs ride the known row (consumed by
      // the reattach rule); roots/queue/draft re-emit into the view now;
      // chips decode async (image bytes come back from the stash) and land
      // via rehydrateChips.
      const cont = this.hooks.continuityFor?.(info.sessionId, agentId);
      this.known.set(info.sessionId, {
        agentId,
        title,
        createdAt: at,
        updatedAt: at,
        ...(cont?.knobs !== undefined ? { knobs: cont.knobs } : {}),
      });
      this.hooks.emit({
        kind: "sessionListed",
        session: { id: info.sessionId, agentId, title, live: false, updatedAt: at },
      });
      if (cont?.roots !== undefined && cont.roots.length > 0) {
        this.hooks.emit({ kind: "contextRootsChanged", sessionId: info.sessionId, roots: cont.roots });
      }
      if (cont?.queue !== undefined && cont.queue.length > 0) {
        // Re-minted ids: the persisted ones came from the old window's
        // counter, which restarts here — a collision with a fresh
        // newBlockId("queued") would make a row's × remove the wrong words.
        const rehydrated = cont.queue.map((q) => ({ ...q, id: newBlockId("queued") }));
        this.promptQueues.set(info.sessionId, rehydrated);
        for (const prompt of rehydrated) {
          this.hooks.emit({ kind: "promptQueued", sessionId: info.sessionId, prompt });
        }
      }
      if (cont?.draft !== undefined && cont.draft !== "") {
        this.hooks.emit({ kind: "sessionDraftChanged", sessionId: info.sessionId, draft: cont.draft });
      }
      if (cont?.chips !== undefined && cont.chips.length > 0) {
        void this.rehydrateChips(info.sessionId, cont.chips);
      }
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
    // Same in-flight signal as a cold open — the row spinner's basis; the
    // set doubles as the reentry guard, so a double-click is one reload.
    if (this.hydrating.has(sessionId)) return;
    this.hydrating.add(sessionId);
    this.hooks.emit({ kind: "sessionHydrating", sessionId, hydrating: true });
    try {
      // Reload discards the render cache and replays from the agent — a turn
      // still streaming into that cache is stopped first, so replay and live
      // stream never interleave.
      await this.interruptTurn(sessionId, { keepHeldWords: true });
      // Live-channel reset, deliberately outside the silent replay window
      // and strictly after the interrupt (the dying turn's tail must not
      // stream into a blanked view): an explicit reload means "what's shown
      // is not trusted" — keeping it up while re-reading would be the cache
      // lying. The view blanks to the same loading page as a cold open (one
      // route); only the *involuntary* re-attach (reopen on connection
      // death) keeps its transcript standing, since there the user asked
      // for nothing and yanking it would be hostile.
      this.hooks.emit({ kind: "transcriptReset", sessionId });
      this.resetDiffAccounting(sessionId);
      const dying = this.sessions.get(sessionId);
      if (dying !== undefined && dying.pendingContext.length > 0) {
        this.contextStash.set(sessionId, dying.pendingContext);
      }
      this.sessions.delete(sessionId);
      const agentId = this.known.get(sessionId)?.agentId;
      if (agentId === undefined) return;
      await this.ensureAttached(sessionId, agentId);
      // Held words kept across the reload re-drain once hydrating clears.
      setImmediate(() => this.drainQueue(sessionId));
    } finally {
      this.hydrating.delete(sessionId);
      this.hooks.emit({ kind: "sessionHydrating", sessionId, hydrating: false });
    }
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
        this.restoreStashedContext(sessionId);
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
        this.restoreStashedContext(sessionId);
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
      if (entry !== undefined) {
        entry.knobs = confirmedFromKnobs(knobs);
        this.hooks.onContinuity?.(sessionId, entry.agentId, { knobs: entry.knobs });
      }
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
    if (chip.kind === "image") {
      // Bytes into the stash at ingress, not at send: the durable chip row
      // carries only the file reference, so a reload must find real bytes.
      void stashImage(imageFileName(chip.id, chip.mimeType), chip.content).catch((err: Error) => {
        this.log.info(`session ${sessionId}: image stash at ingress failed — ${err.message}`);
      });
    }
    session.pendingContext.push(chip);
    this.hooks.emit({ kind: "contextChipAdded", sessionId, chip });
    this.persistChips(sessionId);
  }

  removeContext(sessionId: string, chipId: string): void {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      session.pendingContext = session.pendingContext.filter((c) => c.id !== chipId);
    } else if (this.contextStash.has(sessionId)) {
      // A rehydrated chip removed before its session re-attached: the
      // stash is the only copy — filtering just pendingContext would
      // resurrect the chip at the next attach.
      this.contextStash.set(
        sessionId,
        this.contextStash.get(sessionId)!.filter((c) => c.id !== chipId),
      );
    } else return;
    this.hooks.emit({ kind: "contextChipRemoved", sessionId, chipId });
    this.persistChips(sessionId);
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
    this.persistRoots(sessionId, [...current, normalized]);
    await this.reapplyRoots(sessionId);
  }

  async removeRoot(sessionId: string, path: string): Promise<void> {
    const current = this.hooks.contextRootsFor?.(sessionId) ?? [];
    const next = current.filter((p) => p !== path);
    this.hooks.emit({ kind: "contextRootsChanged", sessionId, roots: next });
    this.persistRoots(sessionId, next);
    await this.reapplyRoots(sessionId);
  }

  private persistRoots(sessionId: string, roots: readonly string[]): void {
    const agentId = this.sessions.get(sessionId)?.agentId ?? this.known.get(sessionId)?.agentId;
    if (agentId === undefined) return;
    this.hooks.onContinuity?.(sessionId, agentId, { roots: [...roots] });
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
      // An involuntary detach like any other: the chips the view renders
      // must survive it (the next attach restores them).
      const dying = this.sessions.get(sessionId);
      if (dying !== undefined && dying.pendingContext.length > 0) {
        this.contextStash.set(sessionId, dying.pendingContext);
      }
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
    // Sidebar-pointer semantics, NOT isActiveSession (which also counts
    // pinned panels): re-activating because a detached panel showed the
    // old id would hijack the sidebar from whatever it is actually on.
    const wasActive = this.hooks.isPointerActive?.(oldId) ?? false;
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
    // Everything the user invested migrates to the fresh id — held words
    // and draft included (they'd otherwise vanish with sessionClosed).
    // The retired shell's durable row goes with it; knobs re-write at the
    // reseed's confirmed publishes below.
    const heldWords = this.promptQueues.get(oldId);
    this.promptQueues.delete(oldId);
    if (heldWords !== undefined && heldWords.length > 0) {
      this.promptQueues.set(sessionId, heldWords);
    }
    const carriedDraft = this.hooks.continuityFor?.(oldId, old.agentId)?.draft;
    this.hooks.onContinuity?.(oldId, old.agentId, null);
    this.hooks.onContinuity?.(sessionId, old.agentId, {
      roots: [...roots],
      chips: fresh.pendingContext.map(persistChip),
      ...(heldWords !== undefined && heldWords.length > 0 ? { queue: [...heldWords] } : {}),
      ...(carriedDraft !== undefined && carriedDraft !== "" ? { draft: carriedDraft } : {}),
    });
    // Same shield as close(): an in-flight session/list walk's stale page
    // must not resurrect the retired shell.
    {
      let tombs = this.closedDuringSync.get(old.agentId);
      if (tombs === undefined) this.closedDuringSync.set(old.agentId, (tombs = new Set()));
      tombs.add(oldId);
    }
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
        // A zero-turn recreate may target a session pinned in a detached
        // panel — activation is decided below by wasActive, never implied.
        activate: false,
      },
      ...(roots.length > 0
        ? [{ kind: "contextRootsChanged", sessionId, roots } as const]
        : []),
      ...fresh.pendingContext.map(
        (chip) => ({ kind: "contextChipAdded", sessionId, chip }) as const,
      ),
      ...(heldWords ?? []).map((prompt) => ({ kind: "promptQueued", sessionId, prompt }) as const),
      ...(carriedDraft !== undefined && carriedDraft !== ""
        ? [{ kind: "sessionDraftChanged", sessionId, draft: carriedDraft } as const]
        : []),
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
    // The turn-start door — the one adjudication every prompt passes,
    // ahead of any transcript write or wire call. Three reasons a turn
    // can't start now, one outcome: the words queue as visible held rows,
    // never silently dropped. Mid-turn (ACP is one prompt per turn)
    // releases at turn end; a standing auth lock releases when login
    // evidence clears it (firing under a lock would fabricate a user
    // message the wire is already witnessed to refuse); words already
    // held ahead keep their order — this prompt joins the back.
    const inFlight =
      this.sessions.get(sessionId)?.inFlight === true || this.turnStarting.has(sessionId);
    const locked = this.hooks.authLocked?.(agentId) === true;
    const behindHeld = (this.promptQueues.get(sessionId)?.length ?? 0) > 0;
    if (inFlight || locked || behindHeld) {
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
      this.persistQueue(sessionId);
      // Held only by order — rehydrated words whose firing trigger died
      // with the old window: release the front now; this prompt fires
      // after them, one per turn end.
      if (!inFlight && !locked) this.drainQueue(sessionId);
      return;
    }
    return this.sendPromptNow(sessionId, agentId, text, parts);
  }

  /** The body behind the door: attach, transcript write, wire call, turn
   * end, drain. Reached only through sendPrompt's adjudication or through
   * drainQueue — which re-checks the same conditions before shifting, so
   * nothing lands here that the door would have held. */
  private async sendPromptNow(
    sessionId: string,
    agentId: string,
    text: string,
    parts?: readonly PromptPart[],
  ): Promise<void> {
    this.turnStarting.add(sessionId);
    let session: LiveSession;
    try {
      await this.ensureAttached(sessionId, agentId);
      const attached = this.sessions.get(sessionId);
      if (attached === undefined) throw new Error(`session ${sessionId} vanished during attach`);
      session = attached;
    } catch (err) {
      // The turn never started: nothing rendered, nothing on the wire —
      // the caller may safely re-hold the words.
      this.turnStarting.delete(sessionId);
      throw new TurnNotStartedError(err as Error);
    }
    // A mode-set confirmation that hasn't arrived by the next prompt is
    // not coming — the flag attributes the *immediate* notification to the
    // user's click; stale, it would record an agent-initiated transition
    // as the user's own combination. Deliberate trade: a bridge deferring
    // its confirmation past the next prompt would lose the recording (none
    // observed) — never recording a wrong combination outranks sometimes
    // missing a right one.
    session.userModeSetPending = false;
    this.sealRun(sessionId, session);
    session.inFlight = true;
    this.turnStarting.delete(sessionId);
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
    this.persistChips(sessionId);
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
      // Drain rides SUCCESS only — one held prompt per completed turn.
      // An errored turn holds the words instead (open/prompt/unlock
      // releases them later): auto-firing the next words into whatever
      // just failed would retry a deterministic rejection forever, and on
      // a crash the status gate can race the exit event — the stream's
      // close rejects the prompt BEFORE the child's exit lands (pool.ts
      // records this observed live), so a drain scheduled off the failure
      // could still see "running" and spend held words into a dying
      // connection. Deferred one IO tick so the turn's own bookkeeping
      // (the finally below) settles first.
      setImmediate(() => this.drainQueue(sessionId));
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
    }
  }

  /** Fire the next held prompt, if its session can start a turn — one per
   * call; the fired turn's own end drains its successor. Holds without
   * shifting while the agent's auth lock stands (or a turn is already in
   * flight); the fired prompt goes through sendPromptNow, past the door —
   * the door's own queue-order condition would otherwise send the front
   * to the back. */
  private drainQueue(sessionId: string): void {
    if (this.sessions.get(sessionId)?.inFlight === true) return;
    if (this.turnStarting.has(sessionId)) return;
    // A reload/open in progress owns the session — the cancelled turn's
    // trailing drain must not fire into the replay window; the reload's
    // own completion re-fires the drain.
    if (this.hydrating.has(sessionId)) return;
    const agentId = this.sessions.get(sessionId)?.agentId ?? this.known.get(sessionId)?.agentId;
    if (agentId === undefined || this.hooks.authLocked?.(agentId) === true) return;
    // A dead or stopped agent holds the queue, never eats it: the crashed
    // turn's own end fires this drain a tick after the exit handler, and
    // shifting into a dead connection would discard words the reattach
    // could have sent. Open/prompt/unlock re-fire the drain once a
    // connection is back.
    if (this.pool.get(agentId)?.status !== "running") return;
    const next = this.promptQueues.get(sessionId)?.shift();
    if (next === undefined) return;
    this.hooks.emit({ kind: "promptUnqueued", sessionId, promptId: next.id });
    this.persistQueue(sessionId);
    void this.sendPromptNow(sessionId, agentId, next.text, next.parts).catch((err: Error) => {
      if (err instanceof TurnNotStartedError) {
        // Nothing rendered, nothing sent — the words go back to the front
        // (only the user discards); view rows resync wholesale so display
        // order stays firing order. The next open/prompt/unlock retries.
        this.log.info(`session ${sessionId}: held words re-held — ${err.message}`);
        const queue = this.promptQueues.get(sessionId) ?? [];
        queue.unshift(next);
        this.promptQueues.set(sessionId, queue);
        this.hooks.emit({ kind: "promptQueueCleared", sessionId });
        for (const q of queue) this.hooks.emit({ kind: "promptQueued", sessionId, prompt: q });
        this.persistQueue(sessionId);
        return;
      }
      // The wire settled: the words were spent — rendered as a user
      // message with an honest error turn, same as a direct prompt that
      // fails. Re-holding would duplicate the send, and a deterministic
      // rejection would retry forever off its own turn's end.
      this.log.info(`session ${sessionId}: queued prompt failed — ${err.message}`);
    });
  }

  /** Durable copies of the queue and the chip row — written through at
   * every mutation so a window reload finds the truth. Resolution through
   * sessions-or-known: both live and merely-listed sessions persist. */
  private persistQueue(sessionId: string): void {
    const agentId = this.sessions.get(sessionId)?.agentId ?? this.known.get(sessionId)?.agentId;
    if (agentId === undefined) return;
    this.hooks.onContinuity?.(sessionId, agentId, {
      queue: [...(this.promptQueues.get(sessionId) ?? [])],
    });
  }

  private persistChips(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    const agentId = session?.agentId ?? this.known.get(sessionId)?.agentId;
    if (agentId === undefined) return;
    const chips = session?.pendingContext ?? this.contextStash.get(sessionId) ?? [];
    this.hooks.onContinuity?.(sessionId, agentId, { chips: chips.map(persistChip) });
  }

  /** Decodes persisted chips back into the view (image bytes read from the
   * attachments stash) — and into the stash map, which the attach ceremony
   * installs into pendingContext exactly like an in-window detach. A chip
   * whose stash file the OS reclaimed drops honestly, logged; the durable
   * row is rewritten so the husk doesn't return next reload. */
  private async rehydrateChips(sessionId: string, persisted: readonly PersistedChip[]): Promise<void> {
    const chips: ContextChip[] = [];
    for (const chip of persisted) {
      if (chip.kind === "image") {
        const content = await readStashedImage(chip.file);
        if (content === null) {
          this.log.info(`session ${sessionId}: pasted image "${chip.label}" not rehydrated — stash file gone`);
          continue;
        }
        chips.push({ kind: "image", id: chip.id, label: chip.label, mimeType: chip.mimeType, content });
      } else if (chip.kind === "attachment") {
        chips.push({
          kind: "attachment",
          id: chip.id,
          label: chip.label,
          path: chip.path,
          ...(chip.mimeType !== undefined ? { mimeType: chip.mimeType } : {}),
        });
      } else {
        chips.push({
          kind: chip.kind,
          id: chip.id,
          label: chip.label,
          content: chip.content,
          ...(chip.sourceUri !== undefined ? { sourceUri: chip.sourceUri } : {}),
        });
      }
    }
    // The reads above are async: the session may have been closed or
    // pruned meanwhile — applying now would ghost a stash entry no
    // teardown will ever remove and emit chips into a deleted view row.
    if (!this.known.has(sessionId)) return;
    if (chips.length > 0) {
      const session = this.sessions.get(sessionId);
      if (session !== undefined) session.pendingContext.push(...chips);
      else this.contextStash.set(sessionId, [...(this.contextStash.get(sessionId) ?? []), ...chips]);
      for (const chip of chips) this.hooks.emit({ kind: "contextChipAdded", sessionId, chip });
    }
    if (chips.length < persisted.length) this.persistChips(sessionId);
  }

  /** The auth lock's release valve: when an agent's lock clears, fire the
   * next held prompt of each of its sessions. An idle session has no
   * coming turn end to drain it — without this, words held at the
   * turn-start door would wait forever behind a login that already
   * happened. */
  drainHeldQueues(agentId: string): void {
    for (const sessionId of [...this.promptQueues.keys()]) {
      const owner = this.sessions.get(sessionId)?.agentId ?? this.known.get(sessionId)?.agentId;
      if (owner === agentId) this.drainQueue(sessionId);
    }
  }

  async stopTurn(sessionId: string, opts?: { keepHeldWords?: boolean }): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Stop means stop: queued prompts go with the cancelled turn — draining
    // them after a deliberate stop would restart what the user just ended.
    // A reload's cancel is plumbing, not the user ending the work: it keeps
    // its held words (keepHeldWords) and re-drains after the re-attach.
    if (opts?.keepHeldWords !== true) this.clearPromptQueue(sessionId);
    await this.pool.cancel(session.poolKey, sessionId);
  }

  /** Drops one still-queued prompt (composer row × button). */
  removeQueuedPrompt(sessionId: string, promptId: string): void {
    const queue = this.promptQueues.get(sessionId);
    const index = queue?.findIndex((q) => q.id === promptId) ?? -1;
    if (queue === undefined || index === -1) return;
    queue.splice(index, 1);
    this.hooks.emit({ kind: "promptUnqueued", sessionId, promptId });
    this.persistQueue(sessionId);
  }

  private clearPromptQueue(sessionId: string): void {
    if ((this.promptQueues.get(sessionId)?.length ?? 0) > 0) {
      this.hooks.emit({ kind: "promptQueueCleared", sessionId });
      this.promptQueues.delete(sessionId);
      this.persistQueue(sessionId);
      return;
    }
    this.promptQueues.delete(sessionId);
  }

  /** Honest interruption: a live turn is cancelled (per the spec)
   * and awaited to settle before the caller rips the session out from under
   * it — the turn's own end (turnEnded, the tool-call sweep) must land
   * first, or it would write into a session that no longer exists. Bounded:
   * a hung agent gets CANCEL_SETTLE_MS, then the caller proceeds anyway —
   * a wedged process must not make a session unclosable. */
  private async interruptTurn(
    sessionId: string,
    opts?: { keepHeldWords?: boolean },
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || !session.inFlight) return;
    await this.stopTurn(sessionId, opts).catch(() => {}); // a dead connection stops nothing — proceed
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
    const diffs = new Map<string, { oldText: string; newText: string; saidOld: boolean }>();
    for (const c of content) {
      if (c.type !== "diff" || c.path === undefined || c.newText === undefined) continue;
      diffs.set(c.path, {
        oldText: c.oldText ?? "",
        newText: c.newText,
        // An explicit string (even "") is the agent's claim; null/omitted
        // is silence — the distinction gates both the baseline note and
        // the card-stash backfill below.
        saidOld: typeof c.oldText === "string",
      });
    }
    if (diffs.size === 0) return {}; // content present but no diffs — not a replacement signal for diffs
    let perSession = this.toolDiffs.get(sessionId);
    if (perSession === undefined) {
      perSession = new Map();
      this.toolDiffs.set(sessionId, perSession);
    }
    perSession.set(toolCallId, diffs);
    for (const [path, d] of diffs) {
      if (d.saidOld) {
        // The agent said its pre-image (including an explicit "") — trust it.
        this.noteFileBaseline(sessionId, path, d.oldText);
        this.noteFileChange(sessionId, path, d.newText, emit);
      } else if (this.fileBaseline(sessionId, path) !== null) {
        this.noteFileChange(sessionId, path, d.newText, emit);
      } else {
        // Omitted/null oldText is not "the file was empty" — real bridges
        // send it for existing files, and latching "" here poisoned the
        // session baseline (first-note-wins) into whole-file-is-new.
        void this.captureBaseline(sessionId, path, d.newText, emit);
      }
    }
    return { diffFiles: [...diffs.keys()] };
  }

  /** The no-claim baseline: reads the pre-image from reality (buffer
   * truth) instead of trusting silence. A file that isn't there reads as
   * "" — exactly what the wire's null-means-new-file would have meant —
   * and a misreported existing file gets its true pre-image. On replay no
   * pre-image survives anywhere, so the earliest observable state becomes
   * the baseline ("no change since load" — the minimal lie, not the
   * maximal one). First-note-wins still holds against the fs gate's own
   * capture. */
  private async captureBaseline(
    sessionId: string,
    path: string,
    newText: string,
    emit: (...events: AgentViewEvent[]) => void,
  ): Promise<void> {
    const epoch = this.diffEpoch.get(sessionId) ?? 0;
    const pre = await (this.hooks.readFileLive?.(path).catch(() => "") ?? Promise.resolve(""));
    if (!this.sessions.has(sessionId)) return; // closed while reading — no dead-map entries
    // A reset landed while we read: this pre-image belongs to wiped
    // accounting — the replay re-notes what is real.
    if ((this.diffEpoch.get(sessionId) ?? 0) !== epoch) return;
    this.noteFileBaseline(sessionId, path, pre);
    // The tool card's stash carried the unsaid claim ("" = whole-file-new)
    // — backfill the recovered pre-image so the card's diff and the files
    // panel tell one story. Said entries (including a said-empty real new
    // file) are the agent's own words and stay untouched.
    if (pre !== "") {
      for (const perCall of this.toolDiffs.get(sessionId)?.values() ?? []) {
        const entry = perCall.get(path);
        if (entry !== undefined && !entry.saidOld && entry.oldText === "") entry.oldText = pre;
      }
    }
    this.noteFileChange(sessionId, path, newText, emit);
  }

  /** Re-reads reality for every diff-bearing path and re-emits the ± —
   * fired when the files panel opens, so the numbers shown match the diff
   * a click opens (baseline vs the LIVE file, not the agent's last
   * report: terminal edits, user edits, and reverts all move the file
   * after a report). No watcher, deliberately — reality is read at the
   * moment someone looks. */
  async refreshFileDiffStats(sessionId: string): Promise<void> {
    const perSession = this.fileBaselines.get(sessionId);
    const read = this.hooks.readFileLive;
    if (perSession === undefined || read === undefined) return;
    const epoch = this.diffEpoch.get(sessionId) ?? 0;
    for (const [path, baseline] of [...perSession]) {
      const live = await read(path).catch(() => "");
      if (!this.sessions.has(sessionId)) return;
      if ((this.diffEpoch.get(sessionId) ?? 0) !== epoch) return;
      const { additions, deletions } = computeLineDiff(baseline, live);
      const prev = this.fileStats.get(sessionId)?.get(path);
      if (prev !== undefined && prev.additions === additions && prev.deletions === deletions) continue;
      let stats = this.fileStats.get(sessionId);
      if (stats === undefined) {
        stats = new Map();
        this.fileStats.set(sessionId, stats);
      }
      stats.set(path, { additions, deletions });
      this.hooks.emit({ kind: "fileDiffStatChanged", sessionId, path, additions, deletions });
    }
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
    const entry = this.toolDiffs.get(sessionId)?.get(toolCallId)?.get(path);
    // saidOld is stash bookkeeping (the backfill gate), not diff content.
    return entry !== undefined ? { oldText: entry.oldText, newText: entry.newText } : null;
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
  handleUpdate(agentId: string, notification: SessionNotification): void {
    const { sessionId, update } = notification;
    // The one identity guard, at the one door every inbound update rides
    // through: session ids are only unique per agent connection, so two
    // agents can legally mint the same string. An update whose sender
    // isn't the session's owner would write one agent's traffic into
    // another's transcript — drop it here, loudly, and nothing deeper
    // ever re-checks.
    const owner = this.sessions.get(sessionId)?.agentId ?? this.known.get(sessionId)?.agentId;
    if (owner !== undefined && owner !== agentId) {
      this.log.info(
        `session ${sessionId}: update from ${agentId} dropped — session belongs to ${owner}`,
      );
      return;
    }
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
    if (update.updatedAt != null && !Number.isNaN(Date.parse(update.updatedAt))) {
      this.known.set(sessionId, { ...this.known.get(sessionId)!, updatedAt: update.updatedAt });
      // One fact, one truth: the drawer's sort key moves with the row now,
      // not at the next full list sync (the reducer's newest-wins merge
      // absorbs a stale wire stamp).
      this.hooks.emit({
        kind: "sessionListed",
        session: {
          id: sessionId,
          agentId: entry.agentId,
          title: entry.title,
          live: this.sessions.has(sessionId),
          updatedAt: update.updatedAt,
        },
      });
    }
    if (update.title == null) return;
    // An agent-authored title marks the session titled even when the text
    // matches what's shown — the first prompt's auto-title must never
    // clobber it (the agent's title wins, in both directions of time).
    const live = this.sessions.get(sessionId);
    if (live !== undefined) live.titled = true;
    if (update.title === entry.title) return;
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
