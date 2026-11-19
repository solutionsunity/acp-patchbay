// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The two choices that stand around the command rules, each at both
// layers, each where it sits in the order a command is judged: the switch
// that allows every command, ahead of the rules it sets aside; and what a
// command no rule decides gets, after them. A change that lets commands
// run unasked says what it means first, and is made only on a second,
// explicit click.
import { useState } from "react";
import { RULE_VERDICTS, type CommandPolicyLayersView, type RuleVerdictView } from "../../shared/protocol";
import { ALWAYS_ALLOW_COMMANDS, WHEN_NO_RULE_DECIDES } from "../../shared/command-rules";
import { policySummary, policyWarning, UNRULED_MEANS, type PolicyLayer } from "./command-policy-view";
import { Toggle } from "./controls";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Change = Parameters<typeof policyWarning>[0];

/** A workspace's "as the machine has it", as its select spells it. */
const AS_MACHINE = "machine";

interface Props {
  policy: CommandPolicyLayersView;
  onAlwaysAllow(layer: PolicyLayer, on: boolean): void;
  onUnruled(layer: PolicyLayer, verdict: RuleVerdictView | null): void;
}

/** A change made at once, or — one that lets commands run unasked — held
 * for its second click, with the dialog that asks for it. */
function useAsked(props: Props) {
  const [asking, setAsking] = useState<{ change: Change; layer: PolicyLayer; warning: NonNullable<ReturnType<typeof policyWarning>> } | null>(null);
  const make = (change: Change, layer: PolicyLayer) => {
    if (change.kind === "alwaysAllow") props.onAlwaysAllow(layer, change.on);
    else props.onUnruled(layer, change.verdict);
  };
  const ask = (change: Change, layer: PolicyLayer) => {
    const warning = policyWarning(change, layer);
    if (warning === null) make(change, layer);
    else setAsking({ change, layer, warning });
  };
  const dialog = (
    <AlertDialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{asking?.warning.title}</AlertDialogTitle>
          <AlertDialogDescription>{asking?.warning.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => asking !== null && make(asking.change, asking.layer)}>{asking?.warning.confirm}</AlertDialogAction>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { ask, dialog };
}

/** Ahead of the rules: every command allowed, the rules and the choice
 * after them kept and not applied. */
export function AlwaysAllowCard(props: Props) {
  const { policy } = props;
  const { ask, dialog } = useAsked(props);
  return (
    <div className="card" data-always-allow>
      <div className="row flex-wrap items-center">
        <h2 className="m-0 mr-auto">{ALWAYS_ALLOW_COMMANDS}</h2>
        {(["workspace", "machine"] as const).map((layer) => (
          <Toggle
            key={layer}
            checked={policy[layer].alwaysAllow}
            label={layer === "workspace" ? "This workspace" : "This machine — every workspace"}
            onChange={(on) => ask({ kind: "alwaysAllow", on }, layer)}
          />
        ))}
      </div>
      <div className="note mx-0 mb-0 mt-1">
        On: every command runs without asking — the rules below, and the choice after them, kept and not applied.
      </div>
      {dialog}
    </div>
  );
}

/** After the rules: what a command gets when none of them decides it. */
export function UnruledCard(props: Props) {
  const { policy } = props;
  const { ask, dialog } = useAsked(props);
  const muted = policy.effective.alwaysAllow;
  const choices = RULE_VERDICTS.map((v) => (
    <SelectItem key={v} value={v}>
      {v} — {UNRULED_MEANS[v]}
    </SelectItem>
  ));
  return (
    <div className="card" data-unruled>
      <h2 className="mt-0">{WHEN_NO_RULE_DECIDES}</h2>
      <div className={muted ? "opacity-50" : undefined} inert={muted} data-unruled-choices>
        <div className="note mx-0 mt-0 mb-2">
          What a command gets when no rule above decides it — and a part of a line that can&apos;t be
          read, which no rule can decide. Allow with deny rules is a blacklist; deny with allow rules
          is a whitelist.
        </div>
        <div className="row">
          <label className="flex items-center gap-1.5 text-[12px]">
            This workspace
            <Select
              value={policy.workspace.unruled ?? AS_MACHINE}
              onValueChange={(v) => ask({ kind: "unruled", verdict: v === AS_MACHINE ? null : (v as RuleVerdictView) }, "workspace")}
            >
              <SelectTrigger aria-label={`${WHEN_NO_RULE_DECIDES} — this workspace`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AS_MACHINE}>as this machine ({policy.machine.unruled})</SelectItem>
                {choices}
              </SelectContent>
            </Select>
          </label>
          <label className="flex items-center gap-1.5 text-[12px]">
            This machine
            <Select value={policy.machine.unruled} onValueChange={(v) => ask({ kind: "unruled", verdict: v as RuleVerdictView }, "machine")}>
              <SelectTrigger aria-label={`${WHEN_NO_RULE_DECIDES} — this machine`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>{choices}</SelectContent>
            </Select>
          </label>
        </div>
      </div>
      <div className="mt-2 text-sm" data-policy-summary>
        {policySummary(policy)}
      </div>
      {dialog}
    </div>
  );
}
