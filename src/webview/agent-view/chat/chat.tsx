// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The transcript: renders the view-model's items in arrival order (the
// ordering principle), the per-turn
// metadata line, and the live elapsed ticker. Long transcripts ride the
// three-mechanism scale strategy: windowed mount, content-visibility
// containment (style.css), and memoized rows.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentViewState, ChatBlock, SessionSummary, TurnUsage } from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { count, formatDuration, type TranscriptView, type TurnRollup } from "./view-model";
import { InjectedUser, Thought, ToolCallCard, ToolRunCard, UserMessage } from "./blocks";
import { AgentMarkdown } from "./markdown";
import { DiffCard, ElicitationCard, PermissionCard, TerminalCard } from "./cards";
import { StatePage } from "./state-page";
import { Button } from "@/components/ui/button";

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
  rollup,
}: {
  live: boolean;
  startedAt: string | null;
  endedAt: string | null;
  stopReason: string | null;
  usage: TurnUsage | null;
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
      className="cursor-pointer select-none py-0.5 text-[11px] text-muted-foreground"
      title={!live && endedAt !== null ? `completed ${new Date(endedAt).toLocaleString()}` : undefined}
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
    >
      {live && <span className="spin mr-1.5 inline-block align-middle" />}
      {parts.join(" · ")}
      {chip && (
        <span
          className={`badge ml-1.5 ${stopReason === "error" ? "text-err" : "text-warn"}`}
          title="the turn did not end cleanly — this is the agent's stop reason"
        >
          {stopReason}
        </span>
      )}
      {open && (
        <div className="pt-0.5">
          {breakdown !== "" ? breakdown : "no tool calls this turn"}
          {usage !== null && (
            <>
              {" · "}
              {usage.input.toLocaleString()} in · {usage.output.toLocaleString()} out
              {usage.cached !== undefined ? ` · ${usage.cached.toLocaleString()} cached` : ""}
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
  sessionId,
}: {
  block: ChatBlock;
  live: boolean;
  sessionId: string;
}) {
  switch (block.kind) {
    case "user":
      return block.injected === true ? (
        <InjectedUser text={block.text} />
      ) : (
        <UserMessage text={block.text} />
      );
    case "text":
      return (
        <div className="msg-agent">
          <AgentMarkdown text={block.text} live={live} />
        </div>
      );
    case "thought":
      return <Thought text={block.text} live={live} />;
    case "toolCall":
      return <ToolCallCard block={block} sessionId={sessionId} />;
    case "turnEnd":
      return null; // rendered by Chat as TurnLine, with its rollup
    case "permission":
      return <PermissionCard block={block} />;
    case "diff":
      return <DiffCard block={block} />;
    case "terminal":
      return <TerminalCard block={block} />;
    case "elicitation":
      return <ElicitationCard block={block} />;
    case "notice":
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
    a.sessionId === b.sessionId &&
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

export function Chat(props: {
  state: AgentViewState;
  activeSession: SessionSummary | null;
  /** The active session's blocks and their derived view — App owns the one
   * transcript read and the one derivation (view-model.ts) because the
   * composer's stats strip consumes the same pass's session totals; passing
   * both keeps them in lockstep by construction. */
  blocks: readonly ChatBlock[];
  derived: TranscriptView;
  /** The shell's smart "+": zero agents → Settings, one → straight
   * to it, several → the picker. */
  onNewChat(): void;
}) {
  const send = useActions();
  const { agents } = props.state;
  const active = props.activeSession;
  const activeId = active?.id;
  const chatRef = useRef<HTMLDivElement>(null);
  const { blocks, derived } = props;

  const [mounted, setMounted] = useState(INITIAL_WINDOW);
  const hidden = Math.max(0, derived.items.length - mounted);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  /** scrollHeight recorded just before a prepend — restored as a scrollTop
   * delta so extending the window never shifts what the user is reading.
   * Null when parked at the very top (a jump-to-start teleport): staying
   * at 0 lets the fill continue chunk by chunk instead of bouncing. */
  const pendingAnchor = useRef<number | null>(null);
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
      pendingAnchor.current = el.scrollTop === 0 ? null : el.scrollHeight;
      setMounted((c) => c + WINDOW_BATCH);
    }
  }, []);

  // Session switch: fresh window, pinned, jump to the tail.
  useLayoutEffect(() => {
    setMounted(INITIAL_WINDOW);
    setPin(true);
    lastScrollTop.current = 0;
    stick();
  }, [activeId, setPin, stick]);

  // Prepend anchoring + teleport chunk-fill.
  useLayoutEffect(() => {
    const el = chatRef.current;
    if (el === null) return;
    if (pendingAnchor.current !== null) {
      el.scrollTop += el.scrollHeight - pendingAnchor.current;
      pendingAnchor.current = null;
    } else if (el.scrollTop === 0 && hiddenRef.current > 0) {
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
  // re-sticks the tail. Never while unpinned: scrollback is never yanked.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = chatRef.current;
    if (el === null || body === null) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) stick();
    });
    ro.observe(body);
    ro.observe(el);
    return () => ro.disconnect();
  }, [body, stick]);

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

  // The in-pane connect state: a chat being started takes over the
  // pane — "Connecting…" resolving into the session, or the failure with
  // its specific reason and a Retry, never a bounce to the empty state.
  // `?? null` guards snapshots minted before this field existed (persisted
  // last-known views survive extension upgrades).
  const connect = props.state.chatConnect ?? null;
  if (connect !== null) {
    const agent = agents.find((a) => a.id === connect.agentId);
    const name = agent?.name ?? connect.agentId;
    if (connect.status === "connecting") {
      // The pool's warmup phase label rides AgentSummary.detail while a
      // launcher download is genuinely in flight ("downloading the agent
      // package…") — the difference between a 20-second silent connect
      // and a said reason.
      const phase = agent?.status === "reconnecting" ? agent.detail : undefined;
      return (
        <StatePage
          icon="loading"
          spin
          tag={<>Connecting {name}…{phase !== undefined ? ` — ${phase}` : ""}</>}
        />
      );
    }
    return (
      <StatePage
        icon="warning"
        tag={
          <>
            {name} couldn't start{connect.reason !== undefined ? ` — ${connect.reason}` : ""}
          </>
        }
      >
        <Button
          size="sm"
          onClick={() =>
            send(
              // a session-click connect retries as the same click —
              // never minting a new session for it
              connect.forSessionId !== undefined
                ? { kind: "switchSession", sessionId: connect.forSessionId }
                : { kind: "startChat", agentId: connect.agentId },
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
      </StatePage>
    );
  }

  // Startup restore in flight (protocol.ts `restoring`): the last open
  // session is on its way back — hold a loading page rather than flashing
  // the empty state. `?? false` guards snapshots minted before the field.
  if (active === null && (props.state.restoring ?? false)) {
    return <StatePage icon="loading" spin tag="Restoring last session…" />;
  }

  if (active === null) {
    return (
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
      </StatePage>
    );
  }

  const { items, rollups, liveRollup, liveBlockId } = derived;
  const visible = hidden > 0 ? items.slice(hidden) : items;
  const activeTurnStartedAt = props.state.activeTurn[active.id];

  return (
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
      {visible.map((item) =>
        item.kind === "toolRun" ? (
          <MemoToolRun key={item.id} calls={item.calls} sessionId={active.id} />
        ) : item.block.kind === "turnEnd" ? (
          <TurnLine
            key={item.block.id}
            live={false}
            startedAt={item.block.startedAt}
            endedAt={item.block.endedAt}
            stopReason={item.block.stopReason}
            usage={item.block.usage}
            rollup={rollups.get(item.block.id)!}
          />
        ) : (
          <MemoBlock
            key={item.block.id}
            block={item.block}
            live={item.block.id === liveBlockId}
            sessionId={active.id}
          />
        ),
      )}
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
  );
}
