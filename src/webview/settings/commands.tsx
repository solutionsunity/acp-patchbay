// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Commands (Trust): the rules that answer for terminal commands an agent
// runs through patchbay — two layers, this workspace's over the machine
// floor — and a tester that shows how they judge a line. Reviewing what
// happened lives on Audit; what's stored (and erasing it) on Data — one
// verb per page, one subject per rules page.
import { type ReactNode, useEffect, useState } from "react";
import { scopeOf, withScope, type AgentScope } from "../../shared/agent-scope";
import { ALWAYS_ALLOW_COMMANDS, matchLabel, ruleLabel, unruledVerdict, unruledWhy } from "../../shared/command-rules";
import type { PatchbayAgentId } from "../../shared/ids";
import { RULE_VERDICTS, type CommandJudgementView, type CommandRuleView, type RuleMatchView, type RuleVerdictView, type SettingsState, type TesterShell } from "../../shared/protocol";
import { AlwaysAllowCard, UnruledCard } from "./command-policy";
import { Icon } from "../shared/icon";
import { filteredRules, filtering, NO_FILTER, ruleCounts, sortedRules, type RuleFilter } from "./command-rules-view";
import { ScopeChip, ScopeChoice, scopeText } from "./rule-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Layer = RuleMatchView["layer"];
/** The rule being typed in an add row, at that card's layer. */
type Draft = RuleMatchView;

const EXAMPLE: Readonly<Record<CommandRuleView["kind"], string>> = { command: "kubectl get *", word: "sudo" };
const COLUMNS = [...RULE_VERDICTS, "total"] as const;

