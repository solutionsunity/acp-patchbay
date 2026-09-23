// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Saved roots: the folders every new session starts with, beyond the
// workspace's own — two lists, this workspace (the default) and every
// workspace. The one place to manage them; the roots chip's Save is a
// shortcut into the same lists.
import { NO_WORKSPACE_TO_SAVE, type SavedRootScope, type SettingsState } from "../../shared/protocol";
import { Icon } from "../shared/icon";
import { Button } from "@/components/ui/button";

/** One saved-roots card — instantiated per scope so the two lists can't
 * drift in presentation or behavior. `roots` null: no folder is open, so
 * this list has no workspace to belong to. */
function SavedRootsCard(props: {
  title: string;
  note: string;
  roots: readonly string[] | null;
  missing: readonly string[];
  emptyText: string;
  onAdd(): void;
  onEdit(path: string): void;
  onRemove(path: string): void;
}) {
  return (
    <div className="card">
      <h2 className="mt-0">{props.title}</h2>
      <div className="note mx-0 mt-0 mb-2">{props.note}</div>
      {props.roots === null ? (
        <div className="note mx-0 mt-0 mb-2">{NO_WORKSPACE_TO_SAVE}</div>
      ) : (
        <>
          {props.roots.length === 0 && <div className="note mx-0 mt-0 mb-2">{props.emptyText}</div>}
          {props.roots.map((path) => (
            <div className="rule" key={path}>
              <code>{path}</code>
              {props.missing.includes(path) && (
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
          <div className="row mt-2.5">
            <Button size="sm" onClick={props.onAdd}>
              Add folder…
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function RootsSection(props: {
  state: SettingsState;
  onAdd(scope: SavedRootScope): void;
  onEdit(path: string, scope: SavedRootScope): void;
  onRemove(path: string, scope: SavedRootScope): void;
}) {
  const { savedRoots } = props.state;
  return (
    <section className="section">
      <h1>Saved roots</h1>
      <div className="sub">
        Folders every new session starts with, next to the workspace&apos;s own — a backend repo
        beside this frontend, a framework&apos;s source checkout. A session owns its list once
        started: removing a root from one session leaves these lists alone, and a change here
        reaches new sessions only.
      </div>

      <SavedRootsCard
        title="This workspace"
        note="The default — the folders this workspace always works with."
        roots={savedRoots.workspace}
        missing={savedRoots.missing}
        emptyText="No saved roots for this workspace."
        onAdd={() => props.onAdd("workspace")}
        onEdit={(path) => props.onEdit(path, "workspace")}
        onRemove={(path) => props.onRemove(path, "workspace")}
      />

      <SavedRootsCard
        title="Every workspace"
        note="Folders every workspace on this machine works with."
        roots={savedRoots.machine}
        missing={savedRoots.missing}
        emptyText="No saved roots for every workspace."
        onAdd={() => props.onAdd("machine")}
        onEdit={(path) => props.onEdit(path, "machine")}
        onRemove={(path) => props.onRemove(path, "machine")}
      />

      <div className="note good">
        This workspace&apos;s list lives in workspaceState (per user, per workspace), the other in
        global storage (per user, this machine) — never in the repo either way.
      </div>
    </section>
  );
}
