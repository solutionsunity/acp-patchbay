// Agent View shell — the single blend: agents + sessions + chat (features §1).
// Vertical order per ui.md: header → session row → chat → read-out strip → composer;
// drawers overlay from the top. Render-only: the shell owns only local UI
// furniture (which drawer is open, the toast); components own their markup
// and send their own actions; everything durable comes from snapshots.
import { useMemo, useState } from "react";
import type { AgentViewState } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { Icon } from "../shared/icon";
import { Chat } from "./chat/chat";
import { deriveTranscript, EMPTY_TRANSCRIPT } from "./chat/view-model";
import { Composer } from "./composer/composer";
import { AgentsDrawer, SessionsDrawer } from "./drawers";
import { Header } from "./header";
import { ReadoutStrip } from "./readout-strip";
import { SessionRow } from "./session-row";
import { Button } from "@/components/ui/button";

type Drawer = "agents" | "sessions" | null;

export function App({
  state,
  pinnedSessionId,
}: {
  state: AgentViewState;
  /** Detached session panel: render exactly this session, ignore the shared
   * active-session pointer, and drop the shell furniture (header, drawers,
   * new-chat) — those belong to the full view. */
  pinnedSessionId?: string;
}) {
  const send = useActions();
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [toast, setToast] = useState<string | null>(null);

  const pinned = pinnedSessionId !== undefined;
  const active =
    state.sessions.find((s) => s.id === (pinned ? pinnedSessionId : state.activeSessionId)) ??
    null;
  const activeAgent = active ? (state.agents.find((a) => a.id === active.agentId) ?? null) : null;

  // The one transcript derivation (view-model.ts), hoisted here because two
  // siblings consume it: Chat renders the items/rollups, the composer's
  // stats strip the same pass's session totals.
  const blocks = active !== null ? (state.transcripts[active.id] ?? []) : [];
  const activeLive = active?.live ?? false;
  const derived = useMemo(
    () => (blocks.length > 0 ? deriveTranscript(blocks, activeLive) : EMPTY_TRANSCRIPT),
    [blocks, activeLive],
  );
  // `?? true` guards snapshots minted before the preferences field existed.
  const showStats = state.preferences?.composerStats ?? true;
  const detach = state.preferences?.detachWindows ?? true;

  // A pinned panel whose session closed is about to be disposed by the host
  // (AgentPanelHost follows the sessions list) — say so for the render or
  // two it exists.
  if (pinned && active === null) {
    return (
      <div className="sidebar">
        <div className="p-4 text-sm opacity-70">This session is closed.</div>
      </div>
    );
  }

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
    if (state.agents.length === 0) send({ kind: "openSettings", section: "agents" });
    else if (state.agents.length === 1) send({ kind: "startChat", agentId: state.agents[0]!.id });
    else setDrawer("agents");
  };

  return (
    <div className="sidebar">
      {!pinned && (
        <Header agent={activeAgent} onSessions={() => setDrawer("sessions")} onNew={newChat} />
      )}
      {active !== null && (
        <SessionRow
          session={active}
          onTitle={pinned ? () => {} : () => setDrawer("sessions")}
          detach={detach && !pinned}
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
      <Chat state={state} activeSession={active} blocks={blocks} derived={derived} onNewChat={newChat} />
      {active !== null && (
        // keyed by session: which panel is open is per-session render state,
        // not something a session switch should inherit
        <ReadoutStrip key={active.id} plan={state.activePlan[active.id] ?? null} />
      )}
      <Composer
        agent={activeAgent}
        session={active}
        commands={active !== null ? (state.commandsBySession[active.id] ?? []) : []}
        contextChips={active !== null ? (state.contextChips[active.id] ?? []) : []}
        contextRoots={active !== null ? (state.contextRoots[active.id] ?? []) : []}
        workspaceRoots={state.workspaceRoots}
        diffableFiles={derived.diffableFiles}
        fileDiffStats={active !== null ? (state.fileDiffStats[active.id] ?? {}) : {}}
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
        queued={active !== null ? (state.promptQueue[active.id] ?? []) : []}
        openEditors={state.openEditors}
        workspaceFiles={state.workspaceFiles}
        knobs={active !== null ? (state.sessionKnobs[active.id] ?? []) : []}
        showStats={showStats}
        totals={derived.totals}
        usage={active !== null ? (state.sessionUsage[active.id] ?? null) : null}
      />
      {drawer !== null && <div className="scrim" onClick={() => setDrawer(null)} />}
      {drawer === "agents" && (
        <AgentsDrawer
          agents={state.agents}
          capabilities={state.capabilities}
          onDone={closeDrawer}
        />
      )}
      {drawer === "sessions" && (
        <SessionsDrawer
          sessions={state.sessions}
          agents={state.agents}
          activeSessionId={state.activeSessionId}
          detach={detach}
          onNew={newChat}
          onDone={() => setDrawer(null)}
        />
      )}
      {toast !== null && <div className="toast">{toast}</div>}
    </div>
  );
}
