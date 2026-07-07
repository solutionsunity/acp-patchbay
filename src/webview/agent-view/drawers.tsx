// Top overlay drawers (ui.md: drawers overlay from the top). The drawer
// shells are presentational; every control inside is the shared layer.
// `onDone(toast?)` closes the drawer — drawer visibility and toasts are the
// shell's local UI state.
import type { AgentViewState, AgentSummary, SessionSummary } from "../../shared/protocol";
import { computeFidelity } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { capabilityOneLiner, FIDELITY_CLASS, FIDELITY_TEXT } from "../shared/capability-format";
import { Icon } from "../shared/icon";
import { Dot } from "./header";
import { Badges, SessionActions } from "./session-row";

/** The agent picker (P17): one row per configured agent with its readiness
 * inline; picking one starts a chat with it — connecting first, inside the
 * chat pane, when it isn't running. Adding agents lives in Settings only
 * (the one rich form — owner-approved consolidation, features.md §1);
 * stop/restart stay as Settings troubleshooting controls plus the crash
 * banner's Restart. */
export function AgentsDrawer(props: {
  agents: readonly AgentSummary[];
  roster: AgentViewState["roster"];
  capabilities: AgentViewState["capabilities"];
  onDone(toast?: string): void;
}) {
  const send = useActions();
  return (
    <div className="drawer">
      <h3>New chat with…</h3>
      {props.agents.length === 0 && (
        <div className="a-row cursor-default">
          <span className="sub">No agents yet — add one in Settings.</span>
        </div>
      )}
      {props.agents.map((a) => {
        const matrix = props.capabilities[a.id];
        const roster = props.roster.find((r) => r.id === a.id);
        const fidelity =
          matrix !== undefined ? computeFidelity(matrix, roster?.knownBypassBridge ?? false) : null;
        return (
          <div
            className="a-row"
            key={a.id}
            onClick={() => {
              send({ kind: "startChat", agentId: a.id });
              props.onDone();
            }}
          >
            <Dot status={a.status} />
            <div className="min-w-0 flex-1">
              <div className="nm">{a.name}</div>
              <div className="sub">
                {a.detail ??
                  (a.status === "running"
                    ? "ready"
                    : a.status === "untested"
                      ? "never connected"
                      : matrix !== undefined
                        ? capabilityOneLiner(matrix)
                        : "")}
              </div>
            </div>
            {fidelity !== null && (
              <span className={`fid ${FIDELITY_CLASS[fidelity]}`}>{FIDELITY_TEXT[fidelity]}</span>
            )}
          </div>
        );
      })}
      <div
        className="foot"
        onClick={() => {
          send({ kind: "openSettings" });
          props.onDone();
        }}
      >
        <Icon name="add" /> Add or manage agents — Settings…
      </div>
    </div>
  );
}

export function SessionsDrawer(props: {
  sessions: readonly SessionSummary[];
  agents: readonly AgentSummary[];
  forkUsed(agentId: string): boolean;
  onNew(): void;
  onDone(): void;
}) {
  const send = useActions();
  return (
    <div className="drawer">
      <h3>Sessions</h3>
      {props.sessions.length === 0 && (
        <div className="s-row cursor-default">
          <span className="sub">No sessions yet.</span>
        </div>
      )}
      {props.sessions.map((s) => {
        const agent = props.agents.find((a) => a.id === s.agentId);
        return (
          <div
            className="s-row relative"
            key={s.id}
            onClick={() => {
              send({ kind: "switchSession", sessionId: s.id });
              props.onDone();
            }}
          >
            {s.live ? <span className="live-dot" /> : <span className="live-dot-slot" />}
            <div>
              <div className="nm">{s.title}</div>
              <div className="sub">{agent?.name ?? s.agentId}</div>
            </div>
            <div className="badges" onClick={(e) => e.stopPropagation()}>
              <Badges session={s} />
              <SessionActions session={s} forkUsed={props.forkUsed(s.agentId)} />
            </div>
          </div>
        );
      })}
      <div className="foot" onClick={props.onNew}>
        <Icon name="add" /> New session
      </div>
    </div>
  );
}
