// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Persisted used-capability cache, keyed by agentId, carrying the
// version it was earned against (used now survives reconnect and persists
// *across restarts* — it only resets when `agentInfo.version` actually
// changes, not on every connect).
// Global store: having actually fired on the wire is a fact about a specific
// build of an agent, not about a workspace.
import { z } from "zod";
import type { CapabilityMatrix } from "../../shared/protocol";
import { USED_MAY_OUTRUN_CLAIM } from "../capabilities";
import { GlobalRecordStore } from "./global-record-store";
import type { KV } from "./kv";

const capabilityCellSchema = z.object({
  declared: z.boolean(),
  used: z.boolean(),
  suspect: z.boolean().optional(),
});

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

  /** Seeds `used` — and `suspect`, a broken bridge must not look clean
   * after a restart — from the cache when `version` matches what's stored;
   * an honest reset (all cells declared-but-not-used) otherwise, same
   * shape `matrixFromDeclared` already produces.
   *
   * The fresh declaration outranks the cache for USED — features gate on
   * used, and a restored mark on an undeclared row would light up a call
   * the spec now forbids. Exception: the rows whose proof may legitimately
   * outrun any claim (USED_MAY_OUTRUN_CLAIM, capabilities.ts) — for those
   * the mark itself carried the claim when earned, and it restores the
   * same way. SUSPECT deliberately restores regardless of the fresh
   * declaration: it gates nothing, and a bridge that flickers a
   * declaration off at the same version must not launder its own warning
   * — "only an actual version change resets it honestly". */
  seed(agentId: string, version: string, freshlyDeclared: CapabilityMatrix): CapabilityMatrix {
    const cached = this.get(agentId);
    if (cached === undefined || cached.version !== version) return freshlyDeclared;
    const seeded = { ...freshlyDeclared };
    for (const key of Object.keys(freshlyDeclared) as (keyof CapabilityMatrix)[]) {
      const cachedCell = cached.matrix[key];
      if (cachedCell?.used) {
        if (freshlyDeclared[key].declared || USED_MAY_OUTRUN_CLAIM.has(key)) {
          seeded[key] = { declared: true, used: true };
        }
      } else if (cachedCell?.suspect === true) {
        seeded[key] = { declared: true, used: false, suspect: true };
      }
    }
    return seeded;
  }

  async save(agentId: string, version: string, matrix: CapabilityMatrix): Promise<void> {
    await this.upsert({ id: agentId, version, matrix });
  }
}
