// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Top bar: current-session agent indicator, the other sessions' attention
// read-out (passed in as children), errors chip, session/new buttons. The
// agent chip is a read-out, not a picker — agent choice happens where it
// matters, in the new-chat flow; beside its name, the version chip — the
// upgrade itself while the agent has a newer version. Settings lives in the
// native view title bar (package.json view/title), not here. The usage
// gauge lives in the composer's stats strip (composer/stats.tsx).
import type { ReactNode } from "react";
import type { AgentSummary } from "../../shared/protocol";
import { versionChip } from "../shared/agent-work";
import { Dot } from "../shared/dot";
import { ErrorsChip } from "../shared/errors-chip";
import { Icon } from "../shared/icon";
import { VersionChip } from "../shared/version-chip";
import { Button } from "@/components/ui/button";

export function Header(props: {
  agent: AgentSummary | null;
  onUpgrade(): void;
  onSessions(): void;
  onNew(): void;
  children?: ReactNode;
}) {
  const chip = versionChip(props.agent ?? undefined);
  return (
    <div className="hdr">
      {props.agent !== null && (
        <div className="agent-chip" title="Current session's agent">
          <Dot status={props.agent.status} />
          <span className="name">{props.agent.name}</span>
          {chip !== null && <VersionChip agentName={props.agent.name} chip={chip} onUpgrade={props.onUpgrade} />}
        </div>
      )}
      {/* two spacers center the read-out in the free space — where the eye
          finds it when it appears, not tucked among the buttons */}
      <div className="spacer" />
      {props.children}
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
