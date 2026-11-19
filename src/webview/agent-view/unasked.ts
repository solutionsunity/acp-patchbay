// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The header's mark that commands run without anyone being asked: what it
// says, and what its click does.
import { ALWAYS_ALLOW_COMMANDS, WHEN_NO_RULE_DECIDES } from "../../shared/command-rules";
import { commandsRunUnasked, type CommandPolicyView } from "../../shared/protocol";

/** What the chip says of `policy`, and what its click does — null while
 * every command no rule allows still asks or is refused. */
export function unaskedChip(policy: CommandPolicyView): { title: string; click: "stopAlwaysAllow" | "openCommands" } | null {
  if (!commandsRunUnasked(policy)) return null;
  return policy.alwaysAllow
    ? { title: `"${ALWAYS_ALLOW_COMMANDS}" is on: every command runs without asking — click to turn it off`, click: "stopAlwaysAllow" }
    : { title: `"${WHEN_NO_RULE_DECIDES}" is allow: commands no rule decides run without asking — click to change it`, click: "openCommands" };
}
