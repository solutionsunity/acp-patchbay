// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// An agent's newer version, as the one control that installs it — the same
// chip beside the agent's name in the Agent View header and on its Settings
// card. The indicator is the action: nothing to hunt for elsewhere.
import type { AgentUpdate } from "../../shared/protocol";
import { Icon } from "./icon";

export function UpgradeChip(props: { agentName: string; update: AgentUpdate; onUpgrade(): void }) {
  const { agentName, update } = props;
  return (
    <button
      type="button"
      className="flex flex-none cursor-pointer items-center gap-1 rounded-full border border-warn/40 px-1.5 text-[11px] text-warn hover:bg-muted"
      title={`Upgrade ${agentName} to ${update.to} — you run ${update.from}`}
      aria-label={`Upgrade ${agentName} to ${update.to}`}
      onClick={props.onUpgrade}
    >
      <Icon name="arrow-circle-up" /> {update.to}
    </button>
  );
}
