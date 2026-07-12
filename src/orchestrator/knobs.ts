// Normalizes every knob-shaped wire fact into one view, and routes every
// knob set back to the wire — the knob sibling of capabilities.ts. This is
// the only module that reads the modes/configOptions relationship; no other
// file (and no webview) may distinguish the two surfaces.
//
// The spec rule this encodes (ACP v1 § Session Config Options, "Relationship
// to Session Modes"): config options supersede modes — a client that
// supports them "SHOULD use configOptions exclusively and ignore modes",
// and modes will be removed from the protocol (v2 already drops
// session/set_mode). So: any non-empty configOptions wins the whole
// surface; modes are only ever a fallback, synthesized into one knob so the
// rest of patchbay renders a single uniform list. This exclusivity replaces
// the old category-keyed dedup ("suppress native modes when a
// category:'mode' option exists"), which depended on a field ACP forbids as
// a correctness dependency ("categories… MUST NOT be required for
// correctness") and was fitted to one bridge's observed shape.
import type {
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import type {
  AgentKnobsView,
  KnobSeed,
  SessionKnobView,
} from "../shared/protocol";

/** The synthetic knob id for the modes-fallback surface. Collision-free by
 * construction: the surfaces are exclusive, so on "modes" no agent option
 * ids exist at all. Also the fold target for legacy stored `mode`/`modeId`
 * selections (foldSeed). */
export const MODE_KNOB_ID = "mode";

/** A session's normalized knob state. `surface` records which wire API
 * drives sets — orchestrator-side routing state, deliberately not part of
 * the webview view (render-only-webview: the UI renders knobs, it never
 * knows which protocol surface they came from). */
export interface NormalizedKnobs {
  surface: "config" | "modes" | "none";
  knobs: readonly SessionKnobView[];
}

export const NO_KNOBS: NormalizedKnobs = { surface: "none", knobs: [] };

function toSelectValue(v: { value: string; name: string; description?: string | null }) {
  return { value: v.value, name: v.name, description: v.description ?? undefined };
}

function toKnobView(opt: SessionConfigOption): SessionKnobView {
  const base = {
    id: opt.id,
    name: opt.name,
    description: opt.description ?? undefined,
    category: opt.category ?? undefined,
  };
  if (opt.type === "boolean") return { ...base, type: "boolean", currentValue: opt.currentValue };
  const options = opt.options.map((o) =>
    "group" in o
      ? { group: o.group, name: o.name, options: o.options.map(toSelectValue) }
      : toSelectValue(o),
  );
  return { ...base, type: "select", currentValue: opt.currentValue, options } as SessionKnobView;
}

/** The one entry point for a session response's knob surface
 * (session/new, /load, /fork). Exclusivity applies here. */
export function normalizeKnobs(
  modes: SessionModeState | null | undefined,
  configOptions: readonly SessionConfigOption[] | null | undefined,
): NormalizedKnobs {
  if (configOptions != null && configOptions.length > 0) {
    return { surface: "config", knobs: configOptions.map(toKnobView) };
  }
  if (modes != null) {
    return {
      surface: "modes",
      knobs: [
        {
          id: MODE_KNOB_ID,
          name: "Mode",
          category: "mode", // UX-only (glyph choice) — never read back for routing
          type: "select",
          currentValue: modes.currentModeId,
          options: modes.availableModes.map((m) => ({
            value: m.id,
            name: m.name,
            description: m.description ?? undefined,
          })),
        },
      ],
    };
  }
  return NO_KNOBS;
}

/** A `config_option_update` notification or a set_config_option response —
 * both carry the complete config state per spec, so this always yields (or
 * upgrades to) the config surface, wholesale. */
export function applyConfigUpdate(
  configOptions: readonly SessionConfigOption[],
): NormalizedKnobs {
  return { surface: "config", knobs: configOptions.map(toKnobView) };
}

/** A `current_mode_update` notification. Only meaningful on the modes
 * surface; on "config" it returns null — dropped, because mapping it onto a
 * config option would need the category as a correctness key, exactly what
 * the spec forbids. The agent's transition duty ("keep both in sync") means
 * a config-surface agent confirms mode changes via config_option_update; a
 * bridge that doesn't earns a quirk entry here, never a standing guess. */
export function applyModeUpdate(
  current: NormalizedKnobs,
  modeId: string,
): NormalizedKnobs | null {
  if (current.surface !== "modes") return null;
  return {
    surface: "modes",
    knobs: current.knobs.map((k) =>
      k.id === MODE_KNOB_ID && k.type === "select" ? { ...k, currentValue: modeId } : k,
    ),
  };
}

/** How one knob set reaches the wire. */
export type KnobSetRoute =
  | { via: "setMode"; modeId: string }
  | { via: "setConfigOption"; configId: string };

function offeredValues(knob: SessionKnobView): string[] {
  if (knob.type !== "select") return [];
  return knob.options.flatMap((o) => ("group" in o ? o.options.map((v) => v.value) : [o.value]));
}

/** Routes a knob set, or refuses (null) when the session doesn't offer that
 * knob/value — patchbay never invents a knob, and the spec requires set
 * values to come from the offered list. */
export function routeKnobSet(
  current: NormalizedKnobs,
  knobId: string,
  value: string | boolean,
): KnobSetRoute | null {
  const knob = current.knobs.find((k) => k.id === knobId);
  if (knob === undefined) return null;
  if (knob.type === "boolean") {
    return typeof value === "boolean" ? { via: "setConfigOption", configId: knobId } : null;
  }
  if (typeof value !== "string" || !offeredValues(knob).includes(value)) return null;
  return current.surface === "modes" && knobId === MODE_KNOB_ID
    ? { via: "setMode", modeId: value }
    : { via: "setConfigOption", configId: knobId };
}

/** The agent-confirmed combination a normalized state represents (id-keyed;
 * the modes-surface knob lands under MODE_KNOB_ID) — what the KnownSession
 * row snapshots for involuntary re-attach, and what the composer-knobs
 * store records on a user set. */
export function confirmedFromKnobs(current: NormalizedKnobs): KnobSeed {
  return Object.fromEntries(current.knobs.map((k) => [k.id, k.currentValue]));
}

/** Folds the legacy two-track stored shapes ({mode?/modeId?, options?})
 * into one id-keyed seed. Explicit option entries win over the legacy mode
 * field. The fold target MODE_KNOB_ID is exact for the modes surface, and
 * lands on the agent's own option id where it happens to be "mode"
 * (claude-agent-acp); anywhere else the entry is skipped at apply time like
 * any other no-longer-offered knob. */
export function foldSeed(seed: {
  mode?: string;
  modeId?: string;
  options?: Readonly<Record<string, string | boolean>>;
}): KnobSeed {
  const mode = seed.mode ?? seed.modeId;
  return {
    ...(mode !== undefined && mode !== "" ? { [MODE_KNOB_ID]: mode } : {}),
    ...seed.options,
  };
}

/** The Settings offerings projection (AgentKnobsView) — offered ids and
 * values only, no current value: offerings describe what a connection can
 * do, not any one session's state. */
export function toOfferedKnobs(knobs: readonly SessionKnobView[]): AgentKnobsView["knobs"] {
  return knobs.map((k) =>
    k.type === "select"
      ? {
          id: k.id,
          name: k.name,
          category: k.category,
          type: "select" as const,
          values: k.options.flatMap((o) =>
            "group" in o
              ? o.options.map((v) => ({ value: v.value, name: v.name }))
              : [{ value: o.value, name: o.name }],
          ),
        }
      : { id: k.id, name: k.name, category: k.category, type: "boolean" as const, values: [] },
  );
}
