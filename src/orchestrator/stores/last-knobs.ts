// Last-used knob combination per agent — the seed source for the
// "knobs start from: last used" preference (stores/preferences.ts).
// Written at the session-manager's one knob-state exit (publishKnobs), so
// what's recorded is always an *agent-confirmed* combination, never a
// pending selection. globalState: knob ids and offered values only —
// non-sensitive, machine-scoped like the agent configs they belong to.
// Seeding through knobs.ts routing means a stale entry (agent dropped a
// knob, renamed a value) is silently skipped at apply time, exactly like a
// no-longer-offered configured default — no validation needed here.
import type { KnobSeed } from "../../shared/protocol";
import type { KV } from "./kv";

const KEY = "acpPatchbay.lastKnobs";

type LastKnobsRecord = Readonly<Record<string, KnobSeed>>;

export class LastKnobsStore {
  constructor(private readonly kv: KV) {}

  get(agentId: string): KnobSeed | undefined {
    return this.kv.get<LastKnobsRecord>(KEY)?.[agentId];
  }

  async record(agentId: string, seed: KnobSeed): Promise<void> {
    const all = this.kv.get<LastKnobsRecord>(KEY) ?? {};
    await this.kv.update(KEY, { ...all, [agentId]: seed });
  }

  /** Data-page inventory: how many agents have a recorded combination. */
  count(): number {
    return Object.keys(this.kv.get<LastKnobsRecord>(KEY) ?? {}).length;
  }

  /** "Disconnect & erase all data" (plan.md P18). */
  async wipe(): Promise<void> {
    await this.kv.update(KEY, undefined);
  }
}
