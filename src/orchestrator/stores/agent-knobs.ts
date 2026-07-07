// Persisted observed-knobs cache (Settings § Agents' default-knob selects),
// keyed by agentId, carrying the `agentInfo.version` the offerings were
// observed at — same lifetime rule as the used-capability cache: survives
// restarts, honestly dropped when the version actually changes. Without it,
// knob offerings died with the extension host (observedKnobs was in-memory
// only) and every restart showed "— not offered" until the next session.
import { z } from "zod";
import { GlobalRecordStore } from "./global-record-store";
import type { KV } from "./kv";

const knobValueSchema = z.object({ value: z.string(), name: z.string() });

export const agentKnobsEntrySchema = z.object({
  id: z.string().min(1), // agentId
  version: z.string().min(1),
  knobs: z.object({
    modes: z.array(z.object({ id: z.string(), name: z.string() })).nullable(),
    options: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        category: z.string().optional(),
        values: z.array(knobValueSchema),
      }),
    ),
  }),
});
export type AgentKnobsEntry = z.infer<typeof agentKnobsEntrySchema>;

const KEY = "acpPatchbay.agentKnobs";

export class AgentKnobsStore extends GlobalRecordStore<AgentKnobsEntry> {
  constructor(kv: KV) {
    super(kv, KEY, agentKnobsEntrySchema);
  }
}
