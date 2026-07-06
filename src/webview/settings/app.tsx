// Settings shell — left nav + cards (ui.md § Settings). Sections fill in with
// their phases: agents/matrix (P5), integrations (P9), permissions (P6),
// rules·skills·commands (P10). Empty states are honest, never placeholders
// pretending to be data.
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
  SettingsState,
} from "../../shared/protocol";
import { capabilityState, computeFidelity } from "../../shared/protocol";
import { capabilityOneLiner, FIDELITY_CLASS, FIDELITY_TEXT } from "../shared/capability-format";
import type { ViewChannel } from "../shared/channel";

const SECTIONS = [
  { id: "agents", icon: "🔌", label: "Agents" },
  { id: "matrix", icon: "◳", label: "Capability matrix" },
  { id: "integrations", icon: "🧩", label: "Integrations" },
  { id: "permissions", icon: "🛡", label: "Permissions" },
  { id: "assets", icon: "📋", label: "Rules · skills · commands" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function App({ channel }: { channel: ViewChannel<SettingsState> }) {
  const state = channel.getState()?.state ?? null;
  const [section, setSection] = useState<SectionId>("agents");

  if (state === null) return null;

  const runDiagnostics = (agentId: string) =>
    channel.sendAction({ kind: "runDiagnostics", agentId });

  return (
    <div class="layout">
      <nav class="nav">
        {SECTIONS.map((s) => (
          <div
            key={s.id}
            class={`it ${section === s.id ? "on" : ""}`}
            onClick={() => setSection(s.id)}
          >
            {s.icon} {s.label}
          </div>
        ))}
        <div class="foot">
          workspace config
          <br />
          <code>.vscode/acp-patchbay.json</code>
          <br />
          credentials: SecretStorage only — never in this file
        </div>
      </nav>
      <main class="main">
        {section === "agents" && (
          <AgentsSection
            state={state}
            onDiagnostics={runDiagnostics}
            onConnectConfigured={(agentId) =>
              channel.sendAction({ kind: "connectAgent", source: { configuredId: agentId } })
            }
            onSave={(config) => channel.sendAction({ kind: "addOrUpdateAgentConfig", config })}
            onRemove={(agentId) => channel.sendAction({ kind: "removeAgentConfig", agentId })}
            onStop={(agentId) => channel.sendAction({ kind: "stopAgent", agentId })}
            onRestart={(agentId) => channel.sendAction({ kind: "restartAgent", agentId })}
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
            onAddCustom={(id, name, source, routing) =>
              channel.sendAction({ kind: "addCustomIntegration", id, name, source, routing })
            }
            onDisconnect={(integrationId) => channel.sendAction({ kind: "disconnectIntegration", integrationId })}
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
            onAddRule={(rule) => channel.sendAction({ kind: "addCommandRule", rule })}
            onRemoveRule={(pattern) => channel.sendAction({ kind: "removeCommandRule", pattern })}
            onSetScope={(scope) => channel.sendAction({ kind: "setFileWriteScope", scope })}
            onAdopt={(agentId) => channel.sendAction({ kind: "adoptWorkspaceAgent", agentId })}
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
  env: {},
  processPolicy: "auto",
  defaults: {},
};

function AgentConfigForm(props: {
  initial: AgentConfigView;
  onSave(config: AgentConfigView): void;
  onCancel(): void;
}) {
  const [id, setId] = useState(props.initial.id);
  const [name, setName] = useState(props.initial.name);
  const [command, setCommand] = useState([props.initial.command, ...props.initial.args].join(" "));
  const [processPolicy, setProcessPolicy] = useState(props.initial.processPolicy);
  const [model, setModel] = useState(props.initial.defaults.model ?? "");
  const [mode, setMode] = useState(props.initial.defaults.mode ?? "");
  const [effort, setEffort] = useState(props.initial.defaults.effort ?? "");

  const save = () => {
    const parts = command.trim().split(/\s+/).filter(Boolean);
    if (id.trim() === "" || name.trim() === "" || parts.length === 0) return;
    props.onSave({
      id: id.trim(),
      name: name.trim(),
      command: parts[0]!,
      args: parts.slice(1),
      env: props.initial.env,
      processPolicy,
      defaults: {
        model: model.trim() || undefined,
        mode: mode.trim() || undefined,
        effort: effort.trim() || undefined,
      },
    });
  };

  return (
    <div class="connect-form">
      <input type="text" placeholder="id (unique)" value={id} disabled={props.initial.id !== ""} onInput={(e) => setId((e.target as HTMLInputElement).value)} />
      <input type="text" placeholder="display name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      <input
        type="text"
        placeholder="command and args…"
        value={command}
        onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
      />
      <select value={processPolicy} onChange={(e) => setProcessPolicy((e.target as HTMLSelectElement).value as AgentConfigView["processPolicy"])}>
        <option value="auto">process: auto</option>
        <option value="shared">process: shared</option>
        <option value="isolated">process: isolated</option>
      </select>
      <input type="text" placeholder="default model…" value={model} onInput={(e) => setModel((e.target as HTMLInputElement).value)} />
      <input type="text" placeholder="default mode…" value={mode} onInput={(e) => setMode((e.target as HTMLInputElement).value)} />
      <input type="text" placeholder="default effort…" value={effort} onInput={(e) => setEffort((e.target as HTMLInputElement).value)} />
      <button class="btn primary row-btn" onClick={save}>
        Save
      </button>
      <button class="btn row-btn" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** Existing workspace config for this agent, or one synthesized from its
 * live launch command — editing/policy/defaults on a roster-launched agent
 * creates its config record on first save, the same file repo-defined
 * agents already use. */
function configFor(state: SettingsState, agent: AgentSummary): AgentConfigView {
  const existing = state.agentConfigs.find((c) => c.id === agent.id);
  if (existing !== undefined) return existing;
  const parts = (agent.command ?? "").trim().split(/\s+/).filter(Boolean);
  return {
    id: agent.id,
    name: agent.name,
    command: parts[0] ?? "",
    args: parts.slice(1),
    env: {},
    processPolicy: "auto",
    defaults: {},
  };
}

function StatTiles({ state }: { state: SettingsState }) {
  const running = state.agents.filter((a) => a.status === "running").length;
  const tiles = [
    { n: state.agents.length, label: "connected" },
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
    </div>
  );
}

/** One default-knob select — rendered enabled only where the agent has been
 * observed to offer that knob (ui.md: unoffered renders disabled
 * "— not offered"; patchbay never invents an option). */
function DefaultKnob(props: {
  glyph: string;
  label: string;
  offered: readonly { value: string; name: string }[] | null;
  value: string;
  onChange(value: string): void;
}) {
  if (props.offered === null || props.offered.length === 0) {
    return (
      <label class="knob-default off" title={`${props.label} — this agent has not offered this knob`}>
        {props.glyph} {props.label}
        <select disabled>
          <option>— not offered</option>
        </select>
      </label>
    );
  }
  return (
    <label class="knob-default">
      {props.glyph} {props.label}
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
  onDiagnostics(agentId: string): void;
  onConnectConfigured(agentId: string): void;
  onSave(config: AgentConfigView): void;
  onRemove(agentId: string): void;
  onStop(agentId: string): void;
  onRestart(agentId: string): void;
}) {
  const { state } = props;
  const [editing, setEditing] = useState<string | null>(null); // agentId being edited, or "" for a new one
  const [diagFor, setDiagFor] = useState<string | null>(null);
  return (
    <section class="section">
      <h1>Agents</h1>
      <div class="sub">
        Any command line that speaks ACP. Status is live; capabilities are
        claimed until exercised.
      </div>
      <StatTiles state={state} />
      {state.agents.length === 0 && (
        <div class="card">
          <div class="note" style="margin:0">
            No agents connected. Connect one from the Agent View sidebar.
          </div>
        </div>
      )}
      {state.agents.map((a) => {
        const matrix = state.capabilities[a.id];
        const roster = state.roster.find((r) => r.id === a.id);
        const config = configFor(state, a);
        const knobs = state.agentKnobs[a.id];
        const concurrencyVerified = matrix?.concurrentSessions?.verified ?? false;
        const saveConfig = (patch: Partial<AgentConfigView>) =>
          props.onSave({ ...config, ...patch });
        const modelValues = knobs?.options.find((o) => o.category === "model")?.values ?? null;
        const effortValues = knobs?.options.find((o) => o.category === "thought_level")?.values ?? null;
        const modeValues = knobs?.modes?.map((m) => ({ value: m.id, name: m.name })) ?? null;
        return (
          <div class="card" key={a.id}>
            <div class="row">
              <span class={`dot ${a.status}`} />
              <span class="nm">{a.name}</span>
              {matrix !== undefined && (
                <FidelityChip matrix={matrix} knownBypassBridge={roster?.knownBypassBridge ?? false} />
              )}
              <span style="flex:1" />
              {a.status === "running" && (
                <>
                  <button class="btn" onClick={() => props.onStop(a.id)}>
                    Stop
                  </button>
                  <button class="btn" onClick={() => setDiagFor(a.id)}>
                    Diagnostics…
                  </button>
                </>
              )}
              <button class="btn" onClick={() => setEditing(a.id)}>
                ✎ Edit
              </button>
              {state.agentConfigs.some((c) => c.id === a.id) && (
                <button class="btn" onClick={() => props.onRemove(a.id)}>
                  Remove
                </button>
              )}
            </div>
            {a.command !== undefined && (
              <div class="mono" style="margin-top:6px">
                {a.command}
              </div>
            )}
            {a.status === "crashed" && (
              <div class="note crashed-note" style="margin-top:6px">
                ⚠ crashed{a.detail !== undefined ? ` — ${a.detail}` : ""}
                <button class="btn" style="margin-left:8px" onClick={() => props.onRestart(a.id)}>
                  Restart
                </button>
              </div>
            )}
            {matrix !== undefined && (
              <div class="note" style="margin-top:6px">
                {capabilityOneLiner(matrix)}
              </div>
            )}
            {editing === a.id ? (
              <AgentConfigForm
                initial={config}
                onSave={(c) => {
                  props.onSave(c);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div class="row" style="margin-top:8px;gap:14px;flex-wrap:wrap">
                <label class="knob-default">
                  process
                  <select
                    value={config.processPolicy}
                    onChange={(e) =>
                      saveConfig({
                        processPolicy: (e.target as HTMLSelectElement)
                          .value as AgentConfigView["processPolicy"],
                      })
                    }
                  >
                    <option value="auto">
                      auto — {concurrencyVerified ? "shared, concurrency verified ✓" : "isolated, unverified"}
                    </option>
                    <option value="shared">shared</option>
                    <option value="isolated">isolated</option>
                  </select>
                </label>
                <DefaultKnob
                  glyph="◈"
                  label="model"
                  offered={modelValues}
                  value={config.defaults.model ?? ""}
                  onChange={(v) => saveConfig({ defaults: { ...config.defaults, model: v || undefined } })}
                />
                <DefaultKnob
                  glyph="⚙"
                  label="mode"
                  offered={modeValues}
                  value={config.defaults.mode ?? ""}
                  onChange={(v) => saveConfig({ defaults: { ...config.defaults, mode: v || undefined } })}
                />
                <DefaultKnob
                  glyph="⚡"
                  label="effort"
                  offered={effortValues}
                  value={config.defaults.effort ?? ""}
                  onChange={(v) => saveConfig({ defaults: { ...config.defaults, effort: v || undefined } })}
                />
              </div>
            )}
          </div>
        );
      })}
      {diagFor !== null && (
        <div class="modal-scrim" onClick={() => setDiagFor(null)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style="margin-top:0">Diagnostics — cost disclosed first</h2>
            <div class="note" style="margin:0 0 10px">
              Re-runs the free protocol checks (a session/fork round-trip in an
              ephemeral temp-directory session — never your workspace). Today
              this consumes <b>no agent turns</b>. Behavior-level probes that
              would spend real turns don't exist yet; when they ship, their
              cost appears here before anything runs.
            </div>
            <div class="row" style="gap:8px">
              <button
                class="btn primary"
                onClick={() => {
                  props.onDiagnostics(diagFor);
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

      <div class="card">
        <h2 style="margin-top:0">Workspace agent configs</h2>
        <div class="note" style="margin:0 0 8px">
          Saved to <code>.vscode/acp-patchbay.json</code> — repo-shareable, never a credential.
        </div>
        {state.agentConfigs.length === 0 && editing === null && (
          <div class="note" style="margin:0 0 8px">
            None saved yet.
          </div>
        )}
        {state.agentConfigs.filter((c) => !state.agents.some((a) => a.id === c.id)).map((c) =>
          editing === c.id ? (
            <AgentConfigForm
              key={c.id}
              initial={c}
              onSave={(config) => {
                props.onSave(config);
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div class="row" key={c.id} style="margin-bottom:6px">
              <span class="nm">{c.name}</span>
              <span class="mono" style="flex:1">
                {[c.command, ...c.args].join(" ")}
              </span>
              {!state.agents.some((a) => a.id === c.id && a.status === "running") && (
                <button class="btn" onClick={() => props.onConnectConfigured(c.id)}>
                  Connect
                </button>
              )}
              <button class="btn" onClick={() => setEditing(c.id)}>
                Edit
              </button>
              <button class="btn" onClick={() => props.onRemove(c.id)}>
                Remove
              </button>
            </div>
          ),
        )}
        {editing === "" ? (
          <AgentConfigForm
            initial={EMPTY_AGENT_CONFIG}
            onSave={(config) => {
              props.onSave(config);
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <button class="btn" onClick={() => setEditing("")}>
            + Add agent config
          </button>
        )}
      </div>
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
];

const STATE_GLYPH = { verified: "●", declared: "◌", "not-declared": "—" } as const;
const STATE_CLASS = { verified: "st-v", declared: "st-d", "not-declared": "st-n" } as const;

function MatrixSection({ state }: { state: SettingsState }) {
  const agents = state.agents;
  return (
    <section class="section">
      <h1>Capability matrix</h1>
      <div class="sub">
        Declared is a claim; verified is what happened on the wire. UI features gate on verified.
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
              <span class="st-v">●</span> verified working
            </span>
            <span>
              <span class="st-d">◌</span> declared, unverified
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
                        title="verified resets on every reconnect"
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
                  return (
                    <td key={a.id}>
                      <span class={STATE_CLASS[st]}>{STATE_GLYPH[st]}</span>
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
            Behavior-level rows verify opportunistically during real use — free. Synthetic probes
            only via Diagnostics, cost disclosed, in an ephemeral temp-dir session. Never on a
            schedule.
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
      <label>
        <input type="radio" checked={!explicit} onChange={() => props.onChange("auto")} /> auto (fully brokered
        only)
      </label>
      <label>
        <input
          type="radio"
          checked={explicit}
          onChange={() => props.onChange(explicit ? props.routing : [])}
        />{" "}
        pinned:
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
          ⚠ <b>{pendingPlugIn.name}</b> is{" "}
          {pendingPlugIn.label === null ? "not yet verified" : FIDELITY_TEXT[pendingPlugIn.label]} — tools
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

/** One curated-registry card: docs link, honest note, and the connect
 * mechanisms this vendor actually offers — OAuth button where DCR is open,
 * key-paste where a static key works, URL field where the endpoint is
 * per-account (docs/reference-mcp-oauth.md). */
function RegistryConnectCard(props: {
  entry: SettingsState["integrationRegistry"][number];
  flow: SettingsState["connectFlow"][string] | undefined;
  onConnectKey(token: string, url?: string): void;
  onConnectOAuth(url?: string): void;
}) {
  const { entry, flow } = props;
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const pending = flow?.status === "pending";
  const userUrlValue = entry.userUrl ? url.trim() : undefined;
  const urlMissing = entry.userUrl && url.trim() === "";

  return (
    <div class="card">
      <div class="row">
        <span class="nm">{entry.name}</span>
        <span style="flex:1" />
        <a class="btn" href={entry.docsUrl}>
          Docs
        </a>
      </div>
      {entry.note !== "" && (
        <div class="note" style="margin-top:6px">
          {entry.note}
        </div>
      )}
      {entry.connectable && (
        <div class="connect-form" style="margin-top:8px">
          {entry.userUrl && (
            <input
              type="text"
              placeholder="your endpoint URL…"
              value={url}
              onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
            />
          )}
          {entry.headerAuth !== null && (
            <>
              <input
                type="password"
                placeholder={entry.headerAuth.hint || "API key…"}
                title={entry.headerAuth.hint}
                value={key}
                onInput={(e) => setKey((e.target as HTMLInputElement).value)}
              />
              <button
                class="btn primary row-btn"
                disabled={pending || key.trim() === "" || urlMissing}
                onClick={() => {
                  props.onConnectKey(key.trim(), userUrlValue);
                  setKey("");
                }}
              >
                Connect with key
              </button>
            </>
          )}
          {entry.oauth && (
            <button
              class="btn row-btn"
              disabled={pending || urlMissing}
              onClick={() => props.onConnectOAuth(userUrlValue)}
            >
              Connect with OAuth…
            </button>
          )}
        </div>
      )}
      {pending && (
        <div class="note" style="margin-top:6px">
          Waiting for authorization in your browser…
        </div>
      )}
      {flow?.status === "failed" && (
        <div class="note" style="margin-top:6px">
          Connect failed: {flow.reason}
        </div>
      )}
    </div>
  );
}

function IntegrationsSection(props: {
  state: SettingsState;
  onConnectKey(registryId: string, token: string, url?: string): void;
  onConnectOAuth(registryId: string, url?: string): void;
  onAddCustom(id: string, name: string, source: IntegrationSourceView, routing: IntegrationRoutingView): void;
  onDisconnect(integrationId: string): void;
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
  const [adding, setAdding] = useState<"stdio" | "http" | null>(null);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<"none" | "header" | "oauth">("none");
  const [headerName, setHeaderName] = useState("Authorization");
  const [token, setToken] = useState("");

  const submitCustom = () => {
    if (id.trim() === "" || name.trim() === "") return;
    // "Bearer " prefix only makes sense on an Authorization header; a
    // custom header name (X-Goog-Api-Key style) carries the raw key.
    const isAuthorization = headerName.trim().toLowerCase() === "authorization";
    const source: IntegrationSourceView =
      adding === "stdio"
        ? { kind: "custom-stdio", command: command.trim(), args: [], env: {} }
        : {
            kind: "custom-http",
            url: url.trim(),
            authType,
            headerName: authType === "header" ? headerName.trim() : undefined,
            valuePrefix: authType === "header" ? (isAuthorization ? "Bearer " : "") : undefined,
            token: authType === "header" ? token : undefined,
          };
    props.onAddCustom(id.trim(), name.trim(), source, "auto");
    setAdding(null);
    setId("");
    setName("");
    setCommand("");
    setUrl("");
    setToken("");
    setHeaderName("Authorization");
  };

  return (
    <section class="section">
      <h1>Integrations</h1>
      <div class="sub">
        Curated and custom are the same mechanism — MCP servers, routed per agent. Workspace-scoped:
        connecting here never makes it available in another repo.
      </div>

      {state.integrationRegistry.map((entry) => {
        const view = state.integrations.find((i) => i.registryId === entry.id);
        if (view !== undefined) return null; // already added below, in the configured list
        return (
          <RegistryConnectCard
            key={entry.id}
            entry={entry}
            flow={state.connectFlow[entry.id]}
            onConnectKey={(token, url) => props.onConnectKey(entry.id, token, url)}
            onConnectOAuth={(url) => props.onConnectOAuth(entry.id, url)}
          />
        );
      })}

      {state.integrations.map((integration) => (
        <div class="card" key={integration.id}>
          <div class="row">
            <span class={`dot ${integration.connected ? "running" : "stopped"}`} />
            <span class="nm">{integration.name}</span>
            <span class="chip">{integration.sourceKind}</span>
            <span style="flex:1" />
            <button class="btn" onClick={() => props.onShare(integration.id)}>
              Share config…
            </button>
            {integration.connected && integration.sourceKind !== "custom-stdio" && (
              <button class="btn" onClick={() => props.onDisconnect(integration.id)}>
                Disconnect
              </button>
            )}
            <button class="btn" onClick={() => props.onRemove(integration.id)}>
              Remove
            </button>
          </div>
          {state.connectFlow[integration.id]?.status === "pending" ? (
            <div class="note" style="margin-top:6px">
              Waiting for authorization in your browser…
            </div>
          ) : state.connectFlow[integration.id]?.status === "failed" ? (
            <div class="note" style="margin-top:6px">
              Connect failed: {state.connectFlow[integration.id]?.reason}
            </div>
          ) : !integration.connected ? (
            <div class="note" style="margin-top:6px">
              Configured, not connected in this workspace — credentials never follow a shared config.
            </div>
          ) : null}
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
            <button class="btn" onClick={() => setAdding("stdio")}>
              + Command (stdio)
            </button>
            <button class="btn" onClick={() => setAdding("http")}>
              + URL (with auth)
            </button>
          </div>
        ) : (
          <div class="connect-form">
            <input type="text" placeholder="id (unique)" value={id} onInput={(e) => setId((e.target as HTMLInputElement).value)} />
            <input type="text" placeholder="display name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            {adding === "stdio" ? (
              <input
                type="text"
                placeholder="command…"
                value={command}
                onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
              />
            ) : (
              <>
                <input type="text" placeholder="https://…" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
                <select
                  value={authType}
                  onChange={(e) => setAuthType((e.target as HTMLSelectElement).value as "none" | "header" | "oauth")}
                >
                  <option value="none">no auth</option>
                  <option value="header">API key (header)</option>
                  <option value="oauth">OAuth (browser)</option>
                </select>
                {authType === "header" && (
                  <>
                    <input
                      type="text"
                      placeholder="header name"
                      title='header carrying the key — "Authorization" sends it as Bearer, any other name sends the raw key'
                      value={headerName}
                      onInput={(e) => setHeaderName((e.target as HTMLInputElement).value)}
                    />
                    <input
                      type="password"
                      placeholder="key…"
                      value={token}
                      onInput={(e) => setToken((e.target as HTMLInputElement).value)}
                    />
                  </>
                )}
              </>
            )}
            <button class="btn primary row-btn" onClick={submitCustom}>
              Add
            </button>
            <button class="btn row-btn" onClick={() => setAdding(null)}>
              Cancel
            </button>
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

function PermissionsSection(props: {
  state: SettingsState;
  onAddRule(rule: CommandRuleView): void;
  onRemoveRule(pattern: string): void;
  onSetScope(scope: FileWriteScopeView): void;
  onAdopt(agentId: string): void;
}) {
  const { state } = props;
  const [pattern, setPattern] = useState("");
  const [verdict, setVerdict] = useState<CommandRuleView["verdict"]>("allow");

  return (
    <section class="section">
      <h1>Permissions</h1>
      <div class="sub">
        One rule set for everything — agent permission requests, MCP tools, terminal. No second
        surface.
      </div>

      <div class="card">
        <h2 style="margin-top:0">Command rules</h2>
        {state.commandRules.length === 0 && (
          <div class="note" style="margin:0 0 8px">
            No rules yet — every command asks.
          </div>
        )}
        {state.commandRules.map((r) => (
          <div class="rule" key={r.pattern}>
            <code>{r.pattern}</code>
            <span class={`verdict ${r.verdict}`}>{r.verdict}</span>
            <span class="e" onClick={() => props.onRemoveRule(r.pattern)}>
              ✕
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
              props.onAddRule({ pattern: pattern.trim(), verdict });
              setPattern("");
            }}
          >
            Add rule
          </button>
        </div>
      </div>

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
        Rules live in workspaceState — per user, per workspace, never in the repo. A cloned
        repository cannot arrive pre-authorized.
      </div>

      {state.pendingAdoptions.length > 0 && (
        <div class="card" style="margin-top:12px">
          <h2 style="margin-top:0">Workspace-defined agents</h2>
          {state.pendingAdoptions.map((a) => (
            <div class="row" key={a.agentId} style="margin-bottom:6px">
              <span>
                this repo defines agent <b>{a.name}</b>
              </span>
              <span class="mono" style="flex:1">
                {a.command}
              </span>
              <button class="btn primary" onClick={() => props.onAdopt(a.agentId)}>
                Adopt…
              </button>
            </div>
          ))}
          <div class="note">
            repo-defined launch commands need one-time adoption (full command shown) behind
            workspace trust
          </div>
        </div>
      )}

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
