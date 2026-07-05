// Agent View shell — the single blend: agents + sessions + chat (features §1).
// Vertical order per ui.md: header → session row → plan strip → chat → composer;
// drawers overlay from the top. Render-only: local state here is ephemeral UI
// furniture (open drawer, toast); everything durable comes from snapshots.
import { useState } from "preact/hooks";
import type {
  AgentStatus,
  AgentSummary,
  AgentViewState,
  ConnectAgentSource,
  SessionSummary,
} from "../../shared/protocol";
import type { ViewChannel } from "../shared/channel";
import { useChannelState } from "../shared/use-channel";

type Drawer = "agents" | "sessions" | null;

export function App({ channel }: { channel: ViewChannel<AgentViewState> }) {
  const state = useChannelState(channel);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [toast, setToast] = useState<string | null>(null);

  if (state === null) return null; // hydrating — snapshot arrives immediately

  const active =
    state.sessions.find((s) => s.id === state.activeSessionId) ?? null;
  const activeAgent = active
    ? (state.agents.find((a) => a.id === active.agentId) ?? null)
    : null;

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  };

  const connect = (source: ConnectAgentSource) => {
    channel.sendAction({ kind: "connectAgent", source });
    setDrawer(null);
    showToast("connecting…");
  };

  return (
    <div class="sidebar">
      <Header
        agent={activeAgent}
        onAgents={() => setDrawer("agents")}
        onSessions={() => setDrawer("sessions")}
        onNew={() => setDrawer("agents")}
        onSettings={() => channel.sendAction({ kind: "openSettings" })}
      />
      {active !== null && <SessionRow session={active} onTitle={() => setDrawer("sessions")} />}
      {/* plan strip: absent entirely until the agent maintains a plan (P4) */}
      <Chat state={state} onConnectClick={() => setDrawer("agents")} />
      <Composer agent={activeAgent} hasSession={active !== null} />
      {drawer !== null && <div class="scrim" onClick={() => setDrawer(null)} />}
      {drawer === "agents" && (
        <AgentsDrawer
          agents={state.agents}
          roster={state.roster}
          onConnect={connect}
          onRestart={(agentId) => {
            channel.sendAction({ kind: "restartAgent", agentId });
            showToast("restarting…");
          }}
        />
      )}
      {drawer === "sessions" && (
        <SessionsDrawer
          sessions={state.sessions}
          agents={state.agents}
          onNew={() => setDrawer("agents")}
        />
      )}
      {toast !== null && <div class="toast">{toast}</div>}
    </div>
  );
}

function Dot({ status }: { status: AgentStatus | "none" }) {
  return <span class={`dot ${status === "none" ? "stopped" : status}`} />;
}

function Header(props: {
  agent: AgentSummary | null;
  onAgents(): void;
  onSessions(): void;
  onNew(): void;
  onSettings(): void;
}) {
  return (
    <div class="hdr">
      <div class="agent-chip" title="Agents — status & routing" onClick={props.onAgents}>
        <Dot status={props.agent?.status ?? "none"} />
        <span class="name">{props.agent?.name ?? "No agent"}</span>
        <span class="caret">▾</span>
      </div>
      <div class="spacer" />
      {/* usage gauge renders only where usage reporting is verified — absent, not grayed */}
      <button class="icon-btn" title="Sessions" onClick={props.onSessions}>
        🕘
      </button>
      <button class="icon-btn" title="New session" onClick={props.onNew}>
        ＋
      </button>
      <button
        class="icon-btn"
        title="Settings — opens directly"
        onClick={props.onSettings}
      >
        ⚙
      </button>
    </div>
  );
}

function Badges({ session }: { session: SessionSummary }) {
  return (
    <>
      {session.emulated && (
        <span
          class="badge emulated"
          title="Continuation seeded from patchbay's last-known view — agent cannot replay"
        >
          emulated
        </span>
      )}
      {session.branchOf !== null && (
        <span class="badge branch" title={`Branched from ${session.branchOf}`}>
          ⑂ branch
        </span>
      )}
    </>
  );
}

function SessionRow(props: { session: SessionSummary; onTitle(): void }) {
  return (
    <div class="sess-row">
      <span class="sess-title" onClick={props.onTitle}>
        {props.session.title}
      </span>
      <Badges session={props.session} />
      <div class="spacer" style="flex:1" />
      <button class="icon-btn" title="Session actions">
        ⋯
      </button>
    </div>
  );
}

