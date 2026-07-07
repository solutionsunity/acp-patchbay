// The active session's title row, its badges, and the ellipsis actions menu
// (shared with the sessions drawer). Actions are sent per session id; only
// drawer-opening stays a shell callback.
import { useState } from "react";
import type { SessionSummary } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { Icon } from "../shared/icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

export function Badges({ session }: { session: SessionSummary }) {
  return (
    <>
      {session.emulated && (
        <span
          className="badge emulated"
          title="Continuation seeded from patchbay's last-known view — agent cannot replay"
        >
          emulated
        </span>
      )}
      {session.branchOf !== null && (
        <span className="badge branch" title={`Branched from ${session.branchOf}`}>
          <Icon name="git-branch" /> branch
        </span>
      )}
    </>
  );
}

/** Ellipsis menu shared by the session row and sessions-drawer rows —
 * Radix DropdownMenu; Rename opens a small Dialog with the title input. */
export function SessionActions({ session, forkUsed }: { session: SessionSummary; forkUsed: boolean }) {
  const send = useActions();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title);

  const save = () => {
    const trimmed = draft.trim();
    if (trimmed !== "") send({ kind: "renameSession", sessionId: session.id, title: trimmed });
    setRenaming(false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-6 w-6" title="Session actions" aria-label="Session actions">
            <Icon name="ellipsis" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setDraft(session.title);
              setRenaming(true);
            }}
          >
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => send({ kind: "branchSession", sessionId: session.id })}>
            Branch <span className="d">{forkUsed ? "native fork ✓" : "emulated"}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => send({ kind: "reloadSession", sessionId: session.id })}>
            Reload from agent
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => send({ kind: "closeSession", sessionId: session.id })}>
            Close
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
          </DialogHeader>
          <Input
            type="text"
            autoFocus
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <DialogFooter>
            <Button size="sm" onClick={save}>
              Save
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SessionRow(props: { session: SessionSummary; forkUsed: boolean; onTitle(): void }) {
  return (
    <div className="sess-row">
      <span className="sess-title" onClick={props.onTitle}>
        {props.session.title}
      </span>
      <Badges session={props.session} />
      <div className="spacer flex-1" />
      <SessionActions session={props.session} forkUsed={props.forkUsed} />
    </div>
  );
}