/** How many rules a layer holds, by kind and verdict. */
function RuleCountsGrid({ rules }: { rules: readonly CommandRuleView[] }) {
  const counts = ruleCounts(rules);
  const rows = [
    { label: "command", n: counts.byKind.command },
    { label: "word", n: counts.byKind.word },
    { label: "total", n: counts.total },
  ];
  return (
    <table className="mb-2 text-xs" data-rule-counts>
      <thead>
        <tr className="text-[var(--pb-text-faint)]">
          <th className="pr-4 text-left font-normal" />
          {COLUMNS.map((v) => (
            <th key={v} className="px-2 text-right font-normal">
              {v}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ label, n }) => (
          <tr key={label} className={label === "total" ? "font-semibold" : undefined}>
            <td className="pr-4">{label}</td>
            {COLUMNS.map((v) => (
              <td key={v} className="px-2 text-right tabular-nums">
                {label === "word" && v === "allow" ? "—" : n[v]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One command-rules card — instantiated per layer (workspace, machine) so
 * the two lists can't drift in presentation or behavior. What is typed in
 * its add row is the tester's draft. A long list is worked through its
 * filter: by pattern, and by agent — the rules one agent is judged by —
 * with the counts and the list following it, and the agents of every rule
 * it shows set at once. */
function CommandRulesCard(props: {
  title: string;
  note: string;
  rules: readonly CommandRuleView[];
  agents: SettingsState["agents"];
  emptyText: string;
  onAdd(rule: CommandRuleView): void;
  onRemove(rule: CommandRuleView): void;
  onScope(rules: readonly CommandRuleView[], scope: AgentScope): void;
  onDraft(rule: CommandRuleView | null): void;
}) {
  const [kind, setKind] = useState<CommandRuleView["kind"]>("command");
  const [pattern, setPattern] = useState("");
  const [verdict, setVerdict] = useState<CommandRuleView["verdict"]>("allow");
  const [scope, setScope] = useState<AgentScope>("auto");
  const [filter, setFilter] = useState<RuleFilter>(NO_FILTER);
  const [bulk, setBulk] = useState<AgentScope | null>(null);
  const trimmed = pattern.trim();
  // A word is one word, and never allows — the picker offers no allow.
  const typed: CommandRuleView | null =
    trimmed === "" || (kind === "word" && /\s/.test(trimmed))
      ? null
      : kind === "word"
        ? { kind, pattern: trimmed, verdict: verdict === "allow" ? "deny" : verdict }
        : { kind, pattern: trimmed, verdict };
  const rule = typed === null ? null : withScope(typed, scope);
  const { onDraft } = props;
  // Told once per change of the rule typed, not once per render.
  const draftKey = rule === null ? "" : `${rule.kind}:${rule.verdict}:${rule.pattern}:${JSON.stringify(scope)}`;
  useEffect(() => {
    onDraft(rule);
  }, [draftKey]);
  const shown = filteredRules(props.rules, filter);
  const narrowed = filtering(filter);

  return (
    <div className="card">
      <h2 className="mt-0">{props.title}</h2>
      <div className="note mx-0 mt-0 mb-2">{props.note}</div>
      {props.rules.length === 0 ? (
        <div className="note mx-0 mt-0 mb-2">{props.emptyText}</div>
      ) : (
        <>
          <div className="row mb-2" data-rule-filter>
            <Input
              type="text"
              className="flex-1"
              placeholder="Filter by pattern…"
              aria-label="Filter rules by pattern"
              value={filter.text}
              onInput={(e) => setFilter({ ...filter, text: (e.target as HTMLInputElement).value })}
            />
            {props.agents.length > 0 && (
              <Select value={filter.agent} onValueChange={(v) => setFilter({ ...filter, agent: v as RuleFilter["agent"] })}>
                <SelectTrigger aria-label="Filter rules by agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">all rules</SelectItem>
                  <SelectItem value="every">for every agent</SelectItem>
                  {props.agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      applies to {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {narrowed && (
            <div className="row mb-2 text-xs" data-rule-shown>
              <span className="flex-1 text-[var(--pb-text-faint)]">
                {shown.length} of {props.rules.length} rules shown
              </span>
              {shown.length > 0 && props.agents.length > 0 && (
                <ScopeChoice
                  agents={props.agents}
                  scope={bulk}
                  label={`Agents for these ${shown.length}…`}
                  title="Set which agents every rule shown applies to"
                  onChange={setBulk}
                  apply={{
                    label: bulk === null ? "Choose the agents" : `Apply to ${shown.length} ${shown.length === 1 ? "rule" : "rules"}: ${scopeText(bulk, props.agents)}`,
                    run: () => {
                      if (bulk !== null) props.onScope(shown, bulk);
                      setBulk(null);
                    },
                  }}
                />
              )}
            </div>
          )}
          <RuleCountsGrid rules={shown} />
        </>
      )}
      {/* A list grows with every "always" — hundreds of rules is real.
          Bounded at about seven rows and scrolled within, it never pushes the
          card after it, or its own add row, out of reach; the filter above
          it is how a long one is worked. */}
      <div className="max-h-[15rem] overflow-y-auto" data-rule-list>
        {sortedRules(shown).map((r) => (
          <div className="rule" key={`${r.kind}:${r.pattern}`}>
            <span className={`verdict ${r.verdict}`}>{r.verdict}</span>
            <span className="text-xs text-[var(--pb-text-faint)]">{r.kind}</span>
            <code>{r.pattern}</code>
            {props.agents.length > 0 && (
              <ScopeChip agents={props.agents} scope={scopeOf(r)} of={`rule ${ruleLabel(r)}`} quiet onChange={(next) => props.onScope([r], next)} />
            )}
            <span
              className="e"
              role="button"
              tabIndex={0}
              aria-label={`Remove rule ${ruleLabel(r)}`}
              onClick={() => props.onRemove(r)}
            >
              <Icon name="close" />
            </span>
          </div>
        ))}
      </div>
      <div className="row mt-2.5">
        <Select
          value={kind}
          onValueChange={(v) => {
            setKind(v as CommandRuleView["kind"]);
            if (v === "word" && verdict === "allow") setVerdict("deny");
          }}
        >
          <SelectTrigger aria-label="Rule kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="command">Command</SelectItem>
            <SelectItem value="word">Word</SelectItem>
          </SelectContent>
        </Select>
        <Input
          type="text"
          placeholder={EXAMPLE[kind]}
          className="flex-1"
          value={pattern}
          onInput={(e) => setPattern((e.target as HTMLInputElement).value)}
        />
        <Select value={verdict} onValueChange={(v) => setVerdict(v as CommandRuleView["verdict"])}>
          <SelectTrigger aria-label="Verdict">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {kind === "command" && <SelectItem value="allow">allow</SelectItem>}
            <SelectItem value="ask">ask</SelectItem>
            <SelectItem value="deny">deny</SelectItem>
          </SelectContent>
        </Select>
        {props.agents.length > 0 && (
          <ScopeChoice
            agents={props.agents}
            scope={scope}
            label={scopeText(scope, props.agents)}
            title="Which agents the rule being added applies to"
            onChange={setScope}
          />
        )}
        <Button
          size="sm"
          disabled={rule === null}
          onClick={() => {
            if (rule === null) return;
            props.onAdd(rule);
            setPattern("");
          }}
        >
          Add rule
        </Button>
      </div>
      <div className="note mx-0 mb-0 mt-2">
        {kind === "word" ? (
          <>
            A word matches one word wherever it sits in a command — <code>--watch</code> catches{" "}
            <code>kubectl get pods --watch</code>, never <code>cat watch.log</code>. A word denies or
            asks; it can&apos;t allow, since a word says nothing of what the command does with it.
          </>
        ) : (
          <>
            A command pattern matches one command&apos;s whole text, <code>*</code> matching anything.
            An allow rule trusts the command itself: the agent chooses the directory and environment
            it runs in (cwd, PATH, other variables), and those can change what the command does. The
            approval card shows them; a rule doesn&apos;t look at them.
          </>
        )}
      </div>
    </div>
  );
}

function MatchText({ match, draft }: { match: RuleMatchView; draft: Draft | null }) {
  const typed =
    draft !== null && match.layer === draft.layer && match.rule.kind === draft.rule.kind && match.rule.pattern === draft.rule.pattern;
  return (
    <>
      {matchLabel(match)}
      {typed && <span className="text-[var(--pb-text-faint)]"> — being typed</span>}
    </>
  );
}

/** How the rules judge one line: each command it runs with the rule that
 * decided it and the rules that matched and lost, each part that can't be
 * seen and why, and the line's verdict. */
function JudgementView({ judgement, draft }: { judgement: CommandJudgementView; draft: Draft | null }) {
  // Each row: the verdict, then the command over why — the text wraps
  // within its column, the badge never does.
  const row = (key: string, verdict: CommandJudgementView["verdict"], text: string, why: ReactNode, also?: ReactNode) => (
    <div key={key} className="rule items-start">
      <span className={`verdict ${verdict} shrink-0`}>{verdict}</span>
      <div className="min-w-0 flex-1">
        <code className="block break-all">{text}</code>
        <div className="text-xs">{why}</div>
        {also}
      </div>
    </div>
  );
  return (
    <div data-command-judgement>
      {judgement.commands.map((c, i) =>
        row(
          `c${i}`,
          c.verdict,
          c.text,
          c.by === null ? unruledWhy(judgement.policy) : <MatchText match={c.by} draft={draft} />,
          c.also.length > 0 && (
            <div className="text-xs text-[var(--pb-text-faint)]">
              also matched:{" "}
              {c.also.map((m, j) => (
                <span key={j}>
                  {j > 0 && ", "}
                  {m.rule.verdict} <MatchText match={m} draft={draft} />
                </span>
              ))}
            </div>
          ),
        ),
      )}
      {judgement.unreadable.map((u, i) => row(`u${i}`, unruledVerdict(judgement.policy), u.text, u.reason))}
      {judgement.commands.length === 0 && judgement.unreadable.length === 0 && (
        <div className="note mx-0">Runs no command — as a command no rule decides: {unruledVerdict(judgement.policy)}.</div>
      )}
      <div className="mt-2 text-sm">
        Line: <span className={`verdict ${judgement.verdict}`}>{judgement.verdict}</span>
      </div>
    </div>
  );
}

/** The tester's agent as its select names it: "" for an agent no rule names. */
const ANY_OTHER = "";

export function CommandsSection(props: {
  state: SettingsState;
  onAddRule(rule: CommandRuleView, layer: Layer): void;
  onRemoveRule(rule: CommandRuleView, layer: Layer): void;
  onScopeRules(rules: readonly CommandRuleView[], layer: Layer, scope: AgentScope): void;
  onTest(line: string, shell: TesterShell, agent: PatchbayAgentId | null, draft: Draft | null): void;
  onAlwaysAllow(layer: Layer, on: boolean): void;
  onUnruled(layer: Layer, verdict: RuleVerdictView | null): void;
}) {
  const { state, onTest } = props;
  // While every command is allowed, the rules are kept and not applied:
  // shown, and not to be worked on.
  const setAside = state.commandPolicy.effective.alwaysAllow;
  const [line, setLine] = useState("");
  const [shell, setShell] = useState<TesterShell>("none");
  // The agent the line is judged for — one since removed is no agent.
  const [as, setAs] = useState<PatchbayAgentId | null>(null);
  const agent = state.agents.some((a) => a.id === as) ? as : null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftFrom = (layer: Layer) => (rule: CommandRuleView | null) =>
    setDraft((held) => (rule !== null ? { rule, layer } : held?.layer === layer ? null : held));
  // Asked again whenever the line, the draft or the rules change — the
  // answer shown is always for what is on the page now.
  useEffect(() => {
    if (line.trim() !== "") onTest(line, shell, agent, draft);
  }, [line, shell, agent, draft, state.commandRules, state.machineCommandRules, state.commandPolicy]);
  const shown = state.commandTest;
  const result = shown !== null && shown.line === line && shown.shell === shell && shown.agent === agent ? shown.judgement : null;

  return (
    <section className="section">
      <h1>Commands</h1>
      <div className="sub">
        Terminal commands an agent runs through patchbay ask first, unless a rule answers or you
        chose otherwise in the two cards around the rules. Each
        command in a line is judged — in a chain, a loop, a <code>bash -c</code> script — and the
        line takes the most severe verdict; what the text can&apos;t show is something no rule decides. This workspace&apos;s
        rules answer first, then the machine&apos;s; within a layer deny beats ask beats allow. A
        rule applies to every agent unless it names the agents it is for: for any other agent it
        isn&apos;t there. An agent running commands itself asks through its own requests, which
        carry no command a rule could match.
      </div>

      <div className="card">
        <h2 className="mt-0">Test a command</h2>
        <div className="note mx-0 mt-0 mb-2">
          As the gate would judge it for the agent chosen, the rule being typed below counted as
          added. No shell: a program and its arguments; bash or zsh: a script, read as that shell reads it.
        </div>
        <div className="row">
          <Select value={shell} onValueChange={(v) => setShell(v as TesterShell)}>
            <SelectTrigger aria-label="Run as">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No shell</SelectItem>
              <SelectItem value="bash">bash</SelectItem>
              <SelectItem value="zsh">zsh</SelectItem>
            </SelectContent>
          </Select>
          {state.agents.length > 0 && (
            <Select value={agent ?? ANY_OTHER} onValueChange={(v) => setAs(v === ANY_OTHER ? null : (v as PatchbayAgentId))}>
              <SelectTrigger aria-label="Test as">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_OTHER}>as any other agent</SelectItem>
                {state.agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    as {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input
            type="text"
            className="flex-1"
            placeholder={shell === "bash" ? "kubectl get pods --watch && rm -rf build" : "npm run build"}
            value={line}
            aria-label="Command to test"
            onInput={(e) => setLine((e.target as HTMLInputElement).value)}
          />
        </div>
        {result !== null && (
          <div className="mt-2">
            <JudgementView judgement={result} draft={draft} />
          </div>
        )}
      </div>

      <AlwaysAllowCard policy={state.commandPolicy} onAlwaysAllow={props.onAlwaysAllow} onUnruled={props.onUnruled} />

      {setAside && (
        <div className="note text-warn" data-rules-set-aside>
          The rules below are set aside while &quot;{ALWAYS_ALLOW_COMMANDS}&quot; is on: every command runs.
        </div>
      )}
      <div className={setAside ? "opacity-50" : undefined} inert={setAside} data-rule-cards>
      <CommandRulesCard
        title="Command rules — this workspace"
        note="Evaluated first — this repo's own tightening or loosening of the machine floor."
        rules={state.commandRules}
        agents={state.agents}
        emptyText="No workspace rules — the machine layer (below) answers, then the choice after it."
        onAdd={(rule) => props.onAddRule(rule, "workspace")}
        onRemove={(rule) => props.onRemoveRule(rule, "workspace")}
        onScope={(rules, scope) => props.onScopeRules(rules, "workspace", scope)}
        onDraft={draftFrom("workspace")}
      />

      <CommandRulesCard
        title="Command rules — this machine"
        note="The fallback floor for every workspace on this machine — consulted only where the workspace layer stays silent."
        rules={state.machineCommandRules}
        agents={state.agents}
        emptyText="No machine rules — every unmatched command gets the choice below."
        onAdd={(rule) => props.onAddRule(rule, "machine")}
        onRemove={(rule) => props.onRemoveRule(rule, "machine")}
        onScope={(rules, scope) => props.onScopeRules(rules, "machine", scope)}
        onDraft={draftFrom("machine")}
      />
      </div>

      <UnruledCard policy={state.commandPolicy} onAlwaysAllow={props.onAlwaysAllow} onUnruled={props.onUnruled} />

      <div className="note good">
        Workspace rules live in workspaceState (per user, per workspace), machine rules in global
        storage (per user, this machine) — never in the repo either way. A cloned repository
        cannot arrive pre-authorized.
      </div>
    </section>
  );
}
