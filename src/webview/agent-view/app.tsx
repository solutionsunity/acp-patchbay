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
  ContextChip,
  LiveSelectionView,
  OpenEditorView,
  PlanBlock,
  SessionConfigOptionView,
  SessionModesView,
  SessionSummary,
  UsageInfo,
} from "../../shared/protocol";
import { computeFidelity } from "../../shared/protocol";
import { capabilityOneLiner, FIDELITY_CLASS, FIDELITY_TEXT } from "../shared/capability-format";
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
        usage={active !== null ? (state.sessionUsage[active.id] ?? null) : null}
        onAgents={() => setDrawer("agents")}
        onSessions={() => setDrawer("sessions")}
        onNew={() => setDrawer("agents")}
        onSettings={() => channel.sendAction({ kind: "openSettings" })}
      />
      {active !== null && (
        <SessionRow
          session={active}
          forkVerified={state.capabilities[active.agentId]?.["session.fork"]?.verified ?? false}
          onTitle={() => setDrawer("sessions")}
          onRename={(title) => renameSession(active.id, title)}
          onClose={() => closeSession(active.id)}
          onBranch={() => channel.sendAction({ kind: "branchSession", sessionId: active.id })}
          onReload={() => channel.sendAction({ kind: "reloadSession", sessionId: active.id })}
        />
      )}
      {activeAgent !== null && activeAgent.status === "crashed" && (
        <div class="crash-banner">
          ⚠ {activeAgent.name} crashed{activeAgent.detail !== undefined ? ` — ${activeAgent.detail}` : ""}
          <button
            class="btn danger row-btn"
            onClick={() => {
              channel.sendAction({ kind: "restartAgent", agentId: activeAgent.id });
              showToast("restarting…");
            }}
          >
            Restart
          </button>
        </div>
      )}
      {active !== null && <PlanStrip plan={state.activePlan[active.id] ?? null} />}
      <Chat
        state={state}
        activeSession={active}
        onConnectClick={() => setDrawer("agents")}
        onResolvePermission={(requestId, optionId) =>
          channel.sendAction({ kind: "resolvePermission", requestId, optionId })
        }
        onResolveDiff={(requestId, accept) =>
          channel.sendAction({ kind: "resolveDiff", requestId, accept })
        }
        onResolveElicitation={(requestId, values) =>
          channel.sendAction({ kind: "resolveElicitation", requestId, values })
        }
      />
      <Composer
        agent={activeAgent}
        session={active}
        commands={active !== null ? (state.commandsBySession[active.id] ?? []) : []}
        contextChips={active !== null ? (state.contextChips[active.id] ?? []) : []}
        contextRoots={active !== null ? (state.contextRoots[active.id] ?? []) : []}
        liveSelection={state.liveSelection}
        openEditors={state.openEditors}
        modes={active !== null ? (state.sessionModes[active.id] ?? null) : null}
        configOptions={active !== null ? (state.sessionConfigOptions[active.id] ?? []) : []}
        onSetMode={(modeId) =>
          channel.sendAction({ kind: "setSessionMode", sessionId: active!.id, modeId })
        }
        onSetConfigOption={(configId, value) =>
          channel.sendAction({ kind: "setSessionConfigOption", sessionId: active!.id, configId, value })
        }
        onSend={(text) => channel.sendAction({ kind: "sendPrompt", sessionId: active!.id, text })}
        onStop={() => channel.sendAction({ kind: "stopTurn", sessionId: active!.id })}
        onAddSelection={() => channel.sendAction({ kind: "addSelectionContext", sessionId: active!.id })}
        onAddFile={() => channel.sendAction({ kind: "addFileContext", sessionId: active!.id })}
        onAddDiagnostics={() =>
          channel.sendAction({ kind: "addDiagnosticsContext", sessionId: active!.id })
        }
        onAddFilePicker={() => channel.sendAction({ kind: "addFilePickerContext", sessionId: active!.id })}
        onAddOpenEditor={(path) =>
          channel.sendAction({ kind: "addOpenEditorContext", sessionId: active!.id, path })
        }
        onAddImage={(dataUrl, mimeType) =>
          channel.sendAction({
            kind: "addImageContext",
            sessionId: active!.id,
            dataUrl,
            mimeType,
            label: `Image (${mimeType})`,
          })
        }
        onAddRoot={() => channel.sendAction({ kind: "addContextRoot", sessionId: active!.id })}
        onRemoveRoot={(path) =>
          channel.sendAction({ kind: "removeContextRoot", sessionId: active!.id, path })
        }
        onRemoveChip={(chipId) =>
          channel.sendAction({ kind: "removeContextChip", sessionId: active!.id, chipId })
        }
      />
      {drawer !== null && <div class="scrim" onClick={() => setDrawer(null)} />}
      {drawer === "agents" && (
        <AgentsDrawer
          agents={state.agents}
          roster={state.roster}
          capabilities={state.capabilities}
          onConnect={connect}
          onStartSession={startSession}
          onRestart={(agentId) => {
            channel.sendAction({ kind: "restartAgent", agentId });
            showToast("restarting…");
          }}
          onStop={(agentId) => {
            channel.sendAction({ kind: "stopAgent", agentId });
            showToast("stopped");
          }}
        />
      )}
      {drawer === "sessions" && (
        <SessionsDrawer
          sessions={state.sessions}
          agents={state.agents}
          forkVerified={(agentId) => state.capabilities[agentId]?.["session.fork"]?.verified ?? false}
          onNew={() => setDrawer("agents")}
          onSwitch={switchSession}
          onRename={renameSession}
          onClose={closeSession}
          onBranch={(sessionId) => channel.sendAction({ kind: "branchSession", sessionId })}
          onReload={(sessionId) => channel.sendAction({ kind: "reloadSession", sessionId })}
        />
      )}
      {toast !== null && <div class="toast">{toast}</div>}
    </div>
  );
}

