// The files chip — edited-files read-out, moved down into the composer's
// foot row (ui.md § Read-out strip amended: files chip now lives beside the
// stats strip, not the plan chip). Same view-model totals, same overlay
// panel content; only the anchor changed — it opens upward from its own
// button instead of spanning the strip. A row's own click is the diff when
// answerable; the go-to-file button always opens the file plainly.
import { useEffect, useRef, useState } from "react";
import type { OpenEditorView } from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { count } from "../chat/view-model";

/** Absolute path → { base, dir } with dir relativized against the longest
 * matching workspace root — display only, actions always carry the full path. */
function splitPath(path: string, roots: readonly string[]): { base: string; dir: string } {
  const root = roots.filter((r) => path.startsWith(r)).sort((a, b) => b.length - a.length)[0];
  const rel = root !== undefined ? path.slice(root.length).replace(/^[/\\]/, "") : path;
  const parts = rel.split(/[/\\]/);
  return { base: parts.pop() ?? rel, dir: parts.join("/") };
}

export function FilesChip({
  sessionId,
  files,
  diffable,
  diffStats,
  openEditors,
  roots,
}: {
  sessionId: string;
  files: readonly string[];
  /** Paths the orchestrator holds a first-touch baseline for — exactly these
   * rows' main click opens the diff instead of the file. */
  diffable: ReadonlySet<string>;
  /** Cumulative +/- since first touch, per path — the row's badge. */
  diffStats: Readonly<Record<string, { additions: number; deletions: number }>>;
  openEditors: readonly OpenEditorView[];
  roots: readonly string[];
}) {
  const send = useActions();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Plain overlay, not a Radix portal — outside-click has to be hand-rolled.
    // The toggle/close buttons are inside wrapRef, so their own onClick
    // handles the close there; this only fires for a click elsewhere.
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  if (files.length === 0) return null;

  return (
    <span className="files-chip-wrap" ref={wrapRef}>
      {open && (
        <div className="overlay-panel files-panel">
          <div className="head">
            <span className="title">{count(files.length, "file")} edited this session</span>
            <button className="close" title="Close" onClick={() => setOpen(false)}>
              <Icon name="close" />
            </button>
          </div>
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
        </div>
      )}
      <button className={`files-btn ${open ? "active" : ""}`} onClick={() => setOpen((v) => !v)}>
        <Icon name="edit" /> {count(files.length, "file")}
      </button>
    </span>
  );
}
