// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Saved roots: the folders new sessions start with, beyond the workspace's
// own — one list, each folder with the workspaces it is saved for. The one
// place to manage them; the roots chip's Save is a shortcut into the same
// list.
import { NO_WORKSPACE_TO_SAVE, type SaveScope, type SettingsState } from "../../shared/protocol";
import { Icon } from "../shared/icon";
import { whereSaid } from "../shared/where";
import { Button } from "@/components/ui/button";

export function RootsSection(props: {
  state: SettingsState;
  onAdd(scope: SaveScope): void;
  onEdit(path: string): void;
  onRemove(path: string): void;
}) {
  const { savedRoots, workspace } = props.state;
  return (
    <section className="section">
      <h1>Saved roots</h1>
      <div className="sub">
        Folders new sessions start with, next to the workspace&apos;s own — a backend repo beside
        this frontend, a framework&apos;s source checkout. A session owns its list once started:
        removing a root from one session leaves this list alone, and a change here reaches new
        sessions only.
      </div>

      <div className="card">
        {savedRoots.entries.length === 0 && <div className="note mx-0 mt-0 mb-2">No saved roots.</div>}
        {savedRoots.entries.map(({ path, workspaces }) => (
          <div className="rule" key={path}>
            <code>{path}</code>
            <span className="note m-0">{whereSaid(workspaces, workspace)}</span>
            {savedRoots.missing.includes(path) && (
              <span
                className="st-s"
                title="Folder not found — needs your action: restore it, or change or remove it here. New sessions skip it meanwhile."
                aria-label={`Saved root ${path} not found`}
              >
                <Icon name="warning" />
              </span>
            )}
            <span
              className="e edit"
              role="button"
              tabIndex={0}
              title="Change folder"
              aria-label={`Change saved root ${path}`}
              onClick={() => props.onEdit(path)}
            >
              <Icon name="edit" />
            </span>
            <span
              className="e"
              role="button"
              tabIndex={0}
              aria-label={`Remove saved root ${path}`}
              onClick={() => props.onRemove(path)}
            >
              <Icon name="close" />
            </span>
          </div>
        ))}
        <div className="row mt-2.5 gap-2">
          <Button
            size="sm"
            disabled={workspace === null}
            title={workspace === null ? NO_WORKSPACE_TO_SAVE : undefined}
            onClick={() => props.onAdd("workspace")}
          >
            Add for this workspace…
          </Button>
          <Button variant="outline" size="sm" onClick={() => props.onAdd("everywhere")}>
            Add for every workspace…
          </Button>
        </div>
      </div>

      <div className="note good">
        Kept in global storage (per user, this machine), so any window can show and change where a
        folder is saved — never in the repo.
      </div>
    </section>
  );
}
