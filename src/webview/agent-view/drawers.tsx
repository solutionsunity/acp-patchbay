// Top overlay drawers (ui.md: drawers overlay from the top). The drawer
// shells are presentational; every control inside is the shared layer.
// `onDone(toast?)` closes the drawer — drawer visibility and toasts are the
// shell's local UI state.
import type { AgentViewState, AgentSummary, SessionSummary } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { capabilityOneLiner } from "../shared/capability-format";
import { Icon } from "../shared/icon";
import { timeAgo } from "../shared/time";
import { Dot } from "./header";
import { SessionActions } from "./session-row";
import { Button } from "@/components/ui/button";

/** Drawer title row with the explicit way out — clicking the scrim still
 * works, but the affordance must be visible (P16). */
function DrawerHead({ title, onClose }: { title: string; onClose(): void }) {
  return (
    <div className="flex items-center">
      <h3 className="flex-1">{title}</h3>
      <Button variant="ghost" size="icon" className="h-6 w-6" title="Close" aria-label="Close" onClick={onClose}>
        <Icon name="close" />
      </Button>
    </div>
  );
}

/** The agent picker (P17): one row per configured agent with its readiness
 * inline; picking one starts a chat with it — connecting first, inside the
 * chat pane, when it isn't running. Adding agents lives in Settings only
 * (the one rich form — owner-approved consolidation, features.md §1);
 * stop/restart stay as Settings troubleshooting controls plus the crash
 * banner's Restart. */
export function AgentsDrawer(props: {
  agents: readonly AgentSummary[];
  capabilities: AgentViewState["capabilities"];
  onDone(toast?: string): void;
}) {
  const send = useActions();
  return (
    <div className="drawer">
      <DrawerHead title="New chat with…" onClose={() => props.onDone()} />
      {props.agents.length === 0 && (
        <div className="a-row cursor-default">
          <span className="sub">No agents yet — add one in Settings.</span>
        </div>
      )}
      {props.agents.map((a) => {
        const matrix = props.capabilities[a.id];
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
  activeSessionId: string | null;
  /** detachWindows preference — off hides "Open in new window". */
  detach: boolean;
  onNew(): void;
  onDone(): void;
}) {
  const send = useActions();
  // Latest activity on top — sorted here in the view, so the reducer stays
  // append-only and wire-merge arrival order stops mattering.
  const ordered = [...props.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="drawer">
      <DrawerHead title="Sessions" onClose={props.onDone} />
      {ordered.length === 0 && (
        <div className="s-row cursor-default">
          <span className="sub">No sessions yet.</span>
        </div>
      )}
      {ordered.map((s) => {
        const agent = props.agents.find((a) => a.id === s.agentId);
        const isActive = s.id === props.activeSessionId;
        return (
          <div
            className={`s-row relative${isActive ? " active" : ""}`}
            key={s.id}
            aria-current={isActive ? "true" : undefined}
            onClick={() => {
              send({ kind: "switchSession", sessionId: s.id });
              props.onDone();
            }}
          >
            {/* green pulse = turn in flight (same green as a running agent);
                blue = completed since last opened; empty slot otherwise */}
            {s.live ? (
              <span className="live-dot" title="Turn in progress" />
            ) : s.unseen === true ? (
              <span className="unseen-dot" title="Completed since you last opened it" />
            ) : (
              <span className="live-dot-slot" />
            )}
            <div>
              <div className="nm">{s.title}</div>
              <div className="sub">
                {agent?.name ?? s.agentId} · {timeAgo(s.updatedAt)}
              </div>
            </div>
            <div className="badges" onClick={(e) => e.stopPropagation()}>
              <SessionActions session={s} detach={props.detach} />
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
