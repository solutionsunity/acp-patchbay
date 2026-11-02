// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The transcript: renders the view-model's items in arrival order (the
// ordering principle), the per-turn
// metadata line, and the live elapsed ticker. Long transcripts ride the
// three-mechanism scale strategy: windowed mount, content-visibility
// containment (style.css), and memoized rows.
import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  attaching,
  userPartsText,
  type AgentViewState,
  type ChatBlock,
  type SessionSummary,
  type SubagentView,
  type TurnUsage,
} from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { chatPaneProgress } from "../../shared/agent-work";
import { Icon } from "../../shared/icon";
import { count } from "../../../shared/count";
import { formatDuration, itemId, type TranscriptView, type TurnRollup } from "./view-model";
import { readingPosition, windowHolding, type ReadingPosition } from "./reading-position";
import { Disclosure } from "../../shared/disclosure";
import {
  AskedByLine,
  CarriedUpdate,
  CompactionDivider,
  ContentPartView,
  InjectedUser,
  NoticeLine,
  PromptNav,
  SessionMessage,
  TerminalBlocks,
  Thought,
  ToolCallCard,
  ToolDisplayPrefs,
  ToolRunCard,
  UserMessage,
} from "./blocks";
import { AgentMarkdown } from "./markdown";
import { DiffCard, PermissionCard, TerminalCard } from "./cards";
import { ElicitationCard } from "../../shared/question-card";
import { StatePage } from "./state-page";
import { knobText, subagentLook, subagentName, subagentStateText } from "../subagent-controls";
import { SubagentDot } from "../subagents-chip";
import { Button } from "@/components/ui/button";
import type { PatchbaySessionId } from "../../../shared/ids";

/** THE turn line — one component, live and settled: while the turn runs it is
 * the ticker (accent spinner + climbing elapsed + counts as they happen);
 * on turn end it settles in place into the metadata line, same shape, same
 * order. Time ALWAYS leads when known — it is the one always-present part
 * of a live turn, so every line has a uniform anchor and the elapsed
 * counter freezes where it ticked. Counts only when nonzero, tokens only
 * when the agent reported them, duration only when observed (a
 * replay-synthesized boundary has no timing — absence over fake), a
 * stop-reason chip only when the turn didn't end cleanly. Click expands
 * the by-kind breakdown. */
