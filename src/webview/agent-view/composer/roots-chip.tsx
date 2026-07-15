// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Context roots (features.md § Chat): workspace folders are the always-active
// baseline — fixed, non-removable, but shown so the count reflects reality.
// `roots` is the removable, user-added external set, passed to the agent as
// `additionalDirectories`. A change re-applies to the live session in place
// (session/load or session/resume "set the complete list"); only an agent
// declaring neither waits for the next reload/branch — and only then does
// the note say so (`applyLive`).
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function RootsChip({
  sessionId,
  roots,
  workspaceRoots,
  applyLive,
}: {
  sessionId: string;
  roots: readonly string[];
  workspaceRoots: readonly string[];
  applyLive: boolean;
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
        {workspaceRoots.map((r) => (
          <div className="flex items-center gap-2 px-2 py-1 text-sm" key={r}>
            <code>{r}</code>
            <span className="text-muted-foreground">workspace</span>
          </div>
        ))}
        {roots.map((r) => (
          <div className="flex items-center gap-2 px-2 py-1 text-sm" key={r}>
            <code>{r}</code>
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
          {!applyLive && (
            <span className="text-muted-foreground">takes effect next reload/branch</span>
          )}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
