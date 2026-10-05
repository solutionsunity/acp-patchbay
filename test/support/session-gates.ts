import { Queue } from "../../src/orchestrator/queue";
import { type AttachWork, SessionGates } from "../../src/orchestrator/session-gates";
import type { SessionsStore } from "../../src/orchestrator/sessions-store";
import type { AgentViewEvent } from "../../src/shared/protocol";
import type { PatchbayAgentId, PatchbaySessionId } from "../../src/shared/ids";

/** The session gates over a store, built the way the orchestrator builds
 * them: two lines per session, every move of their holdings emitted as the
 * session's busy state. The idle reaper is off unless asked for; agents'
 * rows hold nothing unless a test says what they do. */
export function gatesFor(
  sessions: SessionsStore,
  emit: (event: AgentViewEvent) => void,
  opts: {
    idleCloseMs?: number | null;
    connect?(patchbaySessionId: PatchbaySessionId): void;
    agentSettled?(patchbayAgentId: PatchbayAgentId): Promise<void>;
  } = {},
): SessionGates {
  const publish = (patchbaySessionId: PatchbaySessionId) => emit({ kind: "sessionBusyChanged", patchbaySessionId, busy: gates.busy(patchbaySessionId) });
  const gates: SessionGates = new SessionGates(
    sessions,
    new Queue<AttachWork, PatchbaySessionId>(publish),
    new Queue<"prompt", PatchbaySessionId>(publish),
    {
      connect: (patchbaySessionId) => opts.connect?.(patchbaySessionId),
      failed: () => {},
      agentSettled: (patchbayAgentId) => opts.agentSettled?.(patchbayAgentId) ?? Promise.resolve(),
    },
    { idleCloseMs: opts.idleCloseMs ?? null },
  );
  return gates;
}
