// The transcript: renders the view-model's items in arrival order (the
// ordering principle, ui-rendering-strategy § Summary), the per-turn
// metadata line, and the live elapsed ticker.
import { useEffect, useRef, useState } from "react";
import type { AgentViewState, ChatBlock, SessionSummary, TurnEndBlock } from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { deriveTranscript, formatDuration, type TurnRollup } from "./view-model";
import { Thought, ToolCallCard, ToolRunCard } from "./blocks";
import { AgentMarkdown } from "./markdown";
import { DiffCard, ElicitationCard, PermissionCard, TerminalCard } from "./cards";
import { StatePage } from "./state-page";
import { Button } from "@/components/ui/button";

/** Per-turn metadata line (ui-rendering-strategy § Per-turn summary /
 * completion metadata): subtle one-liner under the turn — counts only when
 * nonzero, tokens only when the agent reported them (absence over fake),
 * completion wall-clock as a hover tooltip, and a stop-reason chip only
 * when the turn didn't end cleanly. Click expands the by-kind breakdown. */
function TurnMetaLine({ block, rollup }: { block: TurnEndBlock; rollup: TurnRollup }) {
  const [open, setOpen] = useState(false);
  const parts: string[] = [];
  if (rollup.toolCalls > 0) parts.push(`${rollup.toolCalls} tool call${rollup.toolCalls === 1 ? "" : "s"}`);
  if (rollup.filesTouched > 0) parts.push(`${rollup.filesTouched} file${rollup.filesTouched === 1 ? "" : "s"}`);
  parts.push(formatDuration(block.startedAt, block.endedAt));
  if (block.usage !== null) parts.push(`${block.usage.total.toLocaleString()} tokens`);
  const breakdown = Object.entries(rollup.byKind)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(" · ");
  return (
    <div
      className="cursor-pointer select-none py-0.5 text-[11px] text-muted-foreground"
      title={`completed ${new Date(block.endedAt).toLocaleString()}`}
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
    >
      {parts.join(" · ")}
      {block.stopReason !== "end_turn" && (
        <span
          className={`badge ml-1.5 ${block.stopReason === "error" ? "text-err" : "text-warn"}`}
          title="the turn did not end cleanly — this is the agent's stop reason"
        >
          {block.stopReason}
        </span>
      )}
      {open && (
        <div className="pt-0.5">
          {breakdown !== "" ? breakdown : "no tool calls this turn"}
          {block.usage !== null && (
            <>
              {" · "}
              {block.usage.input.toLocaleString()} in · {block.usage.output.toLocaleString()} out
              {block.usage.cached !== undefined ? ` · ${block.usage.cached.toLocaleString()} cached` : ""}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Live elapsed ticker while a turn is in flight — visible feedback for a
 * slow response instead of silence. Client-side seconds; ephemeral. A
 * spinner, not a clock glyph: animation is the "something is happening"
 * signal, the digits already say how long. */
function TurnTicker({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="py-0.5 text-[11px] text-muted-foreground">
      <Icon name="loading" spin /> {formatDuration(startedAt, new Date(now).toISOString())}
    </div>
  );
}

function Block({ block, live, sessionId }: { block: ChatBlock; live: boolean; sessionId: string }) {
  switch (block.kind) {
    case "user":
      return <div className="msg-user">{block.text}</div>;
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
      return null; // rendered by Chat as TurnMetaLine, with its rollup
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

export function Chat(props: {
  state: AgentViewState;
  activeSession: SessionSummary | null;
  /** The shell's smart "+" (P17): zero agents → Settings, one → straight
   * to it, several → the picker. */
  onNewChat(): void;
}) {
  const send = useActions();
  const { agents } = props.state;
  const active = props.activeSession;
  const chatRef = useRef<HTMLDivElement>(null);
  const blocks = active !== null ? (props.state.transcripts[active.id] ?? []) : [];

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks.length, blocks[blocks.length - 1]]);

  // The in-pane connect state (P17): a chat being started takes over the
  // pane — "Connecting…" resolving into the session, or the failure with
  // its specific reason and a Retry, never a bounce to the empty state.
  // `?? null` guards snapshots minted before this field existed (persisted
  // last-known views survive extension upgrades).
  const connect = props.state.chatConnect ?? null;
  if (connect !== null) {
    const name = agents.find((a) => a.id === connect.agentId)?.name ?? connect.agentId;
    if (connect.status === "connecting") {
      return <StatePage icon="loading" spin tag={<>Connecting {name}…</>} />;
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
        <Button variant="outline" size="sm" onClick={() => send({ kind: "openSettings" })}>
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

  const { items, rollups, liveBlockId } = deriveTranscript(blocks, active.live);
  const activeTurnStartedAt = props.state.activeTurn[active.id];

  return (
    <div className="chat" ref={chatRef}>
      {items.map((item) =>
        item.kind === "toolRun" ? (
          <ToolRunCard key={item.id} calls={item.calls} sessionId={active.id} />
        ) : item.block.kind === "turnEnd" ? (
          <TurnMetaLine key={item.block.id} block={item.block} rollup={rollups.get(item.block.id)!} />
        ) : (
          <Block
            key={item.block.id}
            block={item.block}
            live={item.block.id === liveBlockId}
            sessionId={active.id}
          />
        ),
      )}
      {activeTurnStartedAt !== undefined && <TurnTicker startedAt={activeTurnStartedAt} />}
    </div>
  );
}
