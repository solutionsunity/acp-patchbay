import type { SessionUpdate } from "../../src/orchestrator/acp";
import { readSessionUpdate, type SessionUpdateFact } from "../../src/orchestrator/readers/session-update";

/** A session/update as the pool hands it on — read, its notes dropped. */
export function readUpdate(update: unknown): SessionUpdateFact {
  return readSessionUpdate(update as SessionUpdate, () => {});
}
