// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Agent View shell — the single blend: agents + sessions + chat.
// Vertical order: header → session row → chat → read-out strip → composer;
// drawers overlay from the top. Render-only: the shell owns only local UI
// furniture (which drawer is open, the toast); components own their markup
// and send their own actions; everything durable comes from snapshots.
import { useMemo, useState } from "react";
import type { AgentViewState } from "../../shared/protocol";
import { elsewhere, sessionMark, waitingOn } from "../../shared/attention";
import { useActions } from "../shared/actions";
import { Icon } from "../shared/icon";
import { Chat } from "./chat/chat";
import { deriveTranscript, EMPTY_TRANSCRIPT } from "./chat/view-model";
import { Composer } from "./composer/composer";
import { newChatInFlight } from "./composer/composer-controls";
import { AttentionIndicators } from "./attention";
import { rootsControls } from "./composer/roots-controls";
import { AgentsDrawer, SessionsDrawer } from "./drawers";
import { Header } from "./header";
import { QueueBand } from "./queue-band";
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
  const [toast, setToast] = useState<{ msg: string; kind: "info" | "warning" } | null>(null);

  const pinned = pinnedSessionId !== undefined;
  // A new chat in flight leaves no session active: the pane is the connect
  // state and the composer locks with it — nothing typed can land in the
  // session that was open before the click. The agent is the one being
  // started.
  const incoming = !pinned && newChatInFlight(state.chatConnect);
  const active = incoming
    ? null
    : (state.sessions.find((s) => s.id === (pinned ? pinnedSessionId : state.activeSessionId)) ??
      null);
  const activeAgentId = active?.agentId ?? (incoming ? state.chatConnect?.agentId : undefined);
  const activeAgent = state.agents.find((a) => a.id === activeAgentId) ?? null;

  // The one transcript derivation (view-model.ts), hoisted here because two
  // siblings consume it: Chat renders the items/rollups, the composer's
  // stats strip the same pass's session totals.
  const blocks = active !== null ? (state.transcripts[active.id] ?? []) : [];
  const activeLive = active?.live ?? false;
  const derived = useMemo(
    () => (blocks.length > 0 ? deriveTranscript(blocks, activeLive) : EMPTY_TRANSCRIPT),
    [blocks, activeLive],
  );
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

  // Warnings (ingress refusals) hold a second longer than confirmations —
  // the user wasn't expecting them, so the read starts later.
  const showToast = (msg: string, kind: "info" | "warning" = "info") => {
    setToast({ msg, kind });
    window.setTimeout(() => setToast(null), kind === "warning" ? 3600 : 2600);
  };
  const closeDrawer = (msg?: string) => {
    setDrawer(null);
    if (msg !== undefined) showToast(msg);
  };
  // One intent, one click: a single configured agent starts directly
  // — the single-agent case never pays the multi-agent picker tax; zero
  // routes to Settings (where adding lives); only real choice opens the picker.
  const newChat = () => {
    setDrawer(null);
    if (state.agents.length === 0) send({ kind: "openSettings", section: "agents" });
    else if (state.agents.length === 1) send({ kind: "startChat", agentId: state.agents[0]!.id });
    else setDrawer("agents");
  };

  // Opening the list is a read of the agents' own session/list: another
  // window's activity is on the rows only if it is re-read now.
  const openSessions = () => {
    send({ kind: "syncSessions" });
    setDrawer("sessions");
  };

  return (
    <div className="sidebar">
      {!pinned && (
        <Header
          agent={activeAgent}
          update={activeAgent !== null ? (state.updates[activeAgent.id] ?? null) : null}
          onUpgrade={() => activeAgent !== null && send({ kind: "upgradeAgent", agentId: activeAgent.id })}
          onSessions={openSessions}
          onNew={newChat}
        >
          <AttentionIndicators
            elsewhere={elsewhere(state)}
            agents={state.agents}
            waitingOn={(s) => waitingOn(state, s)}
          />
        </Header>
      )}
      {active !== null && (
        <SessionRow
          session={active}
          onTitle={pinned ? () => {} : openSessions}
          detach={detach && !pinned}
          reloading={(state.hydrating ?? {})[active.id] === true}
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
        <ReadoutStrip
          key={active.id}
          sessionId={active.id}
          plan={state.activePlan[active.id] ?? null}
          files={derived.totals.files}
          diffable={derived.diffableFiles}
          diffStats={state.fileDiffStats[active.id] ?? {}}
          openEditors={state.openEditors}
          roots={state.workspaceRoots}
        />
      )}
      {active !== null && (
        <QueueBand
          sessionId={active.id}
          queued={state.promptQueue[active.id] ?? []}
          composerEmpty={(state.drafts[active.id] ?? "") === ""}
        />
      )}
      <Composer
        agent={activeAgent}
        session={active}
        incoming={incoming}
        commands={active !== null ? (state.commandsBySession[active.id] ?? []) : []}
        contextChips={active !== null ? (state.contextChips[active.id] ?? []) : []}
        contextRoots={active !== null ? (state.contextRoots[active.id] ?? []) : []}
        workspaceRoots={state.workspaceRoots}
        savedRoots={state.savedRoots}
        rootsControls={rootsControls({
          advertised:
            active !== null &&
            state.capabilities[active.agentId]?.["session.additionalDirectories"]?.declared === true,
          resumeDeclared:
            active !== null && state.capabilities[active.agentId]?.["session.resume"]?.declared === true,
          loadDeclared:
            active !== null && state.capabilities[active.agentId]?.["session.load"]?.declared === true,
          hasTurns: active !== null && (state.transcripts[active.id]?.length ?? 0) > 0,
        })}
        liveSelection={state.liveSelection}
        openEditors={state.openEditors}
        workspaceFiles={state.workspaceFiles}
        knobs={active !== null ? (state.sessionKnobs[active.id] ?? []) : []}
        draft={active !== null ? (state.drafts[active.id] ?? "") : ""}
        preferences={state.preferences}
        totals={derived.totals}
        usage={active !== null ? (state.sessionUsage[active.id] ?? null) : null}
        onNotice={(msg) => showToast(msg, "warning")}
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
          capabilities={state.capabilities}
          activeSessionId={state.activeSessionId}
          markOf={(s) => sessionMark(state, s)}
          detach={detach}
          onNew={newChat}
          onDone={() => setDrawer(null)}
        />
      )}
      {toast !== null && (
        <div className={`toast ${toast.kind === "warning" ? "warning" : ""}`}>
          {toast.kind === "warning" && <Icon name="warning" />} {toast.msg}
        </div>
      )}
    </div>
  );
}
