// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Preferences (Settings, Preferences section): machine-scoped behavior
// defaults — done-sound, fresh-session knob source, idle-release timer.
// Machine store by the placement contract: non-sensitive, developer-env, never
// repo-committed (secrets stay out of here by construction — nothing in this
// shape is one). Stored as one partial record merged over defaults
// on every read, so a version that adds a preference never invalidates an
// older stored object and an absent key is honestly "the default".
import { DEFAULT_PREFERENCES, type PreferencesView } from "../../shared/protocol";
import type { KV } from "./kv";

const KEY = "acpPatchbay.preferences";

/** A stored record in any shape a released version wrote, brought to the
 * current one. The one transition so far: `composerStats` (one switch over
 * the whole strip) split into a switch per read-out — a stored "hidden"
 * hides all of them, so nobody's strip reappears on upgrade. */
function migrate(stored: Record<string, unknown>): Partial<PreferencesView> {
  const { composerStats, ...rest } = stored;
  const split =
    composerStats === false
      ? { statsPrompts: false, statsToolCalls: false, statsContext: false, statsPlanUsage: false }
      : {};
  return { ...split, ...(rest as Partial<PreferencesView>) };
}

export class PreferencesStore {
  constructor(private readonly kv: KV) {
    // Once, at construction: a KV applies an update in memory before its
    // write settles, so no read ever sees the old shape. Disk is a trust
    // boundary: a non-object value is left for get() to read as it always has.
    const stored = kv.get<unknown>(KEY);
    if (typeof stored === "object" && stored !== null && "composerStats" in stored) {
      void kv.update(KEY, migrate(stored as Record<string, unknown>));
    }
  }

  /** Always complete — defaults filled in at read time, never at write. */
  get(): PreferencesView {
    return { ...DEFAULT_PREFERENCES, ...this.kv.get<Partial<PreferencesView>>(KEY) };
  }

  /** Patch-in, full-object-out — the emit after a set carries the whole
   * stored truth, never the webview's idea of it. */
  async set(patch: Partial<PreferencesView>): Promise<PreferencesView> {
    const next = { ...this.get(), ...patch };
    await this.kv.update(KEY, next);
    return next;
  }

  /** "Disconnect & erase all data". */
  async wipe(): Promise<void> {
    await this.kv.update(KEY, undefined);
  }
}
