// The session's plan, pinned above the transcript (ui-rendering-strategy §
// Plans): shown only when a plan exists with more than one task; expand is
// manual, never forced — a task completing mid-turn pulses the collapsed
// fraction as a peripheral signal instead of yanking the view open.
import { useEffect, useRef, useState } from "react";
import type { PlanEntry } from "../../shared/protocol";
import { Icon } from "../shared/icon";

export function PlanStrip({ entries }: { entries: readonly PlanEntry[] | null }) {
  const [open, setOpen] = useState(false);
  const done = entries?.filter((e) => e.status === "completed").length ?? 0;
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
  if (entries === null || entries.length <= 1) return null;
  const current =
    entries.find((e) => e.status === "in_progress")?.content ??
    entries[entries.length - 1]?.content ??
    "";
  return (
    <div
      className={`plan-strip ${open ? "open" : ""} ${pulse ? "animate-pulse" : ""}`}
      onClick={() => setOpen((v) => !v)}
    >
      <Icon name={open ? "chevron-down" : "chevron-right"} /> Plan{" "}
      <span className="frac">{done}/{entries.length}</span> — {current}
      {open && (
        <div className="items">
          {entries.map((e, i) => (
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
      )}
    </div>
  );
}
