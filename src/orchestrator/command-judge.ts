// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The command rules applied to what a line runs (shell-reading.ts). Each
// command is judged on its own, by the workspace layer first — its answer
// wins wherever it has one — then the machine's, then by the policy's
// answer for a command no rule decides: ask, unless the user chose allow or
// deny. Within a layer, list order decides nothing: of the rules that
// match, deny beats ask beats allow. The line takes the most severe verdict
// of its commands; a part whose commands can't be seen is something no
// rule decided, and so is a line that runs nothing — each gets the same
// answer. Always-allow sets all of it aside: every line is allowed, no
// rule consulted.
import { unruledVerdict } from "../shared/command-rules";
import {
  DEFAULT_COMMAND_POLICY,
  RULE_VERDICTS,
  type CommandJudgementView,
  type CommandPolicyView,
  type CommandVerdictView,
  type RuleMatchView,
} from "../shared/protocol";
import type { CommandRule, RuleVerdict } from "./stores/permission-rules";
import { programName, type ReadCommand, type ShellReading } from "./shell-reading";

export interface RuleLayers {
  workspace: readonly CommandRule[];
  machine: readonly CommandRule[];
}

/** How severe a verdict is: the later in the winning order, the milder. */
const severity = (verdict: RuleVerdict): number => RULE_VERDICTS.length - RULE_VERDICTS.indexOf(verdict);

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "s");
}

/** Whether `rule` bears on `command`: a command pattern over its whole
 * text; a word over each of its words — the program by its own name too,
 * so `/usr/bin/sudo` holds `sudo`. */
function ruleMatches(rule: CommandRule, command: ReadCommand): boolean {
  const glob = globToRegExp(rule.pattern);
  if (rule.kind === "command") return glob.test(command.text);
  const [program, ...args] = command.words;
  return (program !== undefined && (glob.test(program) || glob.test(programName(program)))) || args.some((w) => glob.test(w));
}

function judgeCommand(command: ReadCommand, layers: RuleLayers, unruled: RuleVerdict): CommandVerdictView {
  const matched = (layer: "workspace" | "machine"): RuleMatchView[] =>
    layers[layer].filter((rule) => ruleMatches(rule, command)).map((rule) => ({ rule, layer }));
  const all = [...matched("workspace"), ...matched("machine")];
  const deciding = all.filter((m) => m.layer === all[0]?.layer);
  if (deciding.length === 0) return { text: command.text, verdict: unruled, by: null, also: [] };
  const by = deciding.reduce((a, b) => (severity(b.rule.verdict) > severity(a.rule.verdict) ? b : a));
  return { text: command.text, verdict: by.rule.verdict, by, also: all.filter((m) => m !== by) };
}

export function judgeCommands(reading: ShellReading, layers: RuleLayers, policy: CommandPolicyView = DEFAULT_COMMAND_POLICY): CommandJudgementView {
  const unruled = unruledVerdict(policy);
  if (policy.alwaysAllow) {
    const commands = reading.commands.map((c) => ({ text: c.text, verdict: unruled, by: null, also: [] }));
    return { verdict: unruled, commands, unreadable: reading.unreadable, policy };
  }
  const commands = reading.commands.map((c) => judgeCommand(c, layers, unruled));
  // what no rule could decide: a part that can't be seen, a line that runs nothing
  const undecided = reading.unreadable.length > 0 || commands.length === 0 ? [unruled] : [];
  const verdict = [...commands.map((c) => c.verdict), ...undecided].reduce<RuleVerdict>((v, c) => (severity(c) > severity(v) ? c : v), "allow");
  return { verdict, commands, unreadable: reading.unreadable, policy };
}
