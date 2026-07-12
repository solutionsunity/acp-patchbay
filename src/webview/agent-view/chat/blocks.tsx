// Prose and tool-call blocks of the transcript. Each component consumes the
// view-model's vocabulary (`live` = the one block receiving deltas) and
// sends its own actions — no callback threading.
import { useState } from "react";
import { isToolCallOpen, type ToolCallBlock } from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { useCopy } from "../../shared/use-copy";
import { AgentMarkdown } from "./markdown";
import { Button } from "@/components/ui/button";

/** The human's own prompt bubble, with a hover-revealed copy affordance to
 * its left — outside the bubble so it never overlaps the text; while the
 * check-mark feedback shows, it stays visible regardless of hover. */
export function UserMessage({ text }: { text: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="group flex max-w-[85%] items-start gap-1.5 self-end">
      <button
        type="button"
        className={`mt-1.5 cursor-pointer border-none bg-transparent p-0.5 text-muted-foreground hover:text-foreground ${
          copied ? "" : "opacity-0 group-hover:opacity-100"
        }`}
        title="Copy prompt"
        aria-label="Copy prompt"
        onClick={() => copy(text)}
      >
        <Icon name={copied ? "check" : "copy"} size={12} />
      </button>
      {/* max-w-full neutralizes .msg-user's own 85% cap (style.css) — the
          wrapper already carries it; 85% of 85% would double-shrink. */}
      <div className="msg-user max-w-full">{text}</div>
    </div>
  );
}

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

/** A harness-injected message that rode the user role on the wire (UserBlock
 * `injected`, classified orchestrator-side) — a real transcript fact, but not
 * something the human typed: a dim collapsed line, never a prompt bubble.
 * The tag slice is display-only; the classification itself never happens here. */
export function InjectedUser({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const tag = /^<([a-z][a-z0-9-]*)/.exec(text.trim())?.[1] ?? "envelope";
  return (
    <div className={`injected ${open ? "open" : ""}`}>
      <div className="cursor-pointer select-none" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="gear" /> {tag} — injected by the agent harness{" "}
        <Icon name={open ? "chevron-down" : "chevron-right"} />
      </div>
      {open && <pre className="body">{text}</pre>}
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

/** The one semantic color axis on tool-call icons: did this call change
 * reality or observe it? (theme.css § tool-call weight accents — one cold
 * info-blue hue at two intensity steps; the axis is ordinal, so it's a
 * ramp, not a hue pair.) Weight, not verdict: the status tag owns
 * ok/warn/err. Observing kinds stay chrome-dim — the noise floor. Never a
 * color per kind: that's decoration, and it collides with the status
 * colors on the same row. */
type ToolWeight = "observe" | "mutate" | "destroy";
const TOOL_WEIGHT: Record<ToolCallBlock["toolKind"], ToolWeight> = {
  read: "observe",
  edit: "mutate",
  delete: "destroy",
  move: "mutate",
  search: "observe",
  execute: "mutate",
  think: "observe",
  fetch: "observe",
  switch_mode: "observe",
  other: "observe",
};
const WEIGHT_CLASS: Record<ToolWeight, string> = {
  observe: "", // inherits the .tool-hd chrome dim
  mutate: "text-mutate",
  destroy: "text-destroy",
};

/** A run's heaviest weight — destructive > mutating > observing, the same
 * precedence idea as the run status tag below (running > interrupted >
 * denied > failed > ok): the collapsed header summarizes, expansion shows
 * each card's own color. */
function heaviestWeight(calls: readonly ToolCallBlock[]): ToolWeight {
  let heaviest: ToolWeight = "observe";
  for (const c of calls) {
    const w = TOOL_WEIGHT[c.toolKind];
    if (w === "destroy") return "destroy";
    if (w === "mutate") heaviest = "mutate";
  }
  return heaviest;
}

/** Right-side status: blocked-by-permission is its own state, visually
 * distinct from a genuine execution failure — different facts. */
function ToolCallStatusTag({ block }: { block: ToolCallBlock }) {
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
  // Set once by the orchestrator's turn-end sweep (session-manager.ts),
  // never re-derived from "is some turn active right now" — a later turn
  // in the same session must not resurrect an old turn's stalled call.
  if (block.interrupted) {
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
}: {
  block: ToolCallBlock;
  sessionId: string;
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
        <span className={WEIGHT_CLASS[TOOL_WEIGHT[block.toolKind]]}>
          <Icon name={TOOL_ICON[block.toolKind]} />
        </span>
        <span className="min-w-0 flex-1 truncate">{block.title}</span>
        {expandable && <Icon name={open ? "chevron-down" : "chevron-right"} />}
        <ToolCallStatusTag block={block} />
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
}: {
  calls: readonly ToolCallBlock[];
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const running = calls.find((c) => isToolCallOpen(c.status) && !c.interrupted);
  const interrupted = calls.find((c) => isToolCallOpen(c.status) && c.interrupted);
  const denied = calls.filter((c) => c.denied).length;
  const failed = calls.filter((c) => c.status === "failed" && !c.denied).length;
  const weightedIcon = (
    <span className={WEIGHT_CLASS[heaviestWeight(calls)]}>
      <Icon name="tools" />
    </span>
  );
  if (open) {
    return (
      <>
        <div
          className="card-hd tool-hd cursor-pointer"
          onClick={() => setOpen(false)}
          aria-expanded={true}
        >
          {weightedIcon} {calls.length} tool calls <Icon name="chevron-down" />
        </div>
        {calls.map((c) => (
          <ToolCallCard key={c.id} block={c} sessionId={sessionId} />
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
        {weightedIcon}
        <span className="min-w-0 flex-1 truncate">
          {calls.length} tool calls{running !== undefined ? ` — ${running.title}` : ""}
        </span>
        <Icon name="chevron-right" />
        <span className="st">
          {running !== undefined ? (
            <span className="spin" />
          ) : interrupted !== undefined ? (
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
