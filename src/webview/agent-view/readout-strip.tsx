// The read-out strip between chat and composer (ui.md § Read-out strip):
// live-turn read-outs at the eye's resting point, deliberately OUTSIDE the
// composer — its binding rule ("above the input = what the agent will see")
// stays intact because this strip is never context, only read-out. Plan chip
// only — the files chip moved into the composer's foot row (files-chip.tsx),
// beside the stats strip, so it reads as part of the input's own counts.
// Absent when there's no plan. Click opens an overlay panel growing up from
// the strip over the chat; X/Escape/re-click/outside-click close. Expand is manual, never
// forced — a task completing mid-turn pulses the collapsed plan chip as a
// peripheral signal instead of yanking the view open.
import { useEffect, useRef, useState } from "react";
import type { PlanEntry } from "../../shared/protocol";
import { Icon } from "../shared/icon";

export function ReadoutStrip({
  plan,
}: {
  plan: readonly PlanEntry[] | null;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const done = plan?.filter((e) => e.status === "completed").length ?? 0;
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
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Plain overlay, not a Radix portal — outside-click has to be hand-rolled
    // (files-chip.tsx carries the same fix for the same reason).
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // Same presence rule as before the move: a plan needs more than one task.
  const hasPlan = plan !== null && plan.length > 1;
  if (!hasPlan) return null;
  const isOpen = open && hasPlan;

  const current =
    plan?.find((e) => e.status === "in_progress")?.content ?? plan?.[plan.length - 1]?.content ?? "";

  return (
    <div className="readout-strip" ref={wrapRef}>
      {isOpen && (
        <div className="overlay-panel readout-panel">
          <div className="head">
            <span className="title">
              Plan <span className="frac">{done}/{plan?.length}</span>
            </span>
            <button className="close" title="Close" onClick={() => setOpen(false)}>
              <Icon name="close" />
            </button>
          </div>
          <div className="items">
            {plan?.map((e, i) => (
              <div key={i} className={e.status}>
                <Icon
                  name={
                    e.status === "completed"
                      ? "check"
                      : e.status === "in_progress"
                        ? "circle-large-filled"
                        : "circle-large"
                  }
                />{" "}
                {e.content}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="chips">
        <button
          className={`chip plan ${isOpen ? "active" : ""} ${pulse ? "animate-pulse" : ""}`}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={isOpen ? "chevron-down" : "chevron-right"} /> Plan{" "}
          <span className="frac">{done}/{plan?.length}</span>
          <span className="current"> — {current}</span>
        </button>
      </div>
    </div>
  );
}
