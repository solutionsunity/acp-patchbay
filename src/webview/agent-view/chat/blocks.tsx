// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Prose and tool-call blocks of the transcript. Each component consumes the
// view-model's vocabulary (`live` = the one block receiving deltas) and
// sends its own actions — no callback threading.
import { createContext, useContext, useState } from "react";
import {
  isToolCallOpen,
  userPartsText,
  terminalBlockId,
  type ContentPart,
  type TerminalBlock,
  type ToolCallBlock,
  type UserPart,
} from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { basename, splitPath } from "../../shared/path";
import { useCopy } from "../../shared/use-copy";
import { attachmentUri } from "../../shared/attachments-base";
import { TerminalView } from "./cards";
import { AgentMarkdown } from "./markdown";
import { toolFileRows } from "./view-model";

/** Mention spelling some agents flatten replayed mentions into as *text*:
 * `[@name](file://… | zed://…)`. Structured mentions arrive as their own
 * part; this regex only recovers ones an agent baked into prose. Anchored
 * to those schemes on purpose: a user's own `[label](url)` markdown stays
 * the literal text they typed (user prompts are never markdown-rendered). */
const MENTION_LINK = /\[@([^\]\n]+)\]\((?:file|zed):\/\/[^()\s]*\)/g;

/** Literal prompt prose, with agent-flattened mention links recovered as
 * tokens — everything else renders exactly as typed. */
