// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The active session's title row and the ellipsis actions menu (shared with
// the sessions drawer). Actions are sent per session id; only drawer-opening
// stays a shell callback. No rename here: ACP has no rename request — agents
// with an in-chat /rename push the new title back via session_info_update.
// Fork, Delete and Close are offered as the agent declares them
// (session-offers.ts).
import type { AgentSummary, SessionSummary } from "../../shared/protocol";
import { sessionOffers } from "../../shared/session-offers";
import { useActions } from "../shared/actions";
import { Icon } from "../shared/icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** A session's actions, shared by the session row and sessions-drawer
 * rows: the two ways to open it apart from the sidebar — a tab, a window —
 * as icons beside the ellipsis menu while the row has the room (a narrow
 * row keeps its title, and the menu, which always holds both), then the
 * menu. `detach` mirrors the detachWindows preference — off hides the
 * window, never the tab: a tab is an editor like any other.
 * `open`/`onOpenChange` are optional: omitted, Radix manages its own state
 * (fine for the lone active-session row); a list of rows (SessionsDrawer)
 * must pass them, controlled from one shared "which id is open" state — two
 * independent uncontrolled menus race their pointerdown handlers when you
 * click straight from one row's trigger to another's, and the second row's
 * own open can lose to the first row's dismiss. One piece of state removes
 * the race instead of chasing it. */
export function SessionActions({
  session,
  agent,
  detach,
  inTabs = false,
  reloading = false,
  open,
  onOpenChange,
}: {
  session: SessionSummary;
  /** The session's agent — what it declares decides what the menu offers. */
  agent: AgentSummary | undefined;
  detach: boolean;
  /** The row's own pick opens the session's tab (the list layout): the
   * row offers the window alone. */
  inTabs?: boolean;
  /** The session is being attached (an open or a reload on its attachment
   * line) — Reload disables rather than queueing a second read behind the
   * first. */
  reloading?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const send = useActions();
  const offers = sessionOffers(agent?.capabilities);
  const openApart = (into: "tab" | "window") => send({ kind: "detachSession", patchbaySessionId: session.id, into });
  return (
    <>
      <span className="open-apart">
        {!inTabs && (
          <Button variant="ghost" size="icon" className="h-6 w-6" title="Open in tab" aria-label="Open in tab" onClick={() => openApart("tab")}>
            <Icon name="window" />
          </Button>
        )}
        {detach && (
          <Button variant="ghost" size="icon" className="h-6 w-6" title="Open in new window" aria-label="Open in new window" onClick={() => openApart("window")}>
            <Icon name="multiple-windows" />
          </Button>
        )}
      </span>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-6 w-6" title="Session actions" aria-label="Session actions">
            <Icon name="ellipsis" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!inTabs && <DropdownMenuItem onSelect={() => openApart("tab")}>Open in tab</DropdownMenuItem>}
          {detach && <DropdownMenuItem onSelect={() => openApart("window")}>Open in new window</DropdownMenuItem>}
          <DropdownMenuItem
            disabled={reloading}
            onSelect={() => send({ kind: "reloadSession", patchbaySessionId: session.id })}
          >
            {reloading ? "Reloading…" : "Reload from agent"}
          </DropdownMenuItem>
          {/* The agent's own id for the session — the host holds it and
              writes it; the view knows the session only by patchbay's id. */}
          <DropdownMenuItem onSelect={() => send({ kind: "copySessionId", patchbaySessionId: session.id })}>
            Copy session ID
          </DropdownMenuItem>
          {offers.fork && (
            <DropdownMenuItem onSelect={() => send({ kind: "forkSession", patchbaySessionId: session.id })}>
              Fork
            </DropdownMenuItem>
          )}
          {/* The host asks before the agent deletes — nothing brings it back. */}
          {offers.delete && (
            <DropdownMenuItem onSelect={() => send({ kind: "deleteSession", patchbaySessionId: session.id })}>
              Delete…
            </DropdownMenuItem>
          )}
          {offers.close && (
            <DropdownMenuItem onSelect={() => send({ kind: "closeSession", patchbaySessionId: session.id })}>
              Close
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export function SessionRow(props: {
  session: SessionSummary;
  agent: AgentSummary | undefined;
  /** The row this session was forked from, when it is a fork whose
   * original the list still names. */
  original: SessionSummary | undefined;
  onTitle(): void;
  detach: boolean;
  reloading: boolean;
}) {
  const send = useActions();
  const { original } = props;
  return (
    <>
      <div className="sess-row">
        <span className="sess-title" onClick={props.onTitle}>
          {props.session.title}
        </span>
        {/* Replay in flight (reload or re-attach) — mirrors the rendering
            area's loading page so the title row says busy too. */}
        {props.reloading && <Icon name="loading" spin />}
        <div className="spacer flex-1" />
        <SessionActions session={props.session} agent={props.agent} detach={props.detach} reloading={props.reloading} />
      </div>
      {props.session.forkedFrom !== undefined && (
        <div className="sess-fork">
          {original !== undefined ? (
            <>
              Forked from{" "}
              <button type="button" onClick={() => send({ kind: "switchSession", patchbaySessionId: original.id })}>
                {original.title}
              </button>
            </>
          ) : (
            "Forked from a session no longer listed"
          )}
        </div>
      )}
    </>
  );
}
