// The active session's title row and the ellipsis actions menu (shared with
// the sessions drawer). Actions are sent per session id; only drawer-opening
// stays a shell callback. No rename here: ACP has no rename request — agents
// with an in-chat /rename push the new title back via session_info_update.
import type { SessionSummary } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { Icon } from "../shared/icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Ellipsis menu shared by the session row and sessions-drawer rows. */
export function SessionActions({ session }: { session: SessionSummary }) {
  const send = useActions();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-6 w-6" title="Session actions" aria-label="Session actions">
          <Icon name="ellipsis" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => send({ kind: "detachSession", sessionId: session.id })}>
          Open in new window
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => send({ kind: "reloadSession", sessionId: session.id })}>
          Reload from agent
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => send({ kind: "closeSession", sessionId: session.id })}>
          Close
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SessionRow(props: { session: SessionSummary; onTitle(): void }) {
  return (
    <div className="sess-row">
      <span className="sess-title" onClick={props.onTitle}>
        {props.session.title}
      </span>
      <div className="spacer flex-1" />
      <SessionActions session={props.session} />
    </div>
  );
}
