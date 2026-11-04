// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Agent View shell — the single blend: agents + sessions + chat.
// Vertical order: header → session row → chat → read-out strip → composer;
// drawers overlay from the top. Render-only: the shell owns only local UI
// furniture (which drawer is open, the toast); components own their markup
// and send their own actions; everything durable comes from snapshots.
import { restartOffered } from "../shared/agent-work";
import { useMemo, useState } from "react";
import { attaching, type AgentViewState, type SubagentView, type UserBlock } from "../../shared/protocol";
import { elsewhere, sessionMark, waitingOn } from "../../shared/attention";
import { useActions } from "../shared/actions";
import { Icon } from "../shared/icon";
import { Chat } from "./chat/chat";
import { SessionLinks } from "./chat/blocks";
import { ownSubagent, subagentAncestors, subagentName } from "./subagent-controls";
import { deriveTranscript, EMPTY_TRANSCRIPT, turnLive } from "./chat/view-model";
import { Composer } from "./composer/composer";
import { newChatInFlight } from "./composer/composer-controls";
import { AttentionIndicators } from "./attention";
import { rootsControls } from "./composer/roots-controls";
import { mcpChipControls } from "./composer/mcp-chip-controls";
import { AgentsDrawer, SessionsDrawer } from "./drawers";
import { Header } from "./header";
import { QueueBand } from "./queue-band";
import { ReadoutStrip } from "./readout-strip";
import { SessionRow } from "./session-row";
import { Button } from "@/components/ui/button";
import type { PatchbaySessionId } from "../../shared/ids";

type Drawer = "agents" | "sessions" | null;

/** One instance, so a session with no sub-agents keeps its derived view. */
const NO_SUBAGENTS: readonly SubagentView[] = [];

