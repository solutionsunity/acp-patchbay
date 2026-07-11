// § Agents (ui.md § Settings): stat tiles + Add Agent, one card per known
// agent — status live, capabilities claimed-until-exercised, write-only env,
// knobs offering only what the agent actually offered.
import { useState, type ReactNode } from "react";
import type { AgentConfigView, AgentSummary, AuthMethodView, RosterEntry, SettingsState } from "../../shared/protocol";
import { hasUnusedProbe } from "../../shared/protocol";
import { capabilityOneLiner } from "../shared/capability-format";
import { Icon } from "../shared/icon";
import { ConfirmButton, Field, FidelityChip, Toggle } from "./controls";
import { parseEnvLines } from "./parse-env";
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
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  envKeys: [],
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
 * orchestrator's job (render-only-webview) — it's sent raw, args empty.
 * Env is write-only: values live in SecretStorage and never reach this
 * webview, so existing vars render as bare `KEY=` lines — leave one blank
 * to keep its stored value, fill it to overwrite, delete the line to remove
 * the variable. Default model/mode/effort deliberately do NOT appear here:
 * the card's knob selects own them, offering only what the agent has
 * actually offered — a free-text duplicate would let the user type options
 * that don't exist. */
function AgentConfigForm(props: {
  initial: AgentConfigView;
  onSave(config: AgentConfigView, env: Record<string, string>): void;
  onCancel(): void;
}) {
  const [id, setId] = useState(props.initial.id);
  const [name, setName] = useState(props.initial.name);
  const [command, setCommand] = useState(displayCommandLine(props.initial.command, props.initial.args));
  const [processPolicy, setProcessPolicy] = useState(props.initial.processPolicy);
  const [autoConnect, setAutoConnect] = useState(props.initial.autoConnect);
  const [envText, setEnvText] = useState(props.initial.envKeys.map((k) => `${k}=`).join("\n"));

  const save = () => {
    if (id.trim() === "" || name.trim() === "" || command.trim() === "") return;
    const env = parseEnvLines(envText);
    props.onSave(
      {
        id: id.trim(),
        name: name.trim(),
        command: command.trim(),
        args: [],
        envKeys: Object.keys(env),
        processPolicy,
        autoConnect,
        defaults: props.initial.defaults,
        registrySource: props.initial.registrySource,
        lastSeenVersion: props.initial.lastSeenVersion,
      },
      env,
    );
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
      <Field label="environment variables" hint="KEY=value, one per line">
        <Textarea
          rows={3}
          className="resize-y"
          placeholder={"MY_API_KEY=…"}
          value={envText}
          onInput={(e) => setEnvText((e.target as HTMLTextAreaElement).value)}
        />
      </Field>
      <div className="note">
        values are stored in VS Code SecretStorage and never shown back — a bare <code>KEY=</code>{" "}
        keeps the stored value, <code>KEY=newvalue</code> overwrites it, deleting the line removes
        the variable
      </div>
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
  // parses on save (render-only-webview: no parsing here).
  return {
    id: agent.id,
    name: agent.name,
    command: (agent.command ?? "").trim(),
    args: [],
    envKeys: [],
    processPolicy: "auto",
    autoConnect: false,
    defaults: {},
    registrySource: null,
    lastSeenVersion: null,
  };
}

/** Registry version vs. what this config is pinned to — null when there's
 * nothing to compare (custom command, local-only roster entry, or already
 * current). Never auto-applied: Upgrade is always the user's own click. */
function updateAvailable(state: SettingsState, config: AgentConfigView | undefined): { from: string; to: string } | null {
  if (config?.registrySource == null) return null;
  const latest = state.roster.find((r) => r.id === config.id)?.registryVersion;
  if (latest == null || latest === config.registrySource.pinnedVersion) return null;
  return { from: config.registrySource.pinnedVersion, to: latest };
}

/** Searchable roster picker (ui.md § Settings Agents "Add Agent" — full
 * scenario: type to filter, click to pick, clear to search again). Fully
 * controlled — the only local state is whether the dropdown is open, so a
 * parent reset (after Add, or on mode toggle) can't leave it out of sync. */
function RosterCombobox(props: {
  entries: readonly RosterEntry[];
  query: string;
  selectedId: string;
  onQueryChange(query: string): void;
  onSelect(rosterId: string): void; // "" clears the selection
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
            {selected !== undefined ? selected.name : "search roster…"}
            <Icon name="chevron-down" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput
              placeholder="search roster…"
              value={props.query}
              onValueChange={(q) => {
                props.onQueryChange(q);
                if (props.selectedId !== "") props.onSelect("");
              }}
            />
            <CommandList>
              <CommandEmpty>
                {props.entries.length === 0
                  ? "no roster entries — try Refresh roster"
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

/** Roster search or custom command (ui.md § Settings Agents) — the one way
 * to add an agent, which is also how it's activated: persisted, connected,
 * and (by default) Verified in one action. Already-configured roster ids
 * are excluded here — their own card below is the way back to them. The two
 * ways of naming an agent are mutually exclusive modes behind one toggle,
 * never two half-filled fields at once. */
function AddAgentRow(props: {
  state: SettingsState;
  onAdd(source: { rosterId: string } | { command: string }, verifyAfterConnect: boolean): void;
  onRefreshRoster(): void;
}) {
  const configuredIds = new Set(props.state.agentConfigs.map((c) => c.id));
  const available = props.state.roster.filter((r) => !configuredIds.has(r.id));
  const [mode, setMode] = useState<"roster" | "custom">("roster");
  const [rosterQuery, setRosterQuery] = useState("");
  const [rosterId, setRosterId] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [verifyAfterAdd, setVerifyAfterAdd] = useState(true);

  const canAdd = mode === "roster" ? rosterId !== "" : customCommand.trim() !== "";

  const resetFields = () => {
    setRosterQuery("");
    setRosterId("");
    setCustomCommand("");
  };

  const add = () => {
    if (mode === "roster" && rosterId !== "") {
      props.onAdd({ rosterId }, verifyAfterAdd);
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
          onClick={props.onRefreshRoster}
          title="Re-check the official ACP registry for new agents and versions"
        >
          <Icon name="refresh" /> Refresh roster
        </Button>
      </div>
      {props.state.registryUpdatedAt !== "" && (
        <div className="note mx-0 mb-0 mt-1">
          registry last checked {new Date(props.state.registryUpdatedAt).toLocaleString()}
        </div>
      )}
      <div className="connect-form mt-2">
        {mode === "roster" ? (
          <RosterCombobox
            entries={available}
            query={rosterQuery}
            selectedId={rosterId}
            onQueryChange={setRosterQuery}
            onSelect={setRosterId}
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
            setMode(mode === "roster" ? "custom" : "roster");
            resetFields();
          }}
        >
          {mode === "roster" ? "Add custom…" : "Add from list"}
        </Button>
        <label className="row gap-1.5">
          <Checkbox
            checked={verifyAfterAdd}
            onCheckedChange={(v) => setVerifyAfterAdd(v === true)}
          />
          Verify after add
        </label>
      </div>
    </div>
  );
}

/** No checksum exists for a registry `binary` distribution (FORMAT.md) —
 * the first download of each (agent, version) gets an explicit, visible
 * confirmation, never a silent fetch-and-run. */
function BinaryInstallModal(props: {
  install: { agentId: string; name: string; archiveUrl: string; cmd: string };
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) props.onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Download required — {props.install.name}</AlertDialogTitle>
          <AlertDialogDescription>
            No checksum exists for this download in the ACP registry — patchbay will fetch it over
            HTTPS and run what's inside. This happens once per version; cached afterward.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="mono">{props.install.archiveUrl}</div>
        <AlertDialogFooter>
          <AlertDialogAction className={buttonVariants({ size: "sm" })} onClick={props.onConfirm}>
            Download &amp; run
          </AlertDialogAction>
          <AlertDialogCancel onClick={props.onCancel}>Cancel</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** `needsAuth` gate (protocol.ts): only "agent"-kind auth methods (the
 * stable default — the agent handles auth itself via `authenticate`) are
 * actionable; "env_var"/"terminal" are both UNSTABLE ACP capabilities,
 * declared but never wired to a button. */
function LoginControl(props: {
  agentId: string;
  methods: readonly AuthMethodView[];
  onAuthenticate(agentId: string, methodId: string): void;
}) {
  const actionable = props.methods.filter((m) => m.kind === "agent");
  const [methodId, setMethodId] = useState(actionable[0]?.id ?? "");
  if (actionable.length === 0) {
    return (
      <span className="note crashed-note">
        <Icon name="warning" /> needs login — no stable auth method available
      </span>
    );
  }
  const selected = actionable.find((m) => m.id === methodId) ?? actionable[0]!;
  return (
    <span className="row gap-1.5">
      {actionable.length > 1 && (
        <Select value={methodId} onValueChange={setMethodId}>
          <SelectTrigger><SelectValue /></SelectTrigger>
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
        onClick={() => props.onAuthenticate(props.agentId, selected.id)}
      >
        Log in
      </Button>
    </span>
  );
}

/** Stat tiles + whatever rides the same row (the Add Agent tile-button) —
 * one container so they share sizing and rhythm. The first surface converted
 * to shadcn primitives (P13a — the first converted surface). */
const TILE = "min-w-24 flex-none rounded-lg px-4 py-2.5 text-center";

export function StatTiles({ state, children }: { state: SettingsState; children?: ReactNode }) {
  const running = state.agents.filter((a) => a.status === "running").length;
  const tiles = [
    { n: state.agents.length, label: "agents", icon: "hubot" },
    { n: running, label: "running", icon: "pulse" },
    { n: state.sessionsToday, label: "sessions today", icon: "comment-discussion" },
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
  onAddAgent(source: { rosterId: string } | { command: string }, verifyAfterConnect: boolean): void;
  onSave(config: AgentConfigView, env: Record<string, string>): void;
  onRemove(agentId: string): void;
  onStop(agentId: string): void;
  onRestart(agentId: string): void;
  onAuthenticate(agentId: string, methodId: string): void;
  onLogout(agentId: string): void;
  onUpgrade(agentId: string): void;
  onRefreshRoster(): void;
  onConfirmBinaryInstall(agentId: string): void;
  onCancelBinaryInstall(agentId: string): void;
}) {
  const { state } = props;
  const [editing, setEditing] = useState<string | null>(null); // agentId being edited
  const [diagFor, setDiagFor] = useState<string | null>(null);
  // Card body (command line, capabilities, knobs) is collapsed by default —
  // the header row carries status and actions; the gear opens the rest.
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});

  // One card per known agent id — the union of connected-this-session
  // (state.agents) and persisted (state.agentConfigs); Add always persists,
  // so in steady state every agent has both. No more separate "workspace
  // configs" list — one roster of cards, not two.
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
          onRefreshRoster={props.onRefreshRoster}
        />
      )}
      {state.pendingBinaryInstall !== null && (
        <BinaryInstallModal
          install={state.pendingBinaryInstall}
          onConfirm={() => props.onConfirmBinaryInstall(state.pendingBinaryInstall!.agentId)}
          onCancel={() => props.onCancelBinaryInstall(state.pendingBinaryInstall!.agentId)}
        />
      )}
      {ids.length === 0 && (
        <div className="card">
          <div className="note m-0">
            No agents yet — add one above.
          </div>
        </div>
      )}
      {ids.map((id) => {
        const a = state.agents.find((x) => x.id === id);
        const config = state.agentConfigs.find((c) => c.id === id);
        const effectiveConfig: AgentConfigView = config ?? (a !== undefined ? configFor(state, a) : EMPTY_AGENT_CONFIG);
        const matrix = state.capabilities[id];
        const roster = state.roster.find((r) => r.id === id);
        const knobs = state.agentKnobs[id];
        const concurrencyUsed = matrix?.concurrentSessions?.used ?? false;
        // No summary at all = the orchestrator never saw this config — the
        // honest unknown is "untested", never a claimed "stopped" (P16).
        const status = a?.status ?? "untested";
        const command = a?.command ?? (config !== undefined ? [config.command, ...config.args].join(" ") : undefined);
        const upgrade = updateAvailable(state, config);
        // Editing forces the body open — the form lives there.
        const detailsOpen = openDetails[id] === true || editing === id;
        // Same predicate the orchestrator's own automatic post-connect/
        // reconnect retry gates on (capability-tracker.ts) — centralized in
        // protocol.ts so "does this still need a check" can't drift between
        // the two call sites. needsAuth is folded in on top: even with no
        // outstanding probe row, an agent stuck needing auth (e.g. no stable
        // login method for patchbay to drive) still needs a manual escape
        // hatch to re-check once the user resolves it out of band.
        const needsVerify =
          a?.needsAuth === true ||
          (matrix !== undefined && hasUnusedProbe(matrix, state.authMethods[id] ?? []));
        // Inline knob/policy edits never touch env — submit every existing
        // key blank, the "keep the stored value" signal (write-only env).
        const saveConfig = (patch: Partial<AgentConfigView>) =>
          props.onSave(
            { ...effectiveConfig, ...patch },
            Object.fromEntries(effectiveConfig.envKeys.map((k) => [k, ""])),
          );
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
          <div className="card" key={id}>
            {/* flex-wrap + min-w-0: at narrow widths the action cluster wraps
                to its own line instead of pushing past the card border */}
            <div className="row flex-wrap">
              <span className={`dot ${status}`} />
              <span className="nm min-w-0">{a?.name ?? effectiveConfig.name}</span>
              {matrix !== undefined && (
                <FidelityChip matrix={matrix} knownBypassBridge={roster?.knownBypassBridge ?? false} />
              )}
              {upgrade !== null && (
                <Badge className="border-warn/40 text-warn" title={`registry has v${upgrade.to}, pinned to v${upgrade.from}`}>
                  update available
                </Badge>
              )}
              <span className="flex-1" />
              {a?.needsAuth === true && (
                <LoginControl agentId={id} methods={state.authMethods[id] ?? []} onAuthenticate={props.onAuthenticate} />
              )}
              {status === "running" && (
                <>
                  {/* Offered only on a declared auth.logout — the spec's
                      "Clients MUST NOT call it" otherwise. Hidden while
                      needsAuth: nothing to log out of. */}
                  {a?.needsAuth !== true && matrix?.["auth.logout"]?.declared === true && (
                    <ConfirmButton
                      label="Log out"
                      icon="sign-out"
                      title="Active sessions may start failing with auth errors until you log in again."
                      onConfirm={() => props.onLogout(id)}
                    />
                  )}
                  <Button variant="outline" size="icon" className="size-8" title="Stop" aria-label="Stop" onClick={() => props.onStop(id)}>
                    <Icon name="debug-stop" />
                  </Button>
                  {needsVerify && (
                    <Button
                      variant="outline" size="icon" className="size-8"
                      title={state.verifyingAgents[id] === true ? "Verifying…" : "Verify…"}
                      aria-label="Verify"
                      disabled={state.verifyingAgents[id] === true}
                      onClick={() => setDiagFor(id)}
                    >
                      <Icon name={state.verifyingAgents[id] === true ? "loading" : "beaker"} spin={state.verifyingAgents[id] === true} />
                    </Button>
                  )}
                </>
              )}
              {status !== "running" && config !== undefined && (
                <Button variant="outline" size="icon" className="size-8" title="Connect" aria-label="Connect" onClick={() => props.onConnectConfigured(id)}>
                  <Icon name="plug" />
                </Button>
              )}
              {upgrade !== null && (
                <Button variant="outline" size="icon" className="size-8" title={`Upgrade to v${upgrade.to}`} aria-label={`Upgrade to v${upgrade.to}`} onClick={() => props.onUpgrade(id)}>
                  <Icon name="arrow-circle-up" />
                </Button>
              )}
              <Button variant="outline" size="icon" className="size-8" title="Edit" aria-label="Edit" onClick={() => setEditing(id)}>
                <Icon name="edit" />
              </Button>
              {config !== undefined && (
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
              <div className="mono mt-1.5 break-all">
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
                onSave={(c, env) => {
                  props.onSave(c, env);
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
                  // Connected but the connect-time offering read hasn't
                  // landed (or is blocked on login) — pending, not "none".
                  <span className="note m-0 self-center">
                    reading this agent's knob offering…
                  </span>
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
        );
      })}
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
