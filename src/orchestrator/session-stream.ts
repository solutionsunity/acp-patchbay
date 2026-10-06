// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A session's transcript as its updates arrive: how a session/update
// notification becomes the view's transcript events — prose runs and where
// one ends, a tool call and the diffs it carries, a replayed history's turn
// boundaries. Live streaming and session/load replay take the one path;
// inside a replay window the events reduce silently into canonical state,
// and the window's closing resync delivers them wholesale. The sessions
// store routes each update to its row and keeps what is the session's own —
// its title, its knobs; everything here is the transcript's.
import type { ContentBlock, SessionNotification } from "@agentclientprotocol/sdk";
import {
  isToolCallOpen,
  type AgentViewEvent,
  type DiffStat,
  type PlanEntry,
  type ToolCallStatus,
  type UserPart,
  userPartsText,
} from "../shared/protocol";
import { boundedText, contentPartOf, toolContentOf, type ImageStash } from "./content-parts";
import { computeLineDiff } from "./diff";
import { createProseRewriter, type ProseRewriter } from "./extensions";
import type { Logger } from "./logger";
import { planUsageOf } from "./meta";
import { toolLocationsOf } from "./tool-locations";
import { randomUUID } from "node:crypto";
import type { PatchbaySessionId } from "../shared/ids";
import { newBlockId } from "./block-ids";

/** Joins several changed regions of one file into one openable diff — the
 * same line on both sides, so it reads as a boundary and never as a change. */
const REGION_MARKER = "\n⋯\n";

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

/** The chunk families that render as prose runs — doubles as the block-id
 * prefix each family's blocks carry. */
export type RunChannel = "user" | "text" | "thought";

/** A session's stream state, kept on its attachment: what the next chunk
 * continues, which tool calls are still open, and a replay's pending turn
 * boundary. */
export interface StreamState {
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
  /** A prompt turn is in flight — release/reap must never close under it. */
  inFlight: boolean;
  /** toolCallIds seen pending/in_progress and not yet resolved — the turn-end
   * sweep's worklist (tool-call analogue of the asks store's stop). Cleared
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

/** What a session's updates carry for its transcript — every kind but the
 * session's own facts, its title and its knobs. */
export type TranscriptUpdate = Exclude<
  SessionNotification["update"],
  { sessionUpdate: "session_info_update" | "current_mode_update" | "config_option_update" }
>;

export class SessionStream {
  /** Agent-reported diff content per tool call (ToolCallContent "diff") —
   * the texts stay here, never in webview state (they can be whole files);
   * the block carries only each path's line counts, and openToolCallDiff
   * reads back through `toolCallDiff`. Cleared with the session; a replay
   * re-sends tool_call content, so it repopulates itself. */
  private readonly toolDiffs = new Map<string, Map<string, Map<string, { oldText: string; newText: string }>>>();
  /** Sessions inside a replay window (openReplay … closeReplay). */
  private readonly replaying = new Set<string>();

  constructor(
    private readonly hooks: {
      emit(...events: AgentViewEvent[]): void;
      /** Advances canonical state without a webview patch — the replay
       * window. Absent: every event patches. */
      emitSilent?(...events: AgentViewEvent[]): void;
    },
    private readonly log: Logger,
  ) {}

  /** A session/load's replay window opens: the transcript resets, its diff
   * texts with it, and every event until closeReplay reduces silently. */
  openReplay(patchbaySessionId: PatchbaySessionId): void {
    this.replaying.add(patchbaySessionId);
    this.emitter(patchbaySessionId)({ kind: "transcriptReset", patchbaySessionId });
    this.forget(patchbaySessionId);
  }

