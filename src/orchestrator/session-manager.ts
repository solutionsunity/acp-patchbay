// Bridges the ACP client pool to the Agent View's chat state. Owns the render
// cache in the sense of deciding *when* it must be rebuilt wholesale — the
// cache itself lives in AgentViewState, updated only through the shared
// reducer (architecture.md § State: render cache is disposable, replay
// always wins, never merged).
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ContentBlock,
  McpServer,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  AgentViewEvent,
  ChatBlock,
  ContextChip,
  KnobSeed,
  PlanEntry,
  SessionSummary,
  TurnUsage,
} from "../shared/protocol";
import {
  applyConfigUpdate,
  applyModeUpdate,
  confirmedFromKnobs,
  foldSeed,
  NO_KNOBS,
  normalizeKnobs,
  routeKnobSet,
  type NormalizedKnobs,
} from "./knobs";
import { nullLogger, type Logger } from "./logger";
import type { AgentPool } from "./pool";
import type { SessionIndexStore } from "./stores/session-index";

export interface SessionManagerHooks {
  emit(...events: AgentViewEvent[]): void;
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
  /** Whether `session.fork` is declared *and used* for this agent — the
   * one signal that decides native fork vs. emulated seeding (P8). */
  isForkUsed?(agentId: string): boolean;
  /** Per-agent knob defaults (folded, knob-id-keyed — knobs.ts foldSeed),
   * applied once, post-create. */
  defaultsFor?(agentId: string): KnobSeed | undefined;
  /** The persisted last-known view (architecture.md § State) — the only
   * continuation available for a dead session whose agent never declared
   * `session/load`. */
  lastKnownView?(sessionId: string): Promise<{ at: string; blocks: readonly ChatBlock[] } | null>;
  /** Canonical (AgentViewState-held) external context roots for a session —
   * read back on reopen/branch since ACP has no live-update request for
   * `additionalDirectories`; a fresh `LiveSession` needs the durable copy,
   * not a SessionManager-local one that would vanish with it. */
  contextRootsFor?(sessionId: string): readonly string[];
}

let blockCounter = 0;
function newBlockId(prefix: string): string {
  return `${prefix}-${++blockCounter}`;
}

function deriveTitle(promptText: string): string {
  const flat = promptText.trim().replace(/\s+/g, " ");
  if (flat === "") return "Untitled session";
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}

interface LiveSession {
  agentId: string;
  /** Which pool connection this session's requests ride — the agentId
   * itself when sharing, a synthetic instance id when process-policy
   * isolated it (P8). Forks always inherit their parent's poolKey. */
  poolKey: string;
  /** True once auto-derived from the first prompt, or explicitly renamed —
   * either way, later auto-titling must not clobber it again. */
  titled: boolean;
  activeTextBlockId: string | null;
  activeThoughtBlockId: string | null;
  pendingContext: ContextChip[];
  /** Normalized knob state (knobs.ts) — carries the wire surface that
   * drives set routing; the view side only ever sees the knob list. */
  knobs: NormalizedKnobs;
}

export class SessionManager {
  private sessions = new Map<string, LiveSession>();
  /** Agent-reported diff content per tool call (ToolCallContent "diff") —
   * the texts stay here, never in webview state (they can be whole files);
   * the block carries only the openable paths, and openToolCallDiff reads
   * back through `toolCallDiff`. Cleared with the session; a replay
   * re-sends tool_call content, so it repopulates itself. */
  private toolDiffs = new Map<string, Map<string, Map<string, { oldText: string; newText: string }>>>();
  private contextTokenCounter = 0;

  constructor(
    private readonly pool: AgentPool,
    private readonly sessionIndex: SessionIndexStore,
    private readonly hooks: SessionManagerHooks,
    /** cwd for (re)connecting a session — v1 has one cwd per workspace. */
    private readonly cwd: () => string,
    /** Builds the local MCP server's mcpServers entry for a fresh session,
     * given the correlation token to spawn it with. `[]` (the default) when
     * no MCP integration is wired — tests mostly don't need it. */
    private readonly mcpServersFor: (contextToken: string, agentId: string) => Promise<McpServer[]> = async () => [],
    /** Output-channel seam (logger.ts). */
    private readonly log: Logger = nullLogger,
  ) {}