function Chat(props: { state: AgentViewState; onConnectClick(): void }) {
  const { agents, sessions, activeSessionId } = props.state;
  const active = sessions.find((s) => s.id === activeSessionId) ?? null;

  if (active === null) {
    return (
      <div class="chat">
        <div class="empty">
          <div class="glyph">⧉</div>
          <div class="tag">
            {agents.length === 0
              ? "Any ACP agent, resident in your editor. Connect one to begin."
              : "No session yet — start one with ＋."}
          </div>
          <div class="pick">
            <button class="btn primary" onClick={props.onConnectClick}>
              {agents.length === 0 ? "Connect agent…" : "＋ New session"}
            </button>
          </div>
        </div>
      </div>
    );
  }
  // chat transcript blocks land at P4
  return <div class="chat" />;
}

function Composer(props: { agent: AgentSummary | null; hasSession: boolean }) {
  const enabled = props.hasSession && props.agent?.status === "running";
  return (
    <div class="composer">
      {/* context row (roots, selection ghost, chips, adder) appears with editor depth (P7) */}
      <div class="input-shell">
        <textarea
          rows={1}
          disabled={!enabled}
          placeholder={
            enabled
              ? `Message ${props.agent!.name} — / for commands`
              : "Connect an agent to start"
          }
        />
        <div class="input-foot">
          <span style="flex:1" />
          {/* model/mode/effort knobs render only when the agent offers them (P8) */}
          <button class="send" disabled={!enabled} title="Send">
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentsDrawer(props: {
  agents: readonly AgentSummary[];
  roster: AgentViewState["roster"];
  onConnect(source: ConnectAgentSource): void;
  onRestart(agentId: string): void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [rosterId, setRosterId] = useState("");
  const [command, setCommand] = useState("");

  return (
    <div class="drawer">
      <h3>Agents</h3>
      {props.agents.length === 0 && (
        <div class="a-row" style="cursor:default">
          <span class="sub">No agents connected.</span>
        </div>
      )}
      {props.agents.map((a) => (
        <div class="a-row" key={a.id}>
          <Dot status={a.status} />
          <div>
            <div class="nm">{a.name}</div>
            {a.detail !== undefined && <div class="sub">{a.detail}</div>}
          </div>
          {/* fidelity chip appears once the capability matrix exists (P5) */}
          {a.status === "crashed" && (
            <button
              class="btn row-btn primary a-act"
              onClick={() => props.onRestart(a.id)}
            >
              Restart
            </button>
          )}
        </div>
      ))}
      {connecting ? (
        <div class="connect-form">
          <div class="row">
            <select
              value={rosterId}
              onChange={(e) => setRosterId((e.target as HTMLSelectElement).value)}
            >
              <option value="">from roster…</option>
              {props.roster.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button
              class="btn primary row-btn"
              disabled={rosterId === ""}
              onClick={() => props.onConnect({ rosterId })}
            >
              Connect
            </button>
          </div>
          <div class="row">
            <input
              type="text"
              placeholder="or a custom command that speaks ACP…"
              value={command}
              onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
            />
            <button
              class="btn row-btn"
              disabled={command.trim() === ""}
              onClick={() => props.onConnect({ command: command.trim() })}
            >
              Connect
            </button>
          </div>
        </div>
      ) : (
        <div class="foot" onClick={() => setConnecting(true)}>
          ＋ Connect agent — roster or custom command…
        </div>
      )}
    </div>
  );
}

function SessionsDrawer(props: {
  sessions: readonly SessionSummary[];
  agents: readonly AgentSummary[];
  onNew(): void;
}) {
  return (
    <div class="drawer">
      <h3>Sessions</h3>
      {props.sessions.length === 0 && (
        <div class="s-row" style="cursor:default">
          <span class="sub">No sessions yet.</span>
        </div>
      )}
      {props.sessions.map((s) => {
        const agent = props.agents.find((a) => a.id === s.agentId);
        return (
          <div class="s-row" key={s.id}>
            {s.live ? <span class="live-dot" /> : <span class="live-dot-slot" />}
            <div>
              <div class="nm">{s.title}</div>
              <div class="sub">{agent?.name ?? s.agentId}</div>
            </div>
            <div class="badges">
              <Badges session={s} />
            </div>
          </div>
        );
      })}
      <div class="foot" onClick={props.onNew}>
        ＋ New session
      </div>
    </div>
  );
}
