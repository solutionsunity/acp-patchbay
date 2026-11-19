// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What the Commands page says about the two choices that stand around the
// rules — the always-allow switch, and what a command no rule decides gets
// — and what it asks before a change that lets commands run unasked.
import { ALWAYS_ALLOW_COMMANDS } from "../../shared/command-rules";
import type { CommandPolicyLayersView, RuleVerdictView } from "../../shared/protocol";

export type PolicyLayer = "workspace" | "machine";

/** Where a layer's choice reaches. */
export const LAYER_REACH: Readonly<Record<PolicyLayer, string>> = {
  workspace: "this workspace",
  machine: "every workspace on this machine",
};

/** What each answer for a command no rule decides means, in a few words. */
export const UNRULED_MEANS: Readonly<Record<RuleVerdictView, string>> = {
  ask: "asks, as a card",
  allow: "runs without asking",
  deny: "is refused without asking",
};

/** A change that lets commands run without asking, and what it must say
 * before it is made — null for a change that doesn't. */
export function policyWarning(
  change: { kind: "alwaysAllow"; on: boolean } | { kind: "unruled"; verdict: RuleVerdictView | null },
  layer: PolicyLayer,
): { title: string; body: string; confirm: string } | null {
  if (change.kind === "alwaysAllow") {
    if (!change.on) return null;
    return {
      title: `Turn on "${ALWAYS_ALLOW_COMMANDS}"?`,
      body: `Every terminal command an agent runs through Patchbay then runs without asking, with your privileges, in ${LAYER_REACH[layer]}. Your command rules are set aside while it is on, deny rules included. File writes and an agent's other requests still ask as they do now.`,
      confirm: "Turn on",
    };
  }
  if (change.verdict !== "allow") return null;
  return {
    title: "Allow commands no rule decides?",
    body: `A terminal command no rule decides then runs without asking, with your privileges, in ${LAYER_REACH[layer]}. Your rules still apply first — but a deny rule stops only what Patchbay can read: a command inside a part it can't read (a command substitution, eval, a script for a shell it doesn't read) runs.`,
    confirm: "Allow",
  };
}

/** How the choices come out here, in one line. */
export function policySummary(policy: CommandPolicyLayersView): string {
  const { effective, workspace } = policy;
  if (effective.alwaysAllow) return `Here: every command runs without asking — "${ALWAYS_ALLOW_COMMANDS}" is on.`;
  const from = workspace.unruled === null ? "this machine's choice" : "this workspace's choice";
  return `Here: a command no rule decides ${UNRULED_MEANS[effective.unruled]} (${from}).`;
}