  isLive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async createSession(
    agentId: string,
    agentName: string,
    cwd: string,
  ): Promise<string> {
    const poolKey = (await this.hooks.resolveProcessFor?.(agentId)) ?? agentId;
    const contextToken = `ctx-${++this.contextTokenCounter}`;
    const { sessionId, modes, configOptions } = await this.pool.newSession(
      poolKey,
      cwd,
      await this.mcpServersFor(contextToken, agentId),
    );
    this.hooks.mapContextToken?.(contextToken, sessionId);
    this.sessions.set(sessionId, {
      agentId,
      poolKey,
      titled: false,
      activeTextBlockId: null,
      activeThoughtBlockId: null,
      pendingContext: [],
      knobs: NO_KNOBS,
    });
    const now = new Date().toISOString();
    const title = `${agentName} session`;
    await this.sessionIndex.upsert({ id: sessionId, agentId, title, createdAt: now, updatedAt: now });
    const summary: SessionSummary = {
      id: sessionId,
      agentId,
      title,
      live: false,
      emulated: false,
      branchOf: null,
    };
    this.hooks.emit({ kind: "sessionCreated", session: summary });
    this.log.info(`session ${sessionId} created with ${agentId} (poolKey ${poolKey})`);
    this.publishKnobs(sessionId, normalizeKnobs(modes, configOptions));
    await this.applyDefaults(agentId, sessionId);
    return sessionId;
  }

  activate(sessionId: string): void {
    this.hooks.emit({ kind: "sessionActivated", sessionId });
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.titled = true; // an explicit rename is never overwritten by auto-titling
    await this.sessionIndex.rename(sessionId, title);
    this.hooks.emit({ kind: "sessionRenamed", sessionId, title });
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.toolDiffs.delete(sessionId);
    await this.sessionIndex.remove(sessionId);
    this.hooks.emit({ kind: "sessionClosed", sessionId });
    if (session === undefined || session.poolKey === session.agentId) return;
    // An isolated instance's dedicated subprocess is only worth keeping
    // alive while it still hosts a session (its own, or a fork of it).
    this.pool.forgetSession(session.poolKey, sessionId);
    if ((this.pool.get(session.poolKey)?.sessions.length ?? 0) === 0) {
      await this.pool.stop(session.poolKey);
    }
  }

