// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Preferences (Settings, Preferences section): machine-scoped behavior
// defaults — the turn-end chime, fresh-session knob source, idle-release timer.
// Machine store by the placement contract: non-sensitive, developer-env, never
// repo-committed (secrets stay out of here by construction — nothing in this
// shape is one). Stored as one partial record merged over defaults
// on every read, so a version that adds a preference never invalidates an
// older stored object and an absent key is honestly "the default".
import { z } from "zod";
import { DEFAULT_PREFERENCES, type PreferencesView, type ToolCallDisplay } from "../../shared/protocol";
import { DISPLAY_LADDER } from "../../shared/tool-display";
import type { KV, StoredEntry } from "./kv";
import { STORAGE_KEYS } from "./storage-keys";

const KEY = STORAGE_KEYS.preferences;

/** Every knob source — a source added to the view is a missing key here. */
const KNOB_SOURCES: Readonly<Record<PreferencesView["knobSource"], true>> = { "agent-default": true, "last-session": true };

/** One schema per preference — a preference added to the view is a
 * missing entry here until it has one. */
const PREFERENCE_SCHEMAS: { [K in keyof PreferencesView]: z.ZodType<PreferencesView[K]> } = {
  soundOnDone: z.boolean(),
  knobSource: z.custom<PreferencesView["knobSource"]>((v) => typeof v === "string" && Object.hasOwn(KNOB_SOURCES, v)),
  idleCloseMinutes: z.number().finite(),
  statsToolCalls: z.boolean(),
  statsContext: z.boolean(),
  statsPlanUsage: z.boolean(),
  detachWindows: z.boolean(),
  attachmentMaxMB: z.number().finite(),
  openThinking: z.boolean(),
  executeCalls: z.custom<ToolCallDisplay>((v) => DISPLAY_LADDER.includes(v as ToolCallDisplay)),
};

/** What is stored, each preference read on its own: one in a shape this
 * version doesn't take reads as its default, and the rest keep theirs. */
function readStored(stored: unknown): Partial<PreferencesView> {
  if (typeof stored !== "object" || stored === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(PREFERENCE_SCHEMAS)) {
    const parsed = schema.safeParse((stored as Record<string, unknown>)[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as Partial<PreferencesView>;
}

/** A stored record in any shape a released version wrote, brought to the
 * current one. Three transitions so far: `composerStats` (one switch over
 * the whole strip) split into a switch per read-out — a stored "hidden"
 * hides all of them, so nobody's strip reappears on upgrade; then
 * `statsPrompts` retired, the prompt count having moved to the read-out
 * strip's prompts chip, which has no switch; then `doneSound` retired, the
 * chime moving from the system's sounds to one the Agent View makes, with
 * nothing to pick. */
const RETIRED = ["composerStats", "statsPrompts", "doneSound"] as const;

function migrate(stored: Record<string, unknown>): Partial<PreferencesView> {
  const { composerStats, statsPrompts: _prompts, doneSound: _sound, ...rest } = stored;
  const split = composerStats === false ? { statsToolCalls: false, statsContext: false, statsPlanUsage: false } : {};
  return { ...split, ...(rest as Partial<PreferencesView>) };
}

export class PreferencesStore implements StoredEntry {
  readonly key = KEY;

  constructor(private readonly kv: KV) {
    // Once, at construction: a KV applies an update in memory before its
    // write settles, so no read ever sees the old shape. Disk is a trust
    // boundary: a non-object value is left for get() to read as it always has.
    const stored = kv.get<unknown>(KEY);
    if (typeof stored === "object" && stored !== null && RETIRED.some((key) => key in stored)) {
      void kv.update(KEY, migrate(stored as Record<string, unknown>));
    }
  }

  /** As stored — defaults are filled in by get(), never here. */
  stored(): unknown {
    return this.kv.get(KEY);
  }

  /** Always complete — defaults filled in at read time, never at write. */
  get(): PreferencesView {
    return { ...DEFAULT_PREFERENCES, ...this.chosen() };
  }

  /** Only the preferences stored, each that reads as one — what an import
   * carries over, leaving every preference the file never held as it is. */
  chosen(): Partial<PreferencesView> {
    return readStored(this.kv.get<unknown>(KEY));
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
