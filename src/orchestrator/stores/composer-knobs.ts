// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Composer knobs — the user's current working knob combination, per agent.
// This is what the composer's knob pills show on *entry* (a fresh session,
// or a history session attached with no live combination in hand) under the
// "knobs start from: last used" preference (stores/preferences.ts). Written
// only from the user-set path (session-manager setKnob, after the agent
// confirms) — never at attach time, so loads/reloads that reset agent-side
// state can't pollute it. Machine store: knob ids and offered values only —
// non-sensitive, machine-scoped like the agent configs they belong to.
// Seeding through knobs.ts routing means a stale entry (agent dropped a
// knob, renamed a value) is silently skipped at apply time, exactly like a
// no-longer-offered configured default — no validation needed here.
import type { KnobSeed } from "../../shared/protocol";
import type { KV } from "./kv";

// Historical key (this store began as "last-used knobs") — kept so existing
// installs carry their combinations across the rename.
const KEY = "acpPatchbay.lastKnobs";

type ComposerKnobsRecord = Readonly<Record<string, KnobSeed>>;

export class ComposerKnobsStore {
  constructor(private readonly kv: KV) {}

  get(agentId: string): KnobSeed | undefined {
    return this.kv.get<ComposerKnobsRecord>(KEY)?.[agentId];
  }

  async record(agentId: string, seed: KnobSeed): Promise<void> {
    const all = this.kv.get<ComposerKnobsRecord>(KEY) ?? {};
    await this.kv.update(KEY, { ...all, [agentId]: seed });
  }

  /** Data-page inventory: how many agents have a recorded combination. */
  count(): number {
    return Object.keys(this.kv.get<ComposerKnobsRecord>(KEY) ?? {}).length;
  }

  /** "Disconnect & erase all data". */
  async wipe(): Promise<void> {
    await this.kv.update(KEY, undefined);
  }
}
