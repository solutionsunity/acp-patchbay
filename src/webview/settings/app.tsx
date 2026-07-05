// Settings shell — left nav + cards (ui.md § Settings). Sections fill in with
// their phases: agents/matrix (P5), integrations (P9), permissions (P6),
// rules·skills·commands (P10). Empty states are honest, never placeholders
// pretending to be data.
import { useState } from "preact/hooks";
import type {
  CapabilityMatrix,
  CapabilityRowId,
  CommandRuleView,
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
        {section === "agents" && <AgentsSection state={state} onDiagnostics={runDiagnostics} />}
        {section === "matrix" && <MatrixSection state={state} />}
        {section === "integrations" && (
          <IntegrationsSection
            state={state}
            onConnect={(registryId) => channel.sendAction({ kind: "connectRegistryIntegration", registryId })}
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
          <Section
            title="Rules · skills · commands"
            sub="Managed in each agent's own native locations — the agent reads its own cwd. Patchbay never passes them down."
            empty="Per-agent asset cards land with P10."
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

function AgentsSection(props: {
  state: SettingsState;
  onDiagnostics(agentId: string): void;
}) {
  const { state } = props;
  return (
    <section class="section">
      <h1>Agents</h1>
      <div class="sub">
        Any command line that speaks ACP. Status is live; capabilities are
        claimed until exercised.
      </div>
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
                <button class="btn" onClick={() => props.onDiagnostics(a.id)}>
                  Diagnostics…
                </button>
              )}
            </div>
            {a.detail !== undefined && (
              <div class="note" style="margin-top:6px">
                {a.detail}
              </div>
            )}
            {matrix !== undefined && (
              <div class="note" style="margin-top:6px">
                {capabilityOneLiner(matrix)}
              </div>
            )}
          </div>
        );
      })}
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
  onChange(routing: IntegrationRoutingView): void;
}) {
  const explicit = props.routing !== "auto";
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
          return (
            <label key={a.id}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() =>
                  props.onChange(checked ? list.filter((id) => id !== a.id) : [...list, a.id])
                }
              />{" "}
              {a.name}
            </label>
          );
        })}
    </div>
  );
}

function IntegrationsSection(props: {
  state: SettingsState;
  onConnect(registryId: string): void;
  onAddCustom(id: string, name: string, source: IntegrationSourceView, routing: IntegrationRoutingView): void;
  onDisconnect(integrationId: string): void;
  onRemove(integrationId: string): void;
  onSetRouting(integrationId: string, routing: IntegrationRoutingView): void;
  onShare(integrationId: string): void;
}) {
  const { state } = props;
  const [adding, setAdding] = useState<"stdio" | "http" | null>(null);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<"none" | "bearer-token">("none");
  const [token, setToken] = useState("");

  const submitCustom = () => {
    if (id.trim() === "" || name.trim() === "") return;
    const source: IntegrationSourceView =
      adding === "stdio"
        ? { kind: "custom-stdio", command: command.trim(), args: [], env: {} }
        : { kind: "custom-http", url: url.trim(), authType, token: authType === "bearer-token" ? token : undefined };
    props.onAddCustom(id.trim(), name.trim(), source, "auto");
    setAdding(null);
    setId("");
    setName("");
    setCommand("");
    setUrl("");
    setToken("");
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
        const flow = state.deviceFlow[entry.id];
        if (view !== undefined) return null; // already added below, in the configured list
        return (
          <div class="card" key={entry.id}>
            <div class="row">
              <span class="nm">{entry.name}</span>
              <span style="flex:1" />
              <button
                class="btn primary"
                disabled={!entry.connectable || flow?.status === "pending"}
                title={entry.connectable ? undefined : "not configured yet — pending an owner-created OAuth App"}
                onClick={() => props.onConnect(entry.id)}
              >
                Connect
              </button>
            </div>
            {!entry.connectable && (
              <div class="note" style="margin-top:6px">
                Not connectable yet — the OAuth App this entry needs hasn't been created.
              </div>
            )}
            {flow?.status === "pending" && (
              <div class="note" style="margin-top:6px">
                Go to <b>{flow.verificationUri}</b> and enter code <code>{flow.userCode}</code>. Waiting…
              </div>
            )}
            {flow?.status === "failed" && (
              <div class="note" style="margin-top:6px">
                Connect failed: {flow.reason}
              </div>
            )}
          </div>
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
          {!integration.connected && (
            <div class="note" style="margin-top:6px">
              Configured, not connected in this workspace — credentials never follow a shared config.
            </div>
          )}
          <div style="margin-top:8px">
            <RoutingEditor
              agents={state.agents}
              routing={integration.routing}
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
                <select value={authType} onChange={(e) => setAuthType((e.target as HTMLSelectElement).value as "none" | "bearer-token")}>
                  <option value="none">no auth</option>
                  <option value="bearer-token">bearer token</option>
                </select>
                {authType === "bearer-token" && (
                  <input
                    type="password"
                    placeholder="token…"
                    value={token}
                    onInput={(e) => setToken((e.target as HTMLInputElement).value)}
                  />
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
