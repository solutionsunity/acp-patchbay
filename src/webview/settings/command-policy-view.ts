// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What the Commands page says about the two choices that stand around the
// rules — the always-allow switch, and what a command no rule decides gets
// — and what it asks before a change that lets commands run unasked.
import { ALWAYS_ALLOW_COMMANDS } from "../../shared/command-rules";
import { effectiveCommandPolicy, type CommandPolicyLayersView, type RuleVerdictView } from "../../shared/protocol";

export type PolicyLayer = "workspace" | "machine";

/** Where a layer's choice reaches. */
export const LAYER_REACH: Readonly<Record<PolicyLayer, string>> = {
  workspace: "this workspace",
  machine: "every workspace on this machine",
};

/** What the switch means, at each layer — said behind its info mark. */
export const ALWAYS_ALLOW_HELP: Readonly<Record<PolicyLayer, string>> = {
  workspace: `On: every terminal command an agent runs through Patchbay runs without asking, in ${LAYER_REACH.workspace}. The rules, and the choice beside this, are kept and not applied. On here or for the machine, it is on here.`,
  machine: `On: every terminal command an agent runs through Patchbay runs without asking, in ${LAYER_REACH.machine}. The rules, and the choice beside this, are kept and not applied.`,
};

const UNRULED = "What a command gets when no rule decides it — and a part of a line that can't be read, which no rule can decide. Rules apply first. Allow with deny rules is a blacklist; deny with allow rules is a whitelist.";

/** What the choice means, at each layer — said behind its info mark. */
export const UNRULED_HELP: Readonly<Record<PolicyLayer, string>> = {
  workspace: `${UNRULED} This workspace's answer stands over this machine's; "as this machine" leaves it to the machine.`,
  machine: `${UNRULED} A workspace may answer for itself.`,
};

/** What each answer for a command no rule decides means, in a few words. */
export const UNRULED_MEANS: Readonly<Record<RuleVerdictView, string>> = {
  ask: "asks, as a card",
  allow: "runs without asking",
  deny: "is refused without asking",
};

/** A change that lets commands run without asking, and what it must say
 * before it is made — null for a change that doesn't. What a change does
 * is read off how the layers come out after it, not off the value picked:
 * a workspace handing its choice back to a machine that allows lets
 * commands run as surely as picking allow does. A change that leaves
 * commands running as they already were has nothing new to say. */
export function policyWarning(
  change: { kind: "alwaysAllow"; on: boolean } | { kind: "unruled"; verdict: RuleVerdictView | null },
  layer: PolicyLayer,
  policy: CommandPolicyLayersView,
): { title: string; body: string; confirm: string } | null {
  if (change.kind === "alwaysAllow") {
    if (!change.on) return null;
    return {
      title: `Turn on "${ALWAYS_ALLOW_COMMANDS}"?`,
      body: `Every terminal command an agent runs through Patchbay then runs without asking, with your privileges, in ${LAYER_REACH[layer]}. Your command rules are set aside while it is on, deny rules included. File writes and an agent's other requests still ask as they do now.`,
      confirm: "Turn on",
    };
  }
  // A machine's allow reaches every workspace that follows it, whatever
  // this one answers for itself; a workspace's choice is judged by how
  // this workspace comes out.
  const lets =
    layer === "machine"
      ? change.verdict === "allow" && policy.machine.unruled !== "allow"
      : effectiveCommandPolicy(policy.machine, { ...policy.workspace, unruled: change.verdict }).unruled === "allow" && policy.effective.unruled !== "allow";
  if (!lets) return null;
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
