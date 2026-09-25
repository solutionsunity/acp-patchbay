// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The read-out strip between chat and composer: what the agent has done this
// session, at the eye's resting point, deliberately OUTSIDE the composer — its
// binding rule ("above the input = what the agent will see") stays intact
// because nothing here is context. Two chips: the plan (left) and the edited
// files (right, files-chip.tsx). Absent when neither has anything to show.
// Each opens a panel growing up from the strip over the chat
// (readout-panel.tsx); the two are sibling overlays, so they share one
// open-state here. Expand is manual, never forced — a task completing
// mid-turn pulses the collapsed plan chip as a peripheral signal instead of
// yanking the view open.
import { useEffect, useRef, useState, type RefObject } from "react";
import type { OpenEditorView, PlanEntry } from "../../shared/protocol";
import { Icon } from "../shared/icon";
import { FilesChip } from "./files-chip";
import { ReadoutPanel } from "./readout-panel";

type PanelId = "plan" | "files";

export function ReadoutStrip(props: {
  sessionId: string;
  plan: readonly PlanEntry[] | null;
  /** Distinct paths the agent touched this session (view-model totals). */
  files: readonly string[];
  diffable: ReadonlySet<string>;
  diffStats: Readonly<Record<string, { additions: number; deletions: number }>>;
  openEditors: readonly OpenEditorView[];
  roots: readonly string[];
}) {
  const [openId, setOpenId] = useState<PanelId | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  // A close clears only the panel it belongs to: on a cross-chip click the
  // open panel's outside-dismiss can land after the other chip's open, and
  // must not stomp it.
  const openChange = (id: PanelId) => (open: boolean) =>
    setOpenId((current) => (open ? id : current === id ? null : current));

  // A plan needs more than one task to be worth a chip.
  const hasPlan = props.plan !== null && props.plan.length > 1;
  // A panel whose chip went away closes with it — left open, it would
  // spring back the moment a new plan arrives, unasked.
  useEffect(() => {
    if (!hasPlan) setOpenId((current) => (current === "plan" ? null : current));
  }, [hasPlan]);
  if (!hasPlan && props.files.length === 0) return null;

  return (
    <div className="readout-strip" ref={stripRef}>
      <div className="chips">
        {hasPlan && (
          <PlanChip plan={props.plan!} open={openId === "plan"} onOpenChange={openChange("plan")} anchor={stripRef} />
        )}
        {props.files.length > 0 && (
          <FilesChip
            sessionId={props.sessionId}
            files={props.files}
            diffable={props.diffable}
            diffStats={props.diffStats}
            openEditors={props.openEditors}
            roots={props.roots}
            open={openId === "files"}
            onOpenChange={openChange("files")}
            anchor={stripRef}
          />
        )}
      </div>
    </div>
  );
}

function PlanChip({
  plan,
  open,
  onOpenChange,
  anchor,
}: {
  plan: readonly PlanEntry[];
  open: boolean;
  onOpenChange(open: boolean): void;
  anchor: RefObject<HTMLDivElement | null>;
}) {
  const done = plan.filter((e) => e.status === "completed").length;
  const [pulse, setPulse] = useState(false);
  const prevDone = useRef(done);
  useEffect(() => {
    const ticked = done > prevDone.current;
    prevDone.current = done;
    if (!ticked) return undefined;
    setPulse(true);
    const t = window.setTimeout(() => setPulse(false), 900);
    return () => window.clearTimeout(t);
  }, [done]);

  const current = plan.find((e) => e.status === "in_progress")?.content ?? plan[plan.length - 1]?.content ?? "";
  const frac = (
    <span className="frac">
      {done}/{plan.length}
    </span>
  );

  return (
    <ReadoutPanel
      open={open}
      onOpenChange={onOpenChange}
      anchor={anchor}
      className="plan-panel"
      title={<>Plan {frac}</>}
      chip={
        <button type="button" className={`chip plan ${open ? "active" : ""} ${pulse ? "animate-pulse" : ""}`}>
          <Icon name={open ? "chevron-down" : "chevron-right"} /> Plan {frac}
          <span className="current"> — {current}</span>
        </button>
      }
    >
      {plan.map((e, i) => (
        <div key={i} className={e.status}>
          <Icon
            name={
              e.status === "completed" ? "check" : e.status === "in_progress" ? "circle-large-filled" : "circle-large"
            }
          />{" "}
          {e.content}
        </div>
      ))}
    </ReadoutPanel>
  );
}
