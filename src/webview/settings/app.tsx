// Settings shell — left nav + cards (ui.md § Settings). Sections fill in with
// their phases: agents/matrix (P5), integrations (P9), permissions (P6),
// rules·skills·commands (P10). Empty states are honest, never placeholders
// pretending to be data.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type {
  AgentAssetsView,
  AgentConfigView,
  AgentSummary,
  AssetCategoryView,
  CapabilityMatrix,
  CapabilityRowId,
  CommandRuleView,
  FidelityLabel,
  FileWriteScopeView,
  IntegrationRoutingView,
  IntegrationSourceView,
  RosterEntry,
  SettingsState,
} from "../../shared/protocol";
import { capabilityState, computeFidelity, hasUnusedProbe } from "../../shared/protocol";
import { capabilityOneLiner, FIDELITY_CLASS, FIDELITY_TEXT } from "../shared/capability-format";
import type { ViewChannel } from "../shared/channel";
import { Icon } from "../shared/icon";

/** Grouped by what the group *is*, not by theme: "This machine" is the
 * global wiring (agents, integrations, and the matrix observing them —
 * globalState/SecretStorage), "Trust" is the permission surface (spans the
 * machine floor and this workspace's rules), "This workspace" is what lives
 * in the workspace itself (asset files the agent reads from its own cwd).
 * The nav teaches the placement contract instead of captioning it. */
const NAV_GROUPS = [
  {
    label: "This machine",
    items: [
      { id: "agents", icon: "plug", label: "Agents" },
      { id: "matrix", icon: "table", label: "Capability matrix" },
      { id: "integrations", icon: "server", label: "MCP Servers" },
    ],
  },
  {
    label: "Trust",
    items: [{ id: "permissions", icon: "shield", label: "Permissions" }],
  },
  {
    label: "This workspace",
    items: [{ id: "assets", icon: "note", label: "Rules · skills · commands" }],
  },
] as const;

type SectionId = (typeof NAV_GROUPS)[number]["items"][number]["id"];

export function App({ channel }: { channel: ViewChannel<SettingsState> }) {
  const state = channel.getState()?.state ?? null;
  const [section, setSection] = useState<SectionId>("agents");

  if (state === null) return null;

  return (
    <div class="layout">
      <nav class="nav">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div class="grp">{group.label}</div>
            {group.items.map((s) => (
              <div
                key={s.id}
                class={`it ${section === s.id ? "on" : ""}`}
                onClick={() => setSection(s.id)}
              >
                <Icon name={s.icon} /> {s.label}
              </div>
            ))}
          </div>
        ))}
        <div class="foot">
          agents &amp; integrations: global (this machine)
          <br />
          never repo-committed
          <br />
          credentials: SecretStorage only
        </div>
      </nav>
      <main class="main">
        {section === "agents" && (
          <AgentsSection
            state={state}
            onVerify={(agentId) => channel.sendAction({ kind: "verifyAgent", agentId })}
            onConnectConfigured={(agentId) =>
              channel.sendAction({ kind: "connectAgent", source: { configuredId: agentId } })
            }
            onAddAgent={(source, verifyAfterConnect) =>
              channel.sendAction({ kind: "connectAgent", source, verifyAfterConnect })
            }
            onSave={(config, env) => channel.sendAction({ kind: "addOrUpdateAgentConfig", config, env })}
            onRemove={(agentId) => channel.sendAction({ kind: "removeAgentConfig", agentId })}
            onStop={(agentId) => channel.sendAction({ kind: "stopAgent", agentId })}
            onRestart={(agentId) => channel.sendAction({ kind: "restartAgent", agentId })}
            onAuthenticate={(agentId, methodId) =>
              channel.sendAction({ kind: "authenticateAgent", agentId, methodId })
            }
            onUpgrade={(agentId) => channel.sendAction({ kind: "upgradeAgent", agentId })}
            onRefreshRoster={() => channel.sendAction({ kind: "refreshRoster" })}
            onConfirmBinaryInstall={(agentId) =>
              channel.sendAction({ kind: "confirmBinaryInstall", agentId })
            }
            onCancelBinaryInstall={(agentId) =>
              channel.sendAction({ kind: "cancelBinaryInstall", agentId })
            }
          />
        )}
        {section === "matrix" && <MatrixSection state={state} />}
        {section === "integrations" && (
          <IntegrationsSection
            state={state}
            onConnectKey={(registryId, token, url) =>
              channel.sendAction({ kind: "connectRegistryKey", registryId, token, url })
            }
            onConnectOAuth={(registryId, url) =>
              channel.sendAction({ kind: "connectRegistryOAuth", registryId, url })
            }
            onAddCustom={(name, source, routing) =>
              channel.sendAction({ kind: "addCustomIntegration", name, source, routing })
            }
            onImportJson={(json) => channel.sendAction({ kind: "importIntegrationsJson", json })}
            onUpdateJson={(integrationId, json) =>
              channel.sendAction({ kind: "updateIntegrationJson", integrationId, json })
            }
            onCancelConnect={(integrationId) =>
              channel.sendAction({ kind: "cancelIntegrationConnect", integrationId })
            }
            onSetActive={(integrationId, active) =>
              channel.sendAction({ kind: "setIntegrationActive", integrationId, active })
            }
            onRemove={(integrationId) => channel.sendAction({ kind: "removeIntegration", integrationId })}
            onSetRouting={(integrationId, routing) =>
              channel.sendAction({ kind: "setIntegrationRouting", integrationId, routing })
            }
            onShare={(integrationId) => channel.sendAction({ kind: "shareIntegrationConfig", integrationId })}
          />
        )}
        {section === "permissions" && (
          <PermissionsSection
            state={state}
            onAddRule={(rule, layer) => channel.sendAction({ kind: "addCommandRule", rule, layer })}
            onRemoveRule={(pattern, layer) =>
              channel.sendAction({ kind: "removeCommandRule", pattern, layer })
            }
            onSetScope={(scope) => channel.sendAction({ kind: "setFileWriteScope", scope })}
          />
        )}
        {section === "assets" && (
          <AssetsSection
            state={state}
            onRefresh={(agentId) => channel.sendAction({ kind: "refreshAgentAssets", agentId })}
            onOpen={(agentId, path) => channel.sendAction({ kind: "openAssetFile", agentId, path })}
          />
        )}
      </main>
    </div>
  );
}

/** Labeled form field — one row: label column | control column. */
function Field(props: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="field" title={props.hint}>
      <span class="lbl">{props.label}</span>
      {props.children}
    </label>
  );
}

/** Two-step destructive button: first click arms it, second confirms;
 * anything else (blur, 4s) disarms. Confirmation without a modal. */
function ConfirmButton(props: { label: string; confirmLabel?: string; title?: string; onConfirm(): void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      class={`btn ${armed ? "danger" : ""}`}
      title={props.title}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 4000);
          return;
        }
        setArmed(false);
        props.onConfirm();
      }}
    >
      {armed ? (props.confirmLabel ?? `Confirm ${props.label.toLowerCase()}?`) : props.label}
    </button>
  );
}

/** The active/inactive mute switch — a real toggle, not a bare checkbox. */
function Toggle(props: { checked: boolean; label: string; title?: string; onChange(checked: boolean): void }) {
  return (
    <label class="switch" title={props.title}>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)}
      />
      <span class="track" />
      {props.label}
    </label>
  );
}

