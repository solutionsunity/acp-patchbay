// Context roots (features.md § Chat): workspace folders are the always-active
// baseline — fixed, non-removable, but shown so the count reflects reality.
// `roots` is the removable, user-added external set, passed to the agent as
// `additionalDirectories` on the next create/reload/fork (ACP has no
// live-update request, so a note says so).
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function RootsChip({
  sessionId,
  roots,
  workspaceRoots,
}: {
  sessionId: string;
  roots: readonly string[];
  workspaceRoots: readonly string[];
}) {
  const send = useActions();
  const count = workspaceRoots.length + roots.length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="ctx-chip h-auto">
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
              className="h-5 px-1 text-muted-foreground"
              onClick={() => send({ kind: "removeContextRoot", sessionId, path: r })}
            >
              remove
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
          <span className="text-muted-foreground">takes effect next reload/branch</span>
        </Button>
      </PopoverContent>
    </Popover>
  );
}
