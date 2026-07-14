// The composer: context chips row, the Lexical prompt editor (typed-trigger
// menus + inline tokens live in prompt-editor.tsx), knobs, send/stop. Owns
// its send/stop routing per session id; the only ephemeral state is UI
// furniture (draft content, open adder, drag height).
import { useRef, useState } from "react";
import type {
  AgentSummary,
  ContextChip,
  LiveSelectionView,
  OpenEditorView,
  PromptPart,
  QueuedPrompt,
  SessionKnobView,
  SessionSummary,
  UsageInfo,
} from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import type { SessionTotals } from "../chat/view-model";
import { FilesChip } from "./files-chip";
import { extractUris, ingestFiles } from "./ingress";
import { Knobs } from "./knobs";
import { ComposerStats } from "./stats";
import { basename } from "./menus";
import { PromptEditor } from "./prompt-editor";
import { RootsChip } from "./roots-chip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AvailableCommand } from "../../../shared/protocol";

export function Composer(props: {
  agent: AgentSummary | null;
  session: SessionSummary | null;
  commands: readonly AvailableCommand[];
  contextChips: readonly ContextChip[];
  contextRoots: readonly string[];
  workspaceRoots: readonly string[];
  /** Whether a root change re-applies to the live session (agent declares
   * session/load or session/resume) — drives the roots chip's honesty note. */
  rootsApplyLive: boolean;
  /** Paths the orchestrator holds a first-touch baseline for — feeds the
   * files chip's diff-vs-open-file row behavior. */
  diffableFiles: ReadonlySet<string>;
  /** Cumulative +/- since first touch, per path — the files chip's badges. */
  fileDiffStats: Readonly<Record<string, { additions: number; deletions: number }>>;
  liveSelection: LiveSelectionView | null;
  /** Prompts sent mid-turn, waiting for the turn to end — removable rows. */
  queued: readonly QueuedPrompt[];
  openEditors: readonly OpenEditorView[];
  workspaceFiles: { query: string; files: readonly string[]; dirs: readonly string[] };
  knobs: readonly SessionKnobView[];
  /** Session stats strip (Preferences composerStats gates it off entirely). */
  showStats: boolean;
  totals: SessionTotals;
  usage: UsageInfo | null;
  /** Ingress cap (Preferences attachmentMaxMB) — policy is host-owned; the
   * webview only applies the snapshot's value at the admission point. */
  attachmentMaxMB: number;
  /** Ingress refusals surface through the app's toast. */
  onNotice(message: string): void;
}) {
  const send = useActions();
  const [adderOpen, setAdderOpen] = useState(false);
  // Drop-target affordance only — a state-styled region, not an overlay
  // (no z-escape, no dismissal, no placement, no focus: none of the four
  // problems overlay-surfaces exists for).
  const [dragOver, setDragOver] = useState(false);
  // The resize surface is the whole composer block (context row → send row),
  // dragged from its top edge — the input itself never grows a resizer.
  // Ephemeral by design: render furniture, reset with the webview.
  const [height, setHeight] = useState<number | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y0: number; h0: number } | null>(null);
  const submitRef = useRef<(() => void) | null>(null);
  const MIN_HEIGHT = 160; // never squeezes the 5-line input out of view
  const enabled = props.session !== null && props.agent?.status === "running";
  const sessionId = props.session?.id ?? "";
  const live = props.session?.live ?? false;

  const sendOrStop = () => {
    if (live) send({ kind: "stopTurn", sessionId });
    else submitRef.current?.();
  };
  // Enter during a live turn queues (the orchestrator holds it until the
  // turn ends); the Stop button is the only stop — Enter-as-stop would be
  // too easy to trip once sending mid-turn is legal.
  const onSubmit = (text: string, parts?: readonly PromptPart[]): void =>
    send({ kind: "sendPrompt", sessionId, text, parts });

  /** The adder's entries — also reused by the `@` mention picker's fixed rows. */
  const addSelection = () => send({ kind: "addSelectionContext", sessionId });
  const addDiagnostics = () => send({ kind: "addDiagnosticsContext", sessionId });
  const addFilePicker = () => send({ kind: "addFilePickerContext", sessionId });

  /** Byte-carrying attachments (paste, external drop) → the one ingress
   * processor; admitted images/files go up as actions, refusals surface as
   * toasts. Fire-and-forget: ingest never throws. */
  const ingest = (files: File[]) => {
    void ingestFiles(files, props.attachmentMaxMB * 1024 * 1024).then((out) => {
      for (const img of out.images) {
        send({ kind: "addImageContext", sessionId, base64: img.base64, mimeType: img.mimeType, label: img.label });
      }
      for (const f of out.files) {
        send({ kind: "addDroppedFileContext", sessionId, name: f.name, mimeType: f.mimeType, base64: f.base64 });
      }
      for (const r of out.refusals) props.onNotice(r);
    });
  };

  const onDrop = (e: React.DragEvent) => {
    setDragOver(false);
    if (!enabled) return;
    e.preventDefault();
    // Directories are refused deliberately (v1 scope decision): expanding a
    // tree is a policy question — depth, excludes — not a default. The
    // entry API is the only place a dropped directory is distinguishable.
    const items = [...e.dataTransfer.items];
    const dirs = items.filter((it) => it.webkitGetAsEntry?.()?.isDirectory === true).length;
    if (dirs > 0) props.onNotice("Folders can't be attached — drop files individually");
    const files = items
      .map((it) => (it.kind === "file" && it.webkitGetAsEntry?.()?.isDirectory !== true ? it.getAsFile() : null))
      .filter((f): f is File => f !== null);
    if (files.length > 0) return ingest(files);
    // No bytes → a URI drop (VS Code explorer / editor tabs); the
    // orchestrator resolves paths host-side (lane 1, render-only-webview).
    const uris = extractUris(e.dataTransfer);
    if (uris.length > 0) send({ kind: "addPathContext", sessionId, uris });
  };

  return (
    <div
      className={`composer flex flex-col ${dragOver && enabled ? "drop-target" : ""}`}
      ref={shellRef}
      style={height !== null ? { height } : undefined}
      onDragOver={(e) => {
        if (!enabled) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        // Only when the pointer truly leaves the composer — child hops fire
        // dragleave too and would flicker the affordance.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <div
        className="group absolute inset-x-0 -top-[5px] z-10 flex h-[10px] cursor-ns-resize items-center justify-center"
        title="Drag to resize"
        onPointerDown={(e) => {
          drag.current = { y0: e.clientY, h0: shellRef.current!.getBoundingClientRect().height };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current === null) return;
          const next = drag.current.h0 + (drag.current.y0 - e.clientY);
          setHeight(Math.min(window.innerHeight * 0.8, Math.max(MIN_HEIGHT, next)));
        }}
        onPointerUp={(e) => {
          drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      >
        {/* the grabber pill — the visible "hold here" affordance */}
        <div className="h-[3px] w-10 rounded-full bg-border transition-colors group-hover:bg-muted-foreground group-active:bg-muted-foreground" />
      </div>
      {props.queued.map((q) => (
        <div className="queue-row" key={q.id} title={q.text}>
          <Icon name="history" />
          <span className="txt">{q.text}</span>
          <span
            className="x"
            title="Remove from queue"
            onClick={() => send({ kind: "removeQueuedPrompt", sessionId, promptId: q.id })}
          >
            ×
          </span>
        </div>
      ))}
      {(props.contextChips.length > 0 || props.contextRoots.length > 0 || enabled) && (
        <div className="ctx-row">
          {enabled && (
            <RootsChip
              sessionId={sessionId}
              roots={props.contextRoots}
              workspaceRoots={props.workspaceRoots}
              applyLive={props.rootsApplyLive}
            />
          )}
          {enabled && props.liveSelection !== null && (
            <span
              className="ctx-chip ghost"
              title="Live IDE selection — click to add it to context"
              onClick={addSelection}
            >
              <Icon name="target" /> {basename(props.liveSelection.file)}:{props.liveSelection.startLine}
              {props.liveSelection.endLine !== props.liveSelection.startLine
                ? `-${props.liveSelection.endLine}`
                : ""}
            </span>
          )}
          {props.contextChips.map((c) => (
            <span
              className="ctx-chip"
              key={c.id}
              title={
                c.kind === "image" ? c.label : c.kind === "attachment" ? c.path : c.content.slice(0, 300)
              }
            >
              <Icon
                name={
                  c.kind === "selection"
                    ? "target"
                    : c.kind === "file"
                      ? "file"
                      : c.kind === "image"
                        ? "file-media"
                        : c.kind === "attachment"
                          ? "attach"
                          : "warning"
                }
              />{" "}
              {c.label}
              <span className="x" onClick={() => send({ kind: "removeContextChip", sessionId, chipId: c.id })}>
                ×
              </span>
            </span>
          ))}
          {enabled && (
            // A real Popover (like the roots chip): closes on outside click
            // and Escape, panel style shared with every other popover.
            <Popover open={adderOpen} onOpenChange={setAdderOpen}>
              <PopoverTrigger asChild>
                <span className="ctx-chip ctx-add" title="Add context">
                  <Icon name="add" />
                </span>
              </PopoverTrigger>
              <PopoverContent align="start" side="top" className="w-auto min-w-56 p-0">
                {(
                  [
                    { icon: "target", label: "Selection", hint: "current editor selection", run: addSelection },
                    { icon: "file", label: "Current file", hint: "active editor", run: () => send({ kind: "addFileContext", sessionId }) },
                    { icon: "warning", label: "Problems", hint: "workspace diagnostics", run: addDiagnostics },
                    { icon: "attach", label: "Attach file…", hint: "pick any file", run: addFilePicker },
                  ] as const
                ).map((entry) => (
                  <div
                    key={entry.label}
                    className="it"
                    onClick={() => {
                      entry.run();
                      setAdderOpen(false);
                    }}
                  >
                    <b>
                      <Icon name={entry.icon} /> {entry.label}
                    </b>
                    <span className="d">{entry.hint}</span>
                  </div>
                ))}
              </PopoverContent>
            </Popover>
          )}
        </div>
      )}
      <div
        className={`input-shell relative flex min-h-0 flex-1 flex-col ${height === null ? "auto-grow" : ""}`}
      >
        <PromptEditor
          enabled={enabled}
          placeholder={
            enabled
              ? `Message ${props.agent!.name} — / commands · @ context`
              : "Connect an agent to start"
          }
          commands={props.commands}
          openEditors={props.openEditors}
          workspaceFiles={props.workspaceFiles}
          hasSelection={enabled && props.liveSelection !== null}
          onSubmit={onSubmit}
          onPasteFiles={ingest}
          onPickSelection={addSelection}
          onPickProblems={addDiagnostics}
          onPickAttach={addFilePicker}
          submitRef={submitRef}
        />
      </div>
      {/* Outside the input-shell on purpose: the foot sits on the composer's
          elevated surface (--card); only the prompt box keeps --pb-panel. */}
      <div className="input-foot">
        <Knobs sessionId={sessionId} knobs={props.knobs} />
        <span className="flex-1" />
        {props.showStats && props.session !== null && (
          <ComposerStats totals={props.totals} usage={props.usage}>
            <FilesChip
              sessionId={sessionId}
              files={props.totals.files}
              diffable={props.diffableFiles}
              diffStats={props.fileDiffStats}
              openEditors={props.openEditors}
              roots={props.workspaceRoots}
            />
          </ComposerStats>
        )}
        {/* theme-token primary (brand fills superseded — theme.css
            § identity palette); while a turn is live it becomes Stop,
            which is destructive. */}
        <Button
          variant={live ? "destructive" : "default"}
          size="icon"
          className="ml-auto size-[26px] rounded-[7px]"
          disabled={!enabled}
          title={live ? "Stop" : "Send"}
          aria-label={live ? "Stop" : "Send"}
          onClick={sendOrStop}
        >
          <Icon name={live ? "debug-stop" : "arrow-up"} />
        </Button>
      </div>
    </div>
  );
}
