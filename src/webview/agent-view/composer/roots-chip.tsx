// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Context roots: workspace folders are the always-active baseline — fixed,
// non-removable, shown so the count reflects reality; the first is the
// session cwd, the rest ride as `additionalDirectories`. `roots` is the
// removable, user-added external set, on the same field. Every row names
// who holds it: the session's MCP servers always do, the agent as the one
// pure gate (roots-controls.ts) derives from the declared facts the writer
// holds. Where the agent takes the list only at its next open, the note
// offers that open — the same reload the session row's menu has.
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { rootHolders, type RootsControls } from "./roots-controls";

export function RootsChip({
  sessionId,
  roots,
  workspaceRoots,
  controls,
}: {
  sessionId: string;
  roots: readonly string[];
  workspaceRoots: readonly string[];
  controls: RootsControls;
}) {
  const send = useActions();
  const count = workspaceRoots.length + roots.length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* text-[10px] because size-sm's text-xs utility outranks the
            .ctx-chip component rule — keeps this chip on the same font
            step as its plain-span siblings */}
        <Button variant="ghost" size="sm" className="ctx-chip h-auto text-[10px]">
          <Icon name="root-folder" /> {count} root{count === 1 ? "" : "s"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-auto min-w-56">
        {workspaceRoots.map((r, i) => (
          <div className="flex items-center gap-2 px-2 py-1 text-sm" key={r}>
            <code>{r}</code>
            <span className="text-muted-foreground">{rootHolders(controls.agent, i === 0)}</span>
          </div>
        ))}
        {roots.map((r) => (
          <div className="flex items-center gap-2 px-2 py-1 text-sm" key={r}>
            <code>{r}</code>
            <span className="text-muted-foreground">{rootHolders(controls.agent, false)}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1 text-destructive hover:text-destructive"
              title="Remove root"
              aria-label={`Remove root ${r}`}
              onClick={() => send({ kind: "removeContextRoot", sessionId, path: r })}
            >
              <Icon name="trash" />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={() => send({ kind: "addContextRoot", sessionId })}
        >
          <b>+ Add folder…</b>
        </Button>
        {controls.note !== null && (
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
            <span>{controls.note}</span>
            {controls.agent === "nextOpen" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1"
                onClick={() => send({ kind: "reloadSession", sessionId })}
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
