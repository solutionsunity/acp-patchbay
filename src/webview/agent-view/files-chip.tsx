// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The files chip — the read-out strip's way into the files this session's
// agent edited. A control, not a stat: no preference hides it; it is absent
// only while there is nothing to open. A row's own click is the diff when
// answerable; the go-to-file button always opens the file plainly.
import { useEffect, type RefObject } from "react";
import type { OpenEditorView } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { Icon } from "../shared/icon";
import { splitPath } from "../shared/path";
import { count } from "./chat/view-model";
import { ReadoutPanel } from "./readout-panel";

export function FilesChip({
  sessionId,
  files,
  diffable,
  diffStats,
  openEditors,
  roots,
  open,
  onOpenChange,
  anchor,
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
  open: boolean;
  onOpenChange(open: boolean): void;
  anchor: RefObject<HTMLDivElement | null>;
}) {
  const send = useActions();
  // Opening the panel re-reads reality: the ± shown must match the diff
  // a click opens (the live file moves after the agent's last report).
  useEffect(() => {
    if (open) send({ kind: "refreshFileDiffStats", sessionId });
  }, [open]);

  // Session totals — summed over exactly the rows shown, so the header and
  // the row badges can never disagree.
  const total = files.reduce(
    (acc, path) => {
      const stat = diffStats[path];
      return stat === undefined
        ? acc
        : { additions: acc.additions + stat.additions, deletions: acc.deletions + stat.deletions };
    },
    { additions: 0, deletions: 0 },
  );

  return (
    <ReadoutPanel
      open={open}
      onOpenChange={onOpenChange}
      anchor={anchor}
      className="files-panel"
      title={
        <>
          {count(files.length, "file")} edited this session
          {(total.additions > 0 || total.deletions > 0) && (
            <span className="stat">
              {total.additions > 0 && <span className="add">+{total.additions}</span>}
              {total.deletions > 0 && <span className="del">-{total.deletions}</span>}
            </span>
          )}
        </>
      }
      chip={
        <button type="button" className={`chip files ${open ? "active" : ""}`}>
          <Icon name="edit" /> {count(files.length, "file")}
        </button>
      }
    >
      {files.map((path) => {
        const { base, dir } = splitPath(path, roots);
        // Editor reality, not a stored flag: with agent writes landing
        // in the open buffer, dirty here means the
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
              send(canDiff ? { kind: "openSessionFileDiff", sessionId, path } : { kind: "openFile", path })
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
    </ReadoutPanel>
  );
}
