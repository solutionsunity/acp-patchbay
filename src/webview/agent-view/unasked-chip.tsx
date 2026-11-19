// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Shown in the header only while commands run without anyone being asked.
// With always-allow on, a click turns it off, at every layer it is on;
// with only "a command no rule decides is allowed", there is no one switch
// to flip back — a click opens the page that holds the choice.
import type { CommandPolicyView } from "../../shared/protocol";
import { unaskedChip } from "./unasked";
import { Icon } from "../shared/icon";
import { Button } from "@/components/ui/button";

export function UnaskedChip(props: { policy: CommandPolicyView; onStop(): void; onOpen(): void }) {
  const chip = unaskedChip(props.policy);
  if (chip === null) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 gap-1 px-1.5 text-[11px] text-warn"
      title={chip.title}
      aria-label={chip.title}
      data-unasked={chip.click}
      onClick={chip.click === "stopAlwaysAllow" ? props.onStop : props.onOpen}
    >
      <Icon name="unlock" /> unasked
    </Button>
  );
}
