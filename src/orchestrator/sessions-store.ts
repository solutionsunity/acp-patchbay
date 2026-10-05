// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The sessions store: the one home of sessions. A row per session patchbay
// knows — created here, or named by its agent's own `session/list` — under
// patchbay's own id, the agent's id for it the handle every wire call
// carries. Its saved facts live on the session's continuity row, read when
// needed; its live facts are the attachment and the running turn; and every
// operation on a session is here: create, open (the attach ladder), prompt,
// stop, reload, close, a knob set, roots, the held words, release, list.
// A store only: when an operation on a session's connection runs is the
// orchestrator's call — every door reaches those through its session
// gates; saves never wait. A session's transcript as its updates arrive is
// the stream's (session-stream.ts); the transcript itself lives in the
// view state, updated only through the shared reducer — disposable, rebuilt
// by replay, never merged.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ContentBlock,
  McpServer,
  SessionInfo,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  type AgentStatus,
  type AgentViewEvent,
  type ChatBlock,
  type ContextChip,
  type KnobSeed,
  type PersistedChip,
  type PromptPart,
  type QueuedPrompt,
  type SessionContinuity,
  type SessionSummary,
  type TurnUsage,
  type UserPart,
} from "../shared/protocol";
import { imageFileName, readStashedImage, stashedPath, stashImage } from "./attachments";
import {
  applyConfigUpdate,
  applyModeUpdate,
  applySeedToFixedPoint,
  confirmedFromKnobs,
  NO_KNOBS,
  normalizeKnobs,
  routeKnobSet,
  type KnobWire,
  performKnobSet,
  type NormalizedKnobs,
} from "./knobs";
import { sessionKnobExtras } from "./extensions";
import { nullLogger, type Logger } from "./logger";
import { unlessAborted, untilGivenUp } from "./abort";
import type { AttachedServer } from "./mcp-servers-store";
import type { AgentPool } from "./pool";
import { newBlockId, SessionStream, type StreamState } from "./session-stream";
import type { SessionContinuityStore } from "./stores/session-continuity";
import { boundedText } from "./content-parts";
import type { PatchbayAgentId } from "../shared/ids";
import type { PatchbayMcpServerId } from "../shared/ids";

/** A `sessionId` is patchbay's own id for a session — the row's — wherever
 * it isn't named the agent's. */
export interface SessionsStoreHooks {
  emit(...events: AgentViewEvent[]): void;
  /** Advance canonical render state without a webview patch — the
   * session/load replay window. Absent → falls back to `emit` (tests,
   * patch-per-event). */
  emitSilent?(...events: AgentViewEvent[]): void;
  /** Closes a silent window: one wholesale webview sync from canonical
   * state — the replay lands as a single swap, never a patch flood. */
  resyncView?(): void;
  /** The knob seed a session starts from on *entry* — a fresh session, or a
   * history session attached with no live combination in hand (folded,
   * knob-id-keyed — knobs.ts foldSeed). Which seed that is — the agent
   * config's defaults or the composer's per-agent combination — is the
   * orchestrator's policy (Preferences knobSource), not knowledge held here. */
  seedFor?(patchbayAgentId: PatchbayAgentId): KnobSeed | undefined;
  /** Fires when the *user* sets a knob and the agent confirms it — the
   * composer-knobs record behind the last-session knobSource preference
   * (stores/composer-knobs.ts). Deliberately not wired to publishKnobs:
   * attach-time publishes carry agent-reset state, and recording those made
   * "last used" mean "last attached". */
  onKnobsConfirmed?(patchbayAgentId: PatchbayAgentId, seed: KnobSeed): void;
  /** Fires when a real session attaches on an agent (new/load/resume, at
   * the one attach ceremony) — the deferred-probe trigger for latched
   * agents (capability-tracker.noteRealSessionOpened via the orchestrator;
   * extensions/first-session-mcp-latch). Probe sessions never pass through
   * here, which is exactly what makes this the honest "real session" fact.
   * The id is the agent's: probe sessions are known by it. */
  onRealSessionAttached?(patchbayAgentId: PatchbayAgentId, agentSessionId: string): void;
  /** The session's root list moved (a root added or removed, a workspace
   * folder came or went) — the orchestrator tells the session's MCP
   * subprocesses, which re-read `rootsOf`. Fired for attached sessions
   * only: a session with no live attachment has no subprocesses to tell,
   * and its next load or resume spawns ones that read the list fresh. A
   * `session/new` is the exception, fired at birth: its subprocesses start
   * before the agent has named the session, so any early read found none. */
  rootsChanged?(sessionId: string): void;
  /** The saved roots, both scopes as stored (this workspace's first) —
   * read when a session is born, never after. */
  savedRoots?(): readonly string[];
  /** Whether a root is a folder on disk right now — read at every
   * lifecycle request and every server read. Absent: every root is. */
  rootExists?(path: string): boolean;
  /** Roots a lifecycle request skipped because they are gone from disk —
   * the orchestrator re-reads the saved lists' marks. */
  rootsMissing?(paths: readonly string[]): void;
  /** The open workspace's folders, read from reality at every composition
   * (never stored — a reload reads them again). The first is the session
   * cwd; the rest reach the agent as additional directories, so the wire
   * carries exactly the list the roots chip counts. */
  workspaceRoots?(): readonly string[];
  /** The render cache as it currently stands (AgentViewState-held) — the
   * resume rung shows it behind the seam notice: it's the only history
   * there is (patchbay persists no transcripts). */
  currentTranscript?(sessionId: string): readonly ChatBlock[];
  /** Whether `session.delete` is declared *and used* — gates the agent-side
   * delete on close (features gate on used). */
  isDeleteUsed?(patchbayAgentId: PatchbayAgentId): boolean;
  /** Whether this session is on view — the sidebar's active one or a
   * pinned window's. The idle sweep exempts it (the visible chat's state
   * never changes under the user, and the composer, whose draft must block
   * a close, only exists for a viewed session), and it attaches again when
   * its agent comes up — one on-view set, both readers. */
  isActiveSession?(sessionId: string): boolean;
  /** The blue mark: a turn completed while the session wasn't open in the
   * view and the user hasn't looked yet — the reaper must not close under
   * an unseen result (reducer-derived `unseen` on the session summary). */
  isUnseen?(sessionId: string): boolean;
  /** The session's open asks (permission, file write, terminal command,
   * elicitation — the broker holds them) are answered cancelled: a turn
   * told to stop owes the agent that answer (an ACP MUST), and so does a
   * session that closes. */
  cancelAsks?(sessionId: string): void;
  /** Standing auth lock on this agent (the orchestrator's persisted,
   * evidence-gated auth state). While it holds, no turn may start: the
   * turn-start door queues the words instead of firing them into a wire
   * already witnessed to refuse — and the drain holds until the lock's
   * clearing releases it. */
  authLocked?(patchbayAgentId: PatchbayAgentId): boolean;
  /** A zero-turn re-mint gave the session a new id on the agent's side —
   * what keys on that id outside this store (the last-open pointer)
   * follows it. */
  handleChanged?(sessionId: string): void;
}

/** session/list pagination guard: 50 pages of history for one workspace is
 * beyond any honest agent — past it, merge what arrived but never prune. */
const MAX_LIST_PAGES = 50;

/** How long a turn told to stop waits, after its cancel, for the agent to
 * end it — then it ends here, so a Stop, a Reload or a Close never waits on
 * an agent that ignores the cancel. */
const CANCEL_SETTLE_MS = 3000;

/** A root path as agents and saved lists receive it: folder pickers hand
 * back "/x/y/", and a directory is never spelled with a trailing
 * separator (a bare "/" stays itself). */
export function normalizeRootPath(path: string): string {
  return path.replace(/(?<=.)[\\/]+$/, "");
}

