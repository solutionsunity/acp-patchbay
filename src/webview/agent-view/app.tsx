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

  return (
    <div className="sidebar">
      <Header
        agent={activeAgent}
        usage={active !== null ? (state.sessionUsage[active.id] ?? null) : null}
        onAgents={() => setDrawer("agents")}
        onSessions={() => setDrawer("sessions")}
        onNew={() => setDrawer("agents")}
      />
      {active !== null && (
        <SessionRow
          session={active}
          forkUsed={state.capabilities[active.agentId]?.["session.fork"]?.used ?? false}
          onTitle={() => setDrawer("sessions")}
        />
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
      <Chat state={state} activeSession={active} onConnectClick={() => setDrawer("agents")} />
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
      />
      {drawer !== null && <div className="scrim" onClick={() => setDrawer(null)} />}
      {drawer === "agents" && (
        <AgentsDrawer
          agents={state.agents}
          roster={state.roster}
          capabilities={state.capabilities}
          onDone={closeDrawer}
        />
      )}
      {drawer === "sessions" && (
        <SessionsDrawer
          sessions={state.sessions}
          agents={state.agents}
          forkUsed={(agentId) => state.capabilities[agentId]?.["session.fork"]?.used ?? false}
          onNew={() => setDrawer("agents")}
          onDone={() => setDrawer(null)}
        />
      )}
      {toast !== null && <div className="toast">{toast}</div>}
    </div>
  );
}