  /** The replay has landed. A finished replay is the same quiet point as a
   * turn end: nothing is in flight, so history that stops on a still-open
   * call is stranded — without the sweep, a replayed cancelled turn would
   * spin forever (live cancel and its later replay must render
   * identically). The end of the replay ends the trailing prose run too,
   * its rewriter tail landing before the closing resync ships it. And the
   * trailing turn has no next user message to flush it — the end of the
   * replay is its boundary (sweep first: same live rule, the stranded
   * calls' fate lands before the turnEnd block). Skipped when a turn is
   * genuinely in flight (mid-turn reload): that turn's real turnEnded is
   * still coming, and one honest line beats two — the flag is dropped
   * instead, never leaking past the window. */
  finishReplay(patchbaySessionId: PatchbaySessionId, session: StreamState): void {
    this.sweep(patchbaySessionId, session);
    this.seal(patchbaySessionId, session);
    if (session.inFlight) session.replayTurnDirty = false;
    else this.flushReplayBoundary(patchbaySessionId, session, this.emitter(patchbaySessionId));
  }

  /** The replay window closes — on failure too. */
  closeReplay(patchbaySessionId: PatchbaySessionId): void {
    this.replaying.delete(patchbaySessionId);
  }

  /** Replay-window channel pick: inside a session's replay window events reduce silently into
   * canonical state — the closing resync delivers them wholesale; everywhere
   * else they patch the webview live. */
  emitter(patchbaySessionId: PatchbaySessionId): (...events: AgentViewEvent[]) => void {
    return this.replaying.has(patchbaySessionId) && this.hooks.emitSilent !== undefined
      ? this.hooks.emitSilent.bind(this.hooks)
      : this.hooks.emit.bind(this.hooks);
  }

  /** Emits the replay-synthesized turn boundary (nullable timing/stop/usage
   * — see TurnEndBlock) if agent activity is pending, else no-ops. The flag
   * is only ever set inside a replay window, so this can never fire on a
   * live turn. */
  private flushReplayBoundary(
    patchbaySessionId: PatchbaySessionId,
    session: StreamState,
    emit: (...events: AgentViewEvent[]) => void,
  ): void {
    if (!session.replayTurnDirty) return;
    session.replayTurnDirty = false;
    emit({
      kind: "turnEnded",
      patchbaySessionId,
      blockId: newBlockId("turn"),
      startedAt: null,
      at: null,
      stopReason: null,
      usage: null,
    });
  }

