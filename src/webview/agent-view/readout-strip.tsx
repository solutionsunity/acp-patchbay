// The read-out strip between chat and composer (ui.md § Read-out strip):
// live-turn read-outs at the eye's resting point, deliberately OUTSIDE the
// composer — its binding rule ("above the input = what the agent will see")
// stays intact because this strip is never context, only read-out. Plan chip
// left (agent-plan updates), edited-files chip right (view-model totals).
// Each chip is absent when empty; the strip doesn't render when both are.
// Click opens an overlay panel growing up from the strip over the chat;
// X/Escape/re-click close; one panel at a time. Expand is manual, never
// forced — a task completing mid-turn pulses the collapsed plan chip as a
// peripheral signal instead of yanking the view open. In the files panel, a
// row's own click is the diff (the panel's main intention) when one is
// answerable; a dedicated go-to-file button on the right always opens the
// file plainly.
import { useEffect, useRef, useState } from "react";
import type { OpenEditorView, PlanEntry } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { Icon } from "../shared/icon";
import { count } from "./chat/view-model";

type Panel = "plan" | "files";

/** Absolute path → { base, dir } with dir relativized against the longest
 * matching workspace root — display only, actions always carry the full path. */
function splitPath(path: string, roots: readonly string[]): { base: string; dir: string } {
  const root = roots.filter((r) => path.startsWith(r)).sort((a, b) => b.length - a.length)[0];
  const rel = root !== undefined ? path.slice(root.length).replace(/^[/\\]/, "") : path;
  const parts = rel.split(/[/\\]/);
  return { base: parts.pop() ?? rel, dir: parts.join("/") };
}

export function ReadoutStrip({
  sessionId,
  plan,
  files,
  diffable,
  diffStats,
  openEditors,
  roots,
}: {
  sessionId: string;
  plan: readonly PlanEntry[] | null;
  files: readonly string[];
  /** Paths the orchestrator holds a first-touch baseline for (view-model
   * diffableFiles) — exactly these rows' main click opens the diff instead
   * of the file. */
  diffable: ReadonlySet<string>;
  /** Cumulative +/- since first touch, per path — the row's badge; absent
   * until a real change is known (protocol fileDiffStats). */
  diffStats: Readonly<Record<string, { additions: number; deletions: number }>>;
  openEditors: readonly OpenEditorView[];
  roots: readonly string[];
}) {
  const send = useActions();
  const [panel, setPanel] = useState<Panel | null>(null);
  const done = plan?.filter((e) => e.status === "completed").length ?? 0;
  const [pulse, setPulse] = useState(false);
  const prevDone = useRef(done);
  useEffect(() => {
    const ticked = done > prevDone.current;
    prevDone.current = done;
    if (!ticked) return undefined;
    setPulse(true);
    const t = window.setTimeout(() => setPulse(false), 900);
    return () => window.clearTimeout(t);
  }, [done]);
  useEffect(() => {
    if (panel === null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel]);

  // Same presence rules as before the move: a plan needs more than one task,
  // files need at least one. A panel whose chip vanished (plan superseded by
  // a trivial one mid-view) simply stops rendering — no stale content.
  const hasPlan = plan !== null && plan.length > 1;
  const hasFiles = files.length > 0;
  if (!hasPlan && !hasFiles) return null;
  const open: Panel | null = panel === "plan" && !hasPlan ? null : panel === "files" && !hasFiles ? null : panel;
  const toggle = (p: Panel) => setPanel((v) => (v === p ? null : p));

  const current =
    plan?.find((e) => e.status === "in_progress")?.content ?? plan?.[plan.length - 1]?.content ?? "";

  return (
    <div className="readout-strip">
      {open !== null && (
        <div className="readout-panel">
          <div className="head">
            <span className="title">
              {open === "plan" ? (
                <>
                  Plan <span className="frac">{done}/{plan?.length}</span>
                </>
              ) : (
                count(files.length, "file") + " edited this session"
              )}
            </span>
            <button className="close" title="Close" onClick={() => setPanel(null)}>
              <Icon name="close" />
            </button>
          </div>
          {open === "plan" ? (
            <div className="items">
              {plan?.map((e, i) => (
                <div key={i} className={e.status}>
                  <Icon
                    name={
                      e.status === "completed"
                        ? "check"
                        : e.status === "in_progress"
                          ? "circle-large-filled"
                          : "circle-large"
                    }
                  />{" "}
                  {e.content}
                </div>
              ))}
            </div>
          ) : (
            <div className="items">
              {files.map((path) => {
                const { base, dir } = splitPath(path, roots);
                // Editor reality, not a stored flag: with agent writes landing
                // in the open buffer (compliance §12/W1), dirty here means the
                // user's own unsaved edits sit on an agent-touched file.
                const dirty = openEditors.some((e) => e.file === path && e.dirty);
                const canDiff = diffable.has(path);
                const stat = diffStats[path];
                return (
                  <div
                    key={path}
                    className="file-row"
                    title={canDiff ? "Diff — since first agent touch (this session)" : path}
                    // Main click is the diff — that's the row's point.
                    // Non-diffable rows (locations-only) fall back to open.
                    onClick={() =>
                      send(
                        canDiff
                          ? { kind: "openSessionFileDiff", sessionId, path }
                          : { kind: "openFile", path },
                      )
                    }
                  >
                    <Icon name={canDiff ? "diff" : "file"} /> <span className="base">{base}</span>
                    {dir !== "" && <span className="dir">{dir}</span>}
                    {/* always-present right cluster: whichever of stat/dirty
                        are absent this session, the button still anchors right */}
                    <span className="right">
                      {stat !== undefined && (stat.additions > 0 || stat.deletions > 0) && (
                        <span className="stat">
                          {stat.additions > 0 && <span className="add">+{stat.additions}</span>}
                          {stat.deletions > 0 && <span className="del">-{stat.deletions}</span>}
                        </span>
                      )}
                      {dirty && <span className="dirty" title="unsaved changes in editor" />}
                      <button
                        className="gotofile"
                        title="Open file"
                        onClick={(e) => {
                          e.stopPropagation();
                          send({ kind: "openFile", path });
                        }}
                      >
                        <Icon name="go-to-file" />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div className="chips">
        {hasPlan && (
          <button
            className={`chip plan ${open === "plan" ? "active" : ""} ${pulse ? "animate-pulse" : ""}`}
            onClick={() => toggle("plan")}
          >
            <Icon name={open === "plan" ? "chevron-down" : "chevron-right"} /> Plan{" "}
            <span className="frac">{done}/{plan?.length}</span>
            <span className="current"> — {current}</span>
          </button>
        )}
        {hasPlan && hasFiles && <span className="sep" />}
        {hasFiles && (
          <button
            className={`chip files ${open === "files" ? "active" : ""}`}
            onClick={() => toggle("files")}
          >
            <Icon name="edit" /> {count(files.length, "file")}
          </button>
        )}
      </div>
    </div>
  );
}
