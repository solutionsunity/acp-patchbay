// Persisted record of every process patchbay itself spawned (plan.md P15c):
// agent connections and brokered terminals — the direct children, nothing
// deeper (grandchildren are the agent's own, covered by tree-kill and P15a
// self-exit). Written at spawn with the command line read back from the OS
// (record what reality says, compare with what reality says later), cleared
// on observed exit — whatever survives an abnormal end (crash, OS kill,
// host death before cleanup ran) is exactly what the next activate's orphan
// reap looks at. Global store: a machine fact, not a workspace fact, and
// never in Settings Sync (globalState keys stay machine-local unless opted
// in, which this never is).
import { z } from "zod";
import { GlobalRecordStore } from "./global-record-store";
import type { KV } from "./kv";

export const spawnRecordSchema = z.object({
  id: z.string().min(1), // String(pid) — one machine, one live pid at a time
  pid: z.number().int().positive(),
  /** As process-tree.ts's `commandOf` read it right after spawn — reap
   * compares against a fresh read; mismatch = reused pid, spared. */
  command: z.string().min(1),
  kind: z.enum(["agent", "terminal"]),
  /** ISO spawn time — display/debug only, never the reuse guard. */
  at: z.string(),
});
export type SpawnRecord = z.infer<typeof spawnRecordSchema>;

const KEY = "acpPatchbay.spawnRegistry";

export class SpawnRegistryStore extends GlobalRecordStore<SpawnRecord> {
  constructor(kv: KV) {
    super(kv, KEY, spawnRecordSchema);
  }

  async add(pid: number, command: string, kind: SpawnRecord["kind"]): Promise<void> {
    await this.upsert({ id: String(pid), pid, command, kind, at: new Date().toISOString() });
  }

  async removePid(pid: number): Promise<void> {
    await this.remove(String(pid));
  }
}
