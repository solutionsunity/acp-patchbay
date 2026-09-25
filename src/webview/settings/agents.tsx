// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Agents: stat tiles + Add Agent, one card per known
// agent — status live, capabilities claimed-until-exercised, knobs offering
// only what the agent actually offered.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AgentConfigView, AgentSummary, AuthMethodView, RegistryAgentView, SettingsState } from "../../shared/protocol";
import { agentCardControls, runnableLoginMethods } from "./card-controls";
import { capabilityOneLiner } from "../shared/capability-format";
import { Icon } from "../shared/icon";
import { UpgradeChip } from "../shared/upgrade-chip";
import { ConfirmButton, Field, Toggle } from "./controls";
import { formatEnvLines, parseEnvLines } from "./parse-env";
import { SortableItem, SortableList } from "./sortable";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const EMPTY_AGENT_CONFIG: AgentConfigView = {
  id: "",
  name: "",
  command: "",
  args: [],
  env: {},
  processPolicy: "auto",
  autoConnect: false,
  defaults: {},
  registrySource: null,
  lastSeenVersion: null,
};

/** Display-only join for the launch-line input: args carrying whitespace get
 * re-quoted so the round trip through the orchestrator's parser is faithful. */
function displayCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].filter(Boolean).join(" ");
}

/** ✎ Edit: launch line, process policy, env. Parsing the line is the
 * orchestrator's job — it's sent raw, args empty. Env shows what is
 * stored and saves what is in the box. Default model/mode/effort
 * deliberately do NOT appear here: the card's knob selects own them,
 * offering only what the agent has actually offered — a free-text
 * duplicate would let the user type options that don't exist. */