  /** "Disconnect & erase all data" (P18): every session's bookkeeping goes
   * at once — the processes are already down and the session index is wiped
   * by the erase sweep itself; the UI rows leave via the orchestrator's
   * sessionClosed events. */
  reset(): void {
    this.sessions.clear();
    this.toolDiffs.clear();
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

  /** One-click reload (P8): re-`load` replay on demand, even when the
   * session isn't currently invalidated — distinct from the automatic
   * reopen-on-crash path, which only fires when a session isn't live. */
  async reload(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    const agentId = this.sessionIndex.get(sessionId)?.agentId;
    if (agentId === undefined) return;
    await this.reopen(sessionId, agentId);
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
    this.sessions.set(sessionId, {
      agentId,
      poolKey,
      titled: true, // reopened sessions keep whatever title they already have
      activeTextBlockId: null,
      activeThoughtBlockId: null,
      pendingContext: [],
      knobs: NO_KNOBS,
    });
    this.hooks.emit({ kind: "transcriptReset", sessionId });
    const roots = this.hooks.contextRootsFor?.(sessionId) ?? [];
    const contextToken = `ctx-${++this.contextTokenCounter}`;
    this.hooks.mapContextToken?.(contextToken, sessionId);
    const { modes, configOptions } = await this.pool.loadSession(
      poolKey,
      sessionId,
      this.cwd(),
      await this.mcpServersFor(contextToken, agentId),
      [...roots],
    );
    // pool.ts's loadSession already marked "session.load" used the instant
    // the RPC succeeded — this only has to update the render state.
    this.log.info(`session ${sessionId} reopened via session/load on ${agentId}`);
    this.publishKnobs(sessionId, normalizeKnobs(modes, configOptions));
  }

  /** Reopens where possible; otherwise the only continuation left for an
   * agent without `session/load` is an emulated one, seeded from the
   * persisted last-known view (architecture.md § State) — a genuinely fresh
   * session, clearly labeled, never presented as the agent's own memory.
   * Returns the sessionId that's actually live and ready for a prompt: the
   * same id on success, a new one when it had to emulate. */
  private async reopenOrEmulate(sessionId: string, agentId: string): Promise<string> {
    if (this.sessions.has(sessionId)) return sessionId;
    if (this.pool.get(agentId)?.declared?.loadSession) {
      await this.reopen(sessionId, agentId);
      return sessionId;
    }
    const view = await this.hooks.lastKnownView?.(sessionId);
    return this.createEmulatedContinuation(sessionId, agentId, view?.blocks ?? []);
  }

  /** Shared by the dead-end auto-continuation above and by `branch`'s
   * emulated path: a fresh top-level session (its own process-policy
   * decision — an emulated branch is not a real fork, so nothing pins it to
   * the parent's process), with its transcript seeded wholesale from
   * `seedBlocks` and labeled `emulated`. */
  private async createEmulatedContinuation(
    parentSessionId: string,
    agentId: string,
    seedBlocks: readonly ChatBlock[],
  ): Promise<string> {
    const poolKey = (await this.hooks.resolveProcessFor?.(agentId)) ?? agentId;
    const contextToken = `ctx-${++this.contextTokenCounter}`;
    const roots = this.hooks.contextRootsFor?.(parentSessionId) ?? [];
    const { sessionId, modes, configOptions } = await this.pool.newSession(
      poolKey,
      this.cwd(),
      await this.mcpServersFor(contextToken, agentId),
      [...roots],
    );
    this.hooks.mapContextToken?.(contextToken, sessionId);
    this.sessions.set(sessionId, {
      agentId,
      poolKey,
      titled: true,
      activeTextBlockId: null,
      activeThoughtBlockId: null,
      pendingContext: [],
      knobs: NO_KNOBS,
    });
    const now = new Date().toISOString();
    const parentTitle = this.sessionIndex.get(parentSessionId)?.title ?? "session";
    const title = `Branch of ${parentTitle}`;
    await this.sessionIndex.upsert({ id: sessionId, agentId, title, createdAt: now, updatedAt: now });
    const summary: SessionSummary = {
      id: sessionId,
      agentId,
      title,
      live: false,
      emulated: true,
      branchOf: parentSessionId,
    };
    this.hooks.emit({ kind: "sessionCreated", session: summary });
    if (roots.length > 0) this.hooks.emit({ kind: "contextRootsChanged", sessionId, roots });
    if (seedBlocks.length > 0) {
      this.hooks.emit({ kind: "transcriptSeeded", sessionId, blocks: seedBlocks });
    }
    this.publishKnobs(sessionId, normalizeKnobs(modes, configOptions));
    // Semantically a continuation, mechanically a session/new: seed the
    // parent's last agent-confirmed combination — never the defaults, which
    // the user may have steered the parent away from (architecture.md
    // § Session model, seeding table). Knobs the fresh session doesn't
    // offer are skipped silently inside applySeed.
    const confirmed = this.sessionIndex.get(parentSessionId)?.lastConfirmed;
    if (confirmed !== undefined) {
      await this.applySeed(sessionId, foldSeed(confirmed));
    }
    return sessionId;
  }

  /** Branch (P8): native `session/fork` when the agent's `session.fork`
   * capability is declared *and used*, else an emulated continuation
   * seeded from the parent's current transcript — either way, a node in the
   * session graph (`branchOf`); the UI never has to know which mechanism
   * produced it (architecture.md § Branching). */
  async branch(sessionId: string, parentTranscript: readonly ChatBlock[]): Promise<string> {
    const agentId = this.sessions.get(sessionId)?.agentId ?? this.sessionIndex.get(sessionId)?.agentId;
    if (agentId === undefined) throw new Error(`unknown session ${sessionId}`);

    if (!(this.hooks.isForkUsed?.(agentId) ?? false)) {
      return this.createEmulatedContinuation(sessionId, agentId, parentTranscript);
    }

    // Native fork must address the connection holding the parent's live
    // context — reopen first (throws, rather than silently downgrading to
    // emulated, if a capability that tested as *used* turns out not to hold up).
    await this.reopen(sessionId, agentId);
    const poolKey = this.sessions.get(sessionId)!.poolKey;
    const contextToken = `ctx-${++this.contextTokenCounter}`;
    const roots = this.hooks.contextRootsFor?.(sessionId) ?? [];
    const response = await this.pool.fork(
      poolKey,
      sessionId,
      this.cwd(),
      await this.mcpServersFor(contextToken, agentId),
      [...roots],
    );
    this.hooks.mapContextToken?.(contextToken, response.sessionId);
    this.sessions.set(response.sessionId, {
      agentId,
      poolKey,
      titled: true,
      activeTextBlockId: null,
      activeThoughtBlockId: null,
      pendingContext: [],
      knobs: NO_KNOBS,
    });
    const now = new Date().toISOString();
    const parentTitle = this.sessionIndex.get(sessionId)?.title ?? "session";
    const title = `Branch of ${parentTitle}`;
    await this.sessionIndex.upsert({
      id: response.sessionId,
      agentId,
      title,
      createdAt: now,
      updatedAt: now,
    });
    const summary: SessionSummary = {
      id: response.sessionId,
      agentId,
      title,
      live: false,
      emulated: false,
      branchOf: sessionId,
    };
    this.hooks.emit({ kind: "sessionCreated", session: summary });
    if (roots.length > 0) {
      this.hooks.emit({ kind: "contextRootsChanged", sessionId: response.sessionId, roots });
    }
    // Native fork: the agent itself decides how much history to replay as
    // session/update notifications, if any — nothing else to seed here.
    this.publishKnobs(response.sessionId, normalizeKnobs(response.modes, response.configOptions));
    return response.sessionId;
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
   * session (set routing reads the surface from it), emits the full view
   * replace, and records the agent-confirmed combination on the session
   * index (the emulated-continuation seed — the one session birth with no
   * reality left to read). */
  private publishKnobs(sessionId: string, knobs: NormalizedKnobs): void {
    const session = this.sessions.get(sessionId);
    if (session) session.knobs = knobs;
    this.hooks.emit({ kind: "sessionKnobsSet", sessionId, knobs: knobs.knobs });
    if (knobs.surface !== "none") {
      void this.sessionIndex.recordConfirmed(sessionId, { options: confirmedFromKnobs(knobs) });
    }
  }

  /** Per-agent defaults (architecture.md § Session model, mode, effort):
   * applied once, post-create on a *fresh* session only — never on
   * reopen/reload/fork (the agent's own resumed state is the truth), and
   * never on an emulated continuation (which seeds from the parent's
   * confirmed combination instead — the user may have steered away from
   * the defaults). */
  private async applyDefaults(agentId: string, sessionId: string): Promise<void> {
    const defaults = this.hooks.defaultsFor?.(agentId);
    if (defaults === undefined) return;
    await this.applySeed(sessionId, defaults);
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
   * `contextRootsFor` so this stays a pure "append/remove and republish."
   * ACP has no live-update request for `additionalDirectories`, so a change
   * here only reaches the agent on the next reload/branch — honest, not
   * hidden (the same "reload to rejoin truth" pattern P8 already has). */
  addRoot(sessionId: string, path: string): void {
    const current = this.hooks.contextRootsFor?.(sessionId) ?? [];
    if (current.includes(path)) return;
    this.hooks.emit({ kind: "contextRootsChanged", sessionId, roots: [...current, path] });
  }

  removeRoot(sessionId: string, path: string): void {
    const current = this.hooks.contextRootsFor?.(sessionId) ?? [];
    this.hooks.emit({
      kind: "contextRootsChanged",
      sessionId,
      roots: current.filter((p) => p !== path),
    });
  }

  async sendPrompt(sessionId: string, text: string): Promise<void> {
    const agentId = this.sessions.get(sessionId)?.agentId ?? this.sessionIndex.get(sessionId)?.agentId;
    if (agentId === undefined) throw new Error(`unknown session ${sessionId}`);
    const targetId = await this.reopenOrEmulate(sessionId, agentId);
    if (targetId !== sessionId) this.hooks.emit({ kind: "sessionActivated", sessionId: targetId });
    const session = this.sessions.get(targetId)!;
    session.activeTextBlockId = null;
    session.activeThoughtBlockId = null;

    const events: AgentViewEvent[] = [];
    if (!session.titled) {
      session.titled = true;
      const title = deriveTitle(text);
      await this.sessionIndex.rename(targetId, title);
      events.push({ kind: "sessionRenamed", sessionId: targetId, title });
    }
    // Duration basis is send→stop, deliberately not first-chunk→stop: the
    // live ticker exists so a slow response has visible feedback instead of
    // silence, and the silence starts at send.
    const startedAt = new Date().toISOString();
    events.push(
      { kind: "userMessageAppended", sessionId: targetId, blockId: newBlockId("user"), text },
      { kind: "sessionLiveChanged", sessionId: targetId, live: true },
      { kind: "turnStarted", sessionId: targetId, at: startedAt },
    );
    // Attached context rides in as its own labeled blocks, ahead of the
    // user's words — distinguishable to the agent, not merged into prose
    // (features.md § Chat: "explicitly add editor state to the prompt").
    const chips = session.pendingContext;
    session.pendingContext = [];
    for (const chip of chips) {
      events.push({ kind: "contextChipRemoved", sessionId: targetId, chipId: chip.id });
    }
    this.hooks.emit(...events);

    // Image chips ride in the best form the agent accepts (architecture.md §
    // Local MCP server — "paste is never disabled"): a real ImageContent
    // block where `promptCapabilities.image` is declared, else the bytes go
    // to a temp file sent as a ResourceLink — the baseline every agent MUST
    // support per the ACP prompt contract.
    const acceptsImages = this.pool.get(session.poolKey)?.declared?.promptImage ?? false;
    const prompt: ContentBlock[] = [];
    for (const c of chips) {
      if (c.kind !== "image") {
        prompt.push({ type: "text", text: `[${c.label}]\n${c.content}` });
      } else if (acceptsImages) {
        prompt.push({ type: "image", data: c.content, mimeType: c.mimeType ?? "image/png" });
      } else {
        prompt.push(await imageAsResourceLink(c));
      }
    }
    prompt.push({ type: "text", text });
    const endTurn = (stopReason: string, usage: TurnUsage | null) =>
      this.hooks.emit({
        kind: "turnEnded",
        sessionId: targetId,
        blockId: newBlockId("turn"),
        startedAt,
        at: new Date().toISOString(),
        stopReason,
        usage,
      });
    try {
      const response = await this.pool.prompt(session.poolKey, targetId, prompt);
      // end_turn is the unremarkable outcome; anything else is worth a line.
      if (response.stopReason === "end_turn") {
        this.log.debug(`session ${targetId}: turn ended`);
      } else {
        this.log.info(`session ${targetId}: turn stopped — ${response.stopReason}`);
      }
      endTurn(response.stopReason, toTurnUsage(response.usage));
    } catch (err) {
      // The turn still ended — as an error, said as such, never silently.
      endTurn("error", null);
      throw err;
    } finally {
      this.hooks.emit({ kind: "sessionLiveChanged", sessionId: targetId, live: false });
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

  /** The stashed texts for one openToolCallDiff action — null when unknown
   * (stale id after a close; the action is simply a no-op then). */
  toolCallDiff(sessionId: string, toolCallId: string, path: string): { oldText: string; newText: string } | null {
    return this.toolDiffs.get(sessionId)?.get(toolCallId)?.get(path) ?? null;
  }

  /** Routed from AgentPool's onSessionUpdate hook — handles both live
   * streaming and session/load replay identically (same notification shape). */
  handleUpdate(_agentId: string, notification: SessionNotification): void {
    const { sessionId, update } = notification;
    const session = this.sessions.get(sessionId);
    if (!session) return; // update for a session patchbay isn't tracking

    switch (update.sessionUpdate) {
      // Block-model interruption rule (ui-rendering-strategy.md): a chunk
      // merges into the *last* block only if it's the same type — any other
      // block landing in between (the other chunk type, a tool call, a plan)
      // closes it, and a later chunk of the old type starts a fresh block.
      case "agent_message_chunk": {
        if (update.content.type !== "text") return;
        session.activeThoughtBlockId = null; // prose interrupts the thought run
        session.activeTextBlockId ??= newBlockId("text");
        this.hooks.emit({
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
        session.activeThoughtBlockId ??= newBlockId("thought");
        this.hooks.emit({
          kind: "agentThoughtDelta",
          sessionId,
          blockId: session.activeThoughtBlockId,
          text: update.content.text,
        });
        break;
      }
      case "tool_call":
        session.activeTextBlockId = null; // the agent paused to act
        session.activeThoughtBlockId = null;
        this.hooks.emit({
          kind: "toolCallUpserted",
          sessionId,
          blockId: update.toolCallId,
          title: update.title,
          status: update.status ?? "pending",
          toolKind: update.kind ?? "other",
          ...boundedRaw("input", update.rawInput),
          ...boundedRaw("output", update.rawOutput),
          ...(update.locations != null
            ? { locations: update.locations.map((l) => l.path) }
            : {}),
          ...this.stashToolDiffs(sessionId, update.toolCallId, update.content),
        });
        break;
      case "tool_call_update":
        this.hooks.emit({
          kind: "toolCallUpserted",
          sessionId,
          blockId: update.toolCallId,
          title: update.title ?? "",
          status: update.status ?? "completed",
          ...(update.kind != null ? { toolKind: update.kind } : {}),
          ...boundedRaw("input", update.rawInput),
          ...boundedRaw("output", update.rawOutput),
          ...(update.locations != null
            ? { locations: update.locations.map((l) => l.path) }
            : {}),
          ...this.stashToolDiffs(sessionId, update.toolCallId, update.content),
        });
        break;
      case "plan":
        // Session-level state, not a transcript event — replaces the pinned
        // widget's snapshot; it neither appends a block nor interrupts a run.
        this.hooks.emit({
          kind: "planUpdated",
          sessionId,
          entries: toPlanEntries(update.entries),
        });
        break;
      case "available_commands_update":
        this.hooks.emit({
          kind: "commandsAdvertised",
          sessionId,
          commands: update.availableCommands.map((c) => ({
            name: c.name,
            description: c.description,
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
        this.hooks.emit({
          kind: "usageReported",
          sessionId,
          used: update.used,
          size: update.size,
          cost: update.cost ?? undefined,
        });
        break;
      default:
        break; // unconsumed schema surface — a future capability row, not silently guessed at
    }
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

function toPlanEntries(
  entries: readonly { content: string; status: "pending" | "in_progress" | "completed" }[],
): PlanEntry[] {
  return entries.map((e) => ({ content: e.content, status: e.status }));
}