function TurnLine({
  live,
  startedAt,
  endedAt,
  stopReason,
  usage,
  error,
  rollup,
}: {
  live: boolean;
  startedAt: string | null;
  endedAt: string | null;
  stopReason: string | null;
  usage: TurnUsage | null;
  /** Why the turn failed, in the error's own words. */
  error?: string;
  rollup: TurnRollup;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [live]);
  const end = live ? new Date(now).toISOString() : endedAt;
  const parts: string[] = [];
  if (startedAt !== null && end !== null) parts.push(formatDuration(startedAt, end));
  if (rollup.toolCalls > 0) parts.push(count(rollup.toolCalls, "tool call"));
  if (rollup.filesTouched > 0) parts.push(count(rollup.filesTouched, "file"));
  if (usage !== null) parts.push(`${usage.total.toLocaleString()} tokens`);
  const chip = stopReason !== null && stopReason !== "end_turn";
  // A boundary with nothing observable to say (replayed prose-only turn:
  // no timing, no calls, no usage) renders nothing rather than a blank line.
  if (parts.length === 0 && !chip && !live) return null;
  const breakdown = Object.entries(rollup.byKind)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(" · ");
  return (
    <div
      className="py-0.5 text-[11px] text-muted-foreground"
      title={!live && endedAt !== null ? `completed ${new Date(endedAt).toLocaleString()}` : undefined}
    >
      <Disclosure
        open={open}
        onToggle={() => setOpen((v) => !v)}
        label={open ? "Hide the turn's breakdown" : "Show the turn's breakdown"}
      >
        {live && <span className="spin mr-0.5 inline-block align-middle" />}
        {parts.join(" · ")}
        {chip && (
          <span
            className={`badge ml-1 ${stopReason === "error" ? "text-err" : "text-warn"}`}
            title="the turn did not end cleanly — this is the agent's stop reason"
          >
            {stopReason}
          </span>
        )}
      </Disclosure>
      {error !== undefined && <div className="turn-error whitespace-pre-wrap text-err">{error}</div>}
      {open && (
        <div className="pt-0.5">
          {breakdown !== "" ? breakdown : "no tool calls this turn"}
          {usage !== null && (
            <>
              {" · "}
              {usage.input.toLocaleString()} in · {usage.output.toLocaleString()} out
              {usage.cached !== undefined ? ` · ${usage.cached.toLocaleString()} cached` : ""}
              {usage.cacheWrite !== undefined ? ` · ${usage.cacheWrite.toLocaleString()} cache written` : ""}
              {usage.thought !== undefined ? ` · ${usage.thought.toLocaleString()} thinking` : ""}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Block({
  block,
  live,
  openThinking,
  patchbaySessionId,
  agentName,
  roots,
}: {
  block: ChatBlock;
  live: boolean;
  /** The openThinking preference — whether a streaming thought opens. */
  openThinking: boolean;
  patchbaySessionId: PatchbaySessionId;
  /** Workspace roots — tool-call file rows read relative to them. */
  roots: readonly string[];
  /** Who is speaking in this session — the elicitation card must name the
   * agent asking (an ACP client duty), and the name lives in the agents
   * list, never copied into a block. */
  agentName: string;
}) {
  switch (block.kind) {
    case "user":
      return block.injected === true ? (
        <InjectedUser text={userPartsText(block.parts)} />
      ) : (
        <UserMessage id={block.id} parts={block.parts} />
      );
    case "text":
      return (
        <div className="msg-agent">
          <AgentMarkdown text={block.text} live={live} />
        </div>
      );
    case "thought":
      return <Thought text={block.text} live={live} openThinking={openThinking} />;
    case "agentPart":
      // A thought's piece keeps reading as a thought: muted, like its text.
      return (
        <div className={block.thought ? "thought open" : "msg-agent"}>
          <ContentPartView part={block.part} />
        </div>
      );
    case "carried":
      return <CarriedUpdate updateKind={block.updateKind} payload={block.payload} />;
    case "sessionMessage":
      return <SessionMessage block={block} live={live} />;
    case "toolCall":
      return <ToolCallCard block={block} patchbaySessionId={patchbaySessionId} roots={roots} />;
    case "turnEnd":
      return null; // rendered by Chat as TurnLine, with its rollup
    case "permission":
      return (
        <>
          {block.subagent !== undefined && <AskedByLine asked={block.subagent} />}
          <PermissionCard block={block} patchbaySessionId={patchbaySessionId} roots={roots} />
        </>
      );
    case "diff":
      return (
        <>
          {block.subagent !== undefined && <AskedByLine asked={block.subagent} />}
          <DiffCard block={block} />
        </>
      );
    case "terminal":
      return <TerminalCard block={block} />;
    case "elicitation":
      return (
        <>
          {block.subagent !== undefined && <AskedByLine asked={block.subagent} />}
          <ElicitationCard block={block} agentName={agentName} />
        </>
      );
    case "compaction":
      return <CompactionDivider block={block} />;
    case "notice":
      return <NoticeLine block={block} agentName={agentName} />;
    case "patchbayNotice":
      // System voice — visually distinct from agent prose on purpose (the
      // honesty seam: e.g. where a resumed session's cached view ends).
      return (
        <div className="py-1 text-[11px] italic text-muted-foreground">
          <Icon name="info" /> {block.text}
        </div>
      );
  }
}

/** Blocks are immutable out of the reducer, so identity is the memo key for
 * free — only the streaming block re-renders per delta, not the transcript. */
const MemoBlock = memo(Block);
const MemoToolRun = memo(
  ToolRunCard,
  (a, b) =>
    a.patchbaySessionId === b.patchbaySessionId &&
    a.roots === b.roots &&
    a.calls.length === b.calls.length &&
    a.calls.every((c, i) => c === b.calls[i]),
);

/** Windowed mount: rows are the
 * unit — a proxy for k·H pixels; containment makes generous
 * over-mounting cheap, so the counts err large. ~60 rows ≈ 3 viewport
 * pages; one ~page per extension keeps each prepend under the ~100 ms
 * perceptually-instant budget. */
const INITIAL_WINDOW = 60;
const WINDOW_BATCH = 30;

/** The bottom band: within this many pixels of the tail counts as "at the
 * bottom" for re-pinning — wide enough that a sub-line overshoot doesn't
 * break follow, narrow enough that "reading the last message" isn't it. */
const PIN_BAND_PX = 48;

type Left = { session: PatchbaySessionId; position: ReadingPosition | null };

/** Records where the user was as the chat leaves a session. A class because
 * getSnapshotBeforeUpdate is the one moment React gives before a commit
 * changes the DOM: a function component's effects all run after the next
 * session's rows have replaced the ones to read. Renders nothing. */
class OnLeave extends Component<
  {
    session: PatchbaySessionId | undefined;
    read(): ReadingPosition | null;
    keep(left: Left): void;
  },
  unknown,
  Left | null
> {
  override getSnapshotBeforeUpdate(prev: Readonly<OnLeave["props"]>): Left | null {
    return prev.session !== undefined && prev.session !== this.props.session
      ? { session: prev.session, position: this.props.read() }
      : null;
  }
  override componentDidUpdate(_prev: unknown, _state: unknown, left: Left | null) {
    if (left !== null) this.props.keep(left);
  }
  override render() {
    return null;
  }
}

export function Chat(props: {
  state: AgentViewState;
  activeSession: SessionSummary | null;
  /** The active session's blocks and their derived view — App owns the one
   * transcript read and the one derivation (view-model.ts) because the
   * read-out strip and the composer's stats strip consume the same pass's
   * session totals; passing
   * both keeps them in lockstep by construction. */
  blocks: readonly ChatBlock[];
  derived: TranscriptView;
  /** The shell's smart "+": zero agents → Settings, one → straight
   * to it, several → the picker. */
  onNewChat(): void;
  /** A request from outside the transcript (the prompts chip) to bring a
   * prompt into view — a new `seq` is the request. */
  goTo: { seq: number; id: string } | null;
  /** A sub-agent of the session shown instead of the session's own
   * transcript — `blocks` and `derived` are then its own: read-only, no
   * turn of its own, and a way back. */
  subagent?: { view: SubagentView; onBack(): void };
}) {
  const send = useActions();
  const { agents } = props.state;
  const active = props.activeSession;
  const agentName =
    props.state.agents.find((a) => a.id === active?.patchbayAgentId)?.name ?? active?.patchbayAgentId ?? "The agent";
  // The transcript on view — a sub-agent's, or the session's: where its
  // blocks' actions go, and what its reading position is kept under.
  const activePatchbaySessionId = props.subagent?.view.id ?? active?.id;
  const chatRef = useRef<HTMLDivElement>(null);
  const { blocks, derived } = props;
  const terminalBlocks = useMemo(
    () => new Map(blocks.flatMap((b) => (b.kind === "terminal" ? [[b.id, b] as const] : []))),
    [blocks],
  );

  const [mounted, setMounted] = useState(INITIAL_WINDOW);
  const hidden = Math.max(0, derived.items.length - mounted);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const itemsRef = useRef(derived.items);
  itemsRef.current = derived.items;
  /** Scroll-follow contract:
   * auto-follow only while pinned to the bottom — scrollback is never
   * yanked. Unpin is intent-based (upward wheel, touch drag): a position
   * threshold alone loses the race under a fast stream — the first few
   * upward pixels stay inside the bottom band, so the next re-stick yanks
   * the gesture back and the user can never escape. Re-pin is
   * position-based and direction-guarded: reaching the bottom band while
   * not moving up re-pins; programmatic sticks scroll downward, so they
   * re-affirm the pin but can never re-pin over a user's upward intent.
   * The ref is the hot-path truth; the state mirror exists only so the
   * jump-to-latest control can render on pin changes. */
  const pinned = useRef(true);
  const [pinnedView, setPinnedView] = useState(true);
  const setPin = useCallback((v: boolean) => {
    pinned.current = v;
    setPinnedView(v);
  }, []);
  const lastScrollTop = useRef(0);
  /** The one stick-to-tail move (instant, not smooth). */
  const stick = useCallback(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const grow = useCallback(() => {
    const el = chatRef.current;
    if (el !== null && hiddenRef.current > 0) {
      setMounted((c) => c + WINDOW_BATCH);
    }
  }, []);

  // Landing on an item — a prompt gone to, or the place a session was left
  // reading: the window first grows to hold it, then the view lands on it
  // once it is mounted, unpinned, since the user is reading back. A prompt
  // gone to flashes once so the eye finds it.
  const [landing, setLanding] = useState<(ReadingPosition & { flash: boolean }) | null>(null);
  const land = useCallback((to: ReadingPosition & { flash: boolean }) => {
    const size = windowHolding(itemsRef.current.map(itemId), to.item);
    if (size === null) return;
    setMounted((c) => Math.max(c, size));
    setLanding(to);
  }, []);
  const goTo = useCallback((id: string) => land({ item: id, offset: 0, flash: true }), [land]);
  /** The row a landing put at the top, held there for as long as the view
   * stays where the landing left it: in the frames after a jump, rows
   * render in place of their placeholders and move what follows them, and
   * the browser's scroll anchoring doesn't hold through them yet. Any other
   * move of the view — the user's, or the anchoring's once it holds — lets
   * the row go. */
  const held = useRef<{ row: Element; offset: number; at: number } | null>(null);
  const hold = useCallback(() => {
    const el = chatRef.current;
    const h = held.current;
    if (el === null || h === null) return;
    if (el.scrollTop !== h.at || !h.row.isConnected) {
      held.current = null;
      return;
    }
    el.scrollTop += h.row.getBoundingClientRect().top - el.getBoundingClientRect().top + h.offset;
    h.at = el.scrollTop;
  }, []);
  useLayoutEffect(() => {
    if (landing === null) return;
    // One shot: the window grew in the same render, so an item that isn't
    // mounted now never will be — a landing left pending would yank the
    // view at some later, unasked moment.
    setLanding(null);
    const el = chatRef.current;
    const row = el?.querySelector(`.chat-body > [data-item="${CSS.escape(landing.item)}"]`);
    if (el === null || el === undefined || row === null || row === undefined) return;
    setPin(false);
    held.current = { row, offset: landing.offset, at: el.scrollTop };
    hold();
    if (landing.flash) {
      row.querySelector(".msg-user")?.animate(
        [{ boxShadow: "0 0 0 2px var(--pb-accent)" }, { boxShadow: "0 0 0 2px transparent" }],
        { duration: 900, easing: "ease-out" },
      );
    }
  }, [landing, mounted, setPin, hold]);
  const seenGoTo = useRef(props.goTo?.seq);
  useEffect(() => {
    if (props.goTo === null || props.goTo.seq === seenGoTo.current) return;
    seenGoTo.current = props.goTo.seq;
    goTo(props.goTo.id);
  }, [props.goTo, goTo]);
  const promptNav = useMemo(() => ({ order: derived.totals.prompts.map((p) => p.id), goTo }), [derived.totals.prompts, goTo]);

  // Where each session was left reading, by this view alone — render state:
  // a reload starts every session at its end. A session left following its
  // end has no entry.
  const positions = useRef(new Map<PatchbaySessionId, ReadingPosition>());
  const readPosition = useCallback((): ReadingPosition | null => {
    const el = chatRef.current;
    if (el === null) return null;
    const rows = [...el.querySelectorAll<HTMLElement>(".chat-body > [data-item]")].map((row) => {
      const box = row.getBoundingClientRect();
      return { item: row.dataset.item!, top: box.top, bottom: box.bottom };
    });
    return readingPosition(pinned.current, rows, el.getBoundingClientRect().top);
  }, []);
  const keepPosition = useCallback(({ session, position }: Left) => {
    if (position === null) positions.current.delete(session);
    else positions.current.set(session, position);
  }, []);

  // Session switch: fresh window, pinned, at the tail — then back to the
  // place the session was left reading, while its transcript still has it.
  useLayoutEffect(() => {
    setMounted(INITIAL_WINDOW);
    setLanding(null);
    setPin(true);
    lastScrollTop.current = 0;
    stick();
    const left = activePatchbaySessionId === undefined ? undefined : positions.current.get(activePatchbaySessionId);
    if (left !== undefined) land({ ...left, flash: false });
  }, [activePatchbaySessionId, setPin, stick, land]);

  // Growing the window prepends rows above what the user is reading, and
  // the browser's scroll anchoring keeps that in place — a second
  // compensation here would throw the view forward by the batch. Parked at
  // the very top (a jump to the start) nothing anchors, so the window keeps
  // filling chunk by chunk.
  useLayoutEffect(() => {
    const el = chatRef.current;
    if (el !== null && el.scrollTop === 0 && hiddenRef.current > 0) {
      requestAnimationFrame(grow); // parked at the top — keep filling
    }
  }, [mounted, grow]);

  // Follow streaming output only while pinned.
  useEffect(() => {
    if (pinned.current) stick();
  }, [blocks.length, blocks[blocks.length - 1], stick]);

  // Late layout growth: block heights keep changing *after* the data-event
  // scrolls above — markdown/highlighting/mermaid render async, fonts land,
  // content-visibility rows materialize. Scrolling on events therefore
  // strands the view a few lines short of the tail (seen on session/load
  // replay). The content's real size is the truth: while pinned, any growth
  // of the body — or resize of the scroller itself (composer drag) —
  // re-sticks the tail; while a landed row is held, it re-lands the row.
  // Never otherwise: scrollback is never yanked.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = chatRef.current;
    if (el === null || body === null) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) stick();
      else hold();
    });
    ro.observe(body);
    ro.observe(el);
    return () => ro.disconnect();
  }, [body, stick, hold]);

  // The top sentinel extends the window before its edge is ever seen:
  // rootMargin 75% of the viewport ≥ v·t with ~2× headroom (the safety
  // condition). A callback ref because the sentinel exists only in
  // the transcript render, not the state pages.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = chatRef.current;
    if (el === null || sentinel === null) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) grow();
      },
      { root: el, rootMargin: "75% 0px 0px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [sentinel, grow]);

  // Every page the pane shows carries the leave reader in the same place,
  // so it lives through the state pages and sees every session the pane
  // leaves.
  const pane = (page: ReactNode) => (
    <>
      <OnLeave session={activePatchbaySessionId} read={readPosition} keep={keepPosition} />
      {page}
    </>
  );

  // The in-pane connect state: a chat being started takes over the
  // pane — what its agent is busy with, resolving into the session, or the
  // failure with its specific reason and a Retry, never a bounce to the
  // empty state. `?? null` guards snapshots minted before this field
  // existed (persisted last-known views survive extension upgrades).
  const connect = props.state.chatConnect ?? null;
  if (connect !== null) {
    const agent = agents.find((a) => a.id === connect.patchbayAgentId);
    const name = agent?.name ?? connect.patchbayAgentId;
    if (connect.reason === undefined) {
      return pane(<StatePage icon="loading" spin tag={chatPaneProgress(connect, agent)} />);
    }
    return pane(
      <StatePage
        icon="warning"
        tag={
          <>
            {name} couldn't start — {connect.reason}
          </>
        }
      >
        <Button
          size="sm"
          onClick={() =>
            send(
              // a session-click connect retries as the same click —
              // never minting a new session for it
              connect.forPatchbaySessionId !== undefined
                ? { kind: "switchSession", patchbaySessionId: connect.forPatchbaySessionId }
                : { kind: "startChat", patchbayAgentId: connect.patchbayAgentId },
            )
          }
        >
          Retry
        </Button>
        <Button variant="outline" size="sm" onClick={() => send({ kind: "openSettings", section: "agents" })}>
          Settings
        </Button>
        <Button variant="ghost" size="sm" onClick={() => send({ kind: "dismissChatConnect" })}>
          Dismiss
        </Button>
      </StatePage>,
    );
  }

  // Startup restore in flight (protocol.ts `restoring`): the last open
  // session is on its way back — hold a loading page rather than flashing
  // the empty state. `?? false` guards snapshots minted before the field.
  if (active === null && (props.state.restoring ?? false)) {
    return pane(<StatePage icon="loading" spin tag="Restoring last session…" />);
  }

  if (active === null) {
    return pane(
      <StatePage
        icon="comment-discussion"
        tag={
          agents.length === 0
            ? "Any ACP agent, resident in your editor. Set one up to begin."
            : "No session yet — start one with +."
        }
      >
        <Button size="sm" onClick={props.onNewChat}>
          {agents.length === 0 ? (
            "Set up an agent…"
          ) : (
            <>
              <Icon name="add" /> New chat
            </>
          )}
        </Button>
      </StatePage>,
    );
  }

  const { items, rollups, liveRollup, liveBlockId } = derived;
  // Replay in flight with nothing to show — cold open, or an explicit
  // reload (which resets the transcript upfront: shown-but-untrusted
  // content doesn't stay up while reality is re-read). One route, one
  // loading page. Only the involuntary reopen after a connection death
  // keeps its transcript standing through the replay's wholesale swap.
  if (attaching(active) && items.length === 0 && props.subagent === undefined) {
    return pane(<StatePage icon="loading" spin tag="Loading session history…" />);
  }
  const visible = hidden > 0 ? items.slice(hidden) : items;
  const activeTurnStartedAt = props.subagent === undefined ? props.state.activeTurn[active.id] : undefined;
  const transcriptId = activePatchbaySessionId ?? active.id;

  return pane(
    <TerminalBlocks.Provider value={terminalBlocks}>
    <ToolDisplayPrefs.Provider value={props.state.preferences}>
    <PromptNav.Provider value={promptNav}>
    {props.subagent !== undefined && (
      <div className="subagent-bar">
        <button type="button" className="back" title={`Back to ${active.title}`} onClick={props.subagent.onBack}>
          <Icon name="arrow-left" /> {active.title}
        </button>
        <span className="sep">/</span>
        <SubagentDot look={subagentLook(props.subagent.view)} />
        <span className="name">{subagentName(props.subagent.view)}</span>
        <span className="state">
          {subagentStateText(props.subagent.view)}
          {props.subagent.view.config.length > 0 && ` · ${props.subagent.view.config.map((k) => knobText(k)).join(" · ")}`}
        </span>
        <span className="note">read-only</span>
      </div>
    )}
    <div
      className="chat"
      ref={chatRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        const up = el.scrollTop < lastScrollTop.current;
        lastScrollTop.current = el.scrollTop;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_BAND_PX;
        if (!atBottom) setPin(false);
        else if (!up) setPin(true);
      }}
      onWheel={(e) => {
        if (e.deltaY < 0) setPin(false);
      }}
      onTouchMove={() => setPin(false)}
    >
      {/* .chat-body exists so the ResizeObserver above has a content-sized
          element to watch — a scroller's own box never reflects its
          content's height. */}
      <div className="chat-body" ref={setBody}>
      {hidden > 0 && (
        <div ref={setSentinel} className="py-1 text-center text-[11px] text-muted-foreground">
          <Icon name="loading" spin /> loading earlier messages…
        </div>
      )}
      {/* One row per item, named by it: what a reading position records
          and a landing finds. */}
      {visible.map((item) => (
        <div key={itemId(item)} className="chat-row" data-item={itemId(item)}>
          {item.kind === "toolRun" ? (
            <MemoToolRun calls={item.calls} patchbaySessionId={transcriptId} roots={props.state.workspaceRoots} />
          ) : item.block.kind === "turnEnd" ? (
            <TurnLine
              live={false}
              startedAt={item.block.startedAt}
              endedAt={item.block.endedAt}
              stopReason={item.block.stopReason}
              usage={item.block.usage}
              error={item.block.error}
              rollup={rollups.get(item.block.id)!}
            />
          ) : (
            <MemoBlock
              block={item.block}
              live={item.block.id === liveBlockId}
              openThinking={props.state.preferences.openThinking}
              patchbaySessionId={transcriptId}
              agentName={agentName}
              roots={props.state.workspaceRoots}
            />
          )}
        </div>
      ))}
      {activeTurnStartedAt !== undefined && (
        <TurnLine
          live
          startedAt={activeTurnStartedAt}
          endedAt={null}
          stopReason={null}
          usage={null}
          rollup={liveRollup}
        />
      )}
      </div>
      {/* The way back to the tail, whenever unpinned: a corner nav
          control, not a banner — long transcripts make the manual scroll
          back genuinely tedious, and during a live turn the same control
          doubles as the pin state's read-out (clicking re-pins, follow
          resumes). Sticky + zero-height so it floats over the tail
          without adding scroll height. */}
      {!pinnedView && (
        <div className="chat-jump">
          <Button
            size="icon"
            variant="secondary"
            title="Jump to latest"
            aria-label="Jump to latest"
            onClick={() => {
              stick();
              setPin(true);
            }}
          >
            <Icon name="arrow-down" />
          </Button>
        </div>
      )}
    </div>
    </PromptNav.Provider>
    </ToolDisplayPrefs.Provider>
    </TerminalBlocks.Provider>,
  );
}