  /** One update into the session's transcript — live and replayed alike
   * (same notification shape). */
  apply(patchbaySessionId: PatchbaySessionId, session: StreamState, update: TranscriptUpdate): void {
    const emit = this.emitter(patchbaySessionId);

    // Replay boundary tracking: the replay wire carries no turn-resolution
    // events, so turn structure is reconstructed here — agent activity marks
    // the segment dirty, and the next user message (or the end of the replay,
    // in loadSilently) flushes it as a synthesized TurnEndBlock. Only ever
    // set inside the window: live turns get their real turnEnded (runTurn).
    if (
      this.replaying.has(patchbaySessionId) &&
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
      // user block (runTurn), and some agents echo the in-flight prompt
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
          this.seal(patchbaySessionId, session);
          if (this.replaying.has(patchbaySessionId)) {
            session.replayTurnDirty = false;
            emit({
              kind: "turnEnded",
              patchbaySessionId,
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
        this.flushReplayBoundary(patchbaySessionId, session, emit);
        const messageId = update.messageId ?? null;
        if (update.content.type === "text" && harnessEnvelopeTag(update.content.text) !== null) {
          // Harness-injected envelope riding the user role: its own closed,
          // flagged block — never merged into the prose run (an injection
          // between two real messages must not fuse them into one bubble,
          // and the injection itself is not the user's prompt).
          this.seal(patchbaySessionId, session);
          emit({
            kind: "userPartAppended",
            patchbaySessionId,
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
        const part = this.userPartOf(patchbaySessionId, update.content);
        // Non-text parts pass their non-empty flat preview, so the
        // whitespace-only guard in runBlockFor can never swallow them.
        const blockId = this.runBlockFor(patchbaySessionId, session, "user", messageId, userPartsText([part]));
        if (blockId === null) break;
        emit({ kind: "userPartAppended", patchbaySessionId, blockId, part });
        break;
      }
      case "agent_message_chunk": {
        const messageId = update.messageId ?? null;
        if (update.content.type === "resource_link") {
          // Renderable, so render it: a markdown link into the prose
          // run — never a placeholder for content the reader can use. Rides
          // through the run's rewriter like any prose delta: a bypass would
          // reorder it ahead of text the rewriter is still withholding.
          this.emitAgentProse(
            patchbaySessionId,
            session,
            messageId,
            `[${update.content.name}](${update.content.uri})`,
            emit,
          );
          break;
        }
        if (update.content.type !== "text") {
          this.emitAgentPart(patchbaySessionId, session, update.content, false, emit);
          break;
        }
        this.emitAgentProse(patchbaySessionId, session, messageId, update.content.text, emit);
        break;
      }
      case "agent_thought_chunk": {
        if (update.content.type !== "text") {
          this.emitAgentPart(patchbaySessionId, session, update.content, true, emit);
          break;
        }
        const blockId = this.runBlockFor(
          patchbaySessionId,
          session,
          "thought",
          update.messageId ?? null,
          update.content.text,
        );
        if (blockId === null) break;
        emit({ kind: "agentThoughtDelta", patchbaySessionId, blockId, text: update.content.text });
        break;
      }
      case "tool_call": {
        this.seal(patchbaySessionId, session); // the agent paused to act
        const status = update.status ?? "pending";
        this.trackOpenToolCall(session, update.toolCallId, status);
        emit({
          kind: "toolCallUpserted",
          patchbaySessionId,
          blockId: update.toolCallId,
          title: update.title,
          status,
          toolKind: update.kind ?? "other",
          ...boundedRaw("input", update.rawInput),
          ...boundedRaw("output", update.rawOutput),
          ...(update.locations != null
            ? { locations: toolLocationsOf(update.locations) }
            : {}),
          ...(update.content != null
            ? { content: toolContentOf(update.content, this.imageStash(patchbaySessionId, "tool")) }
            : {}),
          ...this.stashToolDiffs(patchbaySessionId, update.toolCallId, update.content),
        });
        break;
      }
      case "tool_call_update": {
        const status = update.status ?? "completed";
        this.trackOpenToolCall(session, update.toolCallId, status);
        emit({
          kind: "toolCallUpserted",
          patchbaySessionId,
          blockId: update.toolCallId,
          title: update.title ?? "",
          status,
          ...(update.kind != null ? { toolKind: update.kind } : {}),
          ...boundedRaw("input", update.rawInput),
          ...boundedRaw("output", update.rawOutput),
          ...(update.locations != null
            ? { locations: toolLocationsOf(update.locations) }
            : {}),
          ...(update.content != null
            ? { content: toolContentOf(update.content, this.imageStash(patchbaySessionId, "tool")) }
            : {}),
          ...this.stashToolDiffs(patchbaySessionId, update.toolCallId, update.content),
        });
        break;
      }
      case "plan":
        // Session-level state, not a transcript event — replaces the pinned
        // widget's snapshot; it neither appends a block nor interrupts a run.
        emit({
          kind: "planUpdated",
          patchbaySessionId,
          entries: toPlanEntries(update.entries),
        });
        break;
      case "available_commands_update":
        emit({
          kind: "commandsAdvertised",
          patchbaySessionId,
          commands: update.availableCommands.map((c) => ({
            name: c.name,
            description: c.description,
            ...(c.input?.hint !== undefined ? { inputHint: c.input.hint } : {}),
          })),
        });
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
          patchbaySessionId,
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
      case "notice":
      case "compaction_update":
      case "compaction_summary_chunk":
        // Declined for now: unstable, and each gated behind a client
        // session capability (notices, compaction) patchbay does not
        // declare, so a conforming agent never sends them.
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

  /** Pulls type:"diff" entries out of a tool call's content: texts stashed
   * here, each path's line counts returned for the event (spread-friendly).
   * Absent content keeps what the call had; present content replaces the
   * collection, per ACP — diffs included, so an update that carries only
   * text (a failed edit's error) leaves the call with no diff to count.
   * A diff counts exactly what the agent reported, and each entry only
   * against its own counterpart: the spec's "original content" doesn't
   * say whole file, agents send either whole files or just the changed
   * regions, and a region measured against anything else — another
   * region, the file on disk — counts lines nobody touched. A missing
   * oldText is the agent saying "nothing before": every line of newText
   * counts as added.
   * Several regions of one file sum, and open as one diff, joined by a
   * marker line both sides share. */
  private stashToolDiffs(
    patchbaySessionId: PatchbaySessionId,
    toolCallId: string,
    content: readonly { type: string; path?: string; oldText?: string | null; newText?: string }[] | null | undefined,
  ): { diffs: Readonly<Record<string, DiffStat>> } | Record<string, never> {
    if (content == null) return {};
    const regions = new Map<string, { olds: string[]; news: string[]; additions: number; deletions: number }>();
    for (const c of content) {
      if (c.type !== "diff" || c.path === undefined || c.newText === undefined) continue;
      const oldText = c.oldText ?? "";
      const { additions, deletions } = computeLineDiff(oldText, c.newText);
      let r = regions.get(c.path);
      if (r === undefined) regions.set(c.path, (r = { olds: [], news: [], additions: 0, deletions: 0 }));
      r.olds.push(oldText);
      r.news.push(c.newText);
      r.additions += additions;
      r.deletions += deletions;
    }
    const texts = new Map<string, { oldText: string; newText: string }>();
    const diffs: Record<string, DiffStat> = {};
    for (const [path, r] of regions) {
      texts.set(path, { oldText: r.olds.join(REGION_MARKER), newText: r.news.join(REGION_MARKER) });
      diffs[path] = { additions: r.additions, deletions: r.deletions };
    }
    let perSession = this.toolDiffs.get(patchbaySessionId);
    if (perSession === undefined) {
      perSession = new Map();
      this.toolDiffs.set(patchbaySessionId, perSession);
    }
    if (texts.size === 0) perSession.delete(toolCallId);
    else perSession.set(toolCallId, texts);
    return { diffs };
  }

  /** Worklist maintenance for the sweep (tool-call analogue of the asks
   * store's stop) — an open status adds, a terminal one removes. */
  private trackOpenToolCall(session: StreamState, toolCallId: string, status: ToolCallStatus): void {
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
  sweep(patchbaySessionId: PatchbaySessionId, session: StreamState): void {
    if (session.openToolCalls.size === 0) return;
    const emit = this.emitter(patchbaySessionId);
    const ids = [...session.openToolCalls];
    session.openToolCalls.clear();
    for (const blockId of ids) {
      emit({ kind: "toolCallInterrupted", patchbaySessionId, blockId });
    }
  }

  /** The stashed texts for one openToolCallDiff action — null when unknown
   * (stale id after a close; the action is simply a no-op then). */
  toolCallDiff(patchbaySessionId: PatchbaySessionId, toolCallId: string, path: string): { oldText: string; newText: string } | null {
    return this.toolDiffs.get(patchbaySessionId)?.get(toolCallId)?.get(path) ?? null;
  }

  /** Replay counterpart of runTurn's part building: one wire content
   * block of a replayed user message → its part, through the one content
   * mapping every chat surface shares. */
  private userPartOf(patchbaySessionId: PatchbaySessionId, content: ContentBlock): UserPart {
    return contentPartOf(content, this.imageStash(patchbaySessionId, "replay"));
  }

  /** A non-text chunk of an agent's message or thought: its own block
   * between prose runs (it seals the run it interrupts), through the one
   * content mapping every chat surface shares — never a placeholder for
   * content the chat can show. */
  private emitAgentPart(
    patchbaySessionId: PatchbaySessionId,
    session: StreamState,
    content: ContentBlock,
    thought: boolean,
    emit: (...events: AgentViewEvent[]) => void,
  ): void {
    this.seal(patchbaySessionId, session);
    emit({
      kind: "agentPartAppended",
      patchbaySessionId,
      blockId: newBlockId("part"),
      part: contentPartOf(content, this.imageStash(patchbaySessionId, "agent")),
      thought,
    });
  }

  /** Images arriving in content are copied to the attachments stash for
   * preview, fire-and-forget; a failed write only costs the preview. The
   * stash is one folder every window and every reload shares, so a stashed
   * image's name is random — a counter restarting at 1 would name another
   * window's image again. */
  private imageStash(patchbaySessionId: PatchbaySessionId, source: string): ImageStash {
    return {
      id: () => `${source}-${randomUUID()}`,
      onError: (err) => this.log.info(`session ${patchbaySessionId}: ${source} image stash failed — ${err.message}`),
    };
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
   *   whole message — live sends render via runTurn, live echoes die at
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
  private runBlockFor(
    patchbaySessionId: PatchbaySessionId,
    session: StreamState,
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
    this.seal(patchbaySessionId, session);
    session.openRun = { channel, blockId: newBlockId(channel), messageId };
    return session.openRun.blockId;
  }

  /** The close-side twin of runBlockFor — the ONE place an open prose run
   * ends. A run's rewriter may be withholding a tail mid-shape; it lands
   * here (raw, honestly) before the run closes, so no close path can make
   * wire text vanish. Every path that ends a run comes through here, except
   * the pre-replay reset (the sessions store's reapplyRoots puts a fresh
   * attachment in place), where the transcript is about to be rebuilt
   * wholesale and the replay re-delivers the same text. */
  seal(patchbaySessionId: PatchbaySessionId, session: StreamState): void {
    const run = session.openRun;
    session.openRun = null;
    if (run === null) return;
    const tail = run.rewriter?.flush() ?? "";
    if (tail === "") return;
    // rewriter rides only agent-text runs (the one arm that attaches it)
    this.emitter(patchbaySessionId)({
      kind: "agentTextDelta",
      patchbaySessionId,
      blockId: run.blockId,
      text: tail,
    });
  }

  /** Agent prose delta → its run's block, through the run's wire-extension
   * rewriter (attached lazily on first prose; extensions/index.ts). May
   * emit nothing when the rewriter withholds the whole delta mid-shape —
   * sealRun flushes the tail wherever the run ends. */
  private emitAgentProse(
    patchbaySessionId: PatchbaySessionId,
    session: StreamState,
    messageId: string | null,
    raw: string,
    emit: (...events: AgentViewEvent[]) => void,
  ): void {
    const blockId = this.runBlockFor(patchbaySessionId, session, "text", messageId, raw);
    if (blockId === null) return;
    const run = session.openRun!; // runBlockFor just returned this run's id
    run.rewriter ??= createProseRewriter();
    const text = run.rewriter.push(raw);
    if (text !== "") emit({ kind: "agentTextDelta", patchbaySessionId, blockId, text });
  }

  /** The session left, or its transcript reset: the diff texts behind its
   * tool cards go. A replay re-sends every tool call's content, and
   * stashToolDiffs re-stashes it. */
  forget(patchbaySessionId: PatchbaySessionId): void {
    this.toolDiffs.delete(patchbaySessionId);
  }

  /** "Disconnect & erase all data": every session's diff texts. */
  reset(): void {
    this.toolDiffs.clear();
  }
}

/** A tool call's rawInput/rawOutput can be arbitrarily large (a full file
 * read, a long command's stdout) — bounded like any agent-sized text.
 * Absent stays absent: the spread-friendly shape keeps `undefined` out of
 * the event entirely so the reducer's "absent = keep existing" merge rule
 * holds. */
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

/** Exhaustiveness backstop for apply's switch — see its default arm. */
function assertUnconsumed(_update: never): void {}

function toPlanEntries(
  entries: readonly { content: string; status: "pending" | "in_progress" | "completed" }[],
): PlanEntry[] {
  return entries.map((e) => ({ content: e.content, status: e.status }));
}
