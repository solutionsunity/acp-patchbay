// Top overlay drawers (ui.md: drawers overlay from the top). The drawer
// shells are presentational; every control inside is the shared layer.
// `onDone(toast?)` closes the drawer — drawer visibility and toasts are the
// shell's local UI state.
import { useState } from "react";
import type { AgentViewState, AgentSummary, ConnectAgentSource, SessionSummary } from "../../shared/protocol";
import { computeFidelity } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { capabilityOneLiner, FIDELITY_CLASS, FIDELITY_TEXT } from "../shared/capability-format";
import { Icon } from "../shared/icon";
import { Dot } from "./header";
import { Badges, SessionActions } from "./session-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function AgentsDrawer(props: {
  agents: readonly AgentSummary[];
  roster: AgentViewState["roster"];
  capabilities: AgentViewState["capabilities"];
  onDone(toast?: string): void;
}) {
  const send = useActions();
  const [connecting, setConnecting] = useState(false);
  const [rosterId, setRosterId] = useState("");
  const [command, setCommand] = useState("");

  const connect = (source: ConnectAgentSource) => {
    send({ kind: "connectAgent", source });
    props.onDone("connecting…");
  };

  return (
    <div className="drawer">
      <h3>Agents</h3>
      {props.agents.length === 0 && (
        <div className="a-row cursor-default">
          <span className="sub">No agents connected.</span>
        </div>
      )}
      {props.agents.map((a) => {
        const matrix = props.capabilities[a.id];
        const roster = props.roster.find((r) => r.id === a.id);
        const fidelity =
          matrix !== undefined ? computeFidelity(matrix, roster?.knownBypassBridge ?? false) : null;
        return (
          <div className="a-row cursor-default" key={a.id}>
            <Dot status={a.status} />
            <div className="min-w-0 flex-1">
              <div className="nm">{a.name}</div>
              <div className="sub">
                {a.detail ?? (matrix !== undefined ? capabilityOneLiner(matrix) : "")}
              </div>
            </div>
            {fidelity !== null && (
              <span className={`fid ${FIDELITY_CLASS[fidelity]}`}>{FIDELITY_TEXT[fidelity]}</span>
            )}
            {a.status === "running" && (
              <>
                <Button
                  size="sm"
                  onClick={() => {
                    send({ kind: "newSession", agentId: a.id });
                    props.onDone();
                  }}
                >
                  Start session
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    send({ kind: "stopAgent", agentId: a.id });
                    props.onDone("stopped");
                  }}
                >
                  Stop
                </Button>
              </>
            )}
            {a.status === "crashed" && (
              <Button
                size="sm"
                onClick={() => {
                  send({ kind: "restartAgent", agentId: a.id });
                  props.onDone("restarting…");
                }}
              >
                Restart
              </Button>
            )}
          </div>
        );
      })}
      {connecting ? (
        <div className="connect-form">
          <div className="row">
            <Select value={rosterId === "" ? undefined : rosterId} onValueChange={setRosterId}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="from roster…" />
              </SelectTrigger>
              <SelectContent>
                {props.roster.map((r) => (
                  <SelectItem value={r.id} key={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" disabled={rosterId === ""} onClick={() => connect({ rosterId })}>
              Connect
            </Button>
          </div>
          <div className="row">
            <Input
              type="text"
              placeholder="or a custom command that speaks ACP…"
              value={command}
              onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={command.trim() === ""}
              onClick={() => connect({ command: command.trim() })}
            >
              Connect
            </Button>
          </div>
        </div>
      ) : (
        <div className="foot" onClick={() => setConnecting(true)}>
          <Icon name="add" /> Connect agent — roster or custom command…
        </div>
      )}
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
