// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Which agents a command rule or a file-write answer applies to, as its
// row shows and edits it: a chip saying the scope in a few words, opening
// the one scope control (scope-control.tsx) over the agents — and, for the
// rules a filter shows, the same control setting all of them at once.
import { useState } from "react";
import { everyAgent, scopeLabel, type AgentScope } from "../../shared/agent-scope";
import type { SettingsState } from "../../shared/protocol";
import { Icon } from "../shared/icon";
import { AppliesToAgents } from "./scope-control";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Agents = SettingsState["agents"];

/** A scope as its chip reads: the agents it names, or "all agents". */
export function scopeText(scope: AgentScope, agents: Agents): string {
  return scopeLabel(scope, (id) => agents.find((a) => a.id === id)?.name) ?? "all agents";
}

/** One row's scope. `quiet`: a scope of every agent shows the control's
 * icon alone — in a long list only the rules that name agents say so. A
 * change is saved as it is made, like every other scope in Settings. */
export function ScopeChip(props: {
  agents: Agents;
  scope: AgentScope;
  /** What the scope is of, for the control's accessible name. */
  of: string;
  quiet?: boolean;
  onChange(scope: AgentScope): void;
}) {
  const text = scopeText(props.scope, props.agents);
  const named = !everyAgent(props.scope);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`scope-chip h-auto min-w-0 shrink gap-1 px-1.5 py-0 text-[11px] ${named ? "named" : "text-muted-foreground"}`}
          title={`Applies to ${text} — change`}
          aria-label={`Agents ${props.of} applies to: ${text}`}
        >
          <Icon name="organization" />
          {(named || props.quiet !== true) && <span className="min-w-0 max-w-[14rem] truncate">{text}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-3 text-[12px]">
        <AppliesToAgents agents={props.agents} scope={props.scope} onChange={props.onChange} />
      </PopoverContent>
    </Popover>
  );
}

/** A scope chosen first, then set — the add row's (kept until the rule is
 * added) and the bulk change's (applied to every rule shown, on its own
 * button, which says how many). */
export function ScopeChoice(props: {
  agents: Agents;
  scope: AgentScope | null;
  label: string;
  title: string;
  onChange(scope: AgentScope): void;
  /** The bulk change's button: shown under the control once a scope is chosen. */
  apply?: { label: string; run(): void };
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0 gap-1" title={props.title}>
          <Icon name="organization" /> {props.label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-3 text-[12px]">
        <AppliesToAgents agents={props.agents} scope={props.scope} onChange={props.onChange} />
        {props.apply !== undefined && (
          <Button
            size="sm"
            className="mt-3"
            disabled={props.scope === null}
            onClick={() => {
              props.apply!.run();
              setOpen(false);
            }}
          >
            {props.apply.label}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
