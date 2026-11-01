// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Context roots: workspace folders are the always-active baseline — fixed,
// non-removable, shown so the count reflects reality; the first is the
// session cwd, the rest ride as `additionalDirectories`. `roots` is the
// removable, user-added external set, on the same field. Every row names
// who holds it: the session's MCP servers always do, the agent as the one
// pure gate (roots-controls.ts) derives from the declared facts the writer
// holds. Where the agent takes the list only at its next open, the note
// offers that open — the same reload the session row's menu has. An
// added row also says whether it is saved for new sessions; the chip only
// saves (the shortcut), Settings manages the saved lists.
import { count } from "../../../shared/count";
import type { SavedRootsView } from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { rootHolders, rootSaving, type RootsControls } from "./roots-controls";
import { SaveMenu } from "./save-menu";
import type { PatchbaySessionId } from "../../../shared/ids";
import type { WorkspaceId } from "../../../shared/workspace";

export function RootsChip({
  patchbaySessionId,
  roots,
  workspaceRoots,
  savedRoots,
  here,
  controls,
}: {
  patchbaySessionId: PatchbaySessionId;
  roots: readonly string[];
  workspaceRoots: readonly string[];
  savedRoots: SavedRootsView;
  here: WorkspaceId | null;
  controls: RootsControls;
}) {
  const send = useActions();
  const total = workspaceRoots.length + roots.length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* text-[10px] because size-sm's text-xs utility outranks the
            .ctx-chip component rule — keeps this chip on the same font
            step as its plain-span siblings */}
        <Button variant="ghost" size="sm" className="ctx-chip h-auto text-[10px]">
          <Icon name="root-folder" /> {count(total, "root")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-auto min-w-[min(14rem,var(--radix-popover-content-available-width))]">
        {workspaceRoots.map((r, i) => (
          <div className="flex items-center gap-2 px-2 py-1 text-sm" key={r}>
            <code className="min-w-0 flex-1">{r}</code>
            <span className="text-muted-foreground">{rootHolders(controls.agent, i === 0)}</span>
          </div>
        ))}
        {roots.map((r) => (
          <div className="flex items-center gap-2 px-2 py-1 text-sm" key={r}>
            <code className="min-w-0 flex-1">{r}</code>
            <span className="text-muted-foreground">{rootHolders(controls.agent, false)}</span>
            <SaveControl path={r} saved={savedRoots} here={here} />
            <Button
              variant="ghost"
              size="sm"
              className="h-5 shrink-0 px-1 text-destructive hover:text-destructive"
              title="Remove root"
              aria-label={`Remove root ${r}`}
              onClick={() => send({ kind: "removeContextRoot", patchbaySessionId, path: r })}
            >
              <Icon name="trash" />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={() => send({ kind: "addContextRoot", patchbaySessionId })}
        >
          <b>+ Add folder…</b>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground"
          onClick={() => send({ kind: "openSettings", section: "roots" })}
        >
          Manage saved roots…
        </Button>
        {controls.note !== null && (
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
            <span>{controls.note}</span>
            {controls.agent === "nextOpen" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1"
                onClick={() => send({ kind: "reloadSession", patchbaySessionId })}
              >
                Reopen now
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Saved for this workspace: where it is saved, read-only here. Unsaved:
 * the Save menu. */
function SaveControl({ path, saved, here }: { path: string; saved: SavedRootsView; here: WorkspaceId | null }) {
  const send = useActions();
  const state = rootSaving(path, saved, here);
  if (state.kind === "saved") return <span className="text-muted-foreground">{state.label}</span>;
  return (
    <SaveMenu
      workspaceOpen={state.workspaceOpen}
      onThisWorkspace={() => send({ kind: "saveRoot", path, scope: "workspace" })}
      onEveryWorkspace={() => send({ kind: "saveRoot", path, scope: "everywhere" })}
    />
  );
}
