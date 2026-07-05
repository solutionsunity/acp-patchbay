// Settings shell — left nav + cards (ui.md § Settings). Sections fill in with
// their phases: agents/matrix (P5), integrations (P9), permissions (P6),
// rules·skills·commands (P10). Empty states are honest, never placeholders
// pretending to be data.
import { useState } from "preact/hooks";
import type { SettingsState } from "../../shared/protocol";
import type { ViewChannel } from "../shared/channel";
import { useChannelState } from "../shared/use-channel";

const SECTIONS = [
  { id: "agents", icon: "🔌", label: "Agents" },
  { id: "matrix", icon: "◳", label: "Capability matrix" },
  { id: "integrations", icon: "🧩", label: "Integrations" },
  { id: "permissions", icon: "🛡", label: "Permissions" },
  { id: "assets", icon: "📋", label: "Rules · skills · commands" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function App({ channel }: { channel: ViewChannel<SettingsState> }) {
  const state = useChannelState(channel);
  const [section, setSection] = useState<SectionId>("agents");

  if (state === null) return null;

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
        {section === "agents" && <AgentsSection state={state} />}
        {section === "matrix" && (
          <Section
            title="Capability matrix"
            sub="Declared is a claim; verified is what happened on the wire. UI features gate on verified."
            empty="The matrix appears once an agent has connected. (Lands with P5.)"
          />
        )}
        {section === "integrations" && (
          <Section
            title="Integrations"
            sub="Curated and custom are the same mechanism — MCP servers, routed per agent. Workspace-scoped by default."
            empty="No integrations yet. (Lands with P9.)"
          />
        )}
        {section === "permissions" && (
          <Section
            title="Permissions"
            sub="One rule set for everything — agent permission requests, MCP tools, terminal. No second surface."
            empty="Rules UI lands with P6. Defaults apply meanwhile: nothing pre-allowed."
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

function AgentsSection({ state }: { state: SettingsState }) {
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
      {state.agents.map((a) => (
        <div class="card" key={a.id}>
          <div class="row">
            <span class={`dot ${a.status}`} />
            <span class="nm">{a.name}</span>
            <span style="flex:1" />
            {a.detail !== undefined && <span class="note" style="margin:0">{a.detail}</span>}
          </div>
        </div>
      ))}
    </section>
  );
}
