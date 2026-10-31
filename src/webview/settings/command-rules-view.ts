// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What the Commands page derives from a layer's rules: the order they show
// in, and how many of each there are.
import { RULE_VERDICTS, type CommandRuleView } from "../../shared/protocol";

type Verdict = CommandRuleView["verdict"];
type Kind = CommandRuleView["kind"];

const VERDICTS: readonly Verdict[] = RULE_VERDICTS;
const KINDS: readonly Kind[] = ["command", "word"];

/** Deny first, then ask, then allow — the order verdicts win in, since the
 * order rules were added in decides nothing — and by pattern within each. */
export function sortedRules(rules: readonly CommandRuleView[]): CommandRuleView[] {
  return [...rules].sort(
    (a, b) => VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict) || a.pattern.localeCompare(b.pattern) || a.kind.localeCompare(b.kind),
  );
}

export interface RuleCounts {
  /** Each kind's count per verdict, and its total. */
  byKind: Record<Kind, Record<Verdict | "total", number>>;
  /** Every kind's together. */
  total: Record<Verdict | "total", number>;
}

export function ruleCounts(rules: readonly CommandRuleView[]): RuleCounts {
  const zero = (): Record<Verdict | "total", number> => ({ deny: 0, ask: 0, allow: 0, total: 0 });
  const byKind = Object.fromEntries(KINDS.map((k) => [k, zero()])) as RuleCounts["byKind"];
  const total = zero();
  for (const rule of rules) {
    for (const row of [byKind[rule.kind], total]) {
      row[rule.verdict]++;
      row.total++;
    }
  }
  return { byKind, total };
}
