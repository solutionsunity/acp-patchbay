// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// How a command rule reads wherever one is named — a card saying which
// rule decided, the Commands page's tester.
import type { CommandPolicyView, CommandRuleView, RuleMatchView, RuleVerdictView } from "./protocol";

/** The switch and the choice as every surface names them. */
export const ALWAYS_ALLOW_COMMANDS = "Always allow commands";
export const WHEN_NO_RULE_DECIDES = "When no rule decides";

/** What a command no rule decided got, under `policy`. */
export function unruledVerdict(policy: CommandPolicyView): RuleVerdictView {
  return policy.alwaysAllow ? "allow" : policy.unruled;
}

/** Why a command no rule decided got what it got. */
export function unruledWhy(policy: CommandPolicyView): string {
  if (policy.alwaysAllow) return `"${ALWAYS_ALLOW_COMMANDS}" is on`;
  if (policy.unruled === "ask") return "no rule matched";
  return `no rule matched — "${WHEN_NO_RULE_DECIDES}" is ${policy.unruled}`;
}

/** `npm run *` for a command rule, `word sudo` for a word. */
export function ruleLabel(rule: Pick<CommandRuleView, "kind" | "pattern">): string {
  return rule.kind === "word" ? `word ${rule.pattern}` : rule.pattern;
}

/** A rule with its layer: `word sudo (machine)`. */
export function matchLabel(match: RuleMatchView): string {
  return `${ruleLabel(match.rule)} (${match.layer})`;
}
