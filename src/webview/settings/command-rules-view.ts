// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What the Commands page derives from a layer's rules: the order they show
// in, how many of each there are, and the ones a filter shows.
import { appliesTo, everyAgent, scopeOf } from "../../shared/agent-scope";
import type { PatchbayAgentId } from "../../shared/ids";
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

/** Which rules a card shows: those whose pattern holds `text`, and — by
 * agent — every rule, the ones for every agent alone, or the ones one
 * agent is judged by. */
export interface RuleFilter {
  text: string;
  agent: "all" | "every" | PatchbayAgentId;
}

export const NO_FILTER: RuleFilter = { text: "", agent: "all" };

export function filtering(filter: RuleFilter): boolean {
  return filter.text.trim() !== "" || filter.agent !== "all";
}

/** The rules the filter shows. "The ones an agent is judged by" is read as
 * the judge reads it — a rule for every agent is one of them. */
export function filteredRules(rules: readonly CommandRuleView[], filter: RuleFilter): CommandRuleView[] {
  const text = filter.text.trim().toLowerCase();
  const { agent } = filter;
  return rules.filter(
    (r) =>
      (text === "" || r.pattern.toLowerCase().includes(text)) &&
      (agent === "all" || (agent === "every" ? everyAgent(scopeOf(r)) : appliesTo(r, agent))),
  );
}
