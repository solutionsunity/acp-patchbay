// The composer's session-stats strip (Preferences § composerStats): whole-
// session counts from the view-model's single pass, plus the context-window
// gauge (moved from the header, smaller). Pure read-out — counts render only
// when nonzero, the gauge only when the agent reports usage (absence over
// fake, ui.md § gauge); a fresh session shows nothing at all.
import type { UsageInfo } from "../../../shared/protocol";
import { Icon } from "../../shared/icon";
import { count, type SessionTotals } from "../chat/view-model";

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
}: {
  totals: SessionTotals;
  usage: UsageInfo | null;
}) {
  const counts: { icon: string; n: number; tip: string }[] = [
    { icon: "comment", n: totals.prompts, tip: `${count(totals.prompts, "prompt")} this session` },
    { icon: "tools", n: totals.toolCalls, tip: `${count(totals.toolCalls, "tool call")} this session` },
    { icon: "edit", n: totals.filesTouched, tip: `${count(totals.filesTouched, "file")} edited this session` },
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
      {/* sessionUsage only ever gets an entry alongside marking "usage"
          used (pool.ts's notification handler and this both fire off the
          same usage_update), so presence here already means used — absent,
          never grayed, until then. */}
      {usage !== null && <Gauge usage={usage} />}
    </span>
  );
}