function UserProse({ text }: { text: string }) {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_LINK)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(
      <span key={m.index} className="prompt-token mention-token">
        @{m[1]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (nodes.length === 0) return <>{text}</>;
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

/** A pasted/attached image inside the bubble: inline preview off the
 * attachments stash where the bytes landed; a missing file (stash failed,
 * OS temp cleanup, another machine's session) degrades to a labeled chip —
 * never a broken-image glyph. */
function ImagePart({ part }: { part: Extract<UserPart, { kind: "image" }> }) {
  const [broken, setBroken] = useState(false);
  const src = part.file !== undefined ? attachmentUri(part.file) : null;
  if (src === null || broken) {
    return (
      <span className="prompt-token" title={part.mimeType}>
        <Icon name="file-media" /> image
      </span>
    );
  }
  return <img className="user-image" src={src} alt={part.mimeType} onError={() => setBroken(true)} />;
}

/** A labeled context snapshot (selection, problems, embedded resource) —
 * collapsed to its label; the bounded text on demand. */
function ContextPart({ part }: { part: Extract<UserPart, { kind: "context" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="user-context">
      <span
        className="prompt-token cursor-pointer select-none"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Icon name="link" /> {part.label} <Icon name={open ? "chevron-down" : "chevron-right"} />
      </span>
      {open && <pre className="user-context-body">{part.text}</pre>}
    </span>
  );
}

function PartView({ part }: { part: UserPart }) {
  switch (part.kind) {
    case "text":
      return <UserProse text={part.text} />;
    case "mention":
      return (
        <span className="prompt-token mention-token" title={part.uri}>
          @{part.name}
        </span>
      );
    case "image":
      return <ImagePart part={part} />;
    case "attachment":
      return (
        <span className="prompt-token" title={part.path}>
          <Icon name="file" /> {part.name}
        </span>
      );
    case "context":
      return <ContextPart part={part} />;
    case "unrendered":
      return <span className="italic text-muted-foreground">[{part.type} content — not rendered]</span>;
  }
}

/** The human's own prompt bubble — a part sequence rendered in the wire's
 * own vocabulary (text, mentions, images, attachments, context), with a
 * hover-revealed copy affordance to its left — outside the bubble so it
 * never overlaps the text; while the check-mark feedback shows, it stays
 * visible regardless of hover. Copy hands back the flattened readable
 * form (userPartsText). */
export function UserMessage({ parts }: { parts: readonly UserPart[] }) {
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
        onClick={() => copy(userPartsText(parts))}
      >
        <Icon name={copied ? "check" : "copy"} size={12} />
      </button>
      {/* max-w-full neutralizes .msg-user's own 85% cap (style.css) — the
          wrapper already carries it; 85% of 85% would double-shrink. */}
      <div className="msg-user max-w-full">
        {parts.map((part, i) => (
          <PartView key={i} part={part} />
        ))}
      </div>
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
 * reality or observe it? (theme.css tool-call weight accents — one cold
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

/** A link that reads as text until hovered — files in a tool call. */
const LINK =
  "cursor-pointer border-none bg-transparent p-0 text-inherit hover:text-[var(--vscode-textLink-foreground)] hover:underline";
/** A reported file in a tool call's header: the title's own color, a step
 * quieter — never louder than the title. */
const HEADER_LINK = `${LINK} truncate font-mono text-[11px] opacity-70 hover:opacity-100`;

/** Collapsed by default: title, the first file the call reported as a link
 * (`name:line`, "+N" for the other files), and status. The link opens the
 * file at the line the agent named; the rest of the header toggles the
 * details — two targets, because opening a file takes the editor's focus
 * while showing details costs nothing. Expanded: one row per file — name,
 * then every line the agent reported in it, then "diff" when the call
 * carried one (VS Code's native diff editor, never an inline diff view) —
 * listed only when it says more than the header link; then input args and
 * output — bounded upstream, rendered mono, never through markdown. */
export function ToolCallCard({
  block,
  sessionId,
  roots,
}: {
  block: ToolCallBlock;
  sessionId: string;
  /** Workspace roots — file rows read relative to them. */
  roots: readonly string[];
}) {
  const send = useActions();
  const [open, setOpen] = useState(false);
  const rows = toolFileRows(block);
  const listFiles = rows.length > 1 || rows.some((r) => r.diff || r.lines.length > 1);
  const shown = block.content.filter((p) => p.kind !== "terminal");
  const terminals = block.content.flatMap((p) => (p.kind === "terminal" ? [p.terminalId] : []));
  const hasRaw = block.input !== null || block.output !== null;
  const expandable = listFiles || shown.length > 0 || hasRaw;
  const openAt = (path: string, line: number | undefined) =>
    send(line === undefined ? { kind: "openFile", path } : { kind: "openFile", path, line });
  const first = block.locations[0];
  const stop = (act: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    act();
  };
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
        {first !== undefined && (
          <button
            type="button"
            className={`tool-loc min-w-0 max-w-[45%] ${HEADER_LINK}`}
            title={`Open ${first.path}${first.line === null ? "" : ` at line ${first.line}`}`}
            onClick={stop(() => openAt(first.path, first.line ?? undefined))}
          >
            {basename(first.path)}
            {first.line !== null && `:${first.line}`}
          </button>
        )}
        {first !== undefined && rows.length > 1 && (
          <button
            type="button"
            className={`tool-loc-more shrink-0 ${HEADER_LINK}`}
            title="Show the other files this call reported"
            onClick={stop(() => setOpen(true))}
          >
            +{rows.length - 1}
          </button>
        )}
        {expandable && <DetailsToggle open={open} onToggle={stop(() => setOpen((v) => !v))} />}
        <ToolCallStatusTag block={block} />
      </div>
      {open && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2.5">
          {listFiles && (
            <div className="tool-files flex flex-col gap-0.5 text-[12px]">
              {rows.map((r) => {
                const { base, dir } = splitPath(r.path, roots);
                return (
                  <div key={r.path} className="flex min-w-0 items-center gap-1.5">
                    <button
                      type="button"
                      className={`flex shrink-0 items-center gap-1 font-medium ${LINK}`}
                      title={`Open ${r.path}${r.lines[0] === undefined ? "" : ` at line ${r.lines[0]}`}`}
                      onClick={stop(() => openAt(r.path, r.lines[0]))}
                    >
                      <Icon name="go-to-file" />
                      {base}
                      {r.lines[0] !== undefined && `:${r.lines[0]}`}
                    </button>
                    {r.lines.slice(1).map((line) => (
                      <button
                        type="button"
                        key={line}
                        className={`shrink-0 font-mono text-[11px] text-muted-foreground ${LINK}`}
                        title={`Open ${r.path} at line ${line}`}
                        onClick={stop(() => openAt(r.path, line))}
                      >
                        :{line}
                      </button>
                    ))}
                    {dir !== "" && (
                      <span className="min-w-0 truncate text-muted-foreground" title={r.path}>
                        {dir}
                      </span>
                    )}
                    {r.diff && (
                      <button
                        type="button"
                        className={`ml-auto flex shrink-0 items-center gap-1 text-muted-foreground ${LINK}`}
                        title="Open in VS Code's diff editor"
                        onClick={stop(() =>
                          send({ kind: "openToolCallDiff", sessionId, toolCallId: block.id, path: r.path }),
                        )}
                      >
                        <Icon name="diff" /> diff
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {shown.map((part, i) => (
            <ContentPartView key={i} part={part} />
          ))}
          {hasRaw && <RawSection input={block.input} output={block.output} />}
        </div>
      )}
      {terminals.map((id) => (
        <EmbeddedTerminal key={id} terminalId={id} />
      ))}
    </div>
  );
}

/** The chevron that shows or hides a card's details — a real button, so the
 * keyboard reaches it; the header around it stays clickable for the mouse. */
function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      className={`flex shrink-0 items-center ${LINK}`}
      aria-expanded={open}
      aria-label={open ? "Hide details" : "Show details"}
      title={open ? "Hide details" : "Show details"}
      onClick={onToggle}
    >
      <Icon name={open ? "chevron-down" : "chevron-right"} />
    </button>
  );
}

/** One piece of agent-side content — a tool call's content, a non-text
 * piece of an agent's message. Text is the agent's own markdown (console
 * output in fences, labels), rendered like its messages; every other kind
 * shares the user message's part renderers. */
export function ContentPartView({ part }: { part: ContentPart }) {
  if (part.kind === "text") {
    return (
      <div className="msg-agent min-w-0">
        <AgentMarkdown text={part.text} live={false} />
      </div>
    );
  }
  return (
    <div>
      <PartView part={part} />
    </div>
  );
}

/** The call's wire payload — the exact arguments that ran and the tool's
 * unformatted result. Kept for transparency and debugging, one click away
 * and never the main view: what the agent meant to show is its content. */
function RawSection({ input, output }: { input: string | null; output: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className={`flex items-center gap-1 text-[10.5px] uppercase tracking-wide text-muted-foreground ${LINK}`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} /> raw
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1.5">
          {input !== null && (
            <div>
              <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">input</div>
              <pre className="term m-0 whitespace-pre-wrap">{input}</pre>
            </div>
          )}
          {output !== null && (
            <div>
              <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">output</div>
              <pre className="term m-0 whitespace-pre-wrap">{output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Client terminals by block id, provided by the chat. Read only by the
 * embedded terminals themselves, so live output re-renders them and not
 * every tool card around them. */
export const TerminalBlocks = createContext<ReadonlyMap<string, TerminalBlock>>(new Map());

/** A terminal the call runs in, always visible under its header — ACP: the
 * client displays an embedded terminal's output as it is generated. */
function EmbeddedTerminal({ terminalId }: { terminalId: string }) {
  const block = useContext(TerminalBlocks).get(terminalBlockId(terminalId));
  if (block === undefined) {
    return <div className="px-2.5 pb-2 text-[11px] italic text-muted-foreground">terminal {terminalId} — not started</div>;
  }
  return (
    <div className="border-t border-[var(--pb-border)]">
      <TerminalView block={block} />
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
  roots,
}: {
  calls: readonly ToolCallBlock[];
  sessionId: string;
  roots: readonly string[];
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
          {weightedIcon} {calls.length} tool calls{" "}
          <DetailsToggle
            open={true}
            onToggle={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
        </div>
        {calls.map((c) => (
          <ToolCallCard key={c.id} block={c} sessionId={sessionId} roots={roots} />
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
        <DetailsToggle
          open={false}
          onToggle={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        />
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