function Section(props: { title: string; sub: string; empty: string }) {
  return (
    <section class="section">
      <h1>{props.title}</h1>
      <div class="sub">{props.sub}</div>
      <div class="card">
        <div class="note" style="margin:0">
          {props.empty}
        </div>
      </div>
    </section>
  );
}

function FidelityChip({ matrix, knownBypassBridge }: { matrix: CapabilityMatrix; knownBypassBridge: boolean }) {
  const label = computeFidelity(matrix, knownBypassBridge);
  return <span class={`fid ${FIDELITY_CLASS[label]}`}>{FIDELITY_TEXT[label]}</span>;
}

const EMPTY_AGENT_CONFIG: AgentConfigView = {
  id: "",
  name: "",
  command: "",
  args: [],
  envKeys: [],
  processPolicy: "auto",
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
  const [envText, setEnvText] = useState(props.initial.envKeys.map((k) => `${k}=`).join("\n"));

  const save = () => {
    if (id.trim() === "" || name.trim() === "" || command.trim() === "") return;
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue; // blank or not KEY=value — nothing to submit
      env[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
    props.onSave(
      {
        id: id.trim(),
        name: name.trim(),
        command: command.trim(),
        args: [],
        envKeys: Object.keys(env),
        processPolicy,
        defaults: props.initial.defaults,
        registrySource: props.initial.registrySource,
        lastSeenVersion: props.initial.lastSeenVersion,
      },
      env,
    );
  };

  return (
    <div class="connect-form">
      <Field label="id" hint="the storage key — fixed once created">
        <input type="text" placeholder="id (unique)" value={id} disabled={props.initial.id !== ""} onInput={(e) => setId((e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="name">
        <input type="text" placeholder="display name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="command" hint="command and args — quotes supported">
        <input
          type="text"
          placeholder="npx some-acp-agent --flag"
          value={command}
          onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Field label="process policy">
        <select value={processPolicy} onChange={(e) => setProcessPolicy((e.target as HTMLSelectElement).value as AgentConfigView["processPolicy"])}>
          <option value="auto">auto</option>
          <option value="shared">shared</option>
          <option value="isolated">isolated</option>
        </select>
      </Field>
      <Field label="environment variables" hint="KEY=value, one per line">
        <textarea
          rows={3}
          style="resize:vertical"
          placeholder={"MY_API_KEY=…"}
          value={envText}
          onInput={(e) => setEnvText((e.target as HTMLTextAreaElement).value)}
        />
      </Field>
      <div class="note">
        values are stored in VS Code SecretStorage and never shown back — a bare <code>KEY=</code>{" "}
        keeps the stored value, <code>KEY=newvalue</code> overwrites it, deleting the line removes
        the variable
      </div>
      <div class="form-actions">
        <button class="btn primary row-btn" onClick={save}>
          Save
        </button>
        <button class="btn row-btn" onClick={props.onCancel}>
          Cancel
        </button>
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
  const needle = props.query.trim().toLowerCase();
  const filtered = props.entries.filter((r) => r.name.toLowerCase().includes(needle));

  const pick = (r: RosterEntry) => {
    if (r.unavailableReason !== null) return;
    props.onSelect(r.id);
    props.onQueryChange(r.name);
    setOpen(false);
  };

  return (
    <div class="combobox">
      <input
        type="text"
        placeholder="search roster…"
        value={props.query}
        onFocus={() => setOpen(true)}
        onInput={(e) => {
          props.onQueryChange((e.target as HTMLInputElement).value);
          if (props.selectedId !== "") props.onSelect("");
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter") {
            const only = filtered.filter((r) => r.unavailableReason === null);
            if (only.length === 1) pick(only[0]!);
          }
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
      />
      {props.selectedId !== "" && (
        <span
          class="e"
          role="button"
          tabIndex={0}
          aria-label="Clear selection"
          onClick={() => {
            props.onSelect("");
            props.onQueryChange("");
          }}
        >
          <Icon name="close" />
        </span>
      )}
      {open && (
        <div class="combobox-list">
          {filtered.length === 0 &&
            (props.entries.length === 0 ? (
              <div class="combobox-empty note">no roster entries — try Refresh roster</div>
            ) : (
              <div class="combobox-empty note">no matches for “{props.query}”</div>
            ))}
          {filtered.map((r) => (
            <div
              key={r.id}
              class={`combobox-opt ${r.unavailableReason !== null ? "disabled" : ""} ${
                r.id === props.selectedId ? "sel" : ""
              }`}
              title={r.description}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(r)}
            >
              {r.name}
              {r.unavailableReason !== null && <span class="note"> — {r.unavailableReason}</span>}
            </div>
          ))}
        </div>
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
    <div class="card">
      <div class="row">
        <h2 style="margin:0">+ Add Agent</h2>
        <span style="flex:1" />
        <button
          class="btn"
          onClick={props.onRefreshRoster}
          title="Re-check the official ACP registry for new agents and versions"
        >
          <Icon name="refresh" /> Refresh roster
        </button>
      </div>
      {props.state.registryUpdatedAt !== "" && (
        <div class="note" style="margin:4px 0 0">
          registry last checked {new Date(props.state.registryUpdatedAt).toLocaleString()}
        </div>
      )}
      <div class="connect-form" style="margin-top:8px">
        {mode === "roster" ? (
          <RosterCombobox
            entries={available}
            query={rosterQuery}
            selectedId={rosterId}
            onQueryChange={setRosterQuery}
            onSelect={setRosterId}
          />
        ) : (
          <input
            type="text"
            style="width:100%"
            placeholder="custom command that speaks ACP…"
            value={customCommand}
            onInput={(e) => setCustomCommand((e.target as HTMLInputElement).value)}
          />
        )}
      </div>
      <div class="row" style="margin-top:8px;gap:8px;flex-wrap:wrap">
        <button class="btn primary row-btn" disabled={!canAdd} onClick={add}>
          Add
        </button>
        <button
          class="btn row-btn"
          onClick={() => {
            setMode(mode === "roster" ? "custom" : "roster");
            resetFields();
          }}
        >
          {mode === "roster" ? "Add custom…" : "Add from list"}
        </button>
        <label class="row" style="gap:6px">
          <input
            type="checkbox"
            checked={verifyAfterAdd}
            onChange={(e) => setVerifyAfterAdd((e.target as HTMLInputElement).checked)}
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
    <div class="modal-scrim" onClick={props.onCancel}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style="margin-top:0">Download required — {props.install.name}</h2>
        <div class="note" style="margin:0 0 10px">
          No checksum exists for this download in the ACP registry — patchbay will fetch it over
          HTTPS and run what's inside. This happens once per version; cached afterward.
        </div>
        <div class="mono" style="margin-bottom:10px">
          {props.install.archiveUrl}
        </div>
        <div class="row" style="gap:8px">
          <button class="btn primary" onClick={props.onConfirm}>
            Download &amp; run
          </button>
          <button class="btn" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** `needsAuth` gate (protocol.ts): only "agent"-kind auth methods (the
 * stable default — the agent handles auth itself via `authenticate`) are
 * actionable; "env_var"/"terminal" are both UNSTABLE ACP capabilities,
 * declared but never wired to a button. */
function LoginControl(props: {
  agentId: string;
  methods: readonly { id: string; name: string; kind: "agent" | "env_var" | "terminal" }[];
  onAuthenticate(agentId: string, methodId: string): void;
}) {
  const actionable = props.methods.filter((m) => m.kind === "agent");
  const [methodId, setMethodId] = useState(actionable[0]?.id ?? "");
  if (actionable.length === 0) {
    return (
      <span class="note crashed-note">
        <Icon name="warning" /> needs login — no stable auth method available
      </span>
    );
  }
  return (
    <span class="row" style="gap:6px">
      {actionable.length > 1 && (
        <select value={methodId} onChange={(e) => setMethodId((e.target as HTMLSelectElement).value)}>
          {actionable.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      )}
      <button class="btn primary" onClick={() => props.onAuthenticate(props.agentId, methodId || actionable[0]!.id)}>
        Log in
      </button>
    </span>
  );
}

/** Stat tiles + whatever rides the same row (the Add Agent tile-button) —
 * one container so they share sizing and rhythm. */
function StatTiles({ state, children }: { state: SettingsState; children?: ComponentChildren }) {
  const running = state.agents.filter((a) => a.status === "running").length;
  const tiles = [
    { n: state.agents.length, label: "agents" },
    { n: running, label: "running" },
    { n: state.sessionsToday, label: "sessions today" },
  ];
  return (
    <div class="tiles">
      {tiles.map((t) => (
        <div class="tile" key={t.label}>
          <div class="n">{t.n}</div>
          <div class="l">{t.label}</div>
        </div>
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

/** One default-knob select for an option the agent actually offered —
 * patchbay never invents an option, so unoffered knobs simply don't render
 * (the card states the observed reality instead). */
function DefaultKnob(props: {
  icon: string;
  label: string;
  offered: readonly { value: string; name: string }[];
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label class="knob-default">
      <Icon name={props.icon} /> {props.label}
      <select
        value={props.value}
        onChange={(e) => props.onChange((e.target as HTMLSelectElement).value)}
      >
        <option value="">(agent default)</option>
        {props.offered.map((v) => (
          <option key={v.value} value={v.value}>
            {v.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function AgentsSection(props: {
  state: SettingsState;
  onVerify(agentId: string): void;
  onConnectConfigured(agentId: string): void;
  onAddAgent(source: { rosterId: string } | { command: string }, verifyAfterConnect: boolean): void;
  onSave(config: AgentConfigView, env: Record<string, string>): void;
  onRemove(agentId: string): void;
  onStop(agentId: string): void;
  onRestart(agentId: string): void;
  onAuthenticate(agentId: string, methodId: string): void;
  onUpgrade(agentId: string): void;
  onRefreshRoster(): void;
  onConfirmBinaryInstall(agentId: string): void;
  onCancelBinaryInstall(agentId: string): void;
}) {
  const { state } = props;
  const [editing, setEditing] = useState<string | null>(null); // agentId being edited
  const [diagFor, setDiagFor] = useState<string | null>(null);

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
    <section class="section">
      <h1>Agents</h1>
      <div class="sub">
        Any command line that speaks ACP. Status is live; capabilities are
        claimed until exercised.
      </div>
      <StatTiles state={state}>
        <button
          class={`tile add ${addOpen ? "on" : ""}`}
          onClick={() => setAddOpen(!addOpen)}
          aria-expanded={addOpen}
        >
          <div class="n">
            <Icon name={addOpen ? "chevron-up" : "add"} />
          </div>
          <div class="l">{addOpen ? "close" : "add agent"}</div>
        </button>
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
        <div class="card">
          <div class="note" style="margin:0">
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
        const status = a?.status ?? "stopped";
        const command = a?.command ?? (config !== undefined ? [config.command, ...config.args].join(" ") : undefined);
        const upgrade = updateAvailable(state, config);
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
        const modeValues = knobs?.modes?.map((m) => ({ value: m.id, name: m.name })) ?? null;
        const setOptionDefault = (optionId: string, value: string) => {
          const options = { ...effectiveConfig.defaults.options };
          if (value === "") delete options[optionId];
          else options[optionId] = value;
          saveConfig({ defaults: { ...effectiveConfig.defaults, options } });
        };
        return (
          <div class="card" key={id}>
            <div class="row">
              <span class={`dot ${status}`} />
              <span class="nm">{a?.name ?? effectiveConfig.name}</span>
              {matrix !== undefined && (
                <FidelityChip matrix={matrix} knownBypassBridge={roster?.knownBypassBridge ?? false} />
              )}
              {upgrade !== null && (
                <span class="chip" title={`registry has v${upgrade.to}, pinned to v${upgrade.from}`}>
                  update available
                </span>
              )}
              <span style="flex:1" />
              {a?.needsAuth === true && (
                <LoginControl agentId={id} methods={state.authMethods[id] ?? []} onAuthenticate={props.onAuthenticate} />
              )}
              {status === "running" && (
                <>
                  <button class="btn" onClick={() => props.onStop(id)}>
                    Stop
                  </button>
                  {needsVerify && (
                    <button
                      class="btn"
                      disabled={state.verifyingAgents[id] === true}
                      onClick={() => setDiagFor(id)}
                    >
                      {state.verifyingAgents[id] === true ? (
                        <>
                          <Icon name="loading" spin /> Verifying…
                        </>
                      ) : (
                        "Verify…"
                      )}
                    </button>
                  )}
                </>
              )}
              {status !== "running" && config !== undefined && (
                <button class="btn" onClick={() => props.onConnectConfigured(id)}>
                  Connect
                </button>
              )}
              {upgrade !== null && (
                <button class="btn" onClick={() => props.onUpgrade(id)}>
                  Upgrade to v{upgrade.to}
                </button>
              )}
              <button class="btn" onClick={() => setEditing(id)}>
                <Icon name="edit" /> Edit
              </button>
              {config !== undefined && (
                <ConfirmButton
                  label="Remove"
                  title="stops the agent and forgets it — config, env, capability and knob caches"
                  onConfirm={() => props.onRemove(id)}
                />
              )}
            </div>
            {command !== undefined && (
              <div class="mono" style="margin-top:6px">
                {command}
              </div>
            )}
            {status === "crashed" && (
              <div class="note crashed-note" style="margin-top:6px">
                <Icon name="warning" /> crashed{a?.detail !== undefined ? ` — ${a.detail}` : ""}
                <button class="btn" style="margin-left:8px" onClick={() => props.onRestart(id)}>
                  Restart
                </button>
              </div>
            )}
            {matrix !== undefined && (
              <div class="note" style="margin-top:6px">
                {capabilityOneLiner(matrix)}
              </div>
            )}
            {editing === id ? (
              <AgentConfigForm
                initial={effectiveConfig}
                onSave={(c, env) => {
                  props.onSave(c, env);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div class="row" style="margin-top:8px;gap:14px;flex-wrap:wrap">
                <label class="knob-default">
                  process
                  <select
                    value={effectiveConfig.processPolicy}
                    onChange={(e) =>
                      saveConfig({
                        processPolicy: (e.target as HTMLSelectElement)
                          .value as AgentConfigView["processPolicy"],
                      })
                    }
                  >
                    <option value="auto">
                      auto — {concurrencyUsed ? "shared, concurrency used ✓" : "isolated, not yet used"}
                    </option>
                    <option value="shared">shared</option>
                    <option value="isolated">isolated</option>
                  </select>
                </label>
                {knobs === undefined ? (
                  // Never observed vs. observed-and-absent are different
                  // facts — this is the first, stated as such, not dressed
                  // up as "not offered".
                  <span class="note" style="margin:0;align-self:center">
                    session knobs appear after the first session with this agent
                  </span>
                ) : (
                  <>
                    {modeValues !== null && modeValues.length > 0 && (
                      <DefaultKnob
                        icon={KNOB_ICON.mode!}
                        label="mode"
                        offered={modeValues}
                        value={effectiveConfig.defaults.mode ?? ""}
                        onChange={(v) =>
                          saveConfig({ defaults: { ...effectiveConfig.defaults, mode: v || undefined } })
                        }
                      />
                    )}
                    {knobs.options.map((option) => (
                      <DefaultKnob
                        key={option.id}
                        icon={(option.category !== undefined ? KNOB_ICON[option.category] : undefined) ?? "settings"}
                        label={option.name}
                        offered={option.values}
                        value={effectiveConfig.defaults.options?.[option.id] ?? ""}
                        onChange={(v) => setOptionDefault(option.id, v)}
                      />
                    ))}
                    {(modeValues === null || modeValues.length === 0) && knobs.options.length === 0 && (
                      <span class="note" style="margin:0;align-self:center">
                        this agent offered no session knobs
                      </span>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      {diagFor !== null && (
        <div class="modal-scrim" onClick={() => setDiagFor(null)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style="margin-top:0">Verify — cost disclosed first</h2>
            <div class="note" style="margin:0 0 10px">
              Re-runs the free protocol checks (a session/new + session/fork round-trip in an
              ephemeral temp-directory session — never your workspace). Today
              this consumes <b>no agent turns</b>. Behavior-level probes that
              would spend real turns don't exist yet; when they ship, their
              cost appears here before anything runs.
            </div>
            <div class="row" style="gap:8px">
              <button
                class="btn primary"
                onClick={() => {
                  props.onVerify(diagFor);
                  setDiagFor(null);
                }}
              >
                Run
              </button>
              <button class="btn" onClick={() => setDiagFor(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

const MATRIX_ROWS: Array<{ id: CapabilityRowId; label: string }> = [
  { id: "fs.readTextFile", label: "fs.readTextFile" },
  { id: "fs.writeTextFile", label: "fs.writeTextFile" },
  { id: "terminal", label: "terminal" },
  { id: "elicitation", label: "elicitation" },
  { id: "roots.listChanged", label: "roots.listChanged" },
  { id: "resources.subscribe", label: "resources.subscribe" },
  { id: "prompt.image", label: "prompt.image" },
  { id: "prompt.audio", label: "prompt.audio" },
  { id: "prompt.embeddedContext", label: "prompt.embeddedContext" },
  { id: "session.fork", label: "session.fork" },
  { id: "session.load", label: "session.load" },
  { id: "session.resume", label: "session.resume" },
  { id: "mcp.http", label: "mcp.http" },
  { id: "mcp.sse", label: "mcp.sse" },
  { id: "usage", label: "usage reporting" },
  { id: "concurrentSessions", label: "concurrent sessions" },
  { id: "auth", label: "auth" },
];

const STATE_ICON = { used: "pass-filled", declared: "circle", "not-declared": null } as const;
const STATE_CLASS = { used: "st-v", declared: "st-d", "not-declared": "st-n" } as const;
const STATE_TEXT = {
  used: "used — fired successfully on the wire",
  declared: "declared, not used — claimed at initialize, not yet exercised",
  "not-declared": "not declared",
} as const;

/** Cell tooltips explain consequences (ui.md § Capability matrix) — what a
 * missing/unused row actually costs the user, not just its state. */
const ROW_CONSEQUENCE: Partial<Record<CapabilityRowId, string>> = {
  "session.fork": "without it, branching is emulated — seeded from the transcript, labeled",
  "session.load": "without it, reopening after a restart falls back to an emulated continuation",
  "session.resume": "no live path yet — declared state only",
  "fs.readTextFile": "brokered read path — gates the fully-brokered fidelity label",
  "fs.writeTextFile": "brokered write path — routed writes arrive as native diffs",
  terminal: "brokered command execution — gates the fully-brokered fidelity label",
  usage: "without it, no usage gauge is shown — absence over fake",
  concurrentSessions: "process policy `auto` isolates new sessions until this is proven",
  auth: "a working session/new — proven by the free check at add/Verify, or by the first real session",
};

function MatrixSection({ state }: { state: SettingsState }) {
  const agents = state.agents;
  return (
    <section class="section">
      <h1>Capability matrix</h1>
      <div class="sub">
        Declared is a claim; used is what happened on the wire. UI features gate on used.
      </div>
      <div class="sub">
        Rows are hand-picked against the ACP spec's declared capability surface, not derived
        automatically — a new ACP capability needs a row added here before it can show up.
      </div>
      {agents.length === 0 ? (
        <div class="card">
          <div class="note" style="margin:0">
            The matrix appears once an agent has connected.
          </div>
        </div>
      ) : (
        <>
          <div class="legend">
            <span>
              <span class="st-v"><Icon name="pass-filled" /></span> used
            </span>
            <span>
              <span class="st-d"><Icon name="circle" /></span> declared, not used
            </span>
            <span>
              <span class="st-n">—</span> not declared
            </span>
          </div>
          <table>
            <tr>
              <th style="text-align:left">capability</th>
              {agents.map((a) => {
                const resetAt = state.capabilitiesResetAt[a.id];
                return (
                  <th key={a.id}>
                    {a.name}
                    {resetAt !== undefined && (
                      <span
                        class="chip"
                        style="margin-left:6px"
                        title="used resets on every reconnect"
                      >
                        reset {new Date(resetAt).toLocaleTimeString()}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
            {MATRIX_ROWS.map((row) => (
              <tr key={row.id}>
                <td class="cap">{row.label}</td>
                {agents.map((a) => {
                  const cell = state.capabilities[a.id]?.[row.id];
                  const st = capabilityState(cell);
                  const icon = STATE_ICON[st];
                  const consequence = ROW_CONSEQUENCE[row.id];
                  const tooltip = consequence !== undefined ? `${STATE_TEXT[st]} · ${consequence}` : STATE_TEXT[st];
                  return (
                    <td key={a.id} title={tooltip}>
                      <span class={STATE_CLASS[st]}>{icon !== null ? <Icon name={icon} /> : "—"}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr class="sep">
              <td colSpan={agents.length + 1}>patchbay-side — from roster data, not the handshake</td>
            </tr>
            <tr>
              <td class="cap">rules/skills/commands locations</td>
              {agents.map((a) => {
                const mapped = state.roster.find((r) => r.id === a.id)?.assetsMapped ?? false;
                return (
                  <td key={a.id} class={mapped ? "" : "st-n"}>
                    {mapped ? "mapped" : "not mapped"}
                  </td>
                );
              })}
            </tr>
          </table>
          <div class="note">
            Behavior-level rows get marked used opportunistically during real use — free. Synthetic
            probes only via Diagnostics, cost disclosed, in an ephemeral temp-dir session. Never on
            a schedule.
          </div>
        </>
      )}
    </section>
  );
}

/** Per-agent checkboxes for an integration's routing — "auto" (default,
 * fully-brokered agents only) or an explicit pinned list, never
 * all-or-nothing (features.md § Integrations). */
function RoutingEditor(props: {
  agents: SettingsState["agents"];
  routing: IntegrationRoutingView;
  fidelityOf(agentId: string): FidelityLabel | null;
  onChange(routing: IntegrationRoutingView): void;
}) {
  const explicit = props.routing !== "auto";
  // ui.md § Integrations: toggling onto a less-than-fully-brokered agent
  // interrupts with the explicit plug-in confirmation — auto-attach covers
  // fully-brokered only, so anything less is a deliberate act.
  const [pendingPlugIn, setPendingPlugIn] = useState<{ agentId: string; name: string; label: FidelityLabel | null } | null>(null);
  const plugIn = (agentId: string) => {
    const list = props.routing === "auto" ? [] : props.routing;
    props.onChange([...list, agentId]);
    setPendingPlugIn(null);
  };
  return (
    <div class="row" style="gap:10px;flex-wrap:wrap">
      <span
        class="lbl"
        style="font-size:10.5px;letter-spacing:0.04em;text-transform:uppercase;color:var(--pb-text-dim)"
        title="which agents receive this server in their sessions"
      >
        reaches
      </span>
      <label title="attaches automatically, but only to agents whose fs/terminal actually route through patchbay's permission gate (fully brokered) — an agent acting outside the gate never gets it silently">
        <input type="radio" checked={!explicit} onChange={() => props.onChange("auto")} /> fully-brokered
        agents (auto)
      </label>
      <label title="an explicit list — exactly the agents you tick, regardless of fidelity (less-than-brokered ones ask for confirmation)">
        <input
          type="radio"
          checked={explicit}
          onChange={() => props.onChange(explicit ? props.routing : [])}
        />{" "}
        only these agents:
      </label>
      {explicit &&
        props.agents.map((a) => {
          const list = props.routing as readonly string[];
          const checked = list.includes(a.id);
          const fidelity = props.fidelityOf(a.id);
          return (
            <label key={a.id}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => {
                  if (checked) {
                    props.onChange(list.filter((id) => id !== a.id));
                  } else if (fidelity === "fully-brokered") {
                    props.onChange([...list, a.id]);
                  } else {
                    setPendingPlugIn({ agentId: a.id, name: a.name, label: fidelity });
                  }
                }}
              />{" "}
              {a.name}
            </label>
          );
        })}
      {pendingPlugIn !== null && (
        <div class="note plug-in-confirm">
          <Icon name="warning" /> <b>{pendingPlugIn.name}</b> is{" "}
          {pendingPlugIn.label === null ? "not yet determined" : FIDELITY_TEXT[pendingPlugIn.label]} — tools
          this integration exposes may be used outside patchbay's permission flow. Plug in anyway?
          <button class="btn" style="margin-left:8px" onClick={() => plugIn(pendingPlugIn.agentId)}>
            Plug in
          </button>
          <button class="btn" onClick={() => setPendingPlugIn(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** One compact catalog row: name · mechanism chips · Docs · `Connect…`
 * expanding the entry's own form inline. The two mechanisms are presented
 * as the alternatives they are — key paste `— or —` OAuth — never an
 * undifferentiated run of inputs (docs/reference-mcp-oauth.md). */
function CatalogRow(props: {
  entry: SettingsState["integrationRegistry"][number];
  flow: SettingsState["connectFlow"][string] | undefined;
  expanded: boolean;
  onToggle(): void;
  onConnectKey(token: string, url?: string): void;
  onConnectOAuth(url?: string): void;
  onCancelConnect(): void;
  onUseLocal(): void;
}) {
  const { entry, flow } = props;
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const pending = flow?.status === "pending";
  const userUrlValue = entry.userUrl ? url.trim() : undefined;
  const urlMissing = entry.userUrl && url.trim() === "";
  // A gated remote with a verified local server is still connectable —
  // locally (Figma: remote is catalog-allowlisted, the desktop Dev Mode
  // server is open).
  const offersAnything = entry.connectable || entry.local !== null;

  return (
    <div class="cat-row">
      <div class="row">
        <span class="nm">{entry.name}</span>
        {entry.headerAuth !== null && <span class="chip">key</span>}
        {entry.oauth && <span class="chip">OAuth</span>}
        {entry.local !== null && <span class="chip">local</span>}
        <span style="flex:1" />
        <a class="btn" href={entry.docsUrl}>
          Docs
        </a>
        {offersAnything ? (
          <button class={`btn ${props.expanded ? "" : "primary"}`} onClick={props.onToggle} disabled={pending}>
            {pending ? "Connecting…" : props.expanded ? "Close" : "Connect…"}
          </button>
        ) : (
          <span class="chip">not connectable yet</span>
        )}
      </div>
      {entry.note !== "" && (props.expanded || !offersAnything) && (
        <div class="note" style="margin:6px 0 0">
          {entry.note}
        </div>
      )}
      {props.expanded && offersAnything && (
        <>
          {entry.userUrl && (
            <div class="connect-form">
              <Field
                label="endpoint URL"
                hint="per-account service — no fixed URL exists; both connect paths use this endpoint (find yours via Docs)"
              >
                <input
                  type="text"
                  placeholder="https://…"
                  value={url}
                  onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
                />
              </Field>
            </div>
          )}
          {entry.headerAuth !== null && (
            <div class="connect-form">
              <Field label="API key" hint={entry.headerAuth.hint}>
                <div class="ctl-row">
                  <input
                    type="password"
                    placeholder={entry.headerAuth.hint || "API key…"}
                    value={key}
                    onInput={(e) => setKey((e.target as HTMLInputElement).value)}
                  />
                  {entry.headerAuth.keyUrl !== "" && (
                    <a class="btn" href={entry.headerAuth.keyUrl} title={entry.headerAuth.hint}>
                      Get a key ↗
                    </a>
                  )}
                  <button
                    class="btn primary row-btn"
                    disabled={pending || key.trim() === "" || urlMissing}
                    onClick={() => props.onConnectKey(key.trim(), userUrlValue)}
                  >
                    Connect with key
                  </button>
                </div>
              </Field>
            </div>
          )}
          {entry.headerAuth !== null && entry.oauth && <div class="or-divider">— or —</div>}
          {entry.oauth && (
            <div class="connect-form">
              <div class="form-actions">
                <button
                  class="btn row-btn"
                  disabled={pending || urlMissing}
                  onClick={() => props.onConnectOAuth(userUrlValue)}
                >
                  Connect with OAuth (browser)…
                </button>
              </div>
            </div>
          )}
          {entry.local !== null && (
            <>
              <div class="or-divider">
                {entry.connectable ? "— or run it locally —" : "run it locally:"}
              </div>
              <div class="connect-form">
                <div class="form-actions">
                  <button class="btn row-btn" onClick={props.onUseLocal}>
                    Use local server…
                  </button>
                  <span class="note" style="margin:0;align-self:center">
                    {entry.local.note} — prefills the custom form below, nothing runs until you add it
                  </span>
                </div>
              </div>
            </>
          )}
        </>
      )}
      {pending && (
        <div class="note" style="margin:6px 0 0">
          Waiting for authorization in your browser…{" "}
          <button class="btn" onClick={props.onCancelConnect}>
            Cancel
          </button>
        </div>
      )}
      {flow?.status === "failed" && (
        <div class="note" style="margin:6px 0 0">
          Connect failed: {flow.reason}{" "}
          <button class="btn" onClick={props.onCancelConnect} title="clear this note">
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/** KEY=value lines → record; blank/invalid lines are skipped. */
function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // blank or not KEY=value — nothing to submit
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return env;
}

function IntegrationsSection(props: {
  state: SettingsState;
  onConnectKey(registryId: string, token: string, url?: string): void;
  onConnectOAuth(registryId: string, url?: string): void;
  onAddCustom(name: string, source: IntegrationSourceView, routing: IntegrationRoutingView): void;
  onImportJson(json: string): void;
  onUpdateJson(integrationId: string, json: string): void;
  onCancelConnect(integrationId: string): void;
  onSetActive(integrationId: string, active: boolean): void;
  onRemove(integrationId: string): void;
  onSetRouting(integrationId: string, routing: IntegrationRoutingView): void;
  onShare(integrationId: string): void;
}) {
  const { state } = props;
  const fidelityOf = (agentId: string): FidelityLabel | null => {
    const matrix = state.capabilities[agentId];
    if (matrix === undefined) return null;
    return computeFidelity(matrix, state.roster.find((r) => r.id === agentId)?.knownBypassBridge ?? false);
  };
  const [expandedCatalogId, setExpandedCatalogId] = useState<string | null>(null);
  const [adding, setAdding] = useState<"stdio" | "http" | "json" | null>(null);
  /** The name of the last submitted custom add — the form clears on submit,
   * so the OAuth pending/failed note needs its own anchor to render from
   * (a failed custom OAuth stores nothing, so there's no card to carry it).
   * The id is generated orchestrator-side as a slug of the name — mirrored
   * here for lookup only, not invented meaning. */
  const [lastCustomId, setLastCustomId] = useState<string | null>(null);
  const [editingJsonId, setEditingJsonId] = useState<string | null>(null);
  const [jsonDraft, setJsonDraft] = useState("");
  const [importText, setImportText] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<"none" | "header" | "oauth">("none");
  const [headerName, setHeaderName] = useState("Authorization");
  const [token, setToken] = useState("");

  /** One shared form under three entry points (blank add, local prefill,
   * import) — every transition clears it, so a half-filled prefill from an
   * earlier detour never leaks into a fresh add. */
  const resetCustomForm = () => {
    setName("");
    setCommand("");
    setArgsText("");
    setEnvText("");
    setUrl("");
    setAuthType("none");
    setHeaderName("Authorization");
    setToken("");
    setImportText("");
  };
  const openAdd = (mode: "stdio" | "http" | "json" | null) => {
    resetCustomForm();
    setAdding(mode);
  };

  /** Prefill from a curated entry's verified local server — the user
   * completes what's theirs (env values / a running desktop app) and
   * clicks Add; nothing runs before that. */
  const useLocal = (entryName: string, local: NonNullable<SettingsState["integrationRegistry"][number]["local"]>) => {
    resetCustomForm();
    setName(`${entryName} (local)`);
    if (local.kind === "stdio") {
      setAdding("stdio");
      setCommand(local.command);
      setArgsText(local.args.join("\n"));
      setEnvText(local.envKeys.map((k) => `${k}=`).join("\n"));
    } else {
      setAdding("http");
      setUrl(local.url);
      setAuthType("none");
    }
  };

  const submitCustom = () => {
    if (name.trim() === "") return;
    // "Bearer " prefix only makes sense on an Authorization header; a
    // custom header name (X-Goog-Api-Key style) carries the raw key.
    const isAuthorization = headerName.trim().toLowerCase() === "authorization";
    const source: IntegrationSourceView =
      adding === "stdio"
        ? {
            kind: "custom-stdio",
            command: command.trim(),
            args: argsText.split("\n").map((a) => a.trim()).filter((a) => a !== ""),
            env: parseEnvLines(envText),
          }
        : {
            kind: "custom-http",
            url: url.trim(),
            authType,
            headerName: authType === "header" ? headerName.trim() : undefined,
            valuePrefix: authType === "header" ? (isAuthorization ? "Bearer " : "") : undefined,
            token: authType === "header" ? token : undefined,
          };
    props.onAddCustom(name.trim(), source, "auto");
    // mirror of the orchestrator's slug, for flow-note lookup only
    setLastCustomId(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
    setAdding(null);
    setName("");
    setCommand("");
    setArgsText("");
    setEnvText("");
    setUrl("");
    setToken("");
    setHeaderName("Authorization");
  };

  return (
    <section class="section">
      <h1>MCP Servers</h1>
      <div class="sub">
        Curated and custom are the same mechanism — MCP servers, routed per agent. Global to this
        machine, never repo-committed; a shared config never carries its credential.
      </div>

      {state.integrations.length === 0 && (
        <div class="card">
          <div class="note" style="margin:0">
            No servers connected yet — pick one from the catalog below, or add your own.
          </div>
        </div>
      )}
      {state.integrations.map((integration) => (
        <div class="card" key={integration.id}>
          <div class="row">
            <span class={`dot ${integration.connected && integration.active ? "running" : "stopped"}`} />
            <span class="nm">{integration.name}</span>
            <span class="chip">{integration.sourceKind === "registry" ? "curated" : integration.sourceKind}</span>
            <span style="flex:1" />
            <Toggle
              checked={integration.active}
              label="active"
              title="inactive keeps the credential but the server reaches no agent until toggled back"
              onChange={(active) => props.onSetActive(integration.id, active)}
            />
            <button class="btn" onClick={() => props.onShare(integration.id)}>
              Share config…
            </button>
            <ConfirmButton
              label={integration.sourceKind === "registry" ? "Disconnect" : "Remove"}
              title={
                integration.sourceKind === "registry"
                  ? "full clear — credential and config; the catalog entry stays, ready for a fresh connect"
                  : "full clear — credential, env, and config"
              }
              onConfirm={() => props.onRemove(integration.id)}
            />
          </div>
          {integration.command !== undefined && (
            <div class="mono" style="margin-top:6px">
              {integration.command}
            </div>
          )}
          {!integration.active && (
            <div class="note" style="margin-top:6px">
              inactive — configured with its credential intact, reaching no agent
            </div>
          )}
          {integration.editJson !== undefined && editingJsonId === integration.id ? (
            <div class="connect-form">
              <Field label="server JSON" hint="the mcpServers-fragment for this server">
                <textarea
                  rows={7}
                  style="resize:vertical;font-family:var(--vscode-editor-font-family,monospace)"
                  value={jsonDraft}
                  onInput={(e) => setJsonDraft((e.target as HTMLTextAreaElement).value)}
                />
              </Field>
              <div class="note">
                env values are write-only — <code>""</code> keeps the stored value, a filled value
                overwrites, a removed key deletes
              </div>
              <div class="form-actions">
                <button
                  class="btn primary row-btn"
                  onClick={() => {
                    props.onUpdateJson(integration.id, jsonDraft);
                    setEditingJsonId(null);
                  }}
                >
                  Save
                </button>
                <button class="btn row-btn" onClick={() => setEditingJsonId(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : integration.editJson !== undefined ? (
            <div class="row" style="margin-top:6px">
              <button
                class="btn"
                onClick={() => {
                  setJsonDraft(integration.editJson!);
                  setEditingJsonId(integration.id);
                }}
              >
                Edit JSON…
              </button>
            </div>
          ) : null}
          {state.connectFlow[integration.id]?.status === "failed" && (
            <div class="note" style="margin-top:6px">
              {state.connectFlow[integration.id]?.reason}{" "}
              <button class="btn" onClick={() => props.onCancelConnect(integration.id)} title="clear this note">
                Dismiss
              </button>
            </div>
          )}
          <div style="margin-top:8px">
            <RoutingEditor
              agents={state.agents}
              routing={integration.routing}
              fidelityOf={fidelityOf}
              onChange={(routing) => props.onSetRouting(integration.id, routing)}
            />
          </div>
        </div>
      ))}

      <div class="card">
        <h2 style="margin-top:0">Add a custom MCP server</h2>
        {adding === null ? (
          <div class="row" style="gap:10px">
            <button class="btn" onClick={() => openAdd("stdio")}>
              + Command (stdio)
            </button>
            <button class="btn" onClick={() => openAdd("http")}>
              + URL (with auth)
            </button>
            <button class="btn" onClick={() => openAdd("json")}>
              Import JSON…
            </button>
          </div>
        ) : adding === "json" ? (
          <div class="connect-form">
            <textarea
              rows={8}
              style="width:100%;resize:vertical;font-family:var(--vscode-editor-font-family,monospace)"
              placeholder={'the well-known shape: {"mcpServers": {"my-server": {"command": "npx", "args": ["-y", "pkg"], "env": {"KEY": "value"}}}}'}
              value={importText}
              onInput={(e) => setImportText((e.target as HTMLTextAreaElement).value)}
            />
            <div class="note" style="margin:0;flex-basis:100%">
              each entry becomes a server named by its key; env values go straight to
              SecretStorage; entries that don't validate are skipped, labeled below
            </div>
            <button
              class="btn primary row-btn"
              disabled={importText.trim() === ""}
              onClick={() => {
                props.onImportJson(importText);
                setImportText("");
                setAdding(null);
              }}
            >
              Import
            </button>
            <button class="btn row-btn" onClick={() => openAdd(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <div class="connect-form">
            <Field label="name" hint="the display name — the internal id is generated from it">
              <input type="text" placeholder="My MCP server" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            </Field>
            {adding === "stdio" ? (
              <>
                <Field label="command" hint="the executable — quotes supported">
                  <input
                    type="text"
                    placeholder="npx"
                    value={command}
                    onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
                  />
                </Field>
                <Field label="arguments" hint="one per line — no quoting needed">
                  <textarea
                    rows={2}
                    style="resize:vertical"
                    placeholder={"-y\nsome-mcp-server"}
                    value={argsText}
                    onInput={(e) => setArgsText((e.target as HTMLTextAreaElement).value)}
                  />
                </Field>
                <Field label="environment variables" hint="KEY=value, one per line">
                  <textarea
                    rows={2}
                    style="resize:vertical"
                    placeholder={"MY_API_KEY=…"}
                    value={envText}
                    onInput={(e) => setEnvText((e.target as HTMLTextAreaElement).value)}
                  />
                </Field>
                <div class="note" style="margin:0;flex-basis:100%">
                  values go to VS Code SecretStorage and are handed to the agent only when it
                  spawns this server
                </div>
              </>
            ) : (
              <>
                <Field label="endpoint URL">
                  <input type="text" placeholder="https://…" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
                </Field>
                <Field label="authentication">
                  <select
                    value={authType}
                    onChange={(e) => setAuthType((e.target as HTMLSelectElement).value as "none" | "header" | "oauth")}
                  >
                    <option value="none">no auth</option>
                    <option value="header">API key (header)</option>
                    <option value="oauth">OAuth (browser)</option>
                  </select>
                </Field>
                {authType === "header" && (
                  <>
                    <Field
                      label="header name"
                      hint='header carrying the key — "Authorization" sends it as Bearer, any other name sends the raw key'
                    >
                      <input
                        type="text"
                        placeholder="Authorization"
                        value={headerName}
                        onInput={(e) => setHeaderName((e.target as HTMLInputElement).value)}
                      />
                    </Field>
                    <Field label="API key" hint="stored in VS Code SecretStorage only">
                      <input
                        type="password"
                        placeholder="key…"
                        value={token}
                        onInput={(e) => setToken((e.target as HTMLInputElement).value)}
                      />
                    </Field>
                  </>
                )}
              </>
            )}
            <div class="form-actions">
              <button
                class="btn primary row-btn"
                disabled={
                  name.trim() === "" ||
                  (adding === "stdio"
                    ? command.trim() === ""
                    : url.trim() === "" || (authType === "header" && token.trim() === ""))
                }
                onClick={submitCustom}
              >
                Add
              </button>
              <button class="btn row-btn" onClick={() => openAdd(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {lastCustomId !== null && state.connectFlow[lastCustomId]?.status === "pending" && (
          <div class="note" style="margin-top:6px">
            Waiting for authorization in your browser…{" "}
            <button class="btn" onClick={() => props.onCancelConnect(lastCustomId)}>
              Cancel
            </button>
          </div>
        )}
        {lastCustomId !== null && state.connectFlow[lastCustomId]?.status === "failed" && (
          <div class="note" style="margin-top:6px">
            Adding "{lastCustomId}" failed — nothing was stored:{" "}
            {state.connectFlow[lastCustomId]?.reason}{" "}
            <button class="btn" onClick={() => props.onCancelConnect(lastCustomId)} title="clear this note">
              Dismiss
            </button>
          </div>
        )}
        {Object.entries(state.connectFlow)
          .filter(([flowId, f]) => (flowId === "import" || flowId.startsWith("import:")) && f.status === "failed")
          .map(([flowId, f]) => (
            <div class="note" key={flowId} style="margin-top:6px">
              Import: {f.status === "failed" ? f.reason : ""}{" "}
              <button class="btn" onClick={() => props.onCancelConnect(flowId)} title="clear this note">
                Dismiss
              </button>
            </div>
          ))}
      </div>

      <div class="card">
        <h2 style="margin-top:0">Curated catalog</h2>
        <div class="sub" style="margin-bottom:4px">
          Each entry offers exactly the mechanisms its vendor opens — key paste, MCP-spec OAuth, or
          both. Connecting moves it to the list above.
        </div>
        {state.integrationRegistry.map((entry) => {
          const configured = state.integrations.some((i) => i.registryId === entry.id);
          if (configured) return null; // living above, in the connected list
          return (
            <CatalogRow
              key={entry.id}
              entry={entry}
              flow={state.connectFlow[entry.id]}
              expanded={expandedCatalogId === entry.id}
              onToggle={() => setExpandedCatalogId(expandedCatalogId === entry.id ? null : entry.id)}
              onConnectKey={(token, url) => props.onConnectKey(entry.id, token, url)}
              onConnectOAuth={(url) => props.onConnectOAuth(entry.id, url)}
              onCancelConnect={() => props.onCancelConnect(entry.id)}
              onUseLocal={() => {
                if (entry.local !== null) useLocal(entry.name, entry.local);
              }}
            />
          );
        })}
        {state.integrationRegistry.every((entry) =>
          state.integrations.some((i) => i.registryId === entry.id),
        ) && (
          <div class="note" style="margin:0">
            Everything curated is already connected.
          </div>
        )}
      </div>
    </section>
  );
}

function AssetCategory(props: {
  label: string;
  category: AssetCategoryView;
  onOpen(path: string): void;
}) {
  return (
    <div style="margin-top:8px">
      <div class="cap">{props.label}</div>
      {props.category.files === null ? (
        <div class="note" style="margin:2px 0 0">
          not mapped
        </div>
      ) : props.category.files.length === 0 ? (
        <div class="note" style="margin:2px 0 0">
          mapped, nothing found in this workspace
        </div>
      ) : (
        props.category.files.map((f) => (
          <div key={f.path} class="it" style="padding:2px 0" onClick={() => props.onOpen(f.path)}>
            <code>{f.path}</code>
          </div>
        ))
      )}
    </div>
  );
}

function AssetsSection(props: {
  state: SettingsState;
  onRefresh(agentId: string): void;
  onOpen(agentId: string, path: string): void;
}) {
  const { state } = props;
  return (
    <section class="section">
      <h1>Rules · skills · commands</h1>
      <div class="sub">
        Managed in each agent's own native locations — the agent reads its own cwd. Patchbay never
        passes them down; opening a file uses VS Code's own editor, never a copy.
      </div>
      {state.agents.length === 0 && (
        <div class="card">
          <div class="note" style="margin:0">
            No agents connected yet.
          </div>
        </div>
      )}
      {state.agents.map((a) => {
        const assets: AgentAssetsView | undefined = state.assets[a.id];
        return (
          <div class="card" key={a.id}>
            <div class="row">
              <span class="nm">{a.name}</span>
              <span style="flex:1" />
              <button class="btn" onClick={() => props.onRefresh(a.id)}>
                Refresh
              </button>
            </div>
            {assets === undefined ? (
              <div class="note" style="margin-top:6px">
                Not read yet — click Refresh.
              </div>
            ) : (
              <>
                <AssetCategory label="Rules" category={assets.rules} onOpen={(p) => props.onOpen(a.id, p)} />
                <AssetCategory label="Commands" category={assets.commands} onOpen={(p) => props.onOpen(a.id, p)} />
                <AssetCategory label="Skills" category={assets.skills} onOpen={(p) => props.onOpen(a.id, p)} />
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}

const SCOPE_LABEL: Record<FileWriteScopeView, string> = {
  workspace: "workspace only",
  "workspace+temp": "workspace + temp",
  "always-ask": "always ask",
};

/** One command-rules card — instantiated per layer (workspace, machine) so
 * the two lists can't drift in presentation or behavior. */
function CommandRulesCard(props: {
  title: string;
  note: string;
  rules: readonly CommandRuleView[];
  emptyText: string;
  onAdd(rule: CommandRuleView): void;
  onRemove(pattern: string): void;
}) {
  const [pattern, setPattern] = useState("");
  const [verdict, setVerdict] = useState<CommandRuleView["verdict"]>("allow");

  return (
    <div class="card">
      <h2 style="margin-top:0">{props.title}</h2>
      <div class="note" style="margin:0 0 8px">
        {props.note}
      </div>
      {props.rules.length === 0 && (
        <div class="note" style="margin:0 0 8px">
          {props.emptyText}
        </div>
      )}
      {props.rules.map((r) => (
        <div class="rule" key={r.pattern}>
          <code>{r.pattern}</code>
          <span class={`verdict ${r.verdict}`}>{r.verdict}</span>
          <span
            class="e"
            role="button"
            tabIndex={0}
            aria-label={`Remove rule ${r.pattern}`}
            onClick={() => props.onRemove(r.pattern)}
          >
            <Icon name="close" />
          </span>
        </div>
      ))}
      <div class="row" style="margin-top:10px">
        <input
          type="text"
          placeholder="command pattern…"
          style="flex:1"
          value={pattern}
          onInput={(e) => setPattern((e.target as HTMLInputElement).value)}
        />
        <select
          value={verdict}
          onChange={(e) => setVerdict((e.target as HTMLSelectElement).value as CommandRuleView["verdict"])}
        >
          <option value="allow">allow</option>
          <option value="ask">ask</option>
          <option value="deny">deny</option>
        </select>
        <button
          class="btn primary"
          disabled={pattern.trim() === ""}
          onClick={() => {
            props.onAdd({ pattern: pattern.trim(), verdict });
            setPattern("");
          }}
        >
          Add rule
        </button>
      </div>
    </div>
  );
}

function PermissionsSection(props: {
  state: SettingsState;
  onAddRule(rule: CommandRuleView, layer: "workspace" | "machine"): void;
  onRemoveRule(pattern: string, layer: "workspace" | "machine"): void;
  onSetScope(scope: FileWriteScopeView): void;
}) {
  const { state } = props;

  return (
    <section class="section">
      <h1>Permissions</h1>
      <div class="sub">
        One rule set for everything — agent permission requests, MCP tools, terminal. No second
        surface. Two layers: this workspace's rules answer first; the machine layer is the
        fallback floor for every workspace; no rule anywhere means ask.
      </div>

      <CommandRulesCard
        title="Command rules — this workspace"
        note="Evaluated first — this repo's own tightening or loosening of the machine floor."
        rules={state.commandRules}
        emptyText="No workspace rules — the machine layer (below) answers, then ask."
        onAdd={(rule) => props.onAddRule(rule, "workspace")}
        onRemove={(pattern) => props.onRemoveRule(pattern, "workspace")}
      />

      <CommandRulesCard
        title="Command rules — this machine"
        note="The fallback floor for every workspace on this machine — consulted only where the workspace layer stays silent."
        rules={state.machineCommandRules}
        emptyText="No machine rules — every unmatched command asks."
        onAdd={(rule) => props.onAddRule(rule, "machine")}
        onRemove={(pattern) => props.onRemoveRule(pattern, "machine")}
      />

      <div class="card">
        <h2 style="margin-top:0">File writes</h2>
        <div class="row" style="gap:18px">
          {(["workspace", "workspace+temp", "always-ask"] as const).map((scope) => (
            <label key={scope}>
              <input
                type="radio"
                name="fw"
                checked={state.fileWriteScope === scope}
                onChange={() => props.onSetScope(scope)}
              />{" "}
              {SCOPE_LABEL[scope]}
            </label>
          ))}
        </div>
        <div class="note">
          writes surface as diffs either way — auto-accept only changes who clicks, not what is
          visible
        </div>
      </div>

      <div class="note good">
        Workspace rules live in workspaceState (per user, per workspace), machine rules in global
        storage (per user, this machine) — never in the repo either way. A cloned repository
        cannot arrive pre-authorized.
      </div>

      <div class="card" style="margin-top:12px">
        <h2 style="margin-top:0">Decision audit — recent</h2>
        {state.auditTail.length === 0 ? (
          <div class="note" style="margin:0">
            No decisions recorded yet.
          </div>
        ) : (
          <div class="audit">
            {state.auditTail.map((entry, i) => {
              const { ts, kind, ...rest } = entry;
              const detail = Object.entries(rest)
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join(" ");
              return (
                <div key={i}>
                  {new Date(ts).toLocaleTimeString()} {kind} {detail}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
