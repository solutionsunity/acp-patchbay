// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// An agent's newer version, as the one control that installs it — the same
// chip beside the agent's name in the Agent View header and on its Settings
// card. The indicator is the action: nothing to hunt for elsewhere. While
// the upgrade runs, the chip says so and takes no click.
import type { UpgradeOffer } from "./agent-work";
import { Icon } from "./icon";

const CHIP =
  "flex flex-none cursor-pointer items-center gap-1 rounded-full border border-warn/40 px-1.5 text-[11px] text-warn hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent";

export function UpgradeChip(props: { agentName: string; offer: UpgradeOffer; onUpgrade(): void }) {
  const { agentName, offer } = props;
  if (offer.upgrading) {
    const text = offer.to !== undefined ? `upgrading to ${offer.to}…` : "upgrading…";
    return (
      <button type="button" className={CHIP} title={`${agentName}: ${text}`} aria-label={`${agentName} ${text}`} disabled>
        <Icon name="loading" spin /> {text}
      </button>
    );
  }
  return (
    <button
      type="button"
      className={CHIP}
      title={`Upgrade ${agentName} to ${offer.to} — you run ${offer.from}`}
      aria-label={`Upgrade ${agentName} to ${offer.to}`}
      onClick={props.onUpgrade}
    >
      <Icon name="arrow-circle-up" /> {offer.to}
    </button>
  );
}
