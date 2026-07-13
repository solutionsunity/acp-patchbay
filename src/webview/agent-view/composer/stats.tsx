// The composer's session-stats strip (Preferences § composerStats): whole-
// session counts from the view-model's single pass, the files chip
// (children — files-chip.tsx, the one interactive member of this row) slotted
// between counts and the context-window gauge (moved from the header,
// smaller). Counts render only when nonzero, the gauge only when the agent
// reports usage (absence over fake, ui.md § gauge); a fresh session shows
// nothing at all.
import type { ReactNode } from "react";
import type { PlanUsageInfo, UsageInfo } from "../../../shared/protocol";
import { Icon } from "../../shared/icon";
import { count, type SessionTotals } from "../chat/view-model";

/** Known plan-window tags → short labels; an unknown tag renders raw
 * (labels are UX-only, never gating). Unqualified windows are
 * account-wide; model-tagged ones name their model. */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_opus: "7d Opus",
  seven_day_sonnet: "7d Sonnet",
  seven_day_overage_included: "7d+",
  overage: "overage",
};

const STATUS_RANK: Record<PlanUsageInfo["status"], number> = { limited: 0, warning: 1, ok: 2 };

function windowLabel(reading: PlanUsageInfo): string {
  return reading.window === undefined ? "plan" : (WINDOW_LABELS[reading.window] ?? reading.window);
}

/** ≤1 reads as a fraction — the unit is unverified upstream
 * (protocol.ts PlanUsageInfo). */
function pctOf(reading: PlanUsageInfo): number | null {
  return reading.utilization === undefined
    ? null
    : Math.round(reading.utilization <= 1 ? reading.utilization * 100 : reading.utilization);
}

function lineOf(reading: PlanUsageInfo): string {
  const pct = pctOf(reading);
  const resets =
    reading.resetsAt === undefined
      ? ""
      : ` · resets ${new Date(reading.resetsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  return `${windowLabel(reading)}${pct !== null ? ` ${pct}%` : ""}${resets}${reading.status === "limited" ? " · limit reached" : ""}`;
}

/** The plan-usage read-out — the context gauge's sibling (UsageInfo.plan:
 * one sticky reading per parallel window). The chip shows the most severe
 * window, always qualified by its label — a bare percentage would hide
 * whether it's account-wide or one model's weekly window. The tooltip
 * lists every window's standing reading. */
function PlanGauge({ plan }: { plan: Readonly<Record<string, PlanUsageInfo>> }) {
  const readings = Object.values(plan).sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      (pctOf(b) ?? -1) - (pctOf(a) ?? -1),
  );
  const worst = readings[0];
  if (worst === undefined) return null;
  const pct = pctOf(worst);
  const tip = `Plan usage\n${readings.map(lineOf).join("\n")}`;
  return (
    <span
      className={`flex items-center gap-0.5${worst.status === "limited" ? " text-destructive" : ""}`}
      style={worst.status === "warning" ? { color: "var(--pb-warn)" } : undefined}
      title={tip}
    >
      <Icon name="pulse" />
      {windowLabel(worst)}
      {pct !== null ? ` ${pct}%` : ""}
    </span>
  );
}

function Gauge({ usage }: { usage: UsageInfo }) {
  const frac = Math.max(0, Math.min(1, usage.used / usage.size));
  const circumference = 37.7; // 2π·r at r=6
  const tip = `${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens${
    usage.cost !== undefined ? ` · ${usage.cost.amount.toFixed(2)} ${usage.cost.currency}` : ""
  }`;
  return (
    <div className="gauge" title={tip}>
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6" fill="none" stroke="var(--pb-border)" stroke-width="2.5" />
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="var(--pb-consumed)"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-dasharray={`${(frac * circumference).toFixed(1)} ${circumference}`}
        />
      </svg>
      <div className="tip">{tip}</div>
    </div>
  );
}

export function ComposerStats({
  totals,
  usage,
  children,
}: {
  totals: SessionTotals;
  usage: UsageInfo | null;
  /** The files chip (composer.tsx) — slotted here, between counts and the
   * gauge, so the row's order (prompts, tool calls, files, context window)
   * lives in one place and the icon inherits this span's 12px sizing. */
  children?: ReactNode;
}) {
  const counts: { icon: string; n: number; tip: string }[] = [
    { icon: "comment", n: totals.prompts, tip: `${count(totals.prompts, "prompt")} this session` },
    { icon: "tools", n: totals.toolCalls, tip: `${count(totals.toolCalls, "tool call")} this session` },
  ];
  return (
    // mr-6 ≈ one counter's width of air before the send button — the strip is
    // a read-out, the button is a control; they must not read as one cluster.
    // Icon size rides the chrome policy (theme.css § rendered-block chrome).
    <span className="composer-stats mr-6 flex items-center gap-2 text-[11px] text-muted-foreground">
      {counts.map(
        (c) =>
          c.n > 0 && (
            <span key={c.icon} className="flex items-center gap-0.5" title={c.tip}>
              <Icon name={c.icon} /> {c.n}
            </span>
          ),
      )}
      {children}
      {/* sessionUsage only ever gets an entry alongside marking "usage"
          used (pool.ts's notification handler and this both fire off the
          same usage_update), so presence here already means used — absent,
          never grayed, until then. Same rule for the plan reading. */}
      {usage !== null && <Gauge usage={usage} />}
      {usage?.plan !== undefined && Object.keys(usage.plan).length > 0 && <PlanGauge plan={usage.plan} />}
    </span>
  );
}
