// Top bar: current-session agent indicator, errors chip, usage gauge,
// session/new buttons. The agent chip is a read-out, not a picker — agent
// choice happens where it matters, in the new-chat flow; Settings lives in
// the native view title bar (package.json view/title), not here.
import type { AgentStatus, AgentSummary, UsageInfo } from "../../shared/protocol";
import { ErrorsChip } from "../shared/errors-chip";
import { Icon } from "../shared/icon";
import { Button } from "@/components/ui/button";

export function Dot({ status }: { status: AgentStatus | "none" }) {
  return <span className={`dot ${status === "none" ? "stopped" : status}`} />;
}

function UsageGauge({ usage }: { usage: UsageInfo }) {
  const frac = Math.max(0, Math.min(1, usage.used / usage.size));
  const circumference = 62.8;
  const tip = `${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens${
    usage.cost !== undefined ? ` · ${usage.cost.amount.toFixed(2)} ${usage.cost.currency}` : ""
  }`;
  return (
    <div className="gauge" title={tip}>
      <svg width="26" height="26" viewBox="0 0 26 26">
        <circle cx="13" cy="13" r="10" fill="none" stroke="var(--pb-border)" stroke-width="3" />
        <circle
          cx="13"
          cy="13"
          r="10"
          fill="none"
          stroke="var(--pb-consumed)"
          stroke-width="3"
          stroke-linecap="round"
          stroke-dasharray={`${(frac * circumference).toFixed(1)} ${circumference}`}
        />
      </svg>
      <div className="tip">{tip}</div>
    </div>
  );
}

export function Header(props: {
  agent: AgentSummary | null;
  usage: UsageInfo | null;
  onSessions(): void;
  onNew(): void;
}) {
  return (
    <div className="hdr">
      {props.agent !== null && (
        <div className="agent-chip" title="Current session's agent">
          <Dot status={props.agent.status} />
          <span className="name">{props.agent.name}</span>
        </div>
      )}
      <div className="spacer" />
      {/* sessionUsage only ever gets an entry alongside marking "usage"
          used (pool.ts's notification handler and this both fire off the
          same usage_update), so presence here already means used — absent,
          never grayed, until then. */}
      <ErrorsChip />
      {props.usage !== null && <UsageGauge usage={props.usage} />}
      <Button variant="ghost" size="icon" className="h-6 w-6" title="Sessions" aria-label="Sessions" onClick={props.onSessions}>
        <Icon name="history" />
      </Button>
      <Button variant="ghost" size="icon" className="h-6 w-6" title="New session" aria-label="New session" onClick={props.onNew}>
        <Icon name="add" />
      </Button>
    </div>
  );
}
