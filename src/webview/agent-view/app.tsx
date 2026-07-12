// Agent View shell — the single blend: agents + sessions + chat (features §1).
// Vertical order per ui.md: header → session row → plan strip → chat → composer;
// drawers overlay from the top. Render-only: the shell owns only local UI
// furniture (which drawer is open, the toast); components own their markup
// and send their own actions; everything durable comes from snapshots.
import { useState } from "react";
import type { AgentViewState } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { Icon } from "../shared/icon";
import { Chat } from "./chat/chat";
import { Composer } from "./composer/composer";
import { AgentsDrawer, SessionsDrawer } from "./drawers";
import { Header } from "./header";
import { PlanStrip } from "./plan-strip";
import { SessionRow } from "./session-row";
import { Button } from "@/components/ui/button";

type Drawer = "agents" | "sessions" | null;

export function App({ state }: { state: AgentViewState }) {
  const send = useActions();
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [toast, setToast] = useState<string | null>(null);

  const active = state.sessions.find((s) => s.id === state.activeSessionId) ?? null;
  const activeAgent = active ? (state.agents.find((a) => a.id === active.agentId) ?? null) : null;

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  };
  const closeDrawer = (msg?: string) => {
    setDrawer(null);
    if (msg !== undefined) showToast(msg);
  };
  // One intent, one click (P17): a single configured agent starts directly
  // — the single-agent case never pays the multi-agent picker tax; zero
  // routes to Settings (where adding lives); only real choice opens the picker.
  const newChat = () => {
    setDrawer(null);
    if (state.agents.length === 0) send({ kind: "openSettings" });
    else if (state.agents.length === 1) send({ kind: "startChat", agentId: state.agents[0]!.id });
    else setDrawer("agents");
  };

  return (
    <div className="sidebar">
      <Header
        agent={activeAgent}
        usage={active !== null ? (state.sessionUsage[active.id] ?? null) : null}
        onSessions={() => setDrawer("sessions")}
        onNew={newChat}
      />
      {active !== null && (
        <SessionRow session={active} onTitle={() => setDrawer("sessions")} />
      )}
      {activeAgent !== null && activeAgent.status === "crashed" && (
        <div className="crash-banner">
          <Icon name="warning" /> {activeAgent.name} crashed
          {activeAgent.detail !== undefined ? ` — ${activeAgent.detail}` : ""}
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              send({ kind: "restartAgent", agentId: activeAgent.id });
              showToast("restarting…");
            }}
          >
            Restart
          </Button>
          {activeAgent.stderr !== undefined && activeAgent.stderr.length > 0 && (
            <pre className="stderr-tail">{activeAgent.stderr.join("\n")}</pre>
          )}
        </div>
      )}
      {active !== null && <PlanStrip entries={state.activePlan[active.id] ?? null} />}
      <Chat state={state} activeSession={active} onNewChat={newChat} />
      <Composer
        agent={activeAgent}
        session={active}
        commands={active !== null ? (state.commandsBySession[active.id] ?? []) : []}
        contextChips={active !== null ? (state.contextChips[active.id] ?? []) : []}
        contextRoots={active !== null ? (state.contextRoots[active.id] ?? []) : []}
        workspaceRoots={state.workspaceRoots}
        rootsApplyLive={
          // declared drives the mechanism itself (the continuation ladder is
          // declared-gated), so the honesty note follows declared too; a
          // session with nothing in it re-applies by recreation regardless
          (active !== null &&
            ((state.transcripts[active.id]?.length ?? 0) === 0 ||
              state.capabilities[active.agentId]?.["session.load"]?.declared === true ||
              state.capabilities[active.agentId]?.["session.resume"]?.declared === true)) ||
          false
        }
        liveSelection={state.liveSelection}
        openEditors={state.openEditors}
        workspaceFiles={state.workspaceFiles}
        knobs={active !== null ? (state.sessionKnobs[active.id] ?? []) : []}
      />
      {drawer !== null && <div className="scrim" onClick={() => setDrawer(null)} />}
      {drawer === "agents" && (
        <AgentsDrawer
          agents={state.agents}
          registryAgents={state.registryAgents}
          capabilities={state.capabilities}
          onDone={closeDrawer}
        />
      )}
      {drawer === "sessions" && (
        <SessionsDrawer
          sessions={state.sessions}
          agents={state.agents}
          activeSessionId={state.activeSessionId}
          onNew={newChat}
          onDone={() => setDrawer(null)}
        />
      )}
      {toast !== null && <div className="toast">{toast}</div>}
    </div>
  );
}
