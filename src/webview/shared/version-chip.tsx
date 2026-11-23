// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// An agent's version, as one chip beside its name in the Agent View header
// and on its Settings card — the pinned version for a registry agent, the
// reported one otherwise, both in its tooltip. While the registry has a
// newer version, the same chip is the upgrade: the indicator is the action,
// nothing to hunt for elsewhere. While a move of its version runs, the chip
// says so and takes no click.
import type { VersionChip as VersionChipState } from "./agent-work";
import { Icon } from "./icon";

// a version may run long ("0.36.0 (commit 7c61e5bb)"): every chip is capped —
// and never wider than its row — its text cut short, whole in the tooltip
const CHIP = "max-w-[min(10rem,100%)] flex-none rounded-full border px-1.5 text-[11px]";
const TEXT = "min-w-0 truncate";
const ACTION = `${CHIP} flex cursor-pointer items-center gap-1 border-warn/40 text-warn hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent`;

export function VersionChip(props: { agentName: string; chip: VersionChipState; onUpgrade(): void }) {
  const { agentName, chip } = props;
  switch (chip.kind) {
    case "moving":
      return (
        <button type="button" className={ACTION} title={`${agentName}: ${chip.text}`} aria-label={`${agentName} ${chip.text}`} disabled>
          <Icon name="loading" spin /> <span className={TEXT}>{chip.text}</span>
        </button>
      );
    case "update":
      return (
        <button type="button" className={ACTION} title={chip.title} aria-label={`Upgrade ${agentName} to ${chip.to}`} onClick={props.onUpgrade}>
          <Icon name="arrow-circle-up" />
          <span className={TEXT}>
            {chip.from} → {chip.to}
          </span>
        </button>
      );
    case "version":
      return (
        <span className={`${CHIP} truncate border-border text-muted-foreground`} title={chip.title}>
          {chip.shown}
        </span>
      );
  }
}
