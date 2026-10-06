// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The agents and sessions drawers — sheets that drop from the top. Escape,
// the overlay click, the focus trap and focus back to the button that
// opened them are the shared sheet's; every row is a button, so a drawer
// is walked and picked from the keyboard. `onDone(toast?)` closes the
// drawer — drawer visibility and toasts are the shell's local UI state.
import { useState, type ReactNode } from "react";
import type { AgentSummary, SessionSummary } from "../../shared/protocol";
import type { SessionMark } from "../../shared/attention";
import { useActions } from "../shared/actions";
import { capabilityOneLiner } from "../shared/capability-format";
import { Icon } from "../shared/icon";
import { timeAgo } from "../shared/time";
import { MarkDot } from "./attention";
import { unlistedAgents } from "./drawer-notes";
import { Dot } from "./header";
import { SessionActions } from "./session-row";
import { Button } from "@/components/ui/button";
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
        const matrix = a.capabilities;
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
              <div className="sub">
                {a.detail ??
                  (a.status === "running"
                    ? "ready"
                    : a.status === "untested"
                      ? "never connected"
                      : matrix !== undefined
                        ? capabilityOneLiner(matrix)
                        : "")}
              </div>
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

export function SessionsDrawer(props: {
  sessions: readonly SessionSummary[];
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
  // Latest activity on top — sorted here in the view, so the reducer stays
  // append-only and wire-merge arrival order stops mattering.
  const ordered = [...props.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <Drawer title="Sessions" onClose={props.onDone}>
      {ordered.length === 0 && (
        <div className="s-row cursor-default">
          <span className="sub">No sessions yet.</span>
        </div>
      )}
      {ordered.map((s) => {
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
                </div>
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