function AgentConfigForm(props: {
  initial: AgentConfigView;
  onSave(config: AgentConfigView): void;
  onCancel(): void;
}) {
  const [id, setId] = useState(props.initial.id);
  const [name, setName] = useState(props.initial.name);
  const [command, setCommand] = useState(displayCommandLine(props.initial.command, props.initial.args));
  const [processPolicy, setProcessPolicy] = useState(props.initial.processPolicy);
  const [autoConnect, setAutoConnect] = useState(props.initial.autoConnect);
  const [envText, setEnvText] = useState(formatEnvLines(props.initial.env));

  const save = () => {
    if (id.trim() === "" || name.trim() === "" || command.trim() === "") return;
    props.onSave({
      id: id.trim(),
      name: name.trim(),
      command: command.trim(),
      args: [],
      env: parseEnvLines(envText),
      processPolicy,
      autoConnect,
      defaults: props.initial.defaults,
      registrySource: props.initial.registrySource,
      lastSeenVersion: props.initial.lastSeenVersion,
    });
  };

  return (
    <div className="connect-form">
      <Field label="id" hint="the storage key — fixed once created">
        <Input type="text" placeholder="id (unique)" value={id} disabled={props.initial.id !== ""} onInput={(e) => setId((e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="name">
        <Input type="text" placeholder="display name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="command" hint="command and args — quotes supported">
        <Input
          type="text"
          placeholder="npx some-acp-agent --flag"
          value={command}
          onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Field label="process policy">
        <Select value={processPolicy} onValueChange={(v) => setProcessPolicy(v as AgentConfigView["processPolicy"])}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">auto</SelectItem>
            <SelectItem value="shared">shared</SelectItem>
            <SelectItem value="isolated">isolated</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="auto-connect" hint="connect this agent when the window opens">
        <Toggle icon="zap" label="connect on window open" checked={autoConnect} onChange={setAutoConnect} />
      </Field>
      <Field label="environment variables" hint="KEY=value, one per line — stored in VS Code SecretStorage">
        <Textarea
          rows={3}
          className="resize-y"
          placeholder={"MY_API_KEY=…"}
          value={envText}
          onInput={(e) => setEnvText((e.target as HTMLTextAreaElement).value)}
        />
      </Field>
      <div className="form-actions">
        <Button size="sm" onClick={save}>
          Save
        </Button>
        <Button variant="outline" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Existing config for this agent, or one synthesized from its live launch
 * command — editing process-policy/defaults on an agent connected without a
 * config yet (transient — Add always persists one) creates its record on
 * first save. */
function configFor(state: SettingsState, agent: AgentSummary): AgentConfigView {
  const existing = state.agentConfigs.find((c) => c.id === agent.id);
  if (existing !== undefined) return existing;
  // The raw line rides in `command` with args empty — the orchestrator
  // parses on save — no parsing in the webview.
  return {
    id: agent.id,
    name: agent.name,
    command: (agent.command ?? "").trim(),
    args: [],
    env: {},
    processPolicy: "auto",
    autoConnect: false,
    defaults: {},
    registrySource: null,
    lastSeenVersion: null,
  };
}

/** The registry's own icon for an agent (a host-fetched data URI riding
 * RegistryAgentView — CSP-safe by the authored `img-src data:`). Renders nothing
 * when there is none: absence over a generic placeholder that would make
 * every local/custom agent wear the same fake brand.
 *
 * Drawn as a CSS mask over currentColor, not an <img>: the registry ships
 * monochrome marks (fixed dark fills — invisible on dark themes as-is), so
 * the icon takes exactly the color its row's text has, in every theme —
 * the codicon technique. Deliberate trade: a genuinely multicolor logo
 * would flatten to a silhouette; theme-correct beats brand-exact here. */
function AgentIcon({ icon }: { icon: string | null | undefined }) {
  if (icon == null) return null;
  const mask: CSSProperties = {
    backgroundColor: "currentColor",
    maskImage: `url("${icon}")`,
    maskRepeat: "no-repeat",
    maskSize: "contain",
    maskPosition: "center",
  };
  return <span aria-hidden className="inline-block h-4 w-4 shrink-0" style={mask} />;
}

/** Searchable registry picker — the "Add Agent" full scenario: type to
 * filter, click to pick, clear to search again. Fully
 * controlled — the only local state is whether the dropdown is open, so a
 * parent reset (after Add, or on mode toggle) can't leave it out of sync. */
function RegistryCombobox(props: {
  entries: readonly RegistryAgentView[];
  query: string;
  selectedId: string;
  onQueryChange(query: string): void;
  onSelect(registryId: string): void; // "" clears the selection
}) {
  const [open, setOpen] = useState(false);
  const selected = props.entries.find((r) => r.id === props.selectedId);

  return (
    <div className="flex items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            className="w-72 justify-between font-normal"
          >
            {selected !== undefined ? selected.name : "search the registry…"}
            <Icon name="chevron-down" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput
              placeholder="search the registry…"
              value={props.query}
              onValueChange={(q) => {
                props.onQueryChange(q);
                if (props.selectedId !== "") props.onSelect("");
              }}
            />
            <CommandList>
              <CommandEmpty>
                {props.entries.length === 0
                  ? "no registry agents — try Refresh registry"
                  : `no matches for \u201c${props.query}\u201d`}
              </CommandEmpty>
              {props.entries.map((r) => (
                <CommandItem
                  key={r.id}
                  value={r.name}
                  disabled={r.unavailableReason !== null}
                  title={r.description}
                  onSelect={() => {
                    props.onSelect(r.id);
                    props.onQueryChange(r.name);
                    setOpen(false);
                  }}
                >
                  {r.id === props.selectedId && <Icon name="check" />}
                  <AgentIcon icon={r.icon} />
                  {r.name}
                  {r.unavailableReason !== null && <span className="note"> — {r.unavailableReason}</span>}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {props.selectedId !== "" && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Clear selection"
          onClick={() => {
            props.onSelect("");
            props.onQueryChange("");
          }}
        >
          <Icon name="close" />
        </Button>
      )}
    </div>
  );
}

/** Registry search or custom command — the one way
 * to add an agent, which is also how it's activated: persisted, connected,
 * and (by default) Verified in one action. Already-configured registry ids
 * are excluded here — their own card below is the way back to them. The two
 * ways of naming an agent are mutually exclusive modes behind one toggle,
 * never two half-filled fields at once. */
function AddAgentRow(props: {
  state: SettingsState;
  onAdd(source: { registryId: string } | { command: string }, verifyAfterConnect: boolean): void;
  onRefreshRegistry(): void;
}) {
  const configuredIds = new Set(props.state.agentConfigs.map((c) => c.id));
  const available = props.state.registryAgents.filter((r) => !configuredIds.has(r.id));
  const registryCount = props.state.registryAgents.length;
  const [mode, setMode] = useState<"registry" | "custom">("registry");
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryId, setRegistryId] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [verifyAfterAdd, setVerifyAfterAdd] = useState(true);

  const canAdd = mode === "registry" ? registryId !== "" : customCommand.trim() !== "";

  const resetFields = () => {
    setRegistryQuery("");
    setRegistryId("");
    setCustomCommand("");
  };

  const add = () => {
    if (mode === "registry" && registryId !== "") {
      props.onAdd({ registryId }, verifyAfterAdd);
    } else if (mode === "custom" && customCommand.trim() !== "") {
      props.onAdd({ command: customCommand.trim() }, verifyAfterAdd);
    } else {
      return;
    }
    resetFields();
  };

  return (
    <div className="card">
      <div className="row">
        <h2 className="m-0">+ Add Agent</h2>
        <span className="flex-1" />
        <Button
          variant="outline" size="sm"
          onClick={props.onRefreshRegistry}
          title="Re-check the official ACP registry for new agents and versions"
        >
          <Icon name="refresh" /> Refresh registry
        </Button>
      </div>
      {props.state.registryFetchedAt !== "" && (
        <div className="note mx-0 mb-0 mt-1">
          {registryCount} agent{registryCount === 1 ? "" : "s"} in the ACP registry · last
          checked {new Date(props.state.registryFetchedAt).toLocaleString()}
        </div>
      )}
      <div className="connect-form mt-2">
        {mode === "registry" ? (
          <RegistryCombobox
            entries={available}
            query={registryQuery}
            selectedId={registryId}
            onQueryChange={setRegistryQuery}
            onSelect={setRegistryId}
          />
        ) : (
          <Input
            type="text"
            className="w-full"
            placeholder="custom command that speaks ACP…"
            value={customCommand}
            onInput={(e) => setCustomCommand((e.target as HTMLInputElement).value)}
          />
        )}
      </div>
      <div className="row mt-2 gap-2 flex-wrap">
        <Button size="sm" disabled={!canAdd} onClick={add}>
          Add
        </Button>
        <Button
          variant="outline" size="sm"
          onClick={() => {
            setMode(mode === "registry" ? "custom" : "registry");
            resetFields();
          }}
        >
          {mode === "registry" ? "Add custom…" : "Add from registry"}
        </Button>
        <Toggle
          checked={verifyAfterAdd}
          label="Verify after add"
          onChange={setVerifyAfterAdd}
        />
      </div>
    </div>
  );
}

/** `needsAuth` gate — runnable methods per card-controls.ts's
 * `runnableLoginMethods` (the one filter for "can patchbay drive a login
 * here?"); an "unsupported" method stays declared but never wired to a
 * button. Same action either way: the orchestrator routes by method. */
function LoginControl(props: {
  agentId: string;
  methods: readonly AuthMethodView[];
  disabled: boolean;
  onAuthenticate(agentId: string, methodId: string): void;
}) {
  const actionable = runnableLoginMethods(props.methods);
  const [methodId, setMethodId] = useState(actionable[0]?.id ?? "");
  if (actionable.length === 0) {
    return (
      <span className="note crashed-note">
        <Icon name="warning" /> needs login — no runnable login method declared (use the agent's
        own CLI; its instruction, if it gave one, is below)
      </span>
    );
  }
  const selected = actionable.find((m) => m.id === methodId) ?? actionable[0]!;
  return (
    <span className="row gap-1.5">
      {actionable.length > 1 && (
        // `selected.id`, not the raw state: a reconnect may refresh the
        // declared methods under an open popover, and the display must
        // follow the same stale-id fallback the button already fires with.
        <Select value={selected.id} onValueChange={setMethodId}>
          {/* Explicit value: the closed control shows the title only — a
              bare SelectValue echoes the item's children, description
              included, and the widest description would set the trigger's
              width. The open list keeps both lines. */}
          <SelectTrigger><SelectValue>{selected.name}</SelectValue></SelectTrigger>
          <SelectContent>
            {actionable.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
                {m.description !== null && (
                  <span className="block text-[11px] text-muted-foreground">{m.description}</span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button
        size="sm"
        title={selected.description ?? undefined}
        disabled={props.disabled}
        onClick={() => props.onAuthenticate(props.agentId, selected.id)}
      >
        Log in
      </Button>
    </span>
  );
}

/** Stat tiles + whatever rides the same row (the Add Agent tile-button) —
 * one container so they share sizing and rhythm. The first surface converted
 * to shadcn primitives. */
const TILE = "min-w-24 flex-none rounded-lg px-4 py-2.5 text-center";

export function StatTiles({ state, children }: { state: SettingsState; children?: ReactNode }) {
  const running = state.agents.filter((a) => a.status === "running").length;
  const tiles = [
    { n: state.agents.length, label: "agents", icon: "hubot" },
    { n: running, label: "running", icon: "pulse" },
    { n: state.sessionsActiveToday, label: "active today", icon: "comment-discussion" },
  ];
  return (
    <div className="mb-3.5 flex gap-2.5">
      {tiles.map((t) => (
        <Card className={TILE} key={t.label}>
          <div className="flex items-center justify-center gap-1.5 text-[22px] font-semibold">
            <span className="text-muted-foreground"><Icon name={t.icon} /></span>
            {t.n}
          </div>
          <div className="text-[11px] text-muted-foreground">{t.label}</div>
        </Card>
      ))}
      {children}
    </div>
  );
}

/** Category is UX-only in ACP ("MUST NOT be required for correctness") — it
 * decorates a knob with an icon when reported, and an unknown or missing
 * category still renders fine. */
const KNOB_ICON: Record<string, string> = {
  model: "sparkle",
  mode: "gear",
  thought_level: "dashboard",
};

const DEFAULT_SENTINEL = "__agent_default__";
const BOOL_ON = "__on__";
const BOOL_OFF = "__off__";

/** One default-knob select for an option the agent actually offered —
 * patchbay never invents an option, so unoffered knobs simply don't render
 * (the card states the observed reality instead). `offered: null` marks a
 * boolean option: a tri-state select (agent default / on / off), since a
 * checkbox can't express "no default saved". */
function DefaultKnob(props: {
  icon: string;
  label: string;
  offered: readonly { value: string; name: string }[] | null;
  value: string | boolean;
  onChange(value: string | boolean): void;
}) {
  // Radix Select items can't carry value="" — DEFAULT_SENTINEL maps to the
  // config's "unset" at this boundary only, never persisted; booleans ride
  // the BOOL_ON/BOOL_OFF sentinels the same way.
  const selectValue =
    props.value === "" ? DEFAULT_SENTINEL : typeof props.value === "boolean" ? (props.value ? BOOL_ON : BOOL_OFF) : props.value;
  return (
    <label className="knob-default">
      <Icon name={props.icon} /> {props.label}
      <Select
        value={selectValue}
        onValueChange={(v) =>
          props.onChange(v === DEFAULT_SENTINEL ? "" : v === BOOL_ON ? true : v === BOOL_OFF ? false : v)
        }
      >
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_SENTINEL}>(agent default)</SelectItem>
          {props.offered === null ? (
            <>
              <SelectItem value={BOOL_ON}>on</SelectItem>
              <SelectItem value={BOOL_OFF}>off</SelectItem>
            </>
          ) : (
            props.offered.map((v) => (
              <SelectItem key={v.value} value={v.value}>
                {v.name}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </label>
  );
}

/** The stored selections, stated as text while the agent isn't connected —
 * offerings are connection state (read fresh each connect, never persisted),
 * so with no connection there is no list to render, only what's saved. */
function StoredDefaultsLine({ defaults }: { defaults: AgentConfigView["defaults"] }) {
  const entries = Object.entries(defaults).map(([id, v]) => `${id}=${String(v)}`);
  return (
    <span className="note m-0 self-center">
      {entries.length === 0
        ? "no session defaults saved — connect to see this agent's knobs"
        : `saved defaults: ${entries.join(" · ")} — connect to edit`}
    </span>
  );
}

export function AgentsSection(props: {
  state: SettingsState;
  onVerify(agentId: string): void;
  onConnectConfigured(agentId: string): void;
  onAddAgent(source: { registryId: string } | { command: string }, verifyAfterConnect: boolean): void;
  onSave(config: AgentConfigView): void;
  onRemove(agentId: string): void;
  onStop(agentId: string): void;
  onRestart(agentId: string): void;
  onAuthenticate(agentId: string, methodId: string): void;
  onLogout(agentId: string): void;
  onUpgrade(agentId: string): void;
  onRefreshRegistry(): void;
  onReorder(ids: string[]): void;
  /** A card's knob editor is showing (open) or gone — the host opens or
   * ends the throwaway session that reads the agent's surface. */
  onEditDefaults(agentId: string, open: boolean): void;
}) {
  const { state } = props;
  const [editing, setEditing] = useState<string | null>(null); // agentId being edited
  const [diagFor, setDiagFor] = useState<string | null>(null);
  // Card body (command line, capabilities, knobs) is collapsed by default —
  // the header row carries status and actions; the gear opens the rest.
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});
  // The knob editor reads the agent's surface through a host-side session
  // that exists while a card is expanded AND its agent is running — a card
  // expanded while stopped gets its session the moment the agent comes up.
  // Opening is derived here; collapse is the gear click; unmount releases
  // whatever is still open.
  const editingIds = Object.keys(openDetails)
    .filter((id) => openDetails[id] && state.agents.find((a) => a.id === id)?.status === "running")
    .join("\n");
  const onEditDefaults = useRef(props.onEditDefaults);
  onEditDefaults.current = props.onEditDefaults;
  useEffect(() => {
    for (const id of editingIds.split("\n").filter(Boolean)) onEditDefaults.current(id, true);
  }, [editingIds]);
  const editingRef = useRef(editingIds);
  editingRef.current = editingIds;
  useEffect(
    () => () => {
      for (const id of editingRef.current.split("\n").filter(Boolean)) onEditDefaults.current(id, false);
    },
    [],
  );

  // One card per known agent id — the union of connected-this-session
  // (state.agents) and persisted (state.agentConfigs); Add always persists,
  // so in steady state every agent has both. No more separate "workspace
  // configs" list — one set of cards, not two.
  const ids = [
    ...state.agentConfigs.map((c) => c.id),
    ...state.agents.filter((a) => !state.agentConfigs.some((c) => c.id === a.id)).map((a) => a.id),
  ];
  // Open by default only when there's nothing to collapse to — otherwise
  // the trigger button next to the stat tiles is the one way in, so adding
  // stays a click away instead of a permanent card taking up the page.
  const [addOpen, setAddOpen] = useState(ids.length === 0);

  return (
    <section className="section">
      <h1>Agents</h1>
      <div className="sub">
        Any command line that speaks ACP. Status is live; capabilities are
        claimed until exercised.
      </div>
      <StatTiles state={state}>
        {/* Add Agent as a tile-shaped Button — same box as the counter
            Cards, but it reads as an action: accent icon, hover lift.
            ml-auto: the action tile sits right, the counters stay left. */}
        <Button
          variant="outline"
          className={`${TILE} ml-auto h-auto flex-col items-center gap-0 border-border bg-card font-normal text-foreground shadow-sm hover:border-brand hover:bg-accent hover:text-foreground aria-expanded:border-brand aria-expanded:bg-accent`}
          onClick={() => setAddOpen(!addOpen)}
          aria-expanded={addOpen}
        >
          <div className="text-[22px] font-semibold text-brand">
            <Icon name={addOpen ? "chevron-up" : "add"} />
          </div>
          <div className="text-[11px] text-muted-foreground">{addOpen ? "close" : "add agent"}</div>
        </Button>
      </StatTiles>
      {addOpen && (
        <AddAgentRow
          state={state}
          onAdd={(source, verifyAfterConnect) => {
            props.onAddAgent(source, verifyAfterConnect);
            setAddOpen(false);
          }}
          onRefreshRegistry={props.onRefreshRegistry}
        />
      )}
      {ids.length === 0 && (
        <div className="card">
          <div className="note m-0">
            No agents yet — add one above.
          </div>
        </div>
      )}
      <SortableList ids={ids} onReorder={props.onReorder}>
        {ids.map((id) => {
          const a = state.agents.find((x) => x.id === id);
          const config = state.agentConfigs.find((c) => c.id === id);
          const effectiveConfig: AgentConfigView = config ?? (a !== undefined ? configFor(state, a) : EMPTY_AGENT_CONFIG);
          const matrix = state.capabilities[id];
          // Registry row for this config: the config's own registrySource is
          // the link (a config id may predate the registry naming); plain id
          // covers agents added straight from the registry.
          const registry = state.registryAgents.find(
            (r) => r.id === (config?.registrySource?.registryId ?? id),
          );
          const knobs = state.agentKnobs[id];
          const concurrencyUsed = matrix?.concurrentSessions?.used ?? false;
          // No summary at all = the orchestrator never saw this config — the
          // honest unknown is "untested", never a claimed "stopped".
          const status = a?.status ?? "untested";
          const command = a?.command ?? (config !== undefined ? [config.command, ...config.args].join(" ") : undefined);
          // Editing forces the body open — the form lives there.
          const detailsOpen = openDetails[id] === true || editing === id;
          // The action cluster's one derivation (card-controls.ts) — every
          // show/disabled rule lives there, unit-tested; the JSX below reads
          // `controls.x` and nothing else.
          const controls = agentCardControls({
            agent: a,
            config,
            matrix,
            authMethods: state.authMethods[id] ?? [],
            update: state.updates[id],
            verifying: state.verifyingAgents[id] === true,
          });
          const saveConfig = (patch: Partial<AgentConfigView>) =>
            props.onSave({ ...effectiveConfig, ...patch });
          // One normalized knob list (the orchestrator's knobs.ts already
          // resolved the wire's modes/configOptions split) — no dedup here.
          const offeredKnobs = knobs?.knobs ?? [];
          const setKnobDefault = (knobId: string, value: string | boolean) => {
            const defaults = { ...effectiveConfig.defaults };
            if (value === "") delete defaults[knobId];
            else defaults[knobId] = value;
            saveConfig({ defaults });
          };
          // Saved selections the current connection doesn't offer (a model
          // retired, an option gone) — stated, never silently blanked; apply
          // time already guards per session.
          const savedNotOffered: string[] = [];
          if (knobs !== undefined) {
            for (const [knobId, value] of Object.entries(effectiveConfig.defaults)) {
              const offered = offeredKnobs.find((k) => k.id === knobId);
              const valueOffered =
                offered !== undefined &&
                (offered.type === "boolean"
                  ? typeof value === "boolean"
                  : typeof value === "string" && offered.values.some((v) => v.value === value));
              if (!valueOffered) savedNotOffered.push(`${knobId}=${String(value)}`);
            }
          }
          return (
            <SortableItem key={id} id={id} disabled={config === undefined}>
              {(handle) => (
                <div className="card">
                  {/* flex-wrap + min-w-0: at narrow widths the action cluster wraps
                      to its own line instead of pushing past the card border */}
                  <div className="row flex-wrap">
                    {handle}
                    <span className={`dot ${status}`} />
                    <AgentIcon icon={registry?.icon} />
                    <span className="nm min-w-0">{a?.name ?? effectiveConfig.name}</span>
                    {controls.upgrade !== null && (
                      <UpgradeChip
                        agentName={a?.name ?? effectiveConfig.name}
                        update={controls.upgrade}
                        onUpgrade={() => props.onUpgrade(id)}
                      />
                    )}
                    <span className="flex-1" />
                    {controls.login.show && (
                      <LoginControl agentId={id} methods={state.authMethods[id] ?? []} disabled={controls.login.disabled} onAuthenticate={props.onAuthenticate} />
                    )}
                    {/* Log out is *disabled* — never unmounted — while in flight,
                        so the open AlertDialog is never yanked from the tree. */}
                    {controls.logout.show && (
                      <ConfirmButton
                        label="Log out"
                        icon="sign-out"
                        title="Active sessions may start failing with auth errors until you log in again."
                        disabled={controls.logout.disabled}
                        onConfirm={() => props.onLogout(id)}
                      />
                    )}
                    {controls.stop.show && (
                      <Button variant="outline" size="icon" className="size-8" title="Stop" aria-label="Stop" onClick={() => props.onStop(id)}>
                        <Icon name="debug-stop" />
                      </Button>
                    )}
                    {controls.verify.show && (
                      <Button
                        variant="outline" size="icon" className="size-8"
                        title={controls.verify.busy ? "Verifying…" : "Verify…"}
                        aria-label="Verify"
                        disabled={controls.verify.disabled}
                        onClick={() => setDiagFor(id)}
                      >
                        <Icon name={controls.verify.busy ? "loading" : "beaker"} spin={controls.verify.busy} />
                      </Button>
                    )}
                    {controls.connect.show && (
                      <Button variant="outline" size="icon" className="size-8" title="Connect" aria-label="Connect" onClick={() => props.onConnectConfigured(id)}>
                        <Icon name="plug" />
                      </Button>
                    )}
                    {controls.edit.show && (
                      <Button variant="outline" size="icon" className="size-8" title="Edit" aria-label="Edit" onClick={() => setEditing(id)}>
                        <Icon name="edit" />
                      </Button>
                    )}
                    {controls.remove.show && (
                      <ConfirmButton
                        label="Remove"
                        icon="trash"
                        title="stops the agent and forgets it — config, env, and capability cache"
                        onConfirm={() => props.onRemove(id)}
                      />
                    )}
                    <Button
                      variant="outline" size="icon" className="size-8"
                      title={detailsOpen ? "Hide settings" : "Settings"}
                      aria-label={detailsOpen ? "Hide settings" : "Settings"}
                      aria-expanded={detailsOpen}
                      onClick={() => {
                        if (editing === id) setEditing(null);
                        setOpenDetails({ ...openDetails, [id]: !detailsOpen });
                        // Opening is derived (expanded ∧ running — the effect
                        // above); collapsing is this click, stated once.
                        if (detailsOpen) props.onEditDefaults(id, false);
                      }}
                    >
                      <Icon name={detailsOpen ? "chevron-up" : "settings-gear"} />
                    </Button>
                  </div>
                  {/* The auth_required error's own message — the agent's login
                      instruction in its words, and the only guidance there is when
                      it declares no actionable method (Auggie names the exact CLI
                      command here). */}
                  {a?.needsAuth === true && a.authReason !== undefined && (
                    <div className="note mt-1.5">
                      <Icon name="info" /> {a.authReason}
                    </div>
                  )}
                  {/* The connect warmup's honest phase label ("downloading the
                      agent package…") — pool.ts sets it only while a launcher
                      download is genuinely in flight, and clears it itself. */}
                  {status === "reconnecting" && a?.detail !== undefined && (
                    <div className="note mt-1.5">
                      <Icon name="cloud-download" /> {a.detail}
                    </div>
                  )}
                  {status === "crashed" && (
                    <div className="note crashed-note mt-1.5">
                      <Icon name="warning" /> crashed{a?.detail !== undefined ? ` — ${a.detail}` : ""}
                      <Button variant="outline" size="sm" className="ml-2" onClick={() => props.onRestart(id)}>
                        Restart
                      </Button>
                      {a?.stderr !== undefined && a.stderr.length > 0 && (
                        <pre className="stderr-tail">{a.stderr.join("\n")}</pre>
                      )}
                    </div>
                  )}
                  {detailsOpen && command !== undefined && (
                    <div className="mono mt-1.5">
                      {command}
                    </div>
                  )}
                  {detailsOpen && matrix !== undefined && (
                    <div className="note mt-1.5">
                      {capabilityOneLiner(matrix)}
                    </div>
                  )}
                  {!detailsOpen ? null : editing === id ? (
                    <AgentConfigForm
                      initial={effectiveConfig}
                      onSave={(c) => {
                        props.onSave(c);
                        setEditing(null);
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    // one knob per line — process policy, then mode/model/effort/…
                    // (whatever the agent actually offered), never a wrap soup
                    <div className="mt-2 flex flex-col items-start gap-2">
                      <label className="knob-default">
                        process
                        <Select
                          value={effectiveConfig.processPolicy}
                          onValueChange={(v) =>
                            saveConfig({ processPolicy: v as AgentConfigView["processPolicy"] })
                          }
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">
                              auto — {concurrencyUsed ? "shared, concurrency used ✓" : "isolated, not yet used"}
                            </SelectItem>
                            <SelectItem value="shared">shared</SelectItem>
                            <SelectItem value="isolated">isolated</SelectItem>
                          </SelectContent>
                        </Select>
                      </label>
                      <Toggle
                        icon="zap"
                        label="auto-connect"
                        title="connect this agent when the window opens"
                        checked={effectiveConfig.autoConnect}
                        onChange={(v) => saveConfig({ autoConnect: v })}
                      />
                      {status !== "running" ? (
                        // Offerings are connection state — no connection, no list
                        // to render, only the stored selections stated as text.
                        <StoredDefaultsLine defaults={effectiveConfig.defaults} />
                      ) : knobs === undefined ? (
                        // Connected, the editor's session still opening —
                        // pending, not "none".
                        <span className="note m-0 self-center">
                          reading this agent's knob offering…
                        </span>
                      ) : knobs.unavailable !== undefined ? (
                        <span className="note m-0 self-center">{knobs.unavailable}</span>
                      ) : (
                        <>
                          {offeredKnobs.map((knob) => (
                            <DefaultKnob
                              key={knob.id}
                              icon={(knob.category !== undefined ? KNOB_ICON[knob.category] : undefined) ?? "settings"}
                              label={knob.name}
                              offered={knob.type === "boolean" ? null : knob.values}
                              value={effectiveConfig.defaults[knob.id] ?? ""}
                              onChange={(v) => setKnobDefault(knob.id, v)}
                            />
                          ))}
                          {offeredKnobs.length === 0 && (
                            <span className="note m-0 self-center">
                              this agent offered no session knobs
                            </span>
                          )}
                          {savedNotOffered.length > 0 && (
                            <span className="note m-0 self-center">
                              saved but not currently offered: {savedNotOffered.join(" · ")} — applied
                              only where a session actually offers it
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </SortableItem>
          );
        })}
      </SortableList>
      <Dialog open={diagFor !== null} onOpenChange={(open) => { if (!open) setDiagFor(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Verify — cost disclosed first</DialogTitle>
            <DialogDescription>
              Re-runs the free protocol checks (a session/new + session/fork round-trip in an
              ephemeral temp-directory session — never your workspace). Today
              this consumes <b>no agent turns</b>. Behavior-level probes that
              would spend real turns don't exist yet; when they ship, their
              cost appears here before anything runs.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              onClick={() => {
                props.onVerify(diagFor!);
                setDiagFor(null);
              }}
            >
              Run
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDiagFor(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
