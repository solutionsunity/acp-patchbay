// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Prose and tool-call blocks of the transcript. Each component consumes the
// view-model's vocabulary (`live` = the one block receiving deltas) and
// sends its own actions — no callback threading.
import { createContext, useContext, useState, type ReactNode } from "react";
import {
  DEFAULT_PREFERENCES,
  isToolCallOpen,
  userPartsText,
  terminalBlockId,
  unrenderedLabel,
  type CompactionBlock,
  type ContentPart,
  type DiffStat,
  type PreferencesView,
  type TerminalBlock,
  type ToolCallBlock,
  type ToolContentPart,
  type UserPart,
} from "../../../shared/protocol";
import { showsWholeTitle, startsOpen, toolCallDisplay, type ToolDisplayPreference } from "../../../shared/tool-display";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { Disclosure } from "../../shared/disclosure";
import { basename, filePathOf, splitPath } from "../../shared/path";
import { useCopy } from "../../shared/use-copy";
import { attachmentUri } from "../../shared/attachments-base";
import { AgentMarkdown } from "./markdown";
import { DiffStatText } from "./diff-stat";
import { compactionLine, diffTotal, thoughtTail, toolFileRows, type ToolFileRow } from "./view-model";
import type { PatchbaySessionId } from "../../../shared/ids";

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
    // An image sent by address only is a link to it — never fetched into
    // the view.
    return part.uri !== undefined ? (
      <a className={`prompt-token ${LINK}`} href={part.uri} title={part.uri}>
        <Icon name="file-media" /> image
      </a>
    ) : (
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
      <Disclosure
        open={open}
        onToggle={() => setOpen(!open)}
        label={open ? "Hide the snapshot" : "Show the snapshot"}
        className="prompt-token"
      >
        <Icon name="link" /> {part.label}
      </Disclosure>
      {open && <pre className="user-context-body">{part.text}</pre>}
    </span>
  );
}

function PartView({ part }: { part: UserPart }) {
  switch (part.kind) {
    case "text":
      return <UserProse text={part.text} />;
    case "mention":
      return <MentionToken part={part} />;
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
      return <span className="italic text-muted-foreground">[{unrenderedLabel(part.type)}]</span>;
  }
}

/** A resource_link, wherever it arrives — a user's `@file`, a link in a
 * thought or a tool's content. A local file opens in the editor; any other
 * address takes the same path as a link in the agent's prose. */
