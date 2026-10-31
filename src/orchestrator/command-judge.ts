// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The command rules applied to what a line runs (shell-reading.ts). Each
// command is judged on its own, by the workspace layer first — its answer
// wins wherever it has one — then the machine's, then it asks. Within a
// layer, list order decides nothing: of the rules that match, deny beats
// ask beats allow. The line takes the most severe verdict of its commands;
// a part whose commands can't be seen asks, and so does a line that runs
// nothing — never a silent allow.
import { RULE_VERDICTS, type CommandJudgementView, type CommandVerdictView, type RuleMatchView } from "../shared/protocol";
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

function judgeCommand(command: ReadCommand, layers: RuleLayers): CommandVerdictView {
  const matched = (layer: "workspace" | "machine"): RuleMatchView[] =>
    layers[layer].filter((rule) => ruleMatches(rule, command)).map((rule) => ({ rule, layer }));
  const all = [...matched("workspace"), ...matched("machine")];
  const deciding = all.filter((m) => m.layer === all[0]?.layer);
  if (deciding.length === 0) return { text: command.text, verdict: "ask", by: null, also: [] };
  const by = deciding.reduce((a, b) => (severity(b.rule.verdict) > severity(a.rule.verdict) ? b : a));
  return { text: command.text, verdict: by.rule.verdict, by, also: all.filter((m) => m !== by) };
}

export function judgeCommands(reading: ShellReading, layers: RuleLayers): CommandJudgementView {
  const commands = reading.commands.map((c) => judgeCommand(c, layers));
  const worst = commands.reduce<RuleVerdict>((v, c) => (severity(c.verdict) > severity(v) ? c.verdict : v), "allow");
  const verdict = worst === "deny" ? "deny" : reading.unreadable.length > 0 || commands.length === 0 ? "ask" : worst;
  return { verdict, commands, unreadable: reading.unreadable };
}
