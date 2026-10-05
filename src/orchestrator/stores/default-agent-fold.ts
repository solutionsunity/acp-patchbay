// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The old `acpPatchbay.defaultAgent` setting, folded into one agent's
// auto-connect flag. The setting is no longer registered, so it can't be
// cleared; this record is what consumes it — the value the fold last
// flagged an agent for. A value already folded is never folded again, so a
// user who then switches that agent's auto-connect off keeps it off.
// Machine store: the flag it set lives there too.
import type { KV } from "./kv";

const KEY = "acpPatchbay.defaultAgentFolded";

export class DefaultAgentFoldStore {
  constructor(private readonly kv: KV) {}

  folded(): string | undefined {
    return this.kv.get<string>(KEY);
  }

  async record(value: string): Promise<void> {
    await this.kv.update(KEY, value);
  }

  /** "Disconnect & erase all data". */
  async wipe(): Promise<void> {
    await this.kv.update(KEY, undefined);
  }
}
