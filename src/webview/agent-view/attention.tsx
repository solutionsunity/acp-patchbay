// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The header's read-out of the other sessions — waiting on you, finished
// unseen, running — and the one list it opens. Check, then act: a click
// always opens the list (the counts move under the pointer; the list names
// the session before the user leaves the one they are reading). One trigger
// holds all three counts, so there is one overlay and nothing to race.
import { useState } from "react";
import type { AgentSummary, SessionSummary } from "../../shared/protocol";
import type { Elsewhere, SessionMark } from "../../shared/attention";
import { useActions } from "../shared/actions";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const MARK_TITLE: Record<SessionMark, string> = {
  waiting: "Waiting on you",
  running: "Turn in progress",
  unseen: "Finished since you last saw it",
};

// Most urgent first — the order of the counts and of the list's groups.
const ORDER: readonly SessionMark[] = ["waiting", "unseen", "running"];

/** The session mark's dot — one vocabulary for the drawer rows and the
 * header: amber waits on you and green runs (both pulse — something is
 * live), blue is news. */
export function MarkDot({ mark }: { mark: SessionMark | null }) {
  if (mark === null) return <span className="live-dot-slot" />;
  const cls =
    mark === "waiting"
      ? "size-1.5 flex-none animate-[pulse_1.4s_infinite] rounded-full bg-warn"
      : mark === "running"
        ? "live-dot"
        : "unseen-dot";
  return <span className={cls} title={MARK_TITLE[mark]} />;
}

export function AttentionIndicators(props: {
  elsewhere: Elsewhere;
  agents: readonly AgentSummary[];
  /** What each waiting session is blocked on — the list's second line. */
  waitingOn(session: SessionSummary): string;
}) {
  const send = useActions();
  const [open, setOpen] = useState(false);
  const marks = ORDER.filter((m) => props.elsewhere[m].length > 0);
  if (marks.length === 0) return null;
  const summary = marks.map((m) => `${props.elsewhere[m].length} ${MARK_TITLE[m].toLowerCase()}`).join(" · ");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-6 cursor-pointer items-center gap-2 rounded-full border border-border px-2 text-[11px] tabular-nums hover:bg-muted"
          title={`Other sessions: ${summary}`}
          aria-label={`Other sessions: ${summary}`}
        >
          {marks.map((m) => (
            <span key={m} className={`flex items-center gap-1${m === "waiting" ? " font-semibold text-warn" : ""}`}>
              <MarkDot mark={m} />
              {props.elsewhere[m].length}
            </span>
          ))}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-64 p-1">
        {marks.map((m) => (
          <div key={m} role="group" aria-label={MARK_TITLE[m]}>
            <div className="px-2 pt-1.5 pb-0.5 text-[10.5px] tracking-wide text-muted-foreground uppercase">
              {MARK_TITLE[m]}
            </div>
            {props.elsewhere[m].map((s) => (
              <button
                type="button"
                key={s.id}
                className="s-row w-full text-left"
                onClick={() => {
                  send({ kind: "switchSession", sessionId: s.id });
                  setOpen(false);
                }}
              >
                <MarkDot mark={m} />
                <span className="min-w-0">
                  <span className="nm block truncate">{s.title}</span>
                  <span className="sub block">
                    {props.agents.find((a) => a.id === s.agentId)?.name ?? s.agentId}
                    {m === "waiting" ? ` · ${props.waitingOn(s)}` : ""}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
