// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The read-out strip between chat and composer: what the agent has done this
// session, at the eye's resting point, deliberately OUTSIDE the composer — its
// binding rule ("above the input = what the agent will see") stays intact
// because nothing here is context. The plan has a row of its own, its label
// carrying the current step. Below it the sub-agents (subagents-chip.tsx) on
// the left, all of them and those at work, then the prompts (prompts-chip.tsx)
// and the edited files (files-chip.tsx) on the right. Absent when none has anything to show. Each opens a panel growing
// up from the strip over the chat (readout-panel.tsx); they are sibling
// overlays, so they share one open-state here. Expand is manual, never forced — a task completing
// mid-turn pulses the collapsed plan chip as a peripheral signal instead of
// yanking the view open.
import { useEffect, useRef, useState, type RefObject } from "react";
import type { PatchbaySessionId } from "../../shared/ids";
import type { OpenEditorView, PlanEntry, SubagentView, UserBlock } from "../../shared/protocol";
import { Icon } from "../shared/icon";
import { FilesChip } from "./files-chip";
import { PromptsChip } from "./prompts-chip";
import { ReadoutPanel } from "./readout-panel";
import { atWorkRows, atWorkSummary, rosterLabel, rosterRows } from "./subagent-controls";
import { SubagentDot } from "./subagent-head";
import { SubagentsChip } from "./subagents-chip";

type PanelId = "plan" | "subagents" | "atWork" | "prompts" | "files";

export function ReadoutStrip(props: {
  patchbaySessionId: PatchbaySessionId;
  plan: readonly PlanEntry[] | null;
  /** The session's sub-agents, nested ones included. */
  subagents: readonly SubagentView[];
  /** Opens a sub-agent's transcript in the chat. */
  onOpenSubagent(subagent: PatchbaySessionId): void;
  /** The session's prompts, in order (view-model totals). */
  prompts: readonly UserBlock[];
  /** The durable draft is empty — the only state a reuse lands in. */
  composerEmpty: boolean;
  onGoTo(prompt: UserBlock): void;
  onReuse(prompt: UserBlock): void;
  /** Distinct paths the agent touched this session (view-model totals). */
  files: readonly string[];
  openEditors: readonly OpenEditorView[];
  workspaceRoots: readonly string[];
  /** The session's added roots. */
  contextRoots: readonly string[];
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
  const atWork = atWorkRows(props.subagents, props.patchbaySessionId);
  const anyAtWork = atWork.length > 0;
  // A panel whose chip went away closes with it — left open, it would
  // spring back the moment its chip returns, unasked.
  useEffect(() => {
    setOpenId((current) => ((current === "plan" && !hasPlan) || (current === "atWork" && !anyAtWork) ? null : current));
  }, [hasPlan, anyAtWork]);
  const hasRow = props.subagents.length > 0 || props.prompts.length > 0 || props.files.length > 0;
  if (!hasPlan && !hasRow) return null;
  const atWorkShown = atWorkSummary(atWork.map((row) => row.subagent));

  return (
    <div className="readout-strip" ref={stripRef}>
      {hasPlan && (
        <div className="chips">
          <PlanChip plan={props.plan!} open={openId === "plan"} onOpenChange={openChange("plan")} anchor={stripRef} />
        </div>
      )}
      {hasRow && (
        <div className="chips">
          {props.subagents.length > 0 && (
            <SubagentsChip
              patchbaySessionId={props.patchbaySessionId}
              rows={rosterRows(props.subagents, props.patchbaySessionId)}
              label={rosterLabel(props.subagents)}
              mark={<Icon name="type-hierarchy-sub" />}
              className="roster"
              onOpen={props.onOpenSubagent}
              open={openId === "subagents"}
              onOpenChange={openChange("subagents")}
              anchor={stripRef}
            />
          )}
          {anyAtWork && (
            <SubagentsChip
              patchbaySessionId={props.patchbaySessionId}
              rows={atWork}
              label={atWorkShown.label}
              mark={<SubagentDot look={atWorkShown.look} />}
              className="at-work"
              onOpen={props.onOpenSubagent}
              open={openId === "atWork"}
              onOpenChange={openChange("atWork")}
              anchor={stripRef}
            />
          )}
          {props.prompts.length > 0 && (
            <PromptsChip
              prompts={props.prompts}
              composerEmpty={props.composerEmpty}
              onGoTo={props.onGoTo}
              onReuse={props.onReuse}
              open={openId === "prompts"}
              onOpenChange={openChange("prompts")}
              anchor={stripRef}
            />
          )}
          {props.files.length > 0 && (
            <FilesChip
              files={props.files}
              openEditors={props.openEditors}
              workspaceRoots={props.workspaceRoots}
              contextRoots={props.contextRoots}
              open={openId === "files"}
              onOpenChange={openChange("files")}
              anchor={stripRef}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The statuses a plan entry's icon knows. Any other word the agent sends
 * is shown as said, beside the entry. */
const PLAN_STATUS_ICONS = new Map([
  ["pending", "circle-large"],
  ["in_progress", "circle-large-filled"],
  ["completed", "check"],
  ["cancelled", "circle-slash"],
]);

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
      {plan.map((e, i) => {
        const icon = PLAN_STATUS_ICONS.get(e.status);
        return (
          <div key={i} className={icon !== undefined ? e.status : undefined}>
            <Icon name={icon ?? "circle-large"} /> {e.content}
            {icon === undefined && <span className="prio"> · {e.status}</span>}
            {e.priority !== undefined && <span className="prio"> · {e.priority}</span>}
          </div>
        );
      })}
    </ReadoutPanel>
  );
}
