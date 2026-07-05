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
          <Section
            title="Integrations"
            sub="Curated and custom are the same mechanism — MCP servers, routed per agent. Workspace-scoped by default."
            empty="No integrations yet. (Lands with P9.)"
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
