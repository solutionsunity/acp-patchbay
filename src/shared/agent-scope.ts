// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Which agents a command rule or a file-write place applies to: a reach
// over the agents (reach.ts), every agent where the rule names none — as
// every rule stored before rules could name agents does. An agent a rule
// doesn't apply to never meets it: for that agent the rule isn't in its
// layer, and the next layer, then the default, answers. Read on both
// sides of the webview boundary: the broker judges with it, Settings
// filters and labels with it — one reading, so what the page shows as an
// agent's rules is what that agent is judged by.
import type { PatchbayAgentId } from "./ids";
import { forget, namedIn, reaches, type Reach } from "./reach";

export type AgentScope = Reach<PatchbayAgentId>;

/** What carries a scope: a rule, a place's answer. */
export interface AgentScoped {
  agents?: AgentScope;
}

export function scopeOf(scoped: AgentScoped): AgentScope {
  return scoped.agents ?? "auto";
}

/** Whether the scope leaves no agent out: every agent, said outright or by
 * an exception list with nothing on it — where the scope control stands
 * between choosing "all except" and ticking the first one. */
export function everyAgent(scope: AgentScope): boolean {
  return scope === "auto" || (!Array.isArray(scope) && namedIn(scope).length === 0);
}

/** Whether it applies to the agent. Null is an agent no scope names — one
 * added later, or the tester's "any other agent". */
export function appliesTo(scoped: AgentScoped, agent: PatchbayAgentId | null): boolean {
  return reaches(scopeOf(scoped), agent);
}

/** `scoped` under `scope`: every agent is said by naming none, so a rule
 * for every agent stays as it always was stored. */
export function withScope<T extends AgentScoped>(scoped: T, scope: AgentScope): T {
  const { agents: _agents, ...rest } = scoped;
  return (scope === "auto" ? rest : { ...rest, agents: scope }) as T;
}

/** What is scoped, with a removed agent named nowhere. One that was for
 * that agent alone goes with it — null: a rule for nobody would only sit
 * in its list. One that only left it out is for every agent again. */
export function withoutAgent<T extends AgentScoped>(scoped: T, agent: PatchbayAgentId): T | null {
  const scope = scopeOf(scoped);
  if (!namedIn(scope).includes(agent)) return scoped;
  const left = forget(scope, agent);
  if (namedIn(left).length > 0) return withScope(scoped, left);
  return Array.isArray(left) ? null : withScope(scoped, "auto");
}

/** A scope in a few words: "only <names>", "all except <names>" — null
 * for every agent, which is said by saying nothing. An agent since removed
 * is no longer named. */
export function scopeLabel(scope: AgentScope, nameOf: (id: PatchbayAgentId) => string | undefined): string | null {
  if (everyAgent(scope)) return null;
  const names = namedIn(scope).flatMap((id) => nameOf(id) ?? []);
  if (Array.isArray(scope)) return names.length === 0 ? "no agent" : `only ${names.join(", ")}`;
  return names.length === 0 ? null : `all except ${names.join(", ")}`;
}
