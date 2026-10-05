import { Queue } from "../../src/orchestrator/queue";
import { type AttachWork, SessionGates } from "../../src/orchestrator/session-gates";
import type { SessionsStore } from "../../src/orchestrator/sessions-store";
import type { AgentViewEvent } from "../../src/shared/protocol";

/** The session gates over a store, built the way the orchestrator builds
 * them: two lines per session, every move of their holdings emitted as the
 * session's busy state. The idle reaper is off unless asked for; agents'
 * rows hold nothing unless a test says what they do. */
export function gatesFor(
  sessions: SessionsStore,
  emit: (event: AgentViewEvent) => void,
  opts: {
    idleCloseMs?: number | null;
    connect?(sessionId: string): void;
    agentSettled?(agentId: string): Promise<void>;
  } = {},
): SessionGates {
  const publish = (sessionId: string) => emit({ kind: "sessionBusyChanged", sessionId, busy: gates.busy(sessionId) });
  const gates: SessionGates = new SessionGates(
    sessions,
    new Queue<AttachWork>(publish),
    new Queue<"prompt">(publish),
    {
      connect: (sessionId) => opts.connect?.(sessionId),
      failed: () => {},
      agentSettled: (agentId) => opts.agentSettled?.(agentId) ?? Promise.resolve(),
    },
    { idleCloseMs: opts.idleCloseMs ?? null },
  );
  return gates;
}