function MentionToken({ part }: { part: Extract<UserPart, { kind: "mention" }> }) {
  const send = useActions();
  const { name, uri } = part;
  const path = filePathOf(uri);
  const className = `prompt-token mention-token ${LINK}`;
  // What the agent said of the link, above where it goes.
  const said = [part.title, part.description].filter((t) => t !== undefined).join(" — ");
  const tip = (target: string) => (said === "" ? target : `${said}\n${target}`);
  return path !== null ? (
    <button type="button" className={className} title={tip(`Open ${path}`)} onClick={() => send({ kind: "openFile", path })}>
      @{name}
    </button>
  ) : (
    <a className={className} href={uri} title={tip(uri)}>
      @{name}
    </a>
  );
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
 * muted, and collapsed unless asked for. While it streams (`live`) it opens
 * only under the openThinking preference; collapsed, its header carries the
 * newest line, the sign the agent is working. Once the turn moves on it
 * folds to "Thought". Expandable on demand, never deleted; a manual toggle
 * overrides the auto behavior in both directions. */
export function Thought({ text, live, openThinking }: { text: string; live: boolean; openThinking: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? (live && openThinking);
  const tail = live && !open ? thoughtTail(text) : "";
  return (
    <div className={`thought ${open ? "open" : ""}`}>
      <Disclosure open={open} onToggle={() => setManual(!open)} label={open ? "Hide the thought" : "Show the thought"} className="max-w-full">
        <Icon name="sparkle" /> <span className="whitespace-nowrap">{live ? "Thinking…" : "Thought"}</span>
        {tail !== "" && (
          <span className="tail" dir="auto">
            {tail}
          </span>
        )}
      </Disclosure>
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
  const tag = /^<([a-z][a-z0-9-]*)/.exec(text.trim())?.[1] ?? "envelope";
  return <DimLine kind="injected" icon="gear" label={`${tag} — injected by the agent harness`} what="the message" body={text} />;
}

/** Something the agent sent that no surface renders yet (CarriedBlock):
 * its kind, and what it sent one click away — shown, never dropped. */
export function CarriedUpdate({ updateKind, payload }: { updateKind: string; payload: string }) {
  return <DimLine kind="carried" icon="info" label={unrenderedLabel(updateKind)} what="what the agent sent" body={payload} />;
}

const COMPACTION_TONE: Record<ReturnType<typeof compactionLine>["tone"], string> = {
  running: "",
  quiet: "",
  err: "text-err",
  warn: "text-warn",
};

/** A context compaction (CompactionBlock): a rule across the transcript —
 * what sits above it, the agent now holds only as its summary. The summary
 * opens on a click; a failure says why beneath the rule. */
export function CompactionDivider({ block }: { block: CompactionBlock }) {
  const [open, setOpen] = useState(false);
  const line = compactionLine(block);
  const label = (
    <span className={`inline-flex items-center gap-1 ${COMPACTION_TONE[line.tone]}`}>
      {line.tone === "running" ? <span className="spin" /> : <Icon name="fold" />} {line.text}
    </span>
  );
  return (
    <div className="compaction my-2 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="h-px flex-1 bg-border" />
        {block.summary.length > 0 ? (
          <Disclosure open={open} onToggle={() => setOpen(!open)} label={open ? "Hide the summary" : "Show the summary"}>
            {label}
          </Disclosure>
        ) : (
          label
        )}
        <span className="h-px flex-1 bg-border" />
      </div>
      {block.error !== null && <div className="mt-1 text-center text-err">{block.error}</div>}
      {open && (
        <div className="mt-1">
          {block.summary.map((part, i) => (
            <ContentPartView key={i} part={part} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A dim collapsed line beside the conversation, never part of it: a
 * label, and on a click its body — raw text as it came, or content as it
 * renders. */
function DimLine({ kind, icon, label, what, body }: { kind: string; icon: string; label: string; what: string; body: string | ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`dim-line ${kind} ${open ? "open" : ""}`}>
      <Disclosure open={open} onToggle={() => setOpen(!open)} label={open ? `Hide ${what}` : `Show ${what}`}>
        <Icon name={icon} /> {label}
      </Disclosure>
      {open && (typeof body === "string" ? <pre className="body">{body}</pre> : <div className="rendered">{body}</div>)}
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
  // Set once by the orchestrator's turn-end sweep (sessions-store.ts),
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
/** The lines a diff adds and removes, as the button that opens it — an
 * edit's own report is the one place a change is counted. */
function DiffCount({ stat, title, onClick }: { stat: DiffStat; title: string; onClick: () => void }) {
  return (
    <button type="button" className={`diff-count shrink-0 font-mono text-[11px] ${LINK}`} title={title} onClick={onClick}>
      <DiffStatText stat={stat} />
    </button>
  );
}

/** A small caps label over a section of a card's details. */
const SECTION_LABEL = "text-[10.5px] uppercase tracking-wide text-muted-foreground";

/** The click handler of a clickable card header: acts unless the click came
 * from a control inside the header — a chevron, a file link, a ± — which acts
 * on its own. The control lets its click travel on: an open popover or
 * dialog reads a click kept from propagating as handled by the page, and
 * would stay open. */
function headerClick(act: () => void) {
  return (e: React.MouseEvent) => {
    const control = (e.target as Element).closest("button, a[href], input, select, textarea, [role='button']");
    if (control === null || !e.currentTarget.contains(control)) act();
  };
}

/** Collapsed by default: title, the first file the call reported as a link
 * (`name:line`, "+N" for the other files), the lines the call's diffs add
 * and remove, and status. The link opens the file at the line the agent
 * named; the ± opens the diff (VS Code's native diff editor, never an
 * inline diff view) — or, when several files carry one, the details where
 * each has its own; the rest of the header toggles the details — separate
 * targets, because opening an editor takes focus while showing details
 * costs nothing. Expanded: one row per file — name, then every line the
 * agent reported in it, then its ± when the call carried a diff for it —
 * listed only when it says more than the header; then what the tool
 * produced for the user, as the agent presented it; then the raw wire
 * payload behind its own toggle. A terminal the call runs in shows under
 * the header, always visible. The call's kind routes it to a display step
 * (ToolDisplayPrefs): the whole title on a closed card, or the card open;
 * an open card always shows its whole title, and a click overrides the
 * step either way. Hovering the title shows it whole too. */
export function ToolCallCard({
  block,
  patchbaySessionId,
  roots,
}: {
  block: ToolCallBlock;
  patchbaySessionId: PatchbaySessionId;
  /** Workspace roots — file rows read relative to them. */
  roots: readonly string[];
}) {
  const send = useActions();
  const display = toolCallDisplay(block.toolKind, useContext(ToolDisplayPrefs));
  const [manual, setManual] = useState<boolean | null>(null);
  const rows = toolFileRows(block);
  const total = diffTotal(rows);
  const diffRows = rows.filter((r) => r.diff !== null);
  const first = block.locations[0];
  // Listed only when the rows say more than the header: several files, a
  // file with several lines, or a file known only from a diff (the header
  // links locations only).
  const listFiles = rows.length > 1 || rows.some((r) => r.lines.length > 1) || (first === undefined && rows.length > 0);
  const shown = block.content.filter((p) => p.kind !== "terminal");
  const terminals = block.content.flatMap((p) => (p.kind === "terminal" ? [p.terminalId] : []));
  const hasRaw = block.input !== null || block.output !== null;
  const expandable = listFiles || shown.length > 0 || hasRaw;
  // A card with no details stays closed whatever its step — until the call
  // brings some.
  const open = expandable && (manual ?? startsOpen(display));
  const wholeTitle = open || showsWholeTitle(display);
  const openAt = (path: string, line: number | undefined) =>
    send(line === undefined ? { kind: "openFile", path } : { kind: "openFile", path, line });
  const openDiff = (path: string) => send({ kind: "openToolCallDiff", patchbaySessionId, toolCallId: block.id, path });
  return (
    <div className="card">
      {/* The header is a mouse target for the whole row; the keyboard's is
          the chevron — the header holds other buttons, so it can't be one. */}
      <div
        className={`card-hd tool-hd ${expandable ? "cursor-pointer" : ""} ${wholeTitle ? "items-start" : ""}`}
        onClick={expandable ? headerClick(() => setManual(!open)) : undefined}
      >
        <span className={WEIGHT_CLASS[TOOL_WEIGHT[block.toolKind]]} title={block.name}>
          <Icon name={TOOL_ICON[block.toolKind]} />
        </span>
        <span
          className={`min-w-0 flex-1 ${wholeTitle ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "truncate"}`}
          title={block.title}
        >
          {block.title}
        </span>
        {first !== undefined && (
          <button
            type="button"
            className={`tool-loc min-w-0 max-w-[45%] ${HEADER_LINK}`}
            title={`Open ${first.path}${first.line === null ? "" : ` at line ${first.line}`}`}
            onClick={() => openAt(first.path, first.line ?? undefined)}
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
            onClick={() => setManual(true)}
          >
            +{rows.length - 1}
          </button>
        )}
        {total !== null && (
          <DiffCount
            stat={total}
            title={diffRows.length === 1 ? "Open this edit in VS Code's diff editor" : "Show each file's diff"}
            onClick={() => (diffRows.length === 1 ? openDiff(diffRows[0]!.path) : setManual(true))}
          />
        )}
        {expandable && (
          <Disclosure open={open} onToggle={() => setManual(!open)} label={open ? "Hide details" : "Show details"} />
        )}
        <ToolCallStatusTag block={block} />
      </div>
      {open && (
        <CallDetails
          call={block}
          rows={listFiles ? rows : []}
          patchbaySessionId={patchbaySessionId}
          roots={roots}
          rawOpen={false}
        />
      )}
      {terminals.map((id) => (
        <EmbeddedTerminal key={id} terminalId={id} />
      ))}
    </div>
  );
}

/** A tool call's details, one rendering for every card that shows a call
 * (its own card, a permission request about it): one row per file — name,
 * every line the agent reported in it, its folder, its ± when the call
 * carried a diff for it, opening that diff — then what the call produced
 * for the user, as the agent presented it, then the raw wire payload
 * behind its own toggle. `rows` empty = no file list. */
export function CallDetails({
  call,
  rows,
  patchbaySessionId,
  roots,
  rawOpen,
}: {
  call: { id: string; content: readonly ToolContentPart[]; input: string | null; output: string | null };
  rows: readonly ToolFileRow[];
  patchbaySessionId: PatchbaySessionId;
  roots: readonly string[];
  /** The raw payload starts open — where it is what the user decides on. */
  rawOpen: boolean;
}) {
  const send = useActions();
  const shown = call.content.filter((p) => p.kind !== "terminal");
  const openAt = (path: string, line: number | undefined) =>
    send(line === undefined ? { kind: "openFile", path } : { kind: "openFile", path, line });
  const openDiff = (path: string) => send({ kind: "openToolCallDiff", patchbaySessionId, toolCallId: call.id, path });
  return (
    <div className="flex flex-col gap-1.5 px-2.5 pb-2.5">
      {rows.length > 0 && (
        <div className="tool-files flex flex-col gap-0.5 text-[12px]">
          {rows.map((r) => {
            const { base, dir } = splitPath(r.path, roots);
            return (
              <div key={r.path} className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  className={`flex shrink-0 items-center gap-1 font-medium ${LINK}`}
                  title={`Open ${r.path}${r.lines[0] === undefined ? "" : ` at line ${r.lines[0]}`}`}
                  onClick={() => openAt(r.path, r.lines[0])}
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
                    onClick={() => openAt(r.path, line)}
                  >
                    :{line}
                  </button>
                ))}
                {dir !== "" && (
                  <span className="min-w-0 truncate text-muted-foreground" title={r.path}>
                    {dir}
                  </span>
                )}
                {r.diff !== null && (
                  <span className="ml-auto">
                    <DiffCount stat={r.diff} title="Open this file's edit in VS Code's diff editor" onClick={() => openDiff(r.path)} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {shown.map((part, i) => (
        <ContentPartView key={i} part={part} />
      ))}
      {(call.input !== null || call.output !== null) && <RawSection input={call.input} output={call.output} initiallyOpen={rawOpen} />}
    </div>
  );
}

/** One piece of agent-side content — a tool call's content, a non-text
 * piece of an agent's message. Text is the agent's own markdown (console
 * output in fences, labels), rendered like its messages; every other kind
 * shares the user message's part renderers. */
export function ContentPartView({ part }: { part: ContentPart }) {
  // The one place agent content is shown: what the agent addressed to the
  // model alone stays out of what it tells you — collapsed, a click away.
  if (part.forModel === true) {
    const { forModel: _forModel, ...shown } = part;
    return <DimLine kind="for-model" icon="eye-closed" label="meant for the model" what="what the agent gave the model" body={<ContentPartView part={shown} />} />;
  }
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
function RawSection({ input, output, initiallyOpen }: { input: string | null; output: string | null; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div>
      <Disclosure
        open={open}
        onToggle={() => setOpen((v) => !v)}
        label={open ? "Hide the raw wire payload" : "Show the raw wire payload"}
        className={SECTION_LABEL}
      >
        raw
      </Disclosure>
      {open && (
        <div className="mt-1 flex flex-col gap-1.5">
          {(
            [
              ["input", input],
              ["output", output],
            ] as const
          ).map(
            ([name, text]) =>
              text !== null && (
                <div key={name}>
                  <div className={SECTION_LABEL}>{name}</div>
                  <pre className="term m-0 whitespace-pre-wrap">{text}</pre>
                </div>
              ),
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

/** The preferences that route each tool kind to its display step. */
export const ToolDisplayPrefs = createContext<Pick<PreferencesView, ToolDisplayPreference>>(DEFAULT_PREFERENCES);

/** A terminal the call runs in, always visible under its header — ACP: the
 * client displays an embedded terminal's output as it is generated. One
 * patchbay didn't run in this window — the agent's own, or an earlier
 * window's — has nothing here to show, and says so. */
function EmbeddedTerminal({ terminalId }: { terminalId: string }) {
  const block = useContext(TerminalBlocks).get(terminalBlockId(terminalId));
  if (block === undefined) {
    return (
      <div className="ghost-terminal px-2.5 pb-2 text-[11px] italic text-muted-foreground" title={terminalId}>
        a terminal patchbay didn't run here — its output isn't shown
      </div>
    );
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
  patchbaySessionId,
  roots,
}: {
  calls: readonly ToolCallBlock[];
  patchbaySessionId: PatchbaySessionId;
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
        <div className="card-hd tool-hd cursor-pointer" onClick={headerClick(() => setOpen(false))}>
          {weightedIcon} {calls.length} tool calls{" "}
          <Disclosure open={true} onToggle={() => setOpen(false)} label="Collapse the tool calls" />
        </div>
        {calls.map((c) => (
          <ToolCallCard key={c.id} block={c} patchbaySessionId={patchbaySessionId} roots={roots} />
        ))}
      </>
    );
  }
  return (
    <div className="card">
      <div className="card-hd tool-hd cursor-pointer" onClick={headerClick(() => setOpen(true))}>
        {weightedIcon}
        <span className="min-w-0 flex-1 truncate" title={calls.map((c) => c.title).join("\n")}>
          {calls.length} tool calls{running !== undefined ? ` — ${running.title}` : ""}
        </span>
        <Disclosure open={false} onToggle={() => setOpen(true)} label="Show each tool call" />
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

/** A client terminal's command, live state and output — standalone as its
 * own card, or inside the tool call that runs in it. */
export function TerminalView({ block }: { block: TerminalBlock }) {
  return (
    <>
      <div className="card-hd">
        <Icon name="terminal" /> {block.command}
        <span className="st">
          {block.running ? (
            <>
              <span className="spin" /> live
            </>
          ) : block.exitCode === 0 ? (
            <span className="text-ok">
              <Icon name="check" /> exit 0
            </span>
          ) : block.exitCode != null ? (
            <span className="text-err">
              <Icon name="close" /> exit {block.exitCode}
            </span>
          ) : block.signal !== undefined ? (
            <span className="text-warn">
              <Icon name="circle-slash" /> {block.signal}
            </span>
          ) : (
            // exit code unknown — no verdict, no verdict color
            <>exit ?</>
          )}
        </span>
      </div>
      <div className="term">{block.output || " "}</div>
    </>
  );
}
