// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The composer's session-stats strip: the whole-session tool-call count from
// the view-model's single pass, then the context-window gauge (moved from the
// header, smaller), the session's cost and the plan-usage gauge — read-outs
// only, each behind its own preference. Counts render only when nonzero, the
// gauges and the cost only when the agent reports them (absence over fake);
// a fresh session shows nothing at all.
import type { CSSProperties, ReactNode } from "react";
import type { PlanUsageInfo, PreferencesView, UsageInfo } from "../../../shared/protocol";
import { Icon } from "../../shared/icon";
import { count } from "../../../shared/count";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { SessionTotals } from "../chat/view-model";

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

function pctOf(reading: PlanUsageInfo): number | null {
  return reading.utilization === undefined ? null : Math.round(reading.utilization * 100);
}

/** When a window resets: in full for the tooltip, by weekday and hour
 * inline — a window is at most a week long, so the weekday names it. */
function resetsSaid(reading: PlanUsageInfo, inline: boolean): string | null {
  if (reading.resetsAt === undefined) return null;
  const options: Intl.DateTimeFormatOptions = inline
    ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  return `resets ${new Date(reading.resetsAt).toLocaleString(undefined, options)}`;
}

function lineOf(reading: PlanUsageInfo): string {
  const pct = pctOf(reading);
  const resets = resetsSaid(reading, false);
  return `${windowLabel(reading)}${pct !== null ? ` ${pct}%` : ""}${resets !== null ? ` · ${resets}` : ""}${reading.status === "limited" ? " · limit reached" : ""}`;
}

/** A read-out's words on the shared tooltip, which the keyboard reaches
 * too; a screen reader gets the same words as the read-out's label. */
function ReadoutTip({ tip, className, style, children }: { tip: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`flex items-center gap-1 whitespace-nowrap${className !== undefined ? ` ${className}` : ""}`} style={style} tabIndex={0} role="img" aria-label={tip}>
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-line">{tip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The plan-usage read-out — the context gauge's sibling (UsageInfo.plan:
 * one sticky reading per parallel window). The chip shows the most severe
 * window, always qualified by its label — a bare percentage would hide
 * whether it's account-wide or one model's weekly window — and with
 * details when it resets. The tooltip lists every window's standing
 * reading. */
function PlanGauge({ plan, details }: { plan: Readonly<Record<string, PlanUsageInfo>>; details: boolean }) {
  const readings = Object.values(plan).sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      (pctOf(b) ?? -1) - (pctOf(a) ?? -1),
  );
  const worst = readings[0];
  if (worst === undefined) return null;
  const pct = pctOf(worst);
  const resets = details ? resetsSaid(worst, true) : null;
  return (
    <ReadoutTip
      tip={`Plan usage\n${readings.map(lineOf).join("\n")}`}
      className={`plan-gauge gap-0.5${worst.status === "limited" ? " text-destructive" : ""}`}
      style={worst.status === "warning" ? { color: "var(--pb-warn)" } : undefined}
    >
      <Icon name="pulse" />
      {windowLabel(worst)}
      {pct !== null ? ` ${pct}%` : ""}
      {resets !== null ? ` · ${resets}` : ""}
    </ReadoutTip>
  );
}

const tokensCompact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** The context-window gauge: the ring, and with details the numbers it
 * draws — compact inline, in full in the tooltip. The context as it
 * stands, apart from the tokens a turn's footer counts. */
function Gauge({ usage, details }: { usage: UsageInfo; details: boolean }) {
  const frac = Math.max(0, Math.min(1, usage.used / usage.size));
  const circumference = 37.7; // 2π·r at r=6
  return (
    <ReadoutTip tip={`Context ${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens`} className="gauge">
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
      {details && `${tokensCompact.format(usage.used)} / ${tokensCompact.format(usage.size)}`}
    </ReadoutTip>
  );
}

/** The amount in the agent's currency; a code the platform can't format
 * (agent data) is said as sent. */
function costSaid(cost: { amount: number; currency: string }): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cost.currency }).format(cost.amount);
  } catch {
    return `${cost.amount.toFixed(2)} ${cost.currency}`;
  }
}

/** The session's cost so far, as the agent reports it. */
function Cost({ cost }: { cost: { amount: number; currency: string } }) {
  const said = costSaid(cost);
  return (
    <ReadoutTip tip={`Session cost so far ${said}`} className="cost">
      {said}
    </ReadoutTip>
  );
}

export function ComposerStats({
  totals,
  usage,
  show,
}: {
  totals: SessionTotals;
  usage: UsageInfo | null;
  /** The per-read-out preferences — each member gated on its own. */
  show: Pick<PreferencesView, "statsToolCalls" | "statsContextGauge" | "statsPlanGauge" | "statsCost">;
}) {
  // The prompt count lives on the read-out strip's prompts chip — one
  // number, one surface.
  const counts: { icon: string; n: number; tip: string }[] = [
    ...(show.statsToolCalls
      ? [{ icon: "tools", n: totals.toolCalls, tip: `${count(totals.toolCalls, "tool call")} this session` }]
      : []),
  ].filter((c) => c.n > 0);
  // sessionUsage only ever gets an entry alongside marking "usage" used
  // (pool.ts's notification handler and this both fire off the same
  // usage_update), so presence here already means used — absent, never
  // grayed, until then. Same rule for the plan reading and the cost.
  const gauge = show.statsContextGauge !== "off" ? usage : null;
  const cost = show.statsCost ? (usage?.cost ?? null) : null;
  const plan = show.statsPlanGauge !== "off" && usage?.plan !== undefined && Object.keys(usage.plan).length > 0 ? usage.plan : null;
  // Nothing to show renders nothing — no empty box holding the send
  // button's air or a line of its own at narrow widths.
  if (counts.length === 0 && gauge === null && cost === null && plan === null) return null;
  return (
    // mr-6 ≈ one counter's width of air before the send button — the strip is
    // a read-out, the button is a control; they must not read as one cluster.
    // Icon size rides the chrome policy (theme.css). Each read-out stays
    // whole; a strip wider than its room wraps between them.
    <span className="composer-stats mr-6 flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
      {counts.map((c) => (
        <span key={c.icon} className="flex items-center gap-0.5 whitespace-nowrap" title={c.tip}>
          <Icon name={c.icon} /> {c.n}
        </span>
      ))}
      {gauge !== null && <Gauge usage={gauge} details={show.statsContextGauge === "details"} />}
      {cost !== null && <Cost cost={cost} />}
      {plan !== null && <PlanGauge plan={plan} details={show.statsPlanGauge === "details"} />}
    </span>
  );
}