export function App({
  state,
  pinnedPatchbaySessionId,
}: {
  state: AgentViewState;
  /** Detached session panel: render exactly this session, ignore the shared
   * active-session pointer, and drop the shell furniture (header, drawers,
   * new-chat) — those belong to the full view. */
  pinnedPatchbaySessionId?: PatchbaySessionId;
}) {
  const send = useActions();
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "info" | "warning" } | null>(null);
  // A prompt the prompts chip asked for — brought into view in the
  // transcript, or put back in the composer. A new `seq` is the request.
  const [goTo, setGoTo] = useState<{ seq: number; id: string } | null>(null);
  const [reuse, setReuse] = useState<{ seq: number; prompt: UserBlock } | null>(null);
  // A sub-agent's transcript shown in its session's chat instead of the
  // session's own — a view of this pane only, gone with a session switch.
  const [viewing, setViewing] = useState<{ session: PatchbaySessionId; subagent: PatchbaySessionId } | null>(null);

  const pinned = pinnedPatchbaySessionId !== undefined;
  // A new chat in flight leaves no session active: the pane is the connect
  // state and the composer locks with it — nothing typed can land in the
  // session that was open before the click. The agent is the one being
  // started.
  const incoming = !pinned && newChatInFlight(state.chatConnect);
  const active = incoming
    ? null
    : (state.sessions.find((s) => s.id === (pinned ? pinnedPatchbaySessionId : state.activePatchbaySessionId)) ??
      null);
  const activePatchbayAgentId = active?.patchbayAgentId ?? (incoming ? state.chatConnect?.patchbayAgentId : undefined);
  const activeAgent = state.agents.find((a) => a.id === activePatchbayAgentId) ?? null;
  // The open session's agent — what its roots chip is judged against.
  const activeMatrix = active !== null ? activeAgent?.capabilities : undefined;

  // The one transcript derivation (view-model.ts), hoisted here because
  // siblings consume it: Chat renders the items/rollups, the read-out strip
  // and the composer's stats strip the same pass's session totals.
  const blocks = active !== null ? (state.transcripts[active.id] ?? []) : [];
  const activeLive = active !== null && turnLive(state, active.id);
  // `?? {}` guards snapshots minted before the field existed.
  const roster = active !== null ? ((state.subagents ?? {})[active.id] ?? NO_SUBAGENTS) : NO_SUBAGENTS;
  const derived = useMemo(
    () => (blocks.length > 0 ? deriveTranscript(blocks, activeLive, state.preferences, ownSubagent(roster, active?.id)) : EMPTY_TRANSCRIPT),
    [blocks, activeLive, state.preferences, roster, active?.id],
  );
  const viewed = viewing !== null && viewing.session === active?.id ? (roster.find((s) => s.id === viewing.subagent) ?? null) : null;
  const viewedBlocks = viewed !== null ? (state.transcripts[viewed.id] ?? []) : [];
  const viewedLive = viewed?.state?.state === "running";
  const viewedDerived = useMemo(
    () => (viewedBlocks.length > 0 ? deriveTranscript(viewedBlocks, viewedLive, state.preferences, ownSubagent(roster, viewed?.id)) : EMPTY_TRANSCRIPT),
    [viewedBlocks, viewedLive, state.preferences, roster, viewed?.id],
  );
  // Inside the transcript, the session and its sub-agents are links: each
  // opens its own transcript here, the session's its own again.
  const links = useMemo(
    () => ({
      name: (id: PatchbaySessionId) => {
        if (id === active?.id) return active.title;
        const subagent = roster.find((s) => s.id === id);
        return subagent === undefined ? null : subagentName(subagent);
      },
      open: (id: PatchbaySessionId) => setViewing(active === null || id === active.id ? null : { session: active.id, subagent: id }),
    }),
    [active, roster],
  );
  const detach = state.preferences?.detachWindows ?? true;
  // The durable draft is empty — the only state a held prompt is taken back
  // into, or an earlier one reused into.
  const composerEmpty = active === null || (state.drafts[active.id] ?? "") === "";

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
    else if (state.agents.length === 1) send({ kind: "startChat", patchbayAgentId: state.agents[0]!.id });
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
          onUpgrade={() => activeAgent !== null && send({ kind: "upgradeAgent", patchbayAgentId: activeAgent.id })}
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
          agent={activeAgent ?? undefined}
          original={active.forkedFrom === undefined ? undefined : state.sessions.find((s) => s.id === active.forkedFrom)}
          onTitle={pinned ? () => {} : openSessions}
          detach={detach && !pinned}
          reloading={attaching(active)}
        />
      )}
      {activeAgent !== null && restartOffered(activeAgent) && (
        <div className="crash-banner">
          <Icon name="warning" /> {activeAgent.name} crashed
          {activeAgent.detail !== undefined ? ` — ${activeAgent.detail}` : ""}
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              send({ kind: "restartAgent", patchbayAgentId: activeAgent.id });
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
      <SessionLinks.Provider value={links}>
        <Chat
          state={state}
          activeSession={active}
          blocks={viewed !== null ? viewedBlocks : blocks}
          derived={viewed !== null ? viewedDerived : derived}
          onNewChat={newChat}
          goTo={goTo}
          {...(viewed !== null && active !== null ? { subagent: { view: viewed, path: [active.id, ...subagentAncestors(roster, viewed).map((s) => s.id)] } } : {})}
        />
      </SessionLinks.Provider>
      {active !== null && (
        // keyed by session: which panel is open is per-session render state,
        // not something a session switch should inherit
        <ReadoutStrip
          key={active.id}
          patchbaySessionId={active.id}
          plan={state.activePlan[active.id] ?? null}
          subagents={roster}
          onOpenSubagent={(subagent) => setViewing({ session: active.id, subagent })}
          prompts={derived.totals.prompts}
          composerEmpty={composerEmpty}
          onGoTo={(prompt) => {
            setViewing(null);
            setGoTo((g) => ({ seq: (g?.seq ?? 0) + 1, id: prompt.id }));
          }}
          onReuse={(prompt) => setReuse((r) => ({ seq: (r?.seq ?? 0) + 1, prompt }))}
          files={derived.totals.files}
          openEditors={state.openEditors}
          workspaceRoots={state.workspaceRoots}
          contextRoots={state.contextRoots[active.id] ?? []}
        />
      )}
      {active !== null && (
        <QueueBand
          patchbaySessionId={active.id}
          queued={state.promptQueue[active.id] ?? []}
          composerEmpty={composerEmpty}
        />
      )}
      <Composer
        agent={activeAgent}
        focusRequest={state.composerFocus}
        session={active}
        incoming={incoming}
        commands={active !== null ? (state.commandsBySession[active.id] ?? []) : []}
        contextChips={active !== null ? (state.contextChips[active.id] ?? []) : []}
        contextRoots={active !== null ? (state.contextRoots[active.id] ?? []) : []}
        workspaceRoots={state.workspaceRoots}
        savedRoots={state.savedRoots}
        workspace={state.workspace}
        rootsControls={rootsControls({
          advertised: activeMatrix?.["session.additionalDirectories"]?.declared === true,
          resumeDeclared: activeMatrix?.["session.resume"]?.declared === true,
          loadDeclared: activeMatrix?.["session.load"]?.declared === true,
          hasTurns: active?.hasTurns === true,
        })}
        mcpControls={mcpChipControls({
          mcp: active !== null ? state.sessionMcp[active.id] : undefined,
          servers: state.mcpServers,
          here: state.workspace,
          canReopen: activeMatrix?.["session.load"]?.declared === true || activeMatrix?.["session.resume"]?.declared === true,
        })}
        mcpServers={state.mcpServers}
        liveSelection={state.liveSelection}
        openEditors={state.openEditors}
        workspaceFiles={state.workspaceFiles}
        knobs={active !== null ? (state.sessionKnobs[active.id] ?? []) : []}
        draft={active !== null ? (state.drafts[active.id] ?? "") : ""}
        reuse={reuse}
        preferences={state.preferences}
        totals={derived.totals}
        usage={active !== null ? (state.sessionUsage[active.id] ?? null) : null}
        onNotice={(msg) => showToast(msg, "warning")}
        onSent={() => setViewing(null)}
      />
      {drawer === "agents" && (
        <AgentsDrawer agents={state.agents} onDone={closeDrawer} />
      )}
      {drawer === "sessions" && (
        <SessionsDrawer
          sessions={state.sessions}
          agents={state.agents}
          activePatchbaySessionId={state.activePatchbaySessionId}
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
