// Agent View shell — the single blend: agents + sessions + chat (features §1).
// Vertical order per ui.md: header → session row → plan strip → chat → composer;
// drawers overlay from the top. Render-only: local state here is ephemeral UI
// furniture (open drawer, draft text, popovers); everything durable comes
// from snapshots.
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  AgentStatus,
  AgentSummary,
  AgentViewState,
  AvailableCommand,
  ChatBlock,
  ConnectAgentSource,
  PlanBlock,
  SessionSummary,
} from "../../shared/protocol";
import type { ViewChannel } from "../shared/channel";
import { Markdown } from "./markdown";

type Drawer = "agents" | "sessions" | null;

export function App({ channel }: { channel: ViewChannel<AgentViewState> }) {
  const state = channel.getState()?.state ?? null;
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

  const startSession = (agentId: string) => {
    channel.sendAction({ kind: "newSession", agentId });
    setDrawer(null);
  };

  const switchSession = (sessionId: string) => {
    channel.sendAction({ kind: "switchSession", sessionId });
    setDrawer(null);
  };

  const renameSession = (sessionId: string, title: string) => {
    channel.sendAction({ kind: "renameSession", sessionId, title });
  };

  const closeSession = (sessionId: string) => {
    channel.sendAction({ kind: "closeSession", sessionId });
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
      {active !== null && (
        <SessionRow
          session={active}
          onTitle={() => setDrawer("sessions")}
          onRename={(title) => renameSession(active.id, title)}
          onClose={() => closeSession(active.id)}
        />
      )}
      {active !== null && <PlanStrip plan={state.activePlan[active.id] ?? null} />}
      <Chat
        state={state}
        activeSession={active}
        onConnectClick={() => setDrawer("agents")}
      />
      <Composer
        agent={activeAgent}
        session={active}
        commands={active !== null ? (state.commandsBySession[active.id] ?? []) : []}
        onSend={(text) => channel.sendAction({ kind: "sendPrompt", sessionId: active!.id, text })}
        onStop={() => channel.sendAction({ kind: "stopTurn", sessionId: active!.id })}
      />
      {drawer !== null && <div class="scrim" onClick={() => setDrawer(null)} />}
      {drawer === "agents" && (
        <AgentsDrawer
          agents={state.agents}
          roster={state.roster}
          onConnect={connect}
          onStartSession={startSession}
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
          onSwitch={switchSession}
          onRename={renameSession}
          onClose={closeSession}
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
      {/* usage gauge renders only where usage reporting is verified — absent, not grayed (P5) */}
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

/** Small popover shared by the session row and sessions-drawer rows. */
function SessionActions(props: {
  title: string;
  onRename(title: string): void;
  onClose(): void;
  onDone(): void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(props.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);

  if (renaming) {
    const save = () => {
      const trimmed = draft.trim();
      if (trimmed !== "") props.onRename(trimmed);
      props.onDone();
    };
    return (
      <div class="pop" onClick={(e) => e.stopPropagation()}>
        <div class="connect-form">
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") props.onDone();
            }}
          />
          <button class="btn primary row-btn" onClick={save}>
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="pop" onClick={(e) => e.stopPropagation()}>
      <div class="it" onClick={() => setRenaming(true)}>
        Rename…
      </div>
      <div
        class="it"
        onClick={() => {
          props.onClose();
          props.onDone();
        }}
      >
        Close
      </div>
    </div>
  );
}

function SessionRow(props: {
  session: SessionSummary;
  onTitle(): void;
  onRename(title: string): void;
  onClose(): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div class="sess-row" style="position:relative">
      <span class="sess-title" onClick={props.onTitle}>
        {props.session.title}
      </span>
      <Badges session={props.session} />
      <div class="spacer" style="flex:1" />
      <button
        class="icon-btn"
        title="Session actions"
        onClick={() => setMenuOpen((v) => !v)}
      >
        ⋯
      </button>
      {menuOpen && (
        <SessionActions
          title={props.session.title}
          onRename={props.onRename}
          onClose={props.onClose}
          onDone={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}

function PlanStrip({ plan }: { plan: PlanBlock | null }) {
  const [open, setOpen] = useState(false);
  if (plan === null) return null; // present only while the agent maintains a plan
  const done = plan.entries.filter((e) => e.status === "completed").length;
  const current =
    plan.entries.find((e) => e.status === "in_progress")?.content ??
    plan.entries[plan.entries.length - 1]?.content ??
    "";
  return (
    <div class={`plan-strip ${open ? "open" : ""}`} onClick={() => setOpen((v) => !v)}>
      ▸ Plan <span class="frac">{done}/{plan.entries.length}</span> — {current}
      {open && (
        <div class="items">
          {plan.entries.map((e, i) => (
            <div key={i} class={e.status}>
              {e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"} {e.content}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`thought ${open ? "open" : ""}`} onClick={() => setOpen((v) => !v)}>
      💭 {open ? text : text.length > 60 ? `${text.slice(0, 60)}…` : text} ▸
      {open && <div class="body">{text}</div>}
    </div>
  );
}

function ToolCallCard({ title, status }: { title: string; status: string }) {
  const glyph = status === "completed" ? "✓" : status === "failed" ? "✗" : null;
  return (
    <div class="card">
      <div class="card-hd">
        🛠 {title}
        <span class="st">
          {glyph === null ? (
            <>
              <span class="spin" /> {status === "pending" ? "pending" : "running"}
            </>
          ) : (
            glyph
          )}
        </span>
      </div>
    </div>
  );
}

function PlanCard({ block }: { block: PlanBlock }) {
  return (
    <div class="card plan-card">
      <div class="card-hd">📋 Plan</div>
      {block.entries.map((e, i) => (
        <div key={i} class={`row ${e.status}`}>
          {e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"}{" "}
          <span>{e.content}</span>
        </div>
      ))}
    </div>
  );
}

function Block({ block }: { block: ChatBlock }) {
  switch (block.kind) {
    case "user":
      return <div class="msg-user">{block.text}</div>;
    case "text":
      return (
        <div class="msg-agent">
          <Markdown text={block.text} />
        </div>
      );
    case "thought":
      return <Thought text={block.text} />;
    case "toolCall":
      return <ToolCallCard title={block.title} status={block.status} />;
    case "plan":
      return <PlanCard block={block} />;
  }
}

function Chat(props: {
  state: AgentViewState;
  activeSession: SessionSummary | null;
  onConnectClick(): void;
}) {
  const { agents } = props.state;
  const active = props.activeSession;
  const chatRef = useRef<HTMLDivElement>(null);
  const blocks = active !== null ? (props.state.transcripts[active.id] ?? []) : [];

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks.length, blocks[blocks.length - 1]]);

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

  return (
    <div class="chat" ref={chatRef}>
      {blocks.map((block) => (
        <Block key={block.id} block={block} />
      ))}
    </div>
  );
}

function SlashMenu(props: {
  commands: readonly AvailableCommand[];
  filter: string;
  onPick(name: string): void;
}) {
  const matches = props.commands.filter((c) =>
    c.name.toLowerCase().startsWith(props.filter.toLowerCase()),
  );
  if (matches.length === 0) return null;
  return (
    <div class="pop" style="bottom:44px;left:0;right:0">
      {matches.map((c) => (
        <div class="it" key={c.name} onClick={() => props.onPick(c.name)}>
          <b>/{c.name}</b>
          {c.description !== undefined && <span class="d">{c.description}</span>}
        </div>
      ))}
      <div class="src">advertised by the agent · available_commands_update</div>
    </div>
  );
}

function Composer(props: {
  agent: AgentSummary | null;
  session: SessionSummary | null;
  commands: readonly AvailableCommand[];
  onSend(text: string): void;
  onStop(): void;
}) {
  const [draft, setDraft] = useState("");
  const enabled = props.session !== null && props.agent?.status === "running";
  const live = props.session?.live ?? false;
  const showSlash = draft.startsWith("/") && !draft.includes(" ");

  const submit = () => {
    if (live) {
      props.onStop();
      return;
    }
    const text = draft.trim();
    if (text === "") return;
    props.onSend(text);
    setDraft("");
  };

  return (
    <div class="composer">
      {/* context row (roots, selection ghost, chips, adder) appears with editor depth (P7) */}
      <div class="input-shell" style="position:relative">
        {showSlash && (
          <SlashMenu
            commands={props.commands}
            filter={draft.slice(1)}
            onPick={(name) => setDraft(`/${name} `)}
          />
        )}
        <textarea
          rows={1}
          disabled={!enabled}
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            enabled
              ? `Message ${props.agent!.name} — / for commands`
              : "Connect an agent to start"
          }
        />
        <div class="input-foot">
          <span style="flex:1" />
          {/* model/mode/effort knobs render only when the agent offers them (P8) */}
          <button
            class={`send ${live ? "stop" : ""}`}
            disabled={!enabled}
            title={live ? "Stop" : "Send"}
            onClick={submit}
          >
            {live ? "■" : "↑"}
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
  onStartSession(agentId: string): void;
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
        <div class="a-row" key={a.id} style="cursor:default">
          <Dot status={a.status} />
          <div>
            <div class="nm">{a.name}</div>
            {a.detail !== undefined && <div class="sub">{a.detail}</div>}
          </div>
          {/* fidelity chip appears once the capability matrix exists (P5) */}
          {a.status === "running" && (
            <button
              class="btn row-btn primary a-act"
              onClick={() => props.onStartSession(a.id)}
            >
              Start session
            </button>
          )}
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
  onSwitch(sessionId: string): void;
  onRename(sessionId: string, title: string): void;
  onClose(sessionId: string): void;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);

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
          <div
            class="s-row"
            key={s.id}
            style="position:relative"
            onClick={() => props.onSwitch(s.id)}
          >
            {s.live ? <span class="live-dot" /> : <span class="live-dot-slot" />}
            <div>
              <div class="nm">{s.title}</div>
              <div class="sub">{agent?.name ?? s.agentId}</div>
            </div>
            <div class="badges">
              <Badges session={s} />
              <span
                class="kebab"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor((cur) => (cur === s.id ? null : s.id));
                }}
              >
                ⋯
              </span>
            </div>
            {menuFor === s.id && (
              <SessionActions
                title={s.title}
                onRename={(title) => props.onRename(s.id, title)}
                onClose={() => props.onClose(s.id)}
                onDone={() => setMenuFor(null)}
              />
            )}
          </div>
        );
      })}
      <div class="foot" onClick={props.onNew}>
        ＋ New session
      </div>
    </div>
  );
}
