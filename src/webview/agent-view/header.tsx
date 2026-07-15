// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Top bar: current-session agent indicator, errors chip, session/new
// buttons. The agent chip is a read-out, not a picker — agent choice
// happens where it matters, in the new-chat flow; Settings lives in the
// native view title bar (package.json view/title), not here. The usage
// gauge lives in the composer's stats strip (composer/stats.tsx).
import type { AgentStatus, AgentSummary } from "../../shared/protocol";
import { ErrorsChip } from "../shared/errors-chip";
import { Icon } from "../shared/icon";
import { Button } from "@/components/ui/button";

export function Dot({ status }: { status: AgentStatus | "none" }) {
  return <span className={`dot ${status === "none" ? "stopped" : status}`} />;
}

export function Header(props: {
  agent: AgentSummary | null;
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
      <ErrorsChip />
      <Button variant="ghost" size="icon" className="h-6 w-6" title="Sessions" aria-label="Sessions" onClick={props.onSessions}>
        <Icon name="history" />
      </Button>
      <Button variant="ghost" size="icon" className="h-6 w-6" title="New session" aria-label="New session" onClick={props.onNew}>
        <Icon name="add" />
      </Button>
    </div>
  );
}
