// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The files chip — the read-out strip's way into the files this session's
// agent edited. A control, not a stat: no preference hides it; it is absent
// only while there is nothing to open. It lists files and never counts
// lines: a change is counted only on the edit that reported it (the tool
// card's ±), because a file the agent writes itself leaves patchbay no
// trustworthy "before" to measure a session's worth of change against. A
// row opens the file.
import type { RefObject } from "react";
import type { OpenEditorView } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { Icon } from "../shared/icon";
import { splitPath } from "../shared/path";
import { count } from "./chat/view-model";
import { ReadoutPanel } from "./readout-panel";

export function FilesChip({
  files,
  openEditors,
  roots,
  open,
  onOpenChange,
  anchor,
}: {
  files: readonly string[];
  openEditors: readonly OpenEditorView[];
  roots: readonly string[];
  open: boolean;
  onOpenChange(open: boolean): void;
  anchor: RefObject<HTMLDivElement | null>;
}) {
  const send = useActions();
  return (
    <ReadoutPanel
      open={open}
      onOpenChange={onOpenChange}
      anchor={anchor}
      className="files-panel"
      title={<>{count(files.length, "file")} edited this session</>}
      chip={
        <button type="button" className={`chip files ${open ? "active" : ""}`}>
          <Icon name="edit" /> {count(files.length, "file")} edited
        </button>
      }
    >
      {files.map((path) => {
        const { base, dir } = splitPath(path, roots);
        // Editor reality, not a stored flag: with agent writes landing
        // in the open buffer, dirty here means the
        // user's own unsaved edits sit on an agent-touched file.
        const dirty = openEditors.some((e) => e.file === path && e.dirty);
        return (
          <div key={path} className="file-row" title={path} onClick={() => send({ kind: "openFile", path })}>
            <Icon name="file" /> <span className="base">{base}</span>
            {dir !== "" && <span className="dir">{dir}</span>}
            {dirty && (
              <span className="right">
                <span className="dirty" title="unsaved changes in editor" />
              </span>
            )}
          </div>
        );
      })}
    </ReadoutPanel>
  );
}
