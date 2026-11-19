// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The two choices that stand around the command rules, one row in each
// layer's rules card: the switch that allows every command, and what a
// command no rule decides gets. What each means sits behind its info mark.
// A change that lets commands run unasked says what it means first, and is
// made only on a second, explicit click.
import { useState } from "react";
import { RULE_VERDICTS, type CommandPolicyLayersView, type RuleVerdictView } from "../../shared/protocol";
import { ALWAYS_ALLOW_COMMANDS, WHEN_NO_RULE_DECIDES } from "../../shared/command-rules";
import { ALWAYS_ALLOW_HELP, policyWarning, UNRULED_HELP, UNRULED_MEANS, type PolicyLayer } from "./command-policy-view";
import { Icon } from "../shared/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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

/** What a control means, behind a mark beside it — reached by the pointer
 * and by the keyboard alike. */
function Info({ about, text }: { about: string; text: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="inline-flex opacity-60 hover:opacity-100 focus-visible:opacity-100" aria-label={`About "${about}"`}>
            <Icon name="info" size={14} />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-80">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** One layer's two choices, in that layer's rules card. While every
 * command is allowed — by either layer's switch — the choice for a command
 * no rule decides is kept and not to be worked on; the switch always is. */
export function PolicyRow(props: {
  layer: PolicyLayer;
  policy: CommandPolicyLayersView;
  onAlwaysAllow(layer: PolicyLayer, on: boolean): void;
  onUnruled(layer: PolicyLayer, verdict: RuleVerdictView | null): void;
}) {
  const { layer, policy } = props;
  // The change waiting on its second click, and what it said.
  const [asking, setAsking] = useState<{ change: Change; warning: NonNullable<ReturnType<typeof policyWarning>> } | null>(null);
  const make = (change: Change) => {
    if (change.kind === "alwaysAllow") props.onAlwaysAllow(layer, change.on);
    else props.onUnruled(layer, change.verdict);
  };
  const ask = (change: Change) => {
    const warning = policyWarning(change, layer, policy);
    if (warning === null) make(change);
    else setAsking({ change, warning });
  };
  const muted = policy.effective.alwaysAllow;
  const where = layer === "workspace" ? "this workspace" : "this machine";

  return (
    <div className="row mb-2 flex-wrap items-center gap-x-4" data-command-policy={layer}>
      <span className="inline-flex items-center gap-1.5">
        <Toggle checked={policy[layer].alwaysAllow} label={ALWAYS_ALLOW_COMMANDS} onChange={(on) => ask({ kind: "alwaysAllow", on })} />
        <Info about={ALWAYS_ALLOW_COMMANDS} text={ALWAYS_ALLOW_HELP[layer]} />
      </span>
      <span className={`inline-flex items-center gap-1.5 text-[12px]${muted ? " opacity-50" : ""}`} inert={muted} data-unruled>
        {WHEN_NO_RULE_DECIDES}
        <Select
          value={(layer === "workspace" ? policy.workspace.unruled : policy.machine.unruled) ?? AS_MACHINE}
          onValueChange={(v) => ask({ kind: "unruled", verdict: v === AS_MACHINE ? null : (v as RuleVerdictView) })}
        >
          <SelectTrigger aria-label={`${WHEN_NO_RULE_DECIDES} — ${where}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {layer === "workspace" && <SelectItem value={AS_MACHINE}>as this machine ({policy.machine.unruled})</SelectItem>}
            {RULE_VERDICTS.map((v) => (
              <SelectItem key={v} value={v}>
                {v} — {UNRULED_MEANS[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Info about={WHEN_NO_RULE_DECIDES} text={UNRULED_HELP[layer]} />
      </span>

      <AlertDialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{asking?.warning.title}</AlertDialogTitle>
            <AlertDialogDescription>{asking?.warning.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => asking !== null && make(asking.change)}>{asking?.warning.confirm}</AlertDialogAction>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
