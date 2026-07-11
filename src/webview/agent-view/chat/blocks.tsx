// Prose and tool-call blocks of the transcript. Each component consumes the
// view-model's vocabulary (`live` = the one block receiving deltas) and
// sends its own actions — no callback threading.
import { useState } from "react";
import type { ToolCallBlock } from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { AgentMarkdown } from "./markdown";
import { Button } from "@/components/ui/button";

/** agent_thought_chunk feed — not the final answer, and reads that way:
 * muted, collapsed into a "Thinking…" accordion the moment the real answer
 * starts streaming (`live` flips false). Expandable on demand, never
 * deleted; a manual toggle overrides the auto behavior in both directions. */
export function Thought({ text, live }: { text: string; live: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? live;
  return (
    <div className={`thought ${open ? "open" : ""}`}>
      <div
        className="cursor-pointer select-none"
        onClick={() => setManual(open ? false : true)}
        aria-expanded={open}
      >
        <Icon name="sparkle" /> {live ? "Thinking" : "Thought"}
        {live && <span>…</span>}{" "}
        <Icon name={open ? "chevron-down" : "chevron-right"} />
      </div>
      {open && (
        <div className="body">
          <AgentMarkdown text={text} live={live} />
        </div>
      )}
    </div>
  );
}

/** Icon by ACP's own tool-call taxonomy — pattern-matchable at a glance,
 * not a generic spinner-only look. */
const TOOL_ICON: Record<ToolCallBlock["toolKind"], string> = {
  read: "file",
  edit: "edit",
  delete: "trash",
  move: "arrow-right",
  search: "search",
  execute: "terminal",
  think: "sparkle",
  fetch: "cloud-download",
  switch_mode: "arrow-swap",
  other: "tools",
};

/** Right-side status: blocked-by-permission is its own state, visually
 * distinct from a genuine execution failure — different facts. */
function ToolCallStatusTag({ block, turnActive }: { block: ToolCallBlock; turnActive: boolean }) {
  if (block.denied) {
    return (
      <span className="st text-warn">
        <Icon name="shield" /> blocked by permission
      </span>
    );
  }
  if (block.status === "failed") {
    return (
      <span className="st text-err">
        <Icon name="close" /> failed
      </span>
    );
  }
  if (block.status === "completed") {
    return (
      <span className="st text-ok">
        <Icon name="check" />
      </span>
    );
  }
  // Incomplete without an active turn: the wire has no "cancelled" tool
  // status, and a replayed session carries no turn state either — so
  // "interrupted" is *derived*, never stored. A spinner is a claim that
  // work is happening; that claim is only true while a turn is in flight,
  // and this way a live-cancelled turn and its later session/load replay
  // render identically (agent representation is the truth).
  if (!turnActive) {
    return (
      <span className="st text-muted-foreground">
        <Icon name="circle-slash" /> interrupted
      </span>
    );
  }
  return (
    <span className="st">
      <span className="spin" /> {block.status === "pending" ? "pending" : "running"}
    </span>
  );
}

/** Collapsed by default: title + status. Expand reveals input args and
 * output — bounded upstream, rendered mono, never through markdown — and,
 * for calls carrying diff content, "Open diff" per file, routed to VS
 * Code's native diff editor rather than any inline diff view. */
export function ToolCallCard({
  block,
  sessionId,
  turnActive,
}: {
  block: ToolCallBlock;
  sessionId: string;
  turnActive: boolean;
}) {
  const send = useActions();
  const [open, setOpen] = useState(false);
  const expandable = block.input !== null || block.output !== null || block.diffFiles.length > 0;
  return (
    <div className="card">
      <div
        className={`card-hd tool-hd ${expandable ? "cursor-pointer" : ""}`}
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
        aria-expanded={expandable ? open : undefined}
      >
        <Icon name={TOOL_ICON[block.toolKind]} />
        <span className="min-w-0 flex-1 truncate">{block.title}</span>
        {expandable && <Icon name={open ? "chevron-down" : "chevron-right"} />}
        <ToolCallStatusTag block={block} turnActive={turnActive} />
      </div>
      {open && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2.5">
          {block.diffFiles.map((path) => (
            <Button
              variant="outline"
              size="sm"
              key={path}
              className="self-start"
              title="opens in VS Code's diff editor"
              onClick={(e) => {
                e.stopPropagation();
                send({ kind: "openToolCallDiff", sessionId, toolCallId: block.id, path });
              }}
            >
              <Icon name="diff" /> Open diff — {path}
            </Button>
          ))}
          {block.input !== null && (
            <div>
              <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">input</div>
              <pre className="term m-0 whitespace-pre-wrap">{block.input}</pre>
            </div>
          )}
          {block.output !== null && (
            <div>
              <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">output</div>
              <pre className="term m-0 whitespace-pre-wrap">{block.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A run of back-to-back tool calls, collapsed to one summary row so a
 * search-heavy turn doesn't bury the prose — expandable to the individual
 * cards, order intact. The in-flight call's title stays visible on the
 * summary so a live run never reads as a stall. */
export function ToolRunCard({
  calls,
  sessionId,
  turnActive,
}: {
  calls: readonly ToolCallBlock[];
  sessionId: string;
  turnActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const running = calls.find((c) => c.status === "pending" || c.status === "in_progress");
  const denied = calls.filter((c) => c.denied).length;
  const failed = calls.filter((c) => c.status === "failed" && !c.denied).length;
  if (open) {
    return (
      <>
        <div
          className="card-hd tool-hd cursor-pointer"
          onClick={() => setOpen(false)}
          aria-expanded={true}
        >
          <Icon name="tools" /> {calls.length} tool calls <Icon name="chevron-down" />
        </div>
        {calls.map((c) => (
          <ToolCallCard key={c.id} block={c} sessionId={sessionId} turnActive={turnActive} />
        ))}
      </>
    );
  }
  return (
    <div className="card">
      <div
        className="card-hd tool-hd cursor-pointer"
        onClick={() => setOpen(true)}
        aria-expanded={false}
      >
        <Icon name="tools" />
        <span className="min-w-0 flex-1 truncate">
          {calls.length} tool calls{running !== undefined ? ` — ${running.title}` : ""}
        </span>
        <Icon name="chevron-right" />
        <span className="st">
          {running !== undefined && turnActive ? (
            <span className="spin" />
          ) : running !== undefined ? (
            <span className="text-muted-foreground">
              <Icon name="circle-slash" /> interrupted
            </span>
          ) : denied > 0 ? (
            <span className="text-warn">
              <Icon name="shield" /> {denied} blocked
            </span>
          ) : failed > 0 ? (
            <span className="text-err">
              <Icon name="close" /> {failed} failed
            </span>
          ) : (
            <span className="text-ok">
              <Icon name="check" />
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
