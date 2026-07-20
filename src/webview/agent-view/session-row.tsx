// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

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

/** Ellipsis menu shared by the session row and sessions-drawer rows.
 * `detach` mirrors the detachWindows preference — off hides the entry point.
 * `open`/`onOpenChange` are optional: omitted, Radix manages its own state
 * (fine for the lone active-session row); a list of rows (SessionsDrawer)
 * must pass them, controlled from one shared "which id is open" state — two
 * independent uncontrolled menus race their pointerdown handlers when you
 * click straight from one row's trigger to another's, and the second row's
 * own open can lose to the first row's dismiss. One piece of state removes
 * the race instead of chasing it. */
export function SessionActions({
  session,
  detach,
  reloading = false,
  open,
  onOpenChange,
}: {
  session: SessionSummary;
  detach: boolean;
  /** A replay is in flight for this session (state.hydrating) — Reload
   * disables rather than queueing a second replay behind the first. */
  reloading?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const send = useActions();
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-6 w-6" title="Session actions" aria-label="Session actions">
          <Icon name="ellipsis" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {detach && (
          <DropdownMenuItem onSelect={() => send({ kind: "detachSession", sessionId: session.id })}>
            Open in new window
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={reloading}
          onSelect={() => send({ kind: "reloadSession", sessionId: session.id })}
        >
          {reloading ? "Reloading…" : "Reload from agent"}
        </DropdownMenuItem>
        {/* Bare clipboard write, not useCopy: the menu closes on select, so
            there's no surface for the check-mark feedback to live on. */}
        <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(session.id)}>
          Copy session ID
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => send({ kind: "closeSession", sessionId: session.id })}>
          Close
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SessionRow(props: {
  session: SessionSummary;
  onTitle(): void;
  detach: boolean;
  reloading: boolean;
}) {
  return (
    <div className="sess-row">
      <span className="sess-title" onClick={props.onTitle}>
        {props.session.title}
      </span>
      {/* Replay in flight (reload or re-attach) — mirrors the rendering
          area's loading page so the title row says busy too. */}
      {props.reloading && <Icon name="loading" spin />}
      <div className="spacer flex-1" />
      <SessionActions session={props.session} detach={props.detach} reloading={props.reloading} />
    </div>
  );
}
