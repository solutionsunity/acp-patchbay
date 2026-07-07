// Persisted used-capability cache, keyed by agentId, carrying the
// version it was earned against (capability-verification.md, amended:
// used now survives reconnect and persists *across restarts* — it only
// resets when `agentInfo.version` actually changes, not on every connect).
// Global store: having actually fired on the wire is a fact about a specific
// build of an agent, not about a workspace.
import { z } from "zod";
import type { CapabilityMatrix } from "../../shared/protocol";
import { GlobalRecordStore } from "./global-record-store";
import type { KV } from "./kv";

const capabilityCellSchema = z.object({ declared: z.boolean(), used: z.boolean() });

export const usedCacheEntrySchema = z.object({
  id: z.string().min(1), // agentId
  version: z.string().min(1),
  matrix: z.record(z.string(), capabilityCellSchema),
});
export type UsedCacheEntry = z.infer<typeof usedCacheEntrySchema>;

const KEY = "acpPatchbay.usedCapabilities";

export class UsedCapabilityStore extends GlobalRecordStore<UsedCacheEntry> {
  constructor(kv: KV) {
    super(kv, KEY, usedCacheEntrySchema);
  }

  /** Seeds `used` from the cache when `version` matches what's stored —
   * an honest reset (all cells declared-but-not-used) otherwise, same
   * shape `matrixFromDeclared` already produces. */
  seed(agentId: string, version: string, freshlyDeclared: CapabilityMatrix): CapabilityMatrix {
    const cached = this.get(agentId);
    if (cached === undefined || cached.version !== version) return freshlyDeclared;
    const seeded = { ...freshlyDeclared };
    for (const key of Object.keys(freshlyDeclared) as (keyof CapabilityMatrix)[]) {
      const cachedCell = cached.matrix[key];
      if (cachedCell?.used) seeded[key] = { declared: freshlyDeclared[key].declared, used: true };
    }
    return seeded;
  }

  async save(agentId: string, version: string, matrix: CapabilityMatrix): Promise<void> {
    await this.upsert({ id: agentId, version, matrix });
  }
}
