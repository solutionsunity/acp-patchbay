// Preferences (Settings § Preferences): machine-scoped behavior defaults —
// done-sound, fresh-session knob source, idle-release timer. globalState by
// the placement contract: non-sensitive, developer-env, never repo-committed
// (no-secret-exposure.md keeps secrets out of here by construction — nothing
// in this shape is one). Stored as one partial record merged over defaults
// on every read, so a version that adds a preference never invalidates an
// older stored object and an absent key is honestly "the default".
import { DEFAULT_PREFERENCES, type PreferencesView } from "../../shared/protocol";
import type { KV } from "./kv";

const KEY = "acpPatchbay.preferences";

export class PreferencesStore {
  constructor(private readonly kv: KV) {}

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

  /** "Disconnect & erase all data" (plan.md P18). */
  async wipe(): Promise<void> {
    await this.kv.update(KEY, undefined);
  }
}
