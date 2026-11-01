// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// One control for every scope Settings edits — the agents an MCP server is
// routed to, the workspaces a server or a saved root is on in: the three
// reaches stated as the three sentences they are, one mode per line, the
// tick-list indented under whichever list mode is active, never an
// undifferentiated wrap of radios and checkboxes:
//   every   — every one, those to come included;
//   only    — exactly the ticked ones;
//   except  — every one but the ticked ones.
import type { ReactNode } from "react";
import { namedIn, type Reach } from "../../shared/reach";
import { workspaceLabel, type WorkspaceId } from "../../shared/workspace";
import type { SettingsState } from "../../shared/protocol";
import type { PatchbayAgentId } from "../../shared/ids";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

type Mode = "every" | "only" | "except";

/** One thing the scope is chosen over, as its tick reads. */
interface Candidate<Id extends string> {
  id: Id;
  label: ReactNode;
  title?: string;
}

/** How a set's three sentences read. */
interface Wording {
  /** The control's label. */
  heading: string;
  headingTitle: string;
  every: string;
  everyTitle: string;
  only: string;
  except: string;
  /** Said under an empty list mode: there is nothing to tick. */
  none: string;
}

function ScopeControl<Id extends string>(props: {
  wording: Wording;
  candidates: readonly Candidate<Id>[];
  /** Null: not chosen yet — no mode is preselected, and the user picks. */
  reach: Reach<Id> | null;
  onChange(reach: Reach<Id>): void;
}) {
  const { reach, wording } = props;
  const mode: Mode | null = reach === null ? null : reach === "auto" ? "every" : Array.isArray(reach) ? "only" : "except";
  const list = reach === null ? [] : namedIn(reach);
  const setMode = (m: Mode) => {
    if (m === mode) return;
    // A list never carries across modes — the same ids mean the opposite
    // thing in "only" and "except".
    props.onChange(m === "every" ? "auto" : m === "only" ? [] : { except: [] });
  };
  const tick = (id: Id, ticked: boolean) => {
    const next = ticked ? list.filter((x) => x !== id) : [...list, id];
    props.onChange(mode === "only" ? next : { except: next });
  };
  const tickList = (
    <div className="ml-6 flex flex-wrap gap-x-2.5 gap-y-1">
      {props.candidates.map((c) => (
        <label key={c.id} className="flex min-w-0 items-center gap-1.5" title={c.title}>
          <Checkbox checked={list.includes(c.id)} onCheckedChange={() => tick(c.id, list.includes(c.id))} />
          {c.label}
        </label>
      ))}
      {props.candidates.length === 0 && <span className="note m-0">{wording.none}</span>}
    </div>
  );
  return (
    <div className="flex flex-col gap-1.5">
      <span className="lbl text-[10.5px] tracking-[0.04em] uppercase text-muted-foreground" title={wording.headingTitle}>
        {wording.heading}
      </span>
      <RadioGroup className="flex flex-col gap-1" value={mode ?? ""} onValueChange={(v) => setMode(v as Mode)}>
        <label className="flex items-center gap-1.5" title={wording.everyTitle}>
          <RadioGroupItem value="every" /> {wording.every}
        </label>
        <label className="flex items-center gap-1.5">
          <RadioGroupItem value="only" /> {wording.only}
        </label>
        {mode === "only" && tickList}
        <label className="flex items-center gap-1.5">
          <RadioGroupItem value="except" /> {wording.except}
        </label>
        {mode === "except" && tickList}
      </RadioGroup>
    </div>
  );
}

const AGENTS: Wording = {
  heading: "agents",
  headingTitle: "which agents receive this server in their sessions",
  every: "all agents",
  everyTitle: "attaches to every agent, current and future — tool calls still pass the permission broker per agent",
  only: "only these agents",
  except: "all agents except these",
  none: "no agents yet",
};

/** The agents a server is routed to. */
export function AgentScope(props: {
  agents: SettingsState["agents"];
  routing: Reach<PatchbayAgentId>;
  onChange(routing: Reach<PatchbayAgentId>): void;
}) {
  return (
    <ScopeControl
      wording={AGENTS}
      candidates={props.agents.map((a) => ({ id: a.id, label: a.name }))}
      reach={props.routing}
      onChange={props.onChange}
    />
  );
}

/** A workspace's tick: this window's by name, any other by its path and
 * host. */
function workspaceCandidate(id: WorkspaceId, here: WorkspaceId | null): Candidate<WorkspaceId> {
  const { path, host } = workspaceLabel(id);
  const where = host === "" ? path : `${path} · ${host}`;
  if (id === here) return { id, label: "this workspace", title: where };
  return { id, label: <span className="min-w-0 break-all font-mono text-[11.5px]">{where}</span>, title: id };
}

/** The workspaces a server or a saved root is on in. The ticks are this
 * workspace and the ones the scope already names — a workspace joins only
 * from inside it, and any window can take one out. */
export function WorkspaceScope(props: {
  /** What the scope is of, for its heading's title. */
  of: string;
  here: WorkspaceId | null;
  /** Null: not chosen yet. */
  workspaces: Reach<WorkspaceId> | null;
  onChange(workspaces: Reach<WorkspaceId>): void;
}) {
  const named = props.workspaces === null ? [] : namedIn(props.workspaces);
  const ids = props.here === null || named.includes(props.here) ? named : [props.here, ...named];
  const wording: Wording = {
    heading: "workspaces",
    headingTitle: `the workspaces ${props.of} is on in — a workspace is added from inside it, and taken out from any window`,
    every: "every workspace",
    everyTitle: "every workspace on this machine, those opened later included",
    only: "only these workspaces",
    except: "every workspace except these",
    none: "open a workspace to add it here",
  };
  return (
    <ScopeControl
      wording={wording}
      candidates={ids.map((id) => workspaceCandidate(id, props.here))}
      reach={props.workspaces}
      onChange={props.onChange}
    />
  );
}