function Dot({ status }: { status: AgentStatus | "none" }) {
  return <span class={`dot ${status === "none" ? "stopped" : status}`} />;
}

function UsageGauge({ usage }: { usage: UsageInfo }) {
  const frac = Math.max(0, Math.min(1, usage.used / usage.size));
  const circumference = 62.8;
  const tip = `${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens${
    usage.cost !== undefined ? ` · ${usage.cost.amount.toFixed(2)} ${usage.cost.currency}` : ""
  }`;
  return (
    <div class="gauge" title={tip}>
      <svg width="26" height="26" viewBox="0 0 26 26">
        <circle cx="13" cy="13" r="10" fill="none" stroke="var(--pb-border)" stroke-width="3" />
        <circle
          cx="13"
          cy="13"
          r="10"
          fill="none"
          stroke="var(--pb-consumed)"
          stroke-width="3"
          stroke-linecap="round"
          stroke-dasharray={`${(frac * circumference).toFixed(1)} ${circumference}`}
        />
      </svg>
      <div class="tip">{tip}</div>
    </div>
  );
}

function Header(props: {
  agent: AgentSummary | null;
  usage: UsageInfo | null;
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
      {/* sessionUsage only ever gets an entry alongside marking "usage"
          verified (SessionManager emits both atomically), so presence here
          already means verified — absent, never grayed, until then. */}
      {props.usage !== null && <UsageGauge usage={props.usage} />}
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
  forkVerified: boolean;
  onRename(title: string): void;
  onClose(): void;
  onBranch(): void;
  onReload(): void;
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
      <div class="pop" style="top:22px;right:0" onClick={(e) => e.stopPropagation()}>
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
    <div class="pop" style="top:22px;right:0" onClick={(e) => e.stopPropagation()}>
      <div class="it" onClick={() => setRenaming(true)}>
        Rename…
      </div>
      <div
        class="it"
        onClick={() => {
          props.onBranch();
          props.onDone();
        }}
      >
        Branch <span class="d">{props.forkVerified ? "native fork ✓" : "emulated"}</span>
      </div>
      <div
        class="it"
        onClick={() => {
          props.onReload();
          props.onDone();
        }}
      >
        Reload from agent
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
  forkVerified: boolean;
  onTitle(): void;
  onRename(title: string): void;
  onClose(): void;
  onBranch(): void;
  onReload(): void;
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
          forkVerified={props.forkVerified}
          onRename={props.onRename}
          onClose={props.onClose}
          onBranch={props.onBranch}
          onReload={props.onReload}
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

function PermissionCard(props: {
  block: Extract<ChatBlock, { kind: "permission" }>;
  onResolve(optionId: string): void;
}) {
  const { block } = props;
  return (
    <div class="card perm">
      <div class="card-hd">🛡 {block.title} — one broker, one rule set</div>
      <div class="q">
        <code>{block.detail}</code>
      </div>
      {block.resolution === null ? (
        <div class="acts">
          {block.options.map((o) => (
            <button
              key={o.optionId}
              class={`btn ${o.kind === "allow_once" ? "primary" : o.kind.startsWith("reject") ? "danger" : ""}`}
              onClick={() => props.onResolve(o.optionId)}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <div class="resolved">
          ✓ {block.resolution.label}
          {block.resolution.auto ? " (rule)" : ""} · written to decision audit
        </div>
      )}
    </div>
  );
}

function DiffCard(props: {
  block: Extract<ChatBlock, { kind: "diff" }>;
  onResolve(accept: boolean): void;
}) {
  const { block } = props;
  return (
    <div class="card">
      <div class="diff-file">
        📝 <code>{block.file}</code>
        <span class="plus">+{block.additions}</span>
        <span class="minus">−{block.deletions}</span>
        <span class="st" style="margin-left:auto">
          {block.resolution !== null
            ? block.resolution.accepted
              ? `✓ ${block.resolution.auto ? "accepted (rule)" : "accepted"} — written to disk`
              : "✗ rejected — disk untouched"
            : ""}
        </span>
      </div>
      <div class="diff-body">
        {block.lines.slice(0, 40).map((line, i) => (
          <div key={i} class={line.kind === "add" ? "add" : line.kind === "del" ? "del" : ""}>
            {line.text}
          </div>
        ))}
      </div>
      {block.resolution === null && (
        <div class="acts">
          <button class="btn primary" onClick={() => props.onResolve(true)}>
            Accept
          </button>
          <button class="btn danger" onClick={() => props.onResolve(false)}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

function TerminalCard({ block }: { block: Extract<ChatBlock, { kind: "terminal" }> }) {
  return (
    <div class="card">
      <div class="card-hd">
        ▣ {block.command}
        <span class="st">
          {block.running ? (
            <>
              <span class="spin" /> live
            </>
          ) : (
            `✓ exit ${block.exitCode ?? "?"}`
          )}
        </span>
      </div>
      <div class="term">{block.output || " "}</div>
    </div>
  );
}

function ElicitationCard(props: {
  block: Extract<ChatBlock, { kind: "elicitation" }>;
  onResolve(values: Record<string, unknown> | null): void;
}) {
  const { block } = props;
  const [values, setValues] = useState<Record<string, string>>({});

  if (block.resolution !== null) {
    return (
      <div class="card perm">
        <div class="card-hd">❔ {block.message}</div>
        <div class="resolved">{block.resolution.cancelled ? "✗ cancelled" : "✓ submitted"}</div>
      </div>
    );
  }

  const submit = () => {
    const out: Record<string, unknown> = {};
    for (const f of block.fields) {
      const raw = values[f.name] ?? "";
      if (f.type === "number" || f.type === "integer") out[f.name] = raw === "" ? undefined : Number(raw);
      else if (f.type === "boolean") out[f.name] = raw === "true";
      else out[f.name] = raw;
    }
    props.onResolve(out);
  };

  return (
    <div class="card perm">
      <div class="card-hd">❔ {block.message}</div>
      <div class="connect-form" style="padding:0 10px 10px">
        {block.fields.map((f) => (
          <div key={f.name}>
            <label class="k" style="font-size:11px;color:var(--pb-text-faint)">
              {f.title ?? f.name}
              {f.required ? " *" : ""}
            </label>
            {f.type === "boolean" ? (
              <select
                value={values[f.name] ?? "false"}
                onChange={(e) => setValues({ ...values, [f.name]: (e.target as HTMLSelectElement).value })}
              >
                <option value="false">No</option>
                <option value="true">Yes</option>
              </select>
            ) : (
              <input
                type={f.type === "number" || f.type === "integer" ? "number" : "text"}
                value={values[f.name] ?? ""}
                onInput={(e) => setValues({ ...values, [f.name]: (e.target as HTMLInputElement).value })}
              />
            )}
          </div>
        ))}
      </div>
      <div class="acts">
        <button class="btn primary" onClick={submit}>
          Submit
        </button>
        <button class="btn danger" onClick={() => props.onResolve(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Block({
  block,
  onResolvePermission,
  onResolveDiff,
  onResolveElicitation,
}: {
  block: ChatBlock;
  onResolvePermission(requestId: string, optionId: string): void;
  onResolveDiff(requestId: string, accept: boolean): void;
  onResolveElicitation(requestId: string, values: Record<string, unknown> | null): void;
}) {
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
    case "permission":
      return <PermissionCard block={block} onResolve={(optionId) => onResolvePermission(block.id, optionId)} />;
    case "diff":
      return <DiffCard block={block} onResolve={(accept) => onResolveDiff(block.id, accept)} />;
    case "terminal":
      return <TerminalCard block={block} />;
    case "elicitation":
      return (
        <ElicitationCard block={block} onResolve={(values) => onResolveElicitation(block.id, values)} />
      );
  }
}

function Chat(props: {
  state: AgentViewState;
  activeSession: SessionSummary | null;
  onConnectClick(): void;
  onResolvePermission(requestId: string, optionId: string): void;
  onResolveDiff(requestId: string, accept: boolean): void;
  onResolveElicitation(requestId: string, values: Record<string, unknown> | null): void;
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
        <Block
          key={block.id}
          block={block}
          onResolvePermission={props.onResolvePermission}
          onResolveDiff={props.onResolveDiff}
          onResolveElicitation={props.onResolveElicitation}
        />
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

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The `@` context mention picker (ui.md § Composer): open editors plus the
 * adder's own entries — every pick resolves to standard content blocks, so
 * it works for every agent. */
function MentionMenu(props: {
  filter: string;
  openEditors: readonly OpenEditorView[];
  hasSelection: boolean;
  onPickEditor(path: string): void;
  onPickSelection(): void;
  onPickProblems(): void;
  onPickAttach(): void;
}) {
  const filter = props.filter.toLowerCase();
  const editors = props.openEditors.filter((e) =>
    basename(e.file).toLowerCase().includes(filter),
  );
  return (
    <div class="pop" style="bottom:44px;left:0;right:0">
      {editors.slice(0, 8).map((e) => (
        <div class="it" key={e.file} onClick={() => props.onPickEditor(e.file)}>
          <b>📄 {basename(e.file)}</b>
          <span class="d">
            {e.dirty ? "● unsaved · " : ""}
            {e.file}
          </span>
        </div>
      ))}
      {props.hasSelection && (
        <div class="it" onClick={props.onPickSelection}>
          <b>⌖ Selection</b>
          <span class="d">current editor selection</span>
        </div>
      )}
      <div class="it" onClick={props.onPickProblems}>
        <b>⚠ Problems</b>
        <span class="d">workspace diagnostics</span>
      </div>
      <div class="it" onClick={props.onPickAttach}>
        <b>📎 Attach file…</b>
        <span class="d">pick any file</span>
      </div>
      <div class="src">resolves to standard content blocks — works for every agent</div>
    </div>
  );
}

/** ◈ model · ⚙ default · ⚡ effort — one pill per agent-offered knob only; an
 * unoffered knob renders nothing (ui.md § Composer action row). Requested ≠
 * confirmed: a just-changed pill shows ⏳ until the agent's own state
 * notification lands, never optimistically. */
function Knobs(props: {
  modes: SessionModesView | null;
  configOptions: readonly SessionConfigOptionView[];
  onSetMode(modeId: string): void;
  onSetConfigOption(configId: string, value: string | boolean): void;
}) {
  const [pendingMode, setPendingMode] = useState(false);
  useEffect(() => setPendingMode(false), [props.modes?.currentModeId]);
  const [pendingConfig, setPendingConfig] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setPendingConfig((cur) => {
      const next = { ...cur };
      for (const o of props.configOptions) delete next[o.id];
      return next;
    });
  }, [props.configOptions.map((o) => String(o.currentValue)).join("|")]);

  const glyphFor = (category: string | undefined) =>
    category === "model" ? "◈" : category === "thought_level" ? "⚡" : "⚙";

  return (
    <>
      {props.modes && (
        <span class="knob" title="Session mode">
          ⚙
          <select
            value={props.modes.currentModeId}
            onChange={(e) => {
              setPendingMode(true);
              props.onSetMode((e.target as HTMLSelectElement).value);
            }}
          >
            {props.modes.available.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {pendingMode && <span class="knob-pending">⏳</span>}
        </span>
      )}
      {props.configOptions.map((o) => (
        <span class="knob" key={o.id} title={o.name}>
          {glyphFor(o.category)}
          {o.type === "boolean" ? (
            <input
              type="checkbox"
              checked={o.currentValue}
              onChange={(e) => {
                setPendingConfig((cur) => ({ ...cur, [o.id]: true }));
                props.onSetConfigOption(o.id, (e.target as HTMLInputElement).checked);
              }}
            />
          ) : (
            <select
              value={o.currentValue}
              onChange={(e) => {
                setPendingConfig((cur) => ({ ...cur, [o.id]: true }));
                props.onSetConfigOption(o.id, (e.target as HTMLSelectElement).value);
              }}
            >
              {o.options.map((entry) =>
                "group" in entry ? (
                  <optgroup key={entry.group} label={entry.name}>
                    {entry.options.map((v) => (
                      <option key={v.value} value={v.value}>
                        {v.name}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  <option key={entry.value} value={entry.value}>
                    {entry.name}
                  </option>
                ),
              )}
            </select>
          )}
          {pendingConfig[o.id] && <span class="knob-pending">⏳</span>}
        </span>
      ))}
    </>
  );
}

/** ⧉ n — external context roots (features.md § Chat): workspace folders are
 * always active and need no chip; this is the removable, user-added set,
 * passed to the agent as `additionalDirectories` on the next
 * create/reload/fork (ACP has no live-update request, so a note says so). */
function RootsChip(props: {
  roots: readonly string[];
  onAdd(): void;
  onRemove(path: string): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span class="ctx-chip" style="position:relative" onClick={() => setOpen((v) => !v)}>
      ⧉ {props.roots.length} root{props.roots.length === 1 ? "" : "s"}
      {open && (
        <div class="pop" style="bottom:28px;left:0" onClick={(e) => e.stopPropagation()}>
          {props.roots.length === 0 && (
            <div class="it" style="cursor:default">
              <span class="d">no external roots added</span>
            </div>
          )}
          {props.roots.map((r) => (
            <div class="it" key={r}>
              <code>{r}</code>
              <span class="d" onClick={() => props.onRemove(r)}>
                remove
              </span>
            </div>
          ))}
          <div
            class="it"
            onClick={() => {
              props.onAdd();
              setOpen(false);
            }}
          >
            <b>+ Add folder…</b>
            <span class="d">takes effect next reload/branch</span>
          </div>
        </div>
      )}
    </span>
  );
}

function Composer(props: {
  agent: AgentSummary | null;
  session: SessionSummary | null;
  commands: readonly AvailableCommand[];
  contextChips: readonly ContextChip[];
  contextRoots: readonly string[];
  liveSelection: LiveSelectionView | null;
  openEditors: readonly OpenEditorView[];
  modes: SessionModesView | null;
  configOptions: readonly SessionConfigOptionView[];
  onSetMode(modeId: string): void;
  onSetConfigOption(configId: string, value: string | boolean): void;
  onSend(text: string): void;
  onStop(): void;
  onAddSelection(): void;
  onAddFile(): void;
  onAddDiagnostics(): void;
  onAddFilePicker(): void;
  onAddImage(dataUrl: string, mimeType: string): void;
  onAddRoot(): void;
  onRemoveRoot(path: string): void;
  onRemoveChip(chipId: string): void;
  onAddOpenEditor(path: string): void;
}) {
  const [draft, setDraft] = useState("");
  const [adderOpen, setAdderOpen] = useState(false);
  const enabled = props.session !== null && props.agent?.status === "running";
  const live = props.session?.live ?? false;
  const showSlash = draft.startsWith("/") && !draft.includes(" ");
  // The second typed trigger (ui.md § Composer): the caret word starting
  // with "@" opens the context mention picker.
  const mentionToken = (() => {
    if (showSlash) return null;
    const last = draft.split(/\s/).pop() ?? "";
    return last.startsWith("@") ? last : null;
  })();
  const mentionPick = (action: () => void) => {
    setDraft(draft.slice(0, draft.length - mentionToken!.length).trimEnd());
    action();
  };

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result); // "data:image/png;base64,...."
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        props.onAddImage(base64, item.type);
      };
      reader.readAsDataURL(file);
      return; // one image per paste — never disabled, never ambiguous
    }
  };

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
      {(props.contextChips.length > 0 || props.contextRoots.length > 0 || enabled) && (
        <div class="ctx-row">
          {enabled && (
            <RootsChip roots={props.contextRoots} onAdd={props.onAddRoot} onRemove={props.onRemoveRoot} />
          )}
          {enabled && props.liveSelection !== null && (
            <span
              class="ctx-chip ghost"
              title="Live IDE selection — click to add it to context"
              onClick={props.onAddSelection}
            >
              ⌖ {basename(props.liveSelection.file)}:{props.liveSelection.startLine}
              {props.liveSelection.endLine !== props.liveSelection.startLine
                ? `-${props.liveSelection.endLine}`
                : ""}
            </span>
          )}
          {props.contextChips.map((c) => (
            <span class="ctx-chip" key={c.id} title={c.kind === "image" ? c.label : c.content.slice(0, 300)}>
              {c.kind === "selection" ? "⌖" : c.kind === "file" ? "📄" : c.kind === "image" ? "🖼" : "⚠"}{" "}
              {c.label}
              <span class="x" onClick={() => props.onRemoveChip(c.id)}>
                ×
              </span>
            </span>
          ))}
          {enabled && (
            <span class="ctx-chip ctx-add" onClick={() => setAdderOpen((v) => !v)}>
              ＋
            </span>
          )}
          {adderOpen && (
            <div class="pop" style="bottom:28px;left:0">
              <div
                class="it"
                onClick={() => {
                  props.onAddSelection();
                  setAdderOpen(false);
                }}
              >
                <b>⌖ Selection</b>
                <span class="d">current editor selection</span>
              </div>
              <div
                class="it"
                onClick={() => {
                  props.onAddFile();
                  setAdderOpen(false);
                }}
              >
                <b>📄 Current file</b>
                <span class="d">active editor</span>
              </div>
              <div
                class="it"
                onClick={() => {
                  props.onAddDiagnostics();
                  setAdderOpen(false);
                }}
              >
                <b>⚠ Problems</b>
                <span class="d">workspace diagnostics</span>
              </div>
              <div
                class="it"
                onClick={() => {
                  props.onAddFilePicker();
                  setAdderOpen(false);
                }}
              >
                <b>📎 Attach file…</b>
                <span class="d">pick any file</span>
              </div>
            </div>
          )}
        </div>
      )}
      <div class="input-shell" style="position:relative">
        {showSlash && (
          <SlashMenu
            commands={props.commands}
            filter={draft.slice(1)}
            onPick={(name) => setDraft(`/${name} `)}
          />
        )}
        {enabled && mentionToken !== null && (
          <MentionMenu
            filter={mentionToken.slice(1)}
            openEditors={props.openEditors}
            hasSelection={props.liveSelection !== null}
            onPickEditor={(path) => mentionPick(() => props.onAddOpenEditor(path))}
            onPickSelection={() => mentionPick(props.onAddSelection)}
            onPickProblems={() => mentionPick(props.onAddDiagnostics)}
            onPickAttach={() => mentionPick(props.onAddFilePicker)}
          />
        )}
        <textarea
          rows={1}
          disabled={!enabled}
          value={draft}
          onPaste={handlePaste}
          onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            enabled
              ? `Message ${props.agent!.name} — / commands · @ context`
              : "Connect an agent to start"
          }
        />
        <div class="input-foot">
          <Knobs
            modes={props.modes}
            configOptions={props.configOptions}
            onSetMode={props.onSetMode}
            onSetConfigOption={props.onSetConfigOption}
          />
          <span style="flex:1" />
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
  capabilities: AgentViewState["capabilities"];
  onConnect(source: ConnectAgentSource): void;
  onStartSession(agentId: string): void;
  onRestart(agentId: string): void;
  onStop(agentId: string): void;
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
      {props.agents.map((a) => {
        const matrix = props.capabilities[a.id];
        const roster = props.roster.find((r) => r.id === a.id);
        const fidelity =
          matrix !== undefined ? computeFidelity(matrix, roster?.knownBypassBridge ?? false) : null;
        return (
          <div class="a-row" key={a.id} style="cursor:default">
            <Dot status={a.status} />
            <div style="flex:1; min-width:0">
              <div class="nm">{a.name}</div>
              <div class="sub">
                {a.detail ?? (matrix !== undefined ? capabilityOneLiner(matrix) : "")}
              </div>
            </div>
            {fidelity !== null && (
              <span class={`fid ${FIDELITY_CLASS[fidelity]}`}>{FIDELITY_TEXT[fidelity]}</span>
            )}
            {a.status === "running" && (
              <>
                <button class="btn row-btn primary" onClick={() => props.onStartSession(a.id)}>
                  Start session
                </button>
                <button class="btn row-btn" onClick={() => props.onStop(a.id)}>
                  Stop
                </button>
              </>
            )}
            {a.status === "crashed" && (
              <button class="btn row-btn primary" onClick={() => props.onRestart(a.id)}>
                Restart
              </button>
            )}
          </div>
        );
      })}
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
  forkVerified(agentId: string): boolean;
  onNew(): void;
  onSwitch(sessionId: string): void;
  onRename(sessionId: string, title: string): void;
  onClose(sessionId: string): void;
  onBranch(sessionId: string): void;
  onReload(sessionId: string): void;
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
                forkVerified={props.forkVerified(s.agentId)}
                onRename={(title) => props.onRename(s.id, title)}
                onClose={() => props.onClose(s.id)}
                onBranch={() => props.onBranch(s.id)}
                onReload={() => props.onReload(s.id)}
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