function deriveTitle(promptText: string): string {
  const flat = promptText.trim().replace(/\s+/g, " ");
  if (flat === "") return "Untitled session";
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
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

/** What the wire's session metadata may move on a row, read one way for
 * every witness (a `session/list` row, `session_info_update`): a title when
 * one came (null is a clear, treated as silence — blank rows help no one),
 * a stamp when one came and parses. An absent field is the wire saying
 * nothing — it rides as nothing, never as a reset. */
function wireMeta(info: { title?: string | null; updatedAt?: string | null }): {
  title?: string;
  updatedAt?: string;
} {
  const updatedAt =
    info.updatedAt != null && !Number.isNaN(Date.parse(info.updatedAt)) ? info.updatedAt : undefined;
  return {
    ...(info.title != null ? { title: info.title } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

/** One session patchbay currently knows to exist — created here this
 * window, or reported by the agent's own `session/list` — under patchbay's
 * own id for it, minted when it enters and kept for the window's life.
 * This is the store's routing index, not a mirror of the row the user
 * sees: a field lives here only if a store code path branches on it — the
 * owning agent and the agent's id for the session (every wire call routes
 * by them). What the user staged and steered — held words, chips, draft,
 * roots, the knob combination — has one home, the session's continuity
 * row, read from its file when needed (`saved`). What the view shows —
 * title, activity stamp, liveness, the unseen mark — has one home, the
 * view's canonical row; the store reports the evidence that moves it and,
 * when it needs such a fact, reads it through a hook (isActiveSession, …)
 * rather than keeping a copy. In-memory, deliberately: the agent is the
 * source of truth for sessions, repopulated every connect (patchbay
 * stores no transcripts, no index). */
interface KnownSession {
  patchbayAgentId: PatchbayAgentId;
  /** The agent's own id for the session — what every wire call carries,
   * and what inbound traffic names it by. Ids are only unique per agent,
   * so the pair names the row. The zero-turn re-mint replaces it; the
   * row, and every holder keyed by the row's id, stays. */
  handle: string;
  /** True once auto-derived from the first prompt, or set by the agent —
   * either way, later auto-titling must not clobber it again. */
  titled: boolean;
  /** At least one prompt has been sent on this session, or it came back
   * from the agent's own list (a listed session has prior turns). This is
   * the "new session" fact: `!everPrompted` blocks the reaper (a new
   * session never auto-closes), makes "add session" focus this one instead
   * of minting a sibling, and picks the ladder's zero-turn rung: until it
   * is set the agent may have persisted nothing — session/load has been
   * observed to 404 *and kill the live session* on a never-prompted id
   * (claude-agent-acp) — so a never-prompted session is minted again
   * rather than loaded. Lives on the row, not the attachment: an
   * involuntary drop keeps the row, and the row must still know it is new. */
  everPrompted: boolean;
}

interface LiveSession extends StreamState {
  /** Also the connection its requests ride: an agent has one process per
   * window, holding every session opened with it. */
  patchbayAgentId: PatchbayAgentId;
  /** Normalized knob state (knobs.ts) — carries the wire surface that
   * drives set routing; the view side only ever sees the knob list. */
  knobs: NormalizedKnobs;
  /** Epoch ms of the last prompt or session/update — the idle reaper's basis. */
  lastActivityAt: number;
  /** A user knob set went out via session/set_mode and its confirmation —
   * the agent's own current_mode_update — hasn't arrived yet. That
   * notification is when the composer-knobs record fires for the modes
   * surface (set_mode's response carries no state, and bridges have
   * reported rejected changes as succeeded — the notification is the only
   * honest confirmation). The config surface records straight off the
   * set_config_option response and never sets this. */
  userModeSetPending: boolean;
}

function liveSession(patchbayAgentId: PatchbayAgentId): LiveSession {
  return {
    patchbayAgentId,
    openRun: null,
    knobs: NO_KNOBS,
    inFlight: false,
    lastActivityAt: Date.now(),
    openToolCalls: new Set(),
    replayTurnDirty: false,
    userModeSetPending: false,
  };
}

/** An agent's id for a session, with its agent — ids are only unique per
 * agent, so this is what names one row. (The continuity store keys its
 * rows the same way on disk; that key is a storage format, this one an
 * index in memory — each may change without the other.) */
function handleKey(patchbayAgentId: PatchbayAgentId, handle: string): string {
  return `${patchbayAgentId}\u0000${handle}`;
}

/** The work riding an agent's connection: its conversations, and the
 * turns among them still running. */
export interface OpenWork {
  conversations: number;
  turns: number;
}

/** The operations that ride a session's connection — every door reaches
 * them through the session gates, which order them on the session's
 * lines. */
export type SessionConnectionOperations = Pick<
  SessionsStore,
  "hydrate" | "reload" | "close" | "setKnob" | "reapplyRoots" | "release" | "runTurn"
>;

export class SessionsStore {
  private sessions = new Map<string, LiveSession>();
  /** Every session known to exist right now (see KnownSession), by
   * patchbay's id for it. */
  private known = new Map<string, KnownSession>();
  /** The same rows by their agent's id for them (handleKey) — how inbound
   * traffic, which names a session the agent's way, finds its row. */
  private byHandle = new Map<string, string>();
  /** Every attach's context token — what the subprocesses an agent spawns
   * from the session's mcpServers carry on each IPC request — with the
   * attach it was minted for: the agent, the session (once it has a row),
   * and which servers it was given. Good from the mint (the agent may start
   * the servers before it answers) until the agent's connection ends, which
   * ends them too: an agent that keeps one server for all its sessions
   * keeps using the first session's token after that session closed. */
  private tokens = new Map<string, { patchbayAgentId: PatchbayAgentId; sessionId?: string; given: readonly AttachedServer[] }>();
  /** Per agent: the agent's ids of sessions that left (closed, or re-minted
   * away from) while a session/list walk may be in flight — a page fetched
   * before that would otherwise resurrect the row with an empty
   * transcript. Each new walk clears its agent's set first: that walk's
   * pages are post-close truth (a failed agent-side delete resurrecting the
   * row then is honest, not stale). */
  private closedDuringSync = new Map<string, Set<string>>();
  /** One `session/list` walk per agent at a time — a re-read asked mid-walk
   * joins the one in flight. Two interleaved walks would each clear the
   * other's close tombstones (closedDuringSync) and race the prune. */
  private walks = new Map<string, Promise<void>>();
  /** In-flight new sessions by agent (see createSession). */
  private creating = new Map<string, Promise<string>>();
  /** The sessions' transcripts as their updates arrive — prose runs, tool
   * calls and their diffs, replay windows. */
  private readonly stream: SessionStream;

  constructor(
    private readonly pool: AgentPool,
    private readonly hooks: SessionsStoreHooks,
    /** Every session's saved facts, one continuity row each — the truth
     * for them, read when needed (see `saved`). */
    private readonly continuity: SessionContinuityStore,
    /** cwd for (re)connecting a session — v1 has one cwd per workspace. */
    private readonly cwd: () => string,
    /** A session's mcpServers for an attach, given the context token to
     * spawn them with — and which servers were given, and how. None (the
     * default) when no MCP server is wired — tests mostly don't need one. */
    private readonly mcpServersFor: (
      contextToken: string,
      patchbayAgentId: PatchbayAgentId,
    ) => Promise<{ servers: McpServer[]; given: readonly AttachedServer[] }> = async () => ({ servers: [], given: [] }),
    /** Output-channel seam (logger.ts). */
    private readonly log: Logger = nullLogger,
  ) {
    this.stream = new SessionStream(hooks, log);
  }

  isLive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  agentFor(sessionId: string): PatchbayAgentId | undefined {
    return this.sessions.get(sessionId)?.patchbayAgentId ?? this.known.get(sessionId)?.patchbayAgentId;
  }

  /** The session an agent means by its own id for it — what every request
   * and notification from the agent names. */
  rowFor(patchbayAgentId: PatchbayAgentId, agentSessionId: string): string | undefined {
    return this.byHandle.get(handleKey(patchbayAgentId, agentSessionId));
  }

  /** The agent's own id for a session — what it answers to on the wire, and
   * what the user copies to find it in the agent's own tools. */
  handleOf(sessionId: string): string | undefined {
    return this.known.get(sessionId)?.handle;
  }

  /** Files a row under its id and its agent's. A page of the agent's own
   * list that crossed this session's creation may have named it first, as
   * a row of its own — that row is this session, and leaves. */
  private bind(sessionId: string, row: KnownSession): void {
    const key = handleKey(row.patchbayAgentId, row.handle);
    const crossed = this.byHandle.get(key);
    if (crossed !== undefined && crossed !== sessionId) this.forget(crossed);
    this.known.set(sessionId, row);
    this.byHandle.set(key, sessionId);
  }

  /** The row leaves both indexes. */
  private unbind(sessionId: string): void {
    const row = this.known.get(sessionId);
    if (row === undefined) return;
    this.known.delete(sessionId);
    const key = handleKey(row.patchbayAgentId, row.handle);
    if (this.byHandle.get(key) === sessionId) this.byHandle.delete(key);
  }

  /** The session's saved facts — what the user staged and steered (held
   * words, chips, draft, roots, the knob combination), read from its
   * continuity row, the one place they live. Empty for a session the store
   * doesn't know. */
  private saved(sessionId: string): SessionContinuity {
    const row = this.known.get(sessionId);
    if (row === undefined) return {};
    return this.continuity.read(row.handle, row.patchbayAgentId) ?? {};
  }

  /** Writes fields of the session's continuity row — an empty value
   * deletes its field. A session the store doesn't know writes nothing. */
  private save(sessionId: string, fields: SessionContinuity): void {
    const row = this.known.get(sessionId);
    if (row !== undefined) this.write(row, fields);
  }

  /** The one continuity write: a patch merges its fields into the row the
   * agent's id names; null forgets the row. */
  private write(row: { patchbayAgentId: PatchbayAgentId; handle: string }, fields: SessionContinuity | null): void {
    void (fields === null
      ? this.continuity.forget(row.handle, row.patchbayAgentId)
      : this.continuity.patch(row.handle, row.patchbayAgentId, this.cwd(), fields)
    ).catch((err: Error) => this.log.error(`session continuity ${row.handle} — ${err.message}`));
  }

  /** The still-new (never-prompted) session for an agent, if one exists —
   * "add session" focuses it instead of minting a sibling: a new session is
   * unclosable, so stacking blank shells helps no one. Rows, not
   * attachments: a never-prompted session whose connection died is still
   * the agent's new session, and its next use re-mints it (the ladder's
   * zero-turn rung). */
  findNeverPrompted(patchbayAgentId: PatchbayAgentId): string | undefined {
    for (const [sessionId, row] of this.known) {
      if (row.patchbayAgentId === patchbayAgentId && !row.everPrompted) return sessionId;
    }
    return undefined;
  }

  /** Every session of an agent patchbay knows, attached or not. */
  ofAgent(patchbayAgentId: PatchbayAgentId): string[] {
    return [...this.known].filter(([, row]) => row.patchbayAgentId === patchbayAgentId).map(([sessionId]) => sessionId);
  }

  /** The sessions attached to an agent's connection. */
  sessionsOn(patchbayAgentId: PatchbayAgentId): readonly string[] {
    return [...this.sessions].filter(([, session]) => session.patchbayAgentId === patchbayAgentId).map(([sessionId]) => sessionId);
  }

  /** What stopping this agent's connection would disconnect: the
   * conversations on it, and the turns among them still running (those are
   * cut off). A never-prompted session doesn't count — it has nothing to
   * lose and is minted again from its row on next use. */
  openWork(patchbayAgentId: PatchbayAgentId): OpenWork {
    let conversations = 0;
    let turns = 0;
    for (const [sessionId, session] of this.sessions) {
      if (session.patchbayAgentId !== patchbayAgentId) continue;
      if (session.inFlight) turns++;
      if (session.inFlight || this.hasTurns(sessionId)) conversations++;
    }
    return { conversations, turns };
  }

  /** The "new session" fact, read from its one home. An id the store does
   * not know is never new — nothing to re-mint from. */
  private hasTurns(sessionId: string): boolean {
    return this.known.get(sessionId)?.everPrompted ?? true;
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
    const agent = this.pool.get(session.patchbayAgentId);
    if (agent?.status !== "running") return; // nothing attached to free
    const declared = agent.declared;
    if (declared?.sessionClose !== true) return;
    if (declared.loadSession !== true) return;
    const handle = this.known.get(sessionId)?.handle;
    if (handle === undefined) return;
    this.dropLiveSession(sessionId, session);
    try {
      await this.pool.closeSession(session.patchbayAgentId, handle);
      this.log.info(`session ${sessionId}: released (${reason})`);
    } catch (err) {
      // Failure means the agent still holds it — the next open re-attaches
      // either way; the suspect mark already landed at the chokepoint.
      this.log.info(`session ${sessionId}: release failed — ${(err as Error).message}`);
    }
  }

  /** The attached sessions the idle reaper may release now — the resource
   * timer is the ONLY thing that ever closes an attached session (switching
   * chats never does), and the gates run it, a release only on a session
   * with nothing in its lines. Auto-close requires ALL of:
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
  idle(idleCloseMs: number): string[] {
    const cutoff = Date.now() - idleCloseMs;
    return [...this.sessions]
      .filter(
        ([sessionId, session]) =>
          this.hasTurns(sessionId) &&
          session.lastActivityAt <= cutoff &&
          !(this.hooks.isActiveSession?.(sessionId) ?? false) &&
          !(this.hooks.isUnseen?.(sessionId) ?? false) &&
          !this.hasHeld(sessionId),
      )
      .map(([sessionId]) => sessionId);
  }

  /** The one attach chokepoint: every wire call that binds a session to a
   * connection (`session/new`, `session/load`, `session/resume`) rides
   * through here, so the ceremony — the context token and what it was
   * given, the MCP server list, canonical roots, knob normalization —
   * exists exactly once. Callers own *policy*: which rung, LiveSession
   * bookkeeping, what the transcript shows, and where the returned knob
   * state is published (event order is theirs, not this method's). A
   * `session/new` has no row to name in its token yet: its caller files
   * the agent's id it returns, then binds the token. */
  private async attachSession(
    target: { via: "new" } | { via: "load" | "resume"; sessionId: string },
    patchbayAgentId: PatchbayAgentId,
    opts: { cwd?: string; roots?: readonly string[] } = {},
    signal?: AbortSignal,
  ): Promise<{ handle: string; contextToken: string; knobs: NormalizedKnobs; missing: string[] }> {
    // Unguessable: the token is what the IPC socket admits a request by.
    const contextToken = randomUUID();
    const { servers: mcpServers, given } = await unlessAborted(this.mcpServersFor(contextToken, patchbayAgentId), signal);
    this.tokens.set(contextToken, {
      patchbayAgentId,
      given,
      ...(target.via !== "new" ? { sessionId: target.sessionId } : {}),
    });
    const cwd = opts.cwd ?? this.cwd();
    // Roots: an explicit list wins (every session/new — a birth seeded
    // from the saved roots, a recreate carrying its own); otherwise the one
    // composition — workspace folders beyond the cwd, then the session's
    // canonical user-added list. A folder gone from disk is skipped, never
    // sent: the list stays the user's, the wire carries what exists.
    const composed = opts.roots ?? this.rootsFor(target.via !== "new" ? target.sessionId : null, cwd);
    const missing = composed.filter((p) => !this.onDisk(p));
    const roots = composed.filter((p) => !missing.includes(p));
    if (missing.length > 0) this.hooks.rootsMissing?.(missing);
    if (target.via === "new") {
      const r = await unlessAborted(this.pool.newSession(patchbayAgentId, cwd, mcpServers, roots), signal);
      this.hooks.onRealSessionAttached?.(patchbayAgentId, r.sessionId);
      // the session isn't in the view yet — its caller says what was skipped
      return {
        handle: r.sessionId,
        contextToken,
        knobs: normalizeKnobs(r.modes, r.configOptions, sessionKnobExtras(r), this.knobDropLog),
        missing,
      };
    }
    const handle = this.known.get(target.sessionId)?.handle;
    if (handle === undefined) throw new Error(`unknown session ${target.sessionId}`);
    // Told to stop, the wait ends here; an answer that comes later finds
    // no attachment to land in.
    const r = await unlessAborted(
      target.via === "load"
        ? this.pool.loadSession(patchbayAgentId, handle, cwd, mcpServers, roots)
        : this.pool.resumeSession(patchbayAgentId, handle, cwd, mcpServers, roots),
      signal,
    );
    this.hooks.onRealSessionAttached?.(patchbayAgentId, handle);
    this.noticeMissingRoots(target.sessionId, missing);
    return {
      handle,
      contextToken,
      knobs: normalizeKnobs(r.modes, r.configOptions, sessionKnobExtras(r), this.knobDropLog),
      missing,
    };
  }

  /** A `session/new`'s token names its session once the session has a
   * row. */
  private bindToken(token: string, sessionId: string): void {
    const grant = this.tokens.get(token);
    if (grant !== undefined) grant.sessionId = sessionId;
  }

  /** Whether a token was minted at an attach on a connection still up —
   * the IPC socket answers nothing else. */
  admits(token: string): boolean {
    return this.tokens.has(token);
  }

  /** The session a token's attach served, while that session is known. */
  sessionOfToken(token: string): string | undefined {
    const sessionId = this.tokens.get(token)?.sessionId;
    return sessionId !== undefined && this.known.has(sessionId) ? sessionId : undefined;
  }

  /** The agent a server was given to under a token through the bridge —
   * the one delivery that asks patchbay for the server's credential. */
  bridgedTo(token: string, patchbayMcpServerId: PatchbayMcpServerId): PatchbayAgentId | undefined {
    const grant = this.tokens.get(token);
    return grant?.given.some((s) => s.id === patchbayMcpServerId && s.delivery === "bridge") === true ? grant.patchbayAgentId : undefined;
  }

  /** Every token a session's attaches were given — what its subprocesses
   * were spawned with. */
  tokensOf(sessionId: string): string[] {
    return [...this.tokens].filter(([, grant]) => grant.sessionId === sessionId).map(([token]) => token);
  }

  private onDisk(path: string): boolean {
    return this.hooks.rootExists?.(path) ?? true;
  }

  /** Says, in the session, which roots its last lifecycle request skipped
   * — never a silent narrowing of what the user set up. */
  private noticeMissingRoots(sessionId: string, missing: readonly string[]): void {
    if (missing.length === 0) return;
    const blocks = this.hooks.currentTranscript?.(sessionId) ?? [];
    const notice: ChatBlock = {
      kind: "notice",
      id: newBlockId("notice"),
      text: `Not found on disk, so neither the agent nor the MCP servers got ${missing.length === 1 ? "this root" : "these roots"}: ${missing.join(", ")}. Restore the folder, or remove it from the roots (saved ones in Settings › Saved roots).`,
    };
    this.stream.emitter(sessionId)({ kind: "transcriptSeeded", sessionId, blocks: [...blocks, notice] });
  }

  /** Sanitizer report channel (knobs.ts guards) — dropped wire entries land
   * in the Output channel, never a crash. */
  private readonly knobDropLog = (message: string): void => this.log.info(message);

  /** A `session/load` with its replay window silenced: the reset and every replayed update
   * reduce into canonical state only — the old pane content stays up (no
   * blank flash, no patch flood) until the closing resync swaps the webview
   * wholesale. The window closes on failure too: canonical was reset, and
   * the webview must not keep showing blocks canonical no longer holds. */
  private async loadSilently(sessionId: string, patchbayAgentId: PatchbayAgentId, signal: AbortSignal): Promise<NormalizedKnobs> {
    this.stream.openReplay(sessionId);
    try {
      const { knobs } = await this.attachSession({ via: "load", sessionId }, patchbayAgentId, {}, signal);
      const session = this.sessions.get(sessionId);
      if (session !== undefined) this.stream.finishReplay(sessionId, session);
      return knobs;
    } finally {
      this.stream.closeReplay(sessionId);
      this.hooks.resyncView?.();
    }
  }

  /** An agent's new session — one at a time: an agent has one new session
   * (findNeverPrompted), and a second ask while the first is still on the
   * wire gets the same one, not a sibling blank shell. */
  createSession(patchbayAgentId: PatchbayAgentId, agentName: string, cwd: string): Promise<string> {
    const inFlight = this.creating.get(patchbayAgentId);
    if (inFlight !== undefined) return inFlight;
    const run = this.mintSession(patchbayAgentId, agentName, cwd).finally(() => {
      if (this.creating.get(patchbayAgentId) === run) this.creating.delete(patchbayAgentId);
    });
    this.creating.set(patchbayAgentId, run);
    return run;
  }

  private async mintSession(patchbayAgentId: PatchbayAgentId, agentName: string, cwd: string): Promise<string> {
    const saved = this.savedRootsFor(cwd);
    const { handle, contextToken, knobs, missing } = await this.attachSession({ via: "new" }, patchbayAgentId, {
      cwd,
      roots: [...this.rootsFor(null, cwd), ...saved],
    });
    const sessionId = randomUUID();
    this.bind(sessionId, { patchbayAgentId, handle, titled: false, everPrompted: false });
    this.bindToken(contextToken, sessionId);
    const seeded = saved.filter((p) => !missing.includes(p));
    this.sessions.set(sessionId, liveSession(patchbayAgentId));
    const now = new Date().toISOString();
    const title = `${agentName} session`;
    const summary: SessionSummary = {
      id: sessionId,
      patchbayAgentId,
      title,
      busy: [],
      updatedAt: now,
    };
    this.hooks.emit({ kind: "sessionCreated", session: summary });
    // The saved roots are this session's own from here on — the same list
    // a user-added root joins.
    if (seeded.length > 0) {
      this.save(sessionId, { roots: seeded });
      this.hooks.emit({ kind: "contextRootsChanged", sessionId, roots: seeded });
    }
    this.noticeMissingRoots(sessionId, missing);
    this.hooks.rootsChanged?.(sessionId);
    this.log.info(`session ${sessionId} created with ${patchbayAgentId}`);
    this.publishKnobs(sessionId, knobs);
    await this.applySeedFor(patchbayAgentId, sessionId);
    return sessionId;
  }

  /** Points the sidebar at a session — the view's pointer, nothing more;
   * the attach that opening runs is the session gates'. */
  point(sessionId: string): void {
    this.hooks.emit({ kind: "sessionActivated", sessionId });
  }

  /** An agent's sessions on view right now — active or pinned, the reaper's
   * exemption set, read through the same hook. When the agent comes up,
   * these attach again: they sat blank, with nothing to attach to. */
  viewed(patchbayAgentId: PatchbayAgentId): string[] {
    return [...this.known]
      .filter(([sessionId, k]) => k.patchbayAgentId === patchbayAgentId && this.hooks.isActiveSession?.(sessionId) === true)
      .map(([sessionId]) => sessionId);
  }

  /** Opening a session: the one attach ladder, with open's exhaustion
   * policy — a failed rung is logged (blank pane + Reload is the honest
   * degraded state), and no rung at all says so with an inline notice:
   * there is nothing in hand and nothing to fetch (patchbay persists no
   * transcripts) — said as such, never faked. Both wire paths are free (no
   * LLM turn). Open never mints a session. True when the session is
   * attached at the end; an agent not running attaches nothing — its
   * coming up attaches what is on view. */
  async hydrate(sessionId: string, signal: AbortSignal): Promise<boolean> {
    if (this.sessions.has(sessionId)) return true;
    const patchbayAgentId = this.known.get(sessionId)?.patchbayAgentId;
    if (patchbayAgentId === undefined) return false;
    if (this.pool.get(patchbayAgentId)?.status !== "running") return false;
    const outcome = await this.attach(sessionId, patchbayAgentId, signal);
    if (outcome.attached) return true;
    if (outcome.reason === "failed") return false;
    // No rung declared: this session cannot be reopened. Reachable only
    // after a crash/reload (the reaper never closes these).
    if ((this.hooks.currentTranscript?.(sessionId) ?? []).length > 0) return false;
    this.hooks.emit({
      kind: "transcriptSeeded",
      sessionId,
      blocks: [{
        kind: "notice",
        id: newBlockId("notice"),
        text: "This agent supports neither session/load nor session/resume — this session's history lives only in the agent and can't be reopened here.",
      }],
    });
    return false;
  }

  /** The session leaves for good — once its turn has ended (the gates end
   * it first: never a session/delete under a live turn). */
  async close(sessionId: string): Promise<void> {
    // Whatever the session still asks, it asks no one now.
    this.hooks.cancelAsks?.(sessionId);
    const row = this.known.get(sessionId);
    this.forget(sessionId);
    if (row !== undefined) {
      // what the user staged on it leaves with it
      this.write(row, null);
      this.entomb(row);
    }
    // Honest close: forgetting a session locally while a delete-capable
    // agent keeps it would just resurrect it on the next session/list sync.
    // Gated on used, not declared; spec makes delete idempotent, and a
    // failure only means the agent still has it — the sync stays truthful.
    if (row !== undefined && (this.hooks.isDeleteUsed?.(row.patchbayAgentId) ?? false)) {
      await this.pool.deleteSession(row.patchbayAgentId, row.handle).catch((err: Error) => {
        this.log.info(`session ${sessionId}: agent-side delete failed — ${err.message}`);
      });
    }
  }

  /** The one way a session leaves for good: its attachment, its diff texts,
   * its row in both indexes, its view row. The continuity row is the
   * caller's — close forgets it, a prune leaves it to the reconcile, and a
   * removed agent's go together. */
  private forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.stream.forget(sessionId);
    this.unbind(sessionId);
    this.hooks.emit({ kind: "sessionClosed", sessionId });
  }

  /** Shield against a session/list walk already in flight: its earlier
   * pages predate this session's leaving and must not bring it back. */
  private entomb(row: { patchbayAgentId: PatchbayAgentId; handle: string }): void {
    let tombs = this.closedDuringSync.get(row.patchbayAgentId);
    if (tombs === undefined) this.closedDuringSync.set(row.patchbayAgentId, (tombs = new Set()));
    tombs.add(row.handle);
  }

  /** "Disconnect & erase all data": every session's bookkeeping goes
   * at once — the processes are already down; the UI rows leave via the
   * orchestrator's sessionClosed events. */
  reset(): void {
    this.sessions.clear();
    this.known.clear();
    this.byHandle.clear();
    this.stream.reset();
    this.closedDuringSync.clear();
    this.tokens.clear();
  }

  /** A removed agent's session rows leave the view — nothing of them is
   * stored anywhere (agent removal removes only patchbay's config; the
   * sessions live on in the agent and reappear via `session/list` on a
   * re-add). No agent-side delete: the process is already gone. */
  forgetAgentSessions(patchbayAgentId: PatchbayAgentId): void {
    for (const [sessionId, entry] of [...this.known]) {
      if (entry.patchbayAgentId === patchbayAgentId) this.forget(sessionId);
    }
    this.closedDuringSync.delete(patchbayAgentId);
    // Same contract as the auth lock: cleared with the agent's config — a
    // removed agent's rows have no walk left to reconcile them. By agent,
    // not by index: rows of other workspaces were never indexed here.
    void this.continuity
      .forgetAgent(patchbayAgentId)
      .catch((err: Error) => this.log.error(`session continuity drop ${patchbayAgentId} — ${err.message}`));
  }

  /** Sessions ride their agent's connection: any status but running — a
   * Stop, a crash, a fresh connection starting — means the one they rode
   * has ended, and they detach. */
  agentStatusChanged(patchbayAgentId: PatchbayAgentId, status: AgentStatus): void {
    if (status !== "running") this.invalidateAgent(patchbayAgentId);
  }

  /** Drops bookkeeping for sessions whose connection just died — a stale
   * sessionId cannot be used on a new connection until reopened — and the
   * tokens its attaches minted: the subprocesses holding them ended with
   * it. */
  invalidateAgent(patchbayAgentId: PatchbayAgentId): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.patchbayAgentId !== patchbayAgentId) continue;
      this.dropLiveSession(sessionId, session);
    }
    for (const [token, grant] of this.tokens) {
      if (grant.patchbayAgentId === patchbayAgentId) this.tokens.delete(token);
    }
  }

  /** The shared drop helper: the one way a session detaches from its
   * connection and stays known — a crash, a stop, idle release, a reload,
   * a failed roots re-apply. Order matters, because this runs
   * synchronously inside the process's exit handler while the dying
   * prompt's rejection lands a microtask later: the sweep and seal must
   * happen HERE, on the session that still holds the open tool calls and
   * the rewriter tail — endTurn will find the session gone and can only
   * place the turn-end block. What the user staged stays on the session's
   * continuity row, untouched: held words (only the user discards words —
   * Stop, the row's ×, close; the drain's running-agent gate holds them
   * until a reattach can send), chips, draft, roots, knobs. */
  private dropLiveSession(sessionId: string, session: LiveSession): void {
    if (session.inFlight) {
      this.stream.sweep(sessionId, session);
      this.stream.seal(sessionId, session);
    }
    this.sessions.delete(sessionId);
  }

  /** Reads the agent's own session history (`session/list`, cwd-filtered
   * to this workspace) into the view — run on every connect of a
   * list-capable agent. The wire list is the ONLY list (patchbay persists
   * no session records): agents without the capability show just their
   * currently-open sessions — a deliberate scope decision. Pruning —
   * dropping known rows the agent no longer reports — only happens after a
   * *complete* pagination walk: a truncated read must never erase. */
  async syncAgentSessions(patchbayAgentId: PatchbayAgentId): Promise<void> {
    if (this.pool.get(patchbayAgentId)?.declared?.sessionList !== true) {
      // No list will ever name a session of this agent again, so a row of
      // this workspace that no session of this window holds has no reader
      // left — an earlier window's go; this window's stay with its sessions.
      this.reconcile(patchbayAgentId, (handle) => this.rowFor(patchbayAgentId, handle) !== undefined);
      return;
    }
    await this.walkAgentSessions(patchbayAgentId);
  }

  /** The agent's continuity rows for this workspace, held against what
   * names them: `keep` false, the row leaves. */
  private reconcile(patchbayAgentId: PatchbayAgentId, keep: (agentSessionId: string) => boolean): void {
    void this.continuity
      .reconcile(patchbayAgentId, this.cwd(), keep)
      .catch((err: Error) => this.log.error(`session continuity reconcile ${patchbayAgentId} — ${err.message}`));
  }

  /** The user is about to read the list (drawer opening, palette pick):
   * re-read every running agent's own `session/list`, so activity from
   * another window or another client is on the rows — reality at the
   * moment of need, never polled. Per-agent failures log and stop nothing:
   * one agent's bad page must not hold the others' rows. */
  async syncRunningAgents(): Promise<void> {
    await Promise.all(
      this.pool
        .list()
        .filter((agent) => agent.status === "running" && agent.declared?.sessionList === true)
        .map((agent) =>
          this.walkAgentSessions(agent.spec.patchbayAgentId).catch((err: Error) => {
            this.log.info(`${agent.spec.patchbayAgentId}: session/list re-read failed — ${err.message}`);
          }),
        ),
    );
  }

  /** Shared by the connect-time sync and the on-demand re-read; capability
   * gating is the callers' business. Coalesced per agent (see `walks`). */
  private walkAgentSessions(patchbayAgentId: PatchbayAgentId): Promise<void> {
    const inFlight = this.walks.get(patchbayAgentId);
    if (inFlight !== undefined) return inFlight;
    const walk = this.readAgentSessions(patchbayAgentId).finally(() => {
      if (this.walks.get(patchbayAgentId) === walk) this.walks.delete(patchbayAgentId);
    });
    this.walks.set(patchbayAgentId, walk);
    return walk;
  }

  /** The walk itself — every page merged row by row, the prune only after a
   * complete read. */
  private async readAgentSessions(patchbayAgentId: PatchbayAgentId): Promise<void> {
    this.closedDuringSync.delete(patchbayAgentId);
    const cwd = this.cwd();
    const seen = new Set<string>();
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const response = await this.pool.listSessions(patchbayAgentId, {
        cwd,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      // Rows arrive through the response trust boundary (pool's chokepoint):
      // identity-less rows are already dropped, bad sort keys degraded.
      for (const info of response.sessions) {
        // Re-filter defensively: the cwd param is a request, not a contract.
        if (info.cwd !== cwd) continue;
        seen.add(info.sessionId);
        this.noteListedSession(patchbayAgentId, info);
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
        this.log.info(`${patchbayAgentId}: session/list nextCursor is malformed — sync merged, prune skipped`);
        return;
      }
      cursor = response.nextCursor;
    }
    if (!complete) {
      this.log.info(`${patchbayAgentId}: session/list still paging after ${MAX_LIST_PAGES} pages — sync merged, prune skipped`);
      return;
    }
    for (const [sessionId, entry] of [...this.known]) {
      if (entry.patchbayAgentId !== patchbayAgentId || seen.has(entry.handle) || this.sessions.has(sessionId)) continue;
      // The wire is the truth for who exists — a session the agent no
      // longer reports (deleted externally, or a zero-turn shell it never
      // persisted) is gone; live sessions are exempt (a just-created id may
      // trail the agent's own list).
      this.forget(sessionId);
      this.log.info(`session ${sessionId}: gone from ${patchbayAgentId}'s own list — dropped`);
    }
    // The durable rows by the same truth, index or not: a session deleted
    // while no window was open never entered `known`, and its row would
    // otherwise outlive it. Same live exemption as above.
    const attached = new Set(
      this.sessionsOn(patchbayAgentId).flatMap((sessionId) => this.known.get(sessionId)?.handle ?? []),
    );
    this.reconcile(patchbayAgentId, (handle) => seen.has(handle) || attached.has(handle));
  }

  /** One listed session into the view. Title rule: the agent's title wins
   * (patchbay-side rename is gone — ACP has no rename request; in-chat
   * agent commands like /rename round-trip through the agent's own list
   * and session_info_update). */
  private noteListedSession(patchbayAgentId: PatchbayAgentId, info: SessionInfo): void {
    if (this.closedDuringSync.get(patchbayAgentId)?.has(info.sessionId) === true) return;
    const existing = this.rowFor(patchbayAgentId, info.sessionId);
    const now = new Date().toISOString();
    if (existing === undefined) {
      // A session patchbay never saw — created externally (CLI, another
      // editor) or in a previous window. The wire's stamp orders it; an
      // agent that sends none leaves first sight as the only honest stamp.
      const meta = wireMeta(info);
      const title = meta.title ?? "Untitled session";
      const at = meta.updatedAt ?? now;
      // The durable continuity row re-enters with the session — the fields
      // the wire list cannot carry stay there, read as they are needed; the
      // view gets them now: roots, held words and draft at once, chips once
      // their image bytes are read back from the stash (rehydrateChips).
      const sessionId = randomUUID();
      this.bind(sessionId, {
        patchbayAgentId,
        handle: info.sessionId,
        titled: true,
        everPrompted: true, // listed = persisted agent-side = prior turns
      });
      const saved = this.saved(sessionId);
      this.hooks.emit({
        kind: "sessionListed",
        session: { id: sessionId, patchbayAgentId, title, busy: [], updatedAt: at },
      });
      if (info.additionalDirectories !== undefined) {
        // the view has no list for this session yet; the row may
        this.adoptReportedRoots(sessionId, info.additionalDirectories, []);
      } else if ((saved.roots?.length ?? 0) > 0) {
        this.hooks.emit({ kind: "contextRootsChanged", sessionId, roots: saved.roots! });
      }
      for (const prompt of saved.queue ?? []) this.hooks.emit({ kind: "promptQueued", sessionId, prompt });
      if ((saved.draft ?? "") !== "") {
        this.hooks.emit({ kind: "sessionDraftChanged", sessionId, draft: saved.draft! });
      }
      if ((saved.chips?.length ?? 0) > 0) void this.rehydrateChips(sessionId, saved.chips!);
      return;
    }
    // A session known but not open here: whoever opened it last set its
    // roots, and the report is that list. Open here, patchbay is the last
    // writer and the report can only echo or trail a re-apply in flight —
    // adopting it would revert the chip to a list already replaced.
    if (info.additionalDirectories !== undefined && !this.sessions.has(existing)) {
      // the view shows what the row holds — every change writes both
      this.adoptReportedRoots(existing, info.additionalDirectories, this.addedRootsOf(existing));
    }
    // Only what the wire carried rides — the row's own is the truth
    // otherwise (silence is no event at all), and the reducer's newest-wins
    // keeps a local prompt ahead of a trailing wire read.
    const meta = wireMeta(info);
    if (meta.title === undefined && meta.updatedAt === undefined) return;
    this.hooks.emit({ kind: "sessionRefreshed", sessionId: existing, ...meta });
  }

  /** The agent's own report of a session's roots, from its `session/list`
   * row: the complete list the last lifecycle request set, by whichever
   * client sent it. It replaces the user-added list — never merged with it —
   * after the workspace folders are taken out, since `rootsFor` composes
   * those from reality at every open and the row keeps only what the user
   * added. An omitted field never reaches here: the report is optional, so
   * silence says nothing about the list, and the intended list stands.
   * `shown` is what the view lists now; the row and the view are each
   * written only where they differ, so a walk that reports what is already
   * held moves nothing. */
  private adoptReportedRoots(sessionId: string, reported: readonly string[], shown: readonly string[]): void {
    const folders = new Set(this.hooks.workspaceRoots?.() ?? []);
    const added = reported.filter((p) => !folders.has(p));
    const same = (a: readonly string[]) => a.length === added.length && a.every((p, i) => p === added[i]);
    if (!same(this.addedRootsOf(sessionId))) this.save(sessionId, { roots: added });
    if (!same(shown)) this.hooks.emit({ kind: "contextRootsChanged", sessionId, roots: added });
  }

  /** One-click reload: re-attach on demand, even when the session
   * isn't currently invalidated — the same ladder as every attach
   * (load > resume), so a resume-only agent's reload works too. The turn
   * still streaming into the transcript has ended first (the gates end
   * it), so replay and live stream never interleave. */
  async reload(sessionId: string, signal: AbortSignal): Promise<void> {
    // Live-channel reset, deliberately outside the silent replay window
    // and strictly after the turn ended (the dying turn's tail must not
    // stream into a blanked view): an explicit reload means "what's shown
    // is not trusted" — keeping it up while re-reading would be the cache
    // lying. The view blanks to the same loading page as a cold open (one
    // route); only the *involuntary* re-attach (reopen on connection
    // death) keeps its transcript standing, since there the user asked
    // for nothing and yanking it would be hostile.
    this.hooks.emit({ kind: "transcriptReset", sessionId });
    this.stream.forget(sessionId);
    const dying = this.sessions.get(sessionId);
    if (dying !== undefined) this.dropLiveSession(sessionId, dying);
    await this.ensureAttached(sessionId, signal);
  }

  /** Re-attaches a session after its connection died, via `session/load`
   * replay — the render cache is discarded and rebuilt wholesale, never
   * merged with what patchbay had. A sessionId is connection-scoped: without
   * replay there is no protocol-legal way to resume it on the new
   * connection. */
  private async reopen(sessionId: string, patchbayAgentId: PatchbayAgentId, signal: AbortSignal): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    const declared = this.pool.get(patchbayAgentId)?.declared;
    if (!declared?.loadSession) {
      throw new Error(
        `session ${sessionId} is no longer live and ${patchbayAgentId} does not support session/load`,
      );
    }
    this.sessions.set(sessionId, liveSession(patchbayAgentId));
    let knobs: NormalizedKnobs;
    try {
      knobs = await this.loadSilently(sessionId, patchbayAgentId, signal);
    } catch (err) {
      // A failed load must not leave a phantom attachment — callers decide
      // the fallback (the next ladder rung, or an honest failure), and a lingering
      // map entry would make every later prompt hit a session that isn't there.
      this.sessions.delete(sessionId);
      throw err;
    }
    // pool.ts's loadSession already marked "session.load" used the instant
    // the RPC succeeded — this only has to update the render state.
    this.log.info(`session ${sessionId} reopened via session/load on ${patchbayAgentId}`);
    this.publishKnobs(sessionId, knobs);
  }

  /** THE attach ladder — the rung order exists here and nowhere else.
   * First the zero-turn rung: a never-prompted session has nothing
   * agent-side to load or resume, so it is minted again from its row —
   * the agent gives it a fresh id, the session stays itself, everything
   * the user staged still on it — and not a continuation faked (there was
   * nothing to continue: a new session knows it is new). Then
   * `session/load` wherever declared (the only path where what the user
   * sees and what the agent remembers are provably the same), else
   * `session/resume` (the agent's real memory behind an honest seam
   * notice). Nothing below: patchbay never mints a session and calls it a
   * continuation. Exhaustion is the caller's policy, so the outcome is
   * returned, not thrown: `failed` = a declared rung broke (logged here,
   * suspect mark already landed at the wire chokepoint); `no-rung` = the
   * agent declares neither. Told to stop, it stops where it waits and
   * throws — a stop is no rung's failure. */
  private async attach(
    sessionId: string,
    patchbayAgentId: PatchbayAgentId,
    signal: AbortSignal,
  ): Promise<
    | { attached: true }
    | { attached: false; reason: "failed"; error: Error }
    | { attached: false; reason: "no-rung" }
  > {
    if (this.sessions.has(sessionId)) return { attached: true };
    if (!this.hasTurns(sessionId)) {
      await this.recreateEmpty(sessionId, undefined, signal);
      return { attached: true };
    }
    const declared = this.pool.get(patchbayAgentId)?.declared;
    // Read before any rung publishes: the attach's own publishKnobs
    // overwrites this snapshot with the agent's reset state.
    const remembered = this.saved(sessionId).knobs;
    let error: Error | undefined;
    if (declared?.loadSession) {
      try {
        await this.reopen(sessionId, patchbayAgentId, signal);
        await this.reseedAfterAttach(sessionId, patchbayAgentId, remembered, signal);
        return { attached: true };
      } catch (err) {
        if (signal.aborted) throw err;
        // The agent may no longer hold this session — descend to resume
        // rather than erroring forever.
        error = err as Error;
        this.log.info(`session ${sessionId}: load failed, descending the ladder — ${error.message}`);
      }
    }
    if (declared?.sessionResume) {
      try {
        await this.resumeReattach(sessionId, patchbayAgentId, signal);
        await this.reseedAfterAttach(sessionId, patchbayAgentId, remembered, signal);
        return { attached: true };
      } catch (err) {
        this.sessions.delete(sessionId);
        if (signal.aborted) throw err;
        error = err as Error;
        this.log.info(`session ${sessionId}: resume failed — ${error.message}`);
      }
    }
    if (error !== undefined) return { attached: false, reason: "failed", error };
    return { attached: false, reason: "no-rung" };
  }

  /** The attach a reload must land: attach or throw, so a reload with no
   * session behind it fails loudly on its caller's error channel. */
  private async ensureAttached(sessionId: string, signal: AbortSignal): Promise<void> {
    const patchbayAgentId = this.known.get(sessionId)?.patchbayAgentId;
    if (patchbayAgentId === undefined) throw new Error(`unknown session ${sessionId}`);
    const outcome = await this.attach(sessionId, patchbayAgentId, signal);
    if (outcome.attached) return;
    throw outcome.reason === "failed" ? outcome.error : new Error(this.notAttached(sessionId));
  }

  /** Why a session has no attachment, for its caller's error channel. */
  private notAttached(sessionId: string): string {
    const patchbayAgentId = this.agentFor(sessionId);
    const agent = patchbayAgentId === undefined ? undefined : this.pool.get(patchbayAgentId);
    if (patchbayAgentId === undefined || agent?.status !== "running") {
      return `session ${sessionId} is not attached: ${patchbayAgentId ?? "its agent"} is not running`;
    }
    if (agent.declared?.loadSession !== true && agent.declared?.sessionResume !== true) {
      return `session ${sessionId} is not live and ${patchbayAgentId} declares neither session/load nor session/resume`;
    }
    return `session ${sessionId} could not be attached`;
  }

  /** The resume rung: re-attaches via `session/resume` — no replay, so the
   * displayed history is whatever the in-memory render cache still holds
   * (patchbay persists no transcripts), closed with a seam notice marking
   * where it ends and the agent's unreplayed memory continues. Never merged
   * with replay — there is none. */
  private async resumeReattach(sessionId: string, patchbayAgentId: PatchbayAgentId, signal: AbortSignal): Promise<void> {
    this.sessions.set(sessionId, liveSession(patchbayAgentId));
    const { knobs } = await this.attachSession({ via: "resume", sessionId }, patchbayAgentId, {}, signal);
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
    this.log.info(`session ${sessionId} resumed (no replay) on ${patchbayAgentId}`);
    this.publishKnobs(sessionId, knobs);
  }

  /** The user's knob-set entry point (knobs.ts routes and performs it). A
   * knob or value the session doesn't offer is a silent no-op — patchbay
   * never invents a knob. A throw propagates: the caller shows the error. */
  async setKnob(sessionId: string, knobId: string, value: string | boolean): Promise<void> {
    const session = this.sessions.get(sessionId);
    const handle = this.known.get(sessionId)?.handle;
    if (!session || handle === undefined) return;
    const route = routeKnobSet(session.knobs, knobId, value);
    if (route === null) return;
    // Composer recording for a mode set waits for the agent's
    // current_mode_update — the response carries no state (see
    // userModeSetPending). Flag first: the notification may land before
    // the response resolves.
    if (route.via === "setMode") session.userModeSetPending = true;
    let next: NormalizedKnobs | null;
    try {
      next = await performKnobSet(this.knobWire(session.patchbayAgentId), handle, () => session.knobs, route, value, this.knobDropLog);
    } catch (err) {
      if (route.via === "setMode") session.userModeSetPending = false;
      throw err;
    }
    if (next === null) return; // the agent's own notification confirms
    this.publishKnobs(sessionId, next);
    // A user set, agent-confirmed: this — and only this — is what the
    // composer's per-agent combination records. Attach-time publishes never
    // do (they carry agent-reset state).
    this.hooks.onKnobsConfirmed?.(session.patchbayAgentId, confirmedFromKnobs(next));
  }

  /** The wire one routed set needs, bound to this session's connection —
   * its calls name the session the agent's way. The surface a set advances
   * from travels alongside at set time, not route time — it must be the
   * state as it stands then. */
  private knobWire(patchbayAgentId: PatchbayAgentId): KnobWire {
    return {
      setMode: (sessionId, modeId) => this.pool.setSessionMode(patchbayAgentId, sessionId, modeId),
      setConfigOption: (sessionId, configId, value) =>
        this.pool.setSessionConfigOption(patchbayAgentId, sessionId, configId, value),
      send: (method, params) => this.pool.unstableRequest(patchbayAgentId, method, params),
    };
  }

  /** The one exit for knob state: stores the normalized truth on the
   * session (set routing reads the surface from it), saves the combination
   * on the session's continuity row (what reseedAfterAttach restores — the
   * agent cannot report it again after it resets knob state on load), and
   * emits the full view replace. */
  private publishKnobs(sessionId: string, knobs: NormalizedKnobs): void {
    const session = this.sessions.get(sessionId);
    if (session) session.knobs = knobs;
    // An empty surface is not a combination — saving it would erase a real
    // one with "this agent offered nothing this time".
    if (knobs.knobs.length > 0) this.save(sessionId, { knobs: confirmedFromKnobs(knobs) });
    this.hooks.emit({ kind: "sessionKnobsSet", sessionId, knobs: knobs.knobs });
  }

  /** Entry seed: applied
   * post-create on a fresh session, and by reseedAfterAttach on a history
   * session entered with no combination in hand. */
  private async applySeedFor(patchbayAgentId: PatchbayAgentId, sessionId: string, signal?: AbortSignal): Promise<void> {
    const seed = this.hooks.seedFor?.(patchbayAgentId);
    if (seed === undefined) return;
    await this.applySeed(sessionId, seed, signal);
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
    patchbayAgentId: PatchbayAgentId,
    remembered: KnobSeed | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (remembered !== undefined) await this.applySeed(sessionId, remembered, signal);
    else await this.applySeedFor(patchbayAgentId, sessionId, signal);
  }

  /** Issues the set requests for a knob seed to a fixed point (knobs.ts
   * applySeedToFixedPoint), each routed and guarded against what this
   * session actually offers at that moment — silently skipped otherwise.
   * Rejections are swallowed: the honest displayed state comes from the
   * agent's own responses/notifications either way. A session that vanished
   * mid-seed reads as an empty surface, which ends the loop; told to stop,
   * it sets nothing more. */
  private async applySeed(sessionId: string, seed: KnobSeed, signal?: AbortSignal): Promise<void> {
    await applySeedToFixedPoint(
      seed,
      () => (signal?.aborted === true ? NO_KNOBS : (this.sessions.get(sessionId)?.knobs ?? NO_KNOBS)),
      async (route, _knobId, value) => {
        const session = this.sessions.get(sessionId);
        const handle = this.known.get(sessionId)?.handle;
        if (!session || handle === undefined || signal?.aborted === true) return;
        try {
          const next = await performKnobSet(this.knobWire(session.patchbayAgentId), handle, () => session.knobs, route, value, this.knobDropLog);
          if (next !== null) this.publishKnobs(sessionId, next);
        } catch {
          // rejected seed entry — the agent's state stands, nothing to repair
        }
      },
    );
  }

  /** Stages a chip for the session's next prompt — on its continuity row,
   * whether the session is attached right now or not. An image's bytes
   * land in the stash first: the row carries only the file, and names it
   * once it exists. */
  async addContext(sessionId: string, chip: ContextChip): Promise<void> {
    if (!this.known.has(sessionId)) return;
    if (chip.kind === "image") {
      try {
        await stashImage(imageFileName(chip.id, chip.mimeType), chip.content);
      } catch (err) {
        this.log.info(`session ${sessionId}: image not staged — the stash refused it: ${(err as Error).message}`);
        return;
      }
      if (!this.known.has(sessionId)) return; // closed while the bytes landed
    }
    this.save(sessionId, { chips: [...(this.saved(sessionId).chips ?? []), persistChip(chip)] });
    this.hooks.emit({ kind: "contextChipAdded", sessionId, chip });
  }

  removeContext(sessionId: string, chipId: string): void {
    const chips = this.saved(sessionId).chips ?? [];
    if (!chips.some((c) => c.id === chipId)) return;
    this.save(sessionId, { chips: chips.filter((c) => c.id !== chipId) });
    this.hooks.emit({ kind: "contextChipRemoved", sessionId, chipId });
  }

  /** The session's user-added roots — its continuity row's list. */
  private addedRootsOf(sessionId: string): readonly string[] {
    return this.saved(sessionId).roots ?? [];
  }

  /** External context roots: the list lives on the session's continuity
   * row, so this stays "append/remove, republish, tell."
   * The list has two readers: the session's MCP servers, told at once
   * (`tellRoots`), and the agent, which ACP tells only on lifecycle
   * requests — so a change re-applies to the live attachment through one
   * (`reapplyRoots`, the gates' to schedule). A root is therefore always
   * accepted — it reaches the servers regardless — and the chip's gate
   * states, from the same declared facts the pool holds, whether and when
   * the agent gets it. True when the list moved. */
  addRoot(sessionId: string, path: string): boolean {
    if (!this.known.has(sessionId)) return false;
    const normalized = normalizeRootPath(path);
    const current = this.addedRootsOf(sessionId);
    if (current.includes(normalized)) return false;
    const next = [...current, normalized];
    this.save(sessionId, { roots: next });
    this.hooks.emit({ kind: "contextRootsChanged", sessionId, roots: next });
    this.tellRoots(sessionId);
    return true;
  }

  removeRoot(sessionId: string, path: string): boolean {
    if (!this.known.has(sessionId)) return false;
    const next = this.addedRootsOf(sessionId).filter((p) => p !== path);
    this.save(sessionId, { roots: next });
    this.hooks.emit({ kind: "contextRootsChanged", sessionId, roots: next });
    this.tellRoots(sessionId);
    return true;
  }

  /** The session's root list moved (a root added or removed, a workspace
   * folder came or went): its MCP servers hear it now, whatever the
   * agent's rung — telling them is patchbay's own act, no lifecycle request
   * involved. A session with no attachment has no servers to tell. */
  tellRoots(sessionId: string): void {
    if (this.sessions.has(sessionId)) this.hooks.rootsChanged?.(sessionId);
  }

  /** The one composition of what crosses the wire as additional
   * directories: the workspace's folders other than the session cwd (the
   * cwd travels as cwd), then the session's user-added external roots.
   * The roots chip counts the same two lists, so display and wire cannot
   * disagree — they are derived from the same facts. */
  private rootsFor(sessionId: string | null, cwd: string): string[] {
    const folders = (this.hooks.workspaceRoots?.() ?? []).filter((f) => f !== cwd);
    const added = sessionId === null ? [] : this.addedRootsOf(sessionId);
    return [...folders, ...added];
  }

  /** The saved roots a session born at `cwd` starts with — each once, and
   * none it already has by being here (the cwd, a workspace folder). One
   * gone from disk is dropped at the attach, which says so. */
  private savedRootsFor(cwd: string): string[] {
    const present = new Set([cwd, ...(this.hooks.workspaceRoots?.() ?? [])]);
    return [...new Set(this.hooks.savedRoots?.() ?? [])].filter((p) => !present.has(p));
  }

  /** The session's complete root list as its MCP servers read it: the cwd
   * first, then exactly what `rootsFor` composes for the wire, minus any
   * folder gone from disk as the wire skips it — one composition, so the
   * servers and the agent can never be told two different lists. */
  rootsOf(sessionId: string): string[] {
    const cwd = this.cwd();
    return [cwd, ...this.rootsFor(sessionId, cwd).filter((p) => this.onDisk(p))];
  }

  /** The roots the session was given: its root list, minus a cwd no
   * workspace folder backs — with no folder open the session still runs
   * somewhere, but nobody handed the agent that place. What "inside the
   * workspace" means to the write scope. */
  grantedRoots(sessionId: string): string[] {
    const roots = this.rootsOf(sessionId);
    return (this.hooks.workspaceRoots?.() ?? []).includes(this.cwd()) ? roots : roots.slice(1);
  }

  /** The sessions attached right now — what a workspace folder change
   * re-applies its list to. */
  attached(): string[] {
    return [...this.sessions.keys()];
  }

  /** Pushes the canonical root list to a *live* attachment's agent copy,
   * through a lifecycle request where one applies — never under a running
   * turn (the gates hold it until the turn ends, then run it before the
   * held words). Two cases:
   *
   * - **Never prompted, nothing shown**: recreate — `session/new` with the
   *   complete list, same row/title/knobs, old shell closed. The one
   *   universally safe scope change: the agent may have persisted nothing
   *   yet, and `session/load` on a never-prompted id has been observed to
   *   404 *and kill the live session* (claude-agent-acp 0.57). Free by
   *   construction — there is no history to carry — and it covers every
   *   agent, load/resume declared or not.
   * - **Has turns**: in place on the same connection via `session/resume`
   *   (real memory, no replay, transcript untouched; "sets the complete
   *   list"). Not declared → nothing to do: the list is recorded and the
   *   chip says the agent takes it at the next open; a folder change waits
   *   for the next attach, which reads the composed list anyway.
   *
   * Failure is logged, never thrown — but the local attachment is dropped:
   * a failed re-attach may have taken the agent-side session with it, and
   * the next prompt must re-enter the continuation ladder, not hit a
   * corpse. */
  async reapplyRoots(sessionId: string, signal: AbortSignal): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return; // not attached — next attach picks the list up
    const declared = this.pool.get(session.patchbayAgentId)?.declared;
    // An agent that never advertised the field gets no field on any
    // request — a re-attach would carry nothing, so none is made.
    if (declared?.sessionAdditionalDirectories !== true) return;
    if (!this.hasTurns(sessionId)) {
      await this.recreateEmpty(sessionId, session, signal);
      return;
    }
    // Resume is the only re-apply rung after a turn: real memory, no
    // replay. A load would rebuild the whole transcript for one root —
    // never used for roots. No resume → nothing to do here: the list is
    // recorded, the chip says the agent takes it at the next open, and
    // that open (or a folder change's next attach) reads the composed
    // list anyway.
    if (declared.sessionResume !== true) return;
    // The re-attach resets agent-side knob state to its defaults (observed:
    // claude-agent-acp rebuilds session config on load) — but the user asked
    // to change *roots*, nothing else. Re-seed the confirmed combination
    // after, same as recreateEmpty; display stays honest either way, since
    // applySeed routes through set requests whose responses are the truth.
    const seed = confirmedFromKnobs(session.knobs);
    try {
      const { knobs } = await this.attachSession({ via: "resume", sessionId }, session.patchbayAgentId, {}, signal);
      this.publishKnobs(sessionId, knobs);
      await this.applySeed(sessionId, seed, signal);
      this.log.info(`session ${sessionId}: roots re-applied via session/resume`);
    } catch (err) {
      // An involuntary detach like any other.
      const dying = this.sessions.get(sessionId);
      if (dying !== undefined) this.dropLiveSession(sessionId, dying);
      this.log.info(
        `session ${sessionId}: root re-apply failed (${(err as Error).message}) — detached; next prompt re-enters the continuation ladder`,
      );
    }
  }

  /** The zero-turn rung — of reapplyRoots (a root added to a never-prompted
   * session) and of the attach ladder (a never-prompted session whose
   * connection died): the agent persisted nothing for it, so the session is
   * minted again on the agent's side and the empty shell retired. The
   * session stays itself — its row, its view row and everything the user
   * staged on them (chips, held words, draft, roots) — under a fresh agent
   * id; its continuity row follows that id, and the user-steered knob
   * values are re-seeded (silently skipped where the fresh session doesn't
   * offer them). `old` is the live attachment when there still is one. */
  private async recreateEmpty(sessionId: string, old: LiveSession | undefined, signal: AbortSignal): Promise<void> {
    const row = this.known.get(sessionId);
    if (row === undefined) throw new Error(`unknown session ${sessionId}`);
    const { patchbayAgentId, handle: was } = row;
    const { handle, contextToken, knobs, missing } = await this.attachSession(
      { via: "new" },
      patchbayAgentId,
      { roots: this.rootsFor(sessionId, this.cwd()) },
      signal,
    );
    // Closed while the agent minted it: the fresh session serves no one,
    // and is freed like the shell it would have replaced.
    if (this.known.get(sessionId) !== row) {
      this.retire(patchbayAgentId, handle);
      throw new Error(`session ${sessionId} was closed while it was minted again`);
    }
    // Read under the old id, before it moves: the knob combination is what
    // every publish wrote — the same fact a live attachment holds, from its
    // one durable home.
    const carried = this.saved(sessionId);
    const seed = carried.knobs ?? {};
    this.unbind(sessionId);
    row.handle = handle;
    this.bind(sessionId, row);
    this.bindToken(contextToken, sessionId);
    // The continuity row follows the session to its new id.
    this.write({ patchbayAgentId, handle: was }, null);
    if (Object.keys(carried).length > 0) this.write(row, carried);
    // Same shield as close(): an in-flight session/list walk's stale page
    // must not resurrect the retired shell.
    this.entomb({ patchbayAgentId, handle: was });
    this.sessions.set(sessionId, liveSession(patchbayAgentId));
    this.hooks.handleChanged?.(sessionId);
    // A birth like any other: the session says what was skipped, and its
    // servers hear its list once it exists.
    this.noticeMissingRoots(sessionId, missing);
    this.hooks.rootsChanged?.(sessionId);
    // The empty shell, only while its process still exists — a dead
    // connection took it along.
    if (old !== undefined) this.retire(patchbayAgentId, was);
    this.publishKnobs(sessionId, knobs);
    await this.applySeed(sessionId, seed, signal);
    this.log.info(`session ${sessionId}: zero-turn — minted again (agent id ${was} → ${handle})`);
  }

  /** A session the agent holds that no row uses: freed agent-side where the
   * agent can close it, forgotten by the connection either way. */
  private retire(patchbayAgentId: PatchbayAgentId, handle: string): void {
    if (this.pool.get(patchbayAgentId)?.declared?.sessionClose === true) {
      void this.pool.closeSession(patchbayAgentId, handle).catch(() => {});
    } else {
      this.pool.forgetSession(patchbayAgentId, handle);
    }
  }

  /** Words that wait their turn — the held prompts, saved on the
   * session's row; only the user discards them (Stop, the row's ×, close).
   * Ids outlive the window with the row, so they are unique anywhere. */
  hold(sessionId: string, words: Omit<QueuedPrompt, "id">): void {
    if (!this.known.has(sessionId)) return;
    const queued: QueuedPrompt = { id: randomUUID(), ...words };
    this.save(sessionId, { queue: [...(this.saved(sessionId).queue ?? []), queued] });
    this.hooks.emit({ kind: "promptQueued", sessionId, prompt: queued });
  }

  /** Whether words wait on the session's row. */
  hasHeld(sessionId: string): boolean {
    return (this.saved(sessionId).queue?.length ?? 0) > 0;
  }

  /** The held words next in line, taken off the row to start their turn. */
  takeHeld(sessionId: string): QueuedPrompt | undefined {
    const [next, ...rest] = this.saved(sessionId).queue ?? [];
    if (next === undefined) return undefined;
    this.save(sessionId, { queue: rest });
    this.hooks.emit({ kind: "promptUnqueued", sessionId, promptId: next.id });
    return next;
  }

  /** Whether the session's agent stands signed out — its turns hold, never
   * fire into a wire already witnessed to refuse. */
  locked(sessionId: string): boolean {
    const patchbayAgentId = this.agentFor(sessionId);
    return patchbayAgentId !== undefined && this.hooks.authLocked?.(patchbayAgentId) === true;
  }

  /** Whether a turn may start on the session now, as far as its own facts
   * go: its agent running, not signed out. What already runs on the
   * session is the gates' to know. */
  turnAllowed(sessionId: string): boolean {
    const patchbayAgentId = this.agentFor(sessionId);
    return patchbayAgentId !== undefined && this.pool.get(patchbayAgentId)?.status === "running" && !this.locked(sessionId);
  }

  /** One turn: the transcript write, the wire call, the turn's end. The
   * session is attached first (the gates attach it); a turn that cannot
   * start throws before anything is rendered or sent — the words still the
   * user's. `spent` hears the moment they become a user message. Told to
   * stop mid-turn, it sends the cancel, answers the asks the turn leaves
   * open (an ACP MUST), and waits at most CANCEL_SETTLE_MS for the agent to
   * end the turn — a hung agent must not hold the session — then ends it
   * here; an answer that comes later changes nothing. */
  async runTurn(
    sessionId: string,
    words: { text: string; parts?: readonly PromptPart[] },
    signal: AbortSignal,
    spent: () => void,
  ): Promise<void> {
    signal.throwIfAborted();
    const attached = this.sessions.get(sessionId);
    const known = this.known.get(sessionId);
    if (attached === undefined || known === undefined) throw new Error(this.notAttached(sessionId));
    if (this.locked(sessionId)) throw new Error(`${attached.patchbayAgentId} is signed out`);
    if (attached.inFlight) throw new Error(`session ${sessionId} has a turn running`);
    const session = attached;
    const { text, parts } = words;
    // Read now: the zero-turn rung, on the attach just before, may have
    // given the session a fresh agent id.
    const handle = known.handle;
    // A mode-set confirmation that hasn't arrived by the next prompt is
    // not coming — the flag attributes the *immediate* notification to the
    // user's click; stale, it would record an agent-initiated transition
    // as the user's own combination. Deliberate trade: a bridge deferring
    // its confirmation past the next prompt would lose the recording (none
    // observed) — never recording a wrong combination outranks sometimes
    // missing a right one.
    session.userModeSetPending = false;
    this.stream.seal(sessionId, session);
    session.inFlight = true;
    known.everPrompted = true;
    session.lastActivityAt = Date.now();
    spent();

    const events: AgentViewEvent[] = [];
    if (!known.titled) {
      known.titled = true;
      events.push({ kind: "sessionRefreshed", sessionId, title: deriveTitle(text) });
    }
    // Duration basis is send→stop, deliberately not first-chunk→stop: the
    // live ticker exists so a slow response has visible feedback instead of
    // silence, and the silence starts at send.
    const startedAt = new Date().toISOString();
    // Attached context rides in as its own labeled blocks, ahead of the
    // user's words — distinguishable to the agent, not merged into prose
    // (explicitly add editor state to the prompt). The turn takes the
    // chips off the session's row.
    const chips = this.saved(sessionId).chips ?? [];
    if (chips.length > 0) this.save(sessionId, { chips: [] });
    for (const chip of chips) {
      events.push({ kind: "contextChipRemoved", sessionId, chipId: chip.id });
    }
    // The transcript's copy of the prompt, in the part vocabulary — chips
    // first, then prose, the same order the wire blocks below carry. An
    // image is the file its chip staged in the attachments dir.
    const userParts: UserPart[] = chips.map((c): UserPart => {
      if (c.kind === "image") return { kind: "image", mimeType: c.mimeType, file: c.file };
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
    const declared = this.pool.get(session.patchbayAgentId)?.declared;
    const acceptsImages = declared?.promptImage ?? false;
    const acceptsEmbedded = declared?.promptEmbeddedContext ?? false;
    const prompt: ContentBlock[] = [];
    for (const c of chips) {
      if (c.kind === "image") {
        if (acceptsImages) {
          // The bytes are the staged file's; one the OS reclaimed since
          // leaves the prompt without it, said in the log.
          const data = await readStashedImage(c.file);
          if (data === null) {
            this.log.info(`session ${sessionId}: pasted image "${c.label}" not sent — its stash file is gone`);
          } else {
            prompt.push({ type: "image", data, mimeType: c.mimeType });
          }
        } else {
          prompt.push(imageAsResourceLink(c));
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
      // The attachment as it stands, not the capture: a connection that
      // died under the turn took it, and the drop helper swept it then.
      const current = this.sessions.get(sessionId);
      if (current !== undefined) {
        this.stream.sweep(sessionId, current);
        // turn end interrupts prose like anything else — and the run's
        // rewriter tail must land before the turnEnd block, not after
        this.stream.seal(sessionId, current);
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
    // Told to stop while the blocks were read, the turn ends before it
    // reaches the wire: the message stands, nothing was sent.
    if (signal.aborted) {
      endTurn("cancelled", null);
      session.inFlight = false;
      return;
    }
    const cancel = () => {
      void this.pool.cancel(session.patchbayAgentId, handle).catch(() => {}); // a dead connection stops nothing
      // The cancel goes out first, then the asks it leaves are answered —
      // the agent hears the turn is ending before it hears why its ask was.
      this.hooks.cancelAsks?.(sessionId);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = await untilGivenUp(this.pool.prompt(session.patchbayAgentId, handle, prompt), signal, CANCEL_SETTLE_MS);
      if (response === null) {
        this.log.info(
          `session ${sessionId}: turn told to stop, still unanswered after ${CANCEL_SETTLE_MS} ms — ended here`,
        );
        endTurn("cancelled", null);
        return;
      }
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
      signal.removeEventListener("abort", cancel);
      const current = this.sessions.get(sessionId);
      if (current !== undefined) {
        current.inFlight = false;
        current.lastActivityAt = Date.now();
      }
    }
  }

  /** Words whose turn never started go back to the front of the held ones
   * — anything held meanwhile came after them. The view's rows resync
   * wholesale, so their order stays the firing order. A session closed
   * meanwhile took its held words with it, these included. */
  reHold(sessionId: string, words: Omit<QueuedPrompt, "id"> & { id?: string }): void {
    if (!this.known.has(sessionId)) return;
    const queue = [{ ...words, id: words.id ?? randomUUID() }, ...(this.saved(sessionId).queue ?? [])];
    this.save(sessionId, { queue });
    this.hooks.emit({ kind: "promptQueueCleared", sessionId });
    for (const q of queue) this.hooks.emit({ kind: "promptQueued", sessionId, prompt: q });
  }

  /** The composer's draft for the session — saved as the composer hands it
   * over (debounced), the editor state opaque here. A draft for a session
   * the store doesn't know (a stale panel's late save) is refused whole,
   * and an unchanged one writes nothing: every save rewrites the whole
   * machine file, and the debounce ticks while a user merely moves the
   * caret. The view's copy is what sibling views (detached panels) and the
   * next session switch read — the composer applies drafts only when idle,
   * so echoes never fight the keyboard. */
  saveDraft(sessionId: string, draft: string): void {
    if (!this.known.has(sessionId)) return;
    if ((this.saved(sessionId).draft ?? "") === draft) return;
    this.save(sessionId, { draft });
    this.hooks.emit({ kind: "sessionDraftChanged", sessionId, draft });
  }

  /** Decodes saved chips for the view (image bytes read from the
   * attachments stash). A chip whose stash file the OS reclaimed drops
   * honestly, logged, and leaves the row too, so the husk doesn't return
   * next reload. */
  private async rehydrateChips(sessionId: string, persisted: readonly PersistedChip[]): Promise<void> {
    const chips: ContextChip[] = [];
    const gone = new Set<string>();
    for (const chip of persisted) {
      if (chip.kind === "image") {
        const content = await readStashedImage(chip.file);
        if (content === null) {
          this.log.info(`session ${sessionId}: pasted image "${chip.label}" not rehydrated — stash file gone`);
          gone.add(chip.id);
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
    // pruned meanwhile — emitting now would put chips into a deleted row.
    if (!this.known.has(sessionId)) return;
    for (const chip of chips) this.hooks.emit({ kind: "contextChipAdded", sessionId, chip });
    if (gone.size > 0) {
      this.save(sessionId, { chips: (this.saved(sessionId).chips ?? []).filter((c) => !gone.has(c.id)) });
    }
  }

  /** Drops one still-queued prompt (composer row × button). */
  removeQueuedPrompt(sessionId: string, promptId: string): void {
    const queue = this.saved(sessionId).queue ?? [];
    if (!queue.some((q) => q.id === promptId)) return;
    this.save(sessionId, { queue: queue.filter((q) => q.id !== promptId) });
    this.hooks.emit({ kind: "promptUnqueued", sessionId, promptId });
  }

  /** Take the queue's tail back for editing: the row leaves the queue and
   * its editor state becomes the session's draft. Only into an empty
   * draft — the composer flushes its buffer on blur, so the click that
   * asks came after its last save, and merging two messages into one is
   * the user's call, made with Copy. Tail only — the one row whose place
   * a resend keeps — and only a row that carries its editor state (one
   * held before the composer sent it has nothing to come back as; it
   * copies and fires). Anything else is a no-op: a row that already fired
   * is simply gone. */
  takeBack(sessionId: string, promptId: string): void {
    const { queue = [], draft = "" } = this.saved(sessionId);
    const tail = queue.at(-1);
    if (draft !== "" || tail === undefined || tail.id !== promptId || tail.draft === undefined) return;
    this.save(sessionId, { queue: queue.slice(0, -1), draft: tail.draft });
    this.hooks.emit(
      { kind: "promptUnqueued", sessionId, promptId },
      { kind: "sessionDraftChanged", sessionId, draft: tail.draft },
    );
  }

  /** Stop means stop: the held words go with the turn the user ended —
   * draining them after a deliberate stop would restart what they just
   * ended. */
  clearHeld(sessionId: string): void {
    if (!this.hasHeld(sessionId)) return;
    this.save(sessionId, { queue: [] });
    this.hooks.emit({ kind: "promptQueueCleared", sessionId });
  }

  /** The stashed texts for one openToolCallDiff action — null when unknown
   * (stale id after a close; the action is simply a no-op then). */
  toolCallDiff(sessionId: string, toolCallId: string, path: string): { oldText: string; newText: string } | null {
    return this.stream.toolCallDiff(sessionId, toolCallId, path);
  }

  /** Routed from AgentPool's onSessionUpdate hook, live and replayed alike:
   * the session's own facts — its title, its knobs — are kept here; the
   * rest is its transcript's, through the stream. */
  handleUpdate(patchbayAgentId: PatchbayAgentId, notification: SessionNotification): void {
    const { update } = notification;
    // The one door every inbound update rides through names the session the
    // agent's way; with its agent, that id finds the one row it means — two
    // agents minting one id are two rows, and nothing deeper re-checks.
    const sessionId = this.rowFor(patchbayAgentId, notification.sessionId);
    if (sessionId === undefined) return; // a session patchbay isn't tracking
    // Session metadata, not transcript — handled before the live guard: the
    // agent may retitle any session it knows, live in patchbay or not.
    if (update.sessionUpdate === "session_info_update") {
      void this.noteInfoUpdate(sessionId, update);
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) return; // known, but not attached here
    session.lastActivityAt = Date.now(); // any update is activity — the reaper's basis
    switch (update.sessionUpdate) {
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
            this.hooks.onKnobsConfirmed?.(session.patchbayAgentId, confirmedFromKnobs(next));
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
      default:
        this.stream.apply(sessionId, session, update);
    }
  }

  /** `session_info_update`: the agent pushed new title/updatedAt. The
   * agent's title always wins (there is no patchbay-side rename). A null
   * title is a clear, not a rename: patchbay keeps its own (a session list
   * with blank rows helps no one). Both facts ride one refresh to the row
   * they live on — the drawer's title and sort key move now, not at the
   * next full list sync. */
  private async noteInfoUpdate(
    sessionId: string,
    update: { title?: string | null; updatedAt?: string | null },
  ): Promise<void> {
    if (!this.known.has(sessionId)) return;
    const meta = wireMeta(update);
    if (meta.title !== undefined) {
      // An agent-authored title marks the session titled even when the text
      // matches what's shown — the first prompt's auto-title must never
      // clobber it (the agent's title wins, in both directions of time).
      this.known.get(sessionId)!.titled = true;
    }
    if (meta.title === undefined && meta.updatedAt === undefined) return;
    this.hooks.emit({ kind: "sessionRefreshed", sessionId, ...meta });
  }
}

/** The image-paste fallback for agents that never declared
 * `promptCapabilities.image`: the chip's stashed file, sent as a
 * ResourceLink (with ContentBlock::Text, the baseline every agent must
 * accept). The same file backs the transcript's preview. */
function imageAsResourceLink(chip: Extract<PersistedChip, { kind: "image" }>): ContentBlock {
  return {
    type: "resource_link",
    uri: pathToFileURL(stashedPath(chip.file)).toString(),
    name: chip.file,
    mimeType: chip.mimeType,
  };
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

