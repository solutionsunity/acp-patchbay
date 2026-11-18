// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The agents and sessions drawers — sheets that drop from the top. Escape,
// the overlay click, the focus trap and focus back to the button that
// opened them are the shared sheet's; every row is a button, so a drawer
// is walked and picked from the keyboard. `onDone(toast?)` closes the
// drawer — drawer visibility and toasts are the shell's local UI state.
import { useState, type ReactNode } from "react";
import type { AgentSummary, AgentViewState, SessionSummary } from "../../shared/protocol";
import type { SessionMark } from "../../shared/attention";
import { listSessions, NO_SESSION_FILTER, type SessionFilter } from "../../shared/session-list";
import { useActions } from "../shared/actions";
import { agentSubtitle } from "../../shared/capability-format";
import { Icon } from "../shared/icon";
import { timeAgo } from "../../shared/time";
import { MarkDot } from "./attention";
import { unlistedAgents } from "./drawer-notes";
import { Dot } from "../shared/dot";
import { SessionActions } from "./session-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { PatchbaySessionId } from "../../shared/ids";

/** A drawer: the sheet, its title and the explicit way out — the overlay
 * click and Escape close it too, but the affordance must be visible. Open
 * while mounted; the shell unmounts it to close. */
function Drawer({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="drawer" aria-describedby={undefined}>
        <div className="flex items-center">
          <SheetTitle asChild>
            <h3 className="flex-1">{title}</h3>
          </SheetTitle>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6" title="Close" aria-label="Close">
              <Icon name="close" />
            </Button>
          </SheetClose>
        </div>
        {children}
      </SheetContent>
    </Sheet>
  );
}

/** The agent picker: one row per configured agent with its readiness
 * inline; picking one starts a chat with it — connecting first, inside the
 * chat pane, when it isn't running. Adding agents lives in Settings only
 * (the one rich form — owner-approved consolidation);
 * stop/restart stay as Settings troubleshooting controls plus the crash
 * banner's Restart. */
export function AgentsDrawer(props: {
  agents: readonly AgentSummary[];
  onDone(toast?: string): void;
}) {
  const send = useActions();
  return (
    <Drawer title="New chat with…" onClose={() => props.onDone()}>
      {props.agents.length === 0 && (
        <div className="a-row cursor-default">
          <span className="sub">No agents yet — add one in Settings.</span>
        </div>
      )}
      {props.agents.map((a) => {
        return (
          <button
            type="button"
            className="a-row"
            key={a.id}
            onClick={() => {
              send({ kind: "startChat", patchbayAgentId: a.id });
              props.onDone();
            }}
          >
            <Dot status={a.status} />
            <div className="min-w-0 flex-1">
              <div className="nm">{a.name}</div>
              <div className="sub">{agentSubtitle(a, true)}</div>
            </div>
          </button>
        );
      })}
      <button
        type="button"
        className="foot"
        onClick={() => {
          send({ kind: "openSettings", section: "agents" });
          props.onDone();
        }}
      >
        <Icon name="add" /> Add or manage agents — Settings…
      </button>
    </Drawer>
  );
}

/** The sessions, found by what the user remembers of one: a word of its
 * title or — for the ones loaded here, whose conversation is in this
 * window — of what was said in it; narrowed to one agent's. A row says
 * whether it is loaded, the line above the rows how many are: that is how
 * far a search of the conversations reaches. */
export function SessionsDrawer(props: {
  sessions: readonly SessionSummary[];
  transcripts: AgentViewState["transcripts"];
  agents: readonly AgentSummary[];
  activePatchbaySessionId: PatchbaySessionId | null;
  markOf(session: SessionSummary): SessionMark | null;
  /** detachWindows preference — off hides "Open in new window". */
  detach: boolean;
  onNew(): void;
  onDone(): void;
}) {
  const send = useActions();
  // One id, not one bool per row: switching straight from one row's menu to
  // another's needs a single state transition (session-row.tsx), not two
  // independent Radix instances racing to close/open on the same click.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [filter, setFilter] = useState<SessionFilter>(NO_SESSION_FILTER);
  // The filter's agent, while that agent is still one of them.
  const of = props.agents.some((a) => a.id === filter.agent) ? filter.agent : "all";
  // Latest activity on top — ordered in the view (session-list.ts), so the
  // reducer stays append-only and wire-merge arrival order stops mattering.
  const held = { sessions: props.sessions, transcripts: props.transcripts };
  const rows = listSessions(held, { ...filter, agent: of });
  const all = listSessions(held);
  const loaded = all.filter((r) => r.loaded).length;
  const narrowed = rows.length !== all.length;
  return (
    <Drawer title="Sessions" onClose={props.onDone}>
      {all.length > 0 && (
        <>
          <div className="s-filter">
            <Input
              type="text"
              className="min-w-0 flex-1"
              placeholder="Find by title, or by what was said…"
              aria-label="Find a session"
              value={filter.text}
              onInput={(e) => setFilter({ ...filter, text: (e.target as HTMLInputElement).value })}
            />
            {props.agents.length > 1 && (
              <Select value={of} onValueChange={(v) => setFilter({ ...filter, agent: v as SessionFilter["agent"] })}>
                <SelectTrigger aria-label="Sessions of which agent" className="max-w-[45%]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">all agents</SelectItem>
                  {props.agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="s-shown" title="A loaded session's conversation is in this window, so a search reads what was said in it; any other is found by its title">
            {narrowed ? `${rows.length} of ${all.length} sessions` : `${all.length} ${all.length === 1 ? "session" : "sessions"}`} · {loaded} loaded
          </div>
        </>
      )}
      {all.length === 0 && (
        <div className="s-row cursor-default">
          <span className="sub">No sessions yet.</span>
        </div>
      )}
      {all.length > 0 && rows.length === 0 && (
        <div className="s-row cursor-default">
          <span className="sub">No session matches — a conversation is searched only where it is loaded here.</span>
        </div>
      )}
      {rows.map(({ session: s, loaded: here, found }) => {
        const agent = props.agents.find((a) => a.id === s.patchbayAgentId);
        const isActive = s.id === props.activePatchbaySessionId;
        return (
          <div className={`s-row relative${isActive ? " active" : ""}`} key={s.id}>
            <button
              type="button"
              className="s-row-pick"
              aria-current={isActive ? "true" : undefined}
              onClick={() => {
                send({ kind: "switchSession", patchbaySessionId: s.id });
                props.onDone();
              }}
            >
              <MarkDot mark={props.markOf(s)} />
              <div className="min-w-0">
                <div className="nm">{s.title}</div>
                <div className="sub">
                  {agent?.name ?? s.patchbayAgentId} · {timeAgo(s.updatedAt)}
                  {here && " · loaded"}
                </div>
                {found !== null && <div className="found">{found}</div>}
              </div>
            </button>
            <div className="badges">
              <SessionActions
                session={s}
                agent={agent}
                detach={props.detach}
                open={openMenuId === s.id}
                // Radix's DismissableLayer defers an outside-pointerdown
                // dismiss to the following click event (deferPointerDownOutside,
                // Menu's default) — so clicking straight from row A's open
                // menu into row B's trigger opens B first (React's click
                // handler, reached while bubbling through the root
                // container) and only then fires A's deferred dismiss
                // (reached bubbling further up to document). An unconditional
                // clear here would let A's stale close stomp B's fresh open.
                // Only clear when this row is still the one recorded open.
                onOpenChange={(o) =>
                  setOpenMenuId((cur) => (o ? s.id : cur === s.id ? null : cur))
                }
              />
            </div>
          </div>
        );
      })}
      {/* The list is the agents' own session/list — an agent without one
          has no history here, and the drawer says so rather than leaving
          an unexplained gap. */}
      {unlistedAgents(props.agents).map((a) => (
        <div className="s-row cursor-default unlisted" key={a.id}>
          <span className="sub">
            {a.name} doesn&apos;t report its sessions — only the ones open in this window are listed.
          </span>
        </div>
      ))}
      <button type="button" className="foot" onClick={props.onNew}>
        <Icon name="add" /> New session
      </button>
    </Drawer>
  );
}
