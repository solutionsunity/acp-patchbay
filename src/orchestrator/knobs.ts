// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Normalizes every knob-shaped wire fact into one view, and routes every
// knob set back to the wire — the knob sibling of capabilities.ts. This is
// the only module that reads how the wire's knob surfaces relate; no other
// file (and no webview) may distinguish them.
//
// The spec rule this encodes (ACP v1): config options supersede modes — a client that
// supports them "SHOULD use configOptions exclusively and ignore modes",
// and modes will be removed from the protocol (v2 already drops
// session/set_mode). So: any non-empty configOptions wins the whole
// surface; modes are only ever a fallback, synthesized into one knob so the
// rest of patchbay renders a single uniform list. This exclusivity replaces
// the old category-keyed dedup ("suppress native modes when a
// category:'mode' option exists"), which depended on a field ACP forbids as
// a correctness dependency ("categories… MUST NOT be required for
// correctness") and was fitted to one bridge's observed shape.
//
// A THIRD source: wire-extension modules (orchestrator/extensions/) may
// synthesize additional knobs from out-of-spec surfaces. knobs.ts stays
// spec-pure: it accepts opaque `KnobExtra`s — a knob view plus a
// self-executing set route — applies one generic rule (an extra whose id a
// spec-surface knob already owns is dropped; the spec surface is the
// confirming one), and never learns any extension's shape, wire method, or
// display policy.
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

/** What an extension route receives at execute time — session-manager
 * supplies these at its one generic branch; the extension owns everything
 * else (method name, params, display policy). */
export interface KnobExecuteDeps {
  sessionId: string;
  /** Raw wire sender (pool.unstableRequest bound to the session's
   * connection) — the one escape hatch for extension-owned methods. */
  send: (method: string, params: unknown) => Promise<unknown>;
  /** The session's normalized knob state as it stands at execute time. */
  current: NormalizedKnobs;
}

/** One extension-owned knob: the view to offer plus its self-executing set
 * route (core never learns the wire method or policy — the
 * executor returns the next display state, or null to wait for the agent's
 * own notification). Produced only by orchestrator/extensions/ modules. */
export interface KnobExtra {
  knob: SessionKnobView;
  execute: (deps: KnobExecuteDeps, value: string | boolean) => Promise<NormalizedKnobs | null>;
}

/** A session's normalized knob state. `surface` records which wire API
 * drives mode/config sets; `extras` holds the extension-owned knobs that
 * were accepted into `knobs` (routing state for routeKnobSet). Both are
 * orchestrator-side only, deliberately not part of the webview view
 * (the UI renders knobs, it never knows which
 * protocol surface they came from). */
export interface NormalizedKnobs {
  surface: "config" | "modes" | "none";
  knobs: readonly SessionKnobView[];
  extras?: readonly KnobExtra[];
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
 * (session/new, /load, /resume). Exclusivity applies to modes/config here;
 * extension-owned extras are independent axes folded in afterward. */
export function normalizeKnobs(
  modes: SessionModeState | null | undefined,
  configOptions: readonly SessionConfigOption[] | null | undefined,
  extras?: readonly KnobExtra[],
): NormalizedKnobs {
  return withExtras(baseKnobs(modes, configOptions), extras);
}

function baseKnobs(
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

/** Appends extension-owned knobs to a base surface. One generic rule: an
 * extra whose id a spec-surface knob already owns is dropped — the spec
 * surface is the confirming one (e.g. an agent that carries model inside
 * configOptions wins over any legacy model field). Accepted extras are
 * remembered for routing; their views join the uniform knob list. */
function withExtras(
  base: NormalizedKnobs,
  extras: readonly KnobExtra[] | undefined,
): NormalizedKnobs {
  const accepted = (extras ?? []).filter((e) => !base.knobs.some((k) => k.id === e.knob.id));
  if (accepted.length === 0) return base;
  return { ...base, knobs: [...base.knobs, ...accepted.map((e) => e.knob)], extras: accepted };
}

/** A local value advance for one select knob — the helper extension
 * executors use when their axis has no confirmation channel and the user's
 * own pick is the only fact there is to display. */
export function withKnobValue(current: NormalizedKnobs, knobId: string, value: string): NormalizedKnobs {
  return {
    ...current,
    knobs: current.knobs.map((k) =>
      k.id === knobId && k.type === "select" ? { ...k, currentValue: value } : k,
    ),
  };
}

/** A `config_option_update` notification or a set_config_option response —
 * both carry the complete config state per spec, so this always yields (or
 * upgrades to) the config surface, wholesale. `prior` carries the session's
 * standing state so accepted extras survive: they ride the session response,
 * not config updates — a config replace must not silently drop an
 * extension's independent axis. */
export function applyConfigUpdate(
  configOptions: readonly SessionConfigOption[],
  prior?: NormalizedKnobs,
): NormalizedKnobs {
  return withExtras({ surface: "config", knobs: configOptions.map(toKnobView) }, prior?.extras);
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
    ...current, // preserve extras — a mode update never touches an extension's axis
    surface: "modes",
    knobs: current.knobs.map((k) =>
      k.id === MODE_KNOB_ID && k.type === "select" ? { ...k, currentValue: modeId } : k,
    ),
  };
}

/** How one knob set reaches the wire. Extension routes carry their own
 * executor — core runs it without knowing what it does. */
export type KnobSetRoute =
  | { via: "setMode"; modeId: string }
  | { via: "setConfigOption"; configId: string }
  | { via: "extension"; extra: KnobExtra };

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
  const valid =
    knob.type === "boolean"
      ? typeof value === "boolean"
      : typeof value === "string" && offeredValues(knob).includes(value);
  if (!valid) return null;
  // Extension-owned knobs execute themselves; provenance is the accepted
  // extras list, never an id or category — a spec-surface knob that happens
  // to share an extension's id was already deduped at normalize, so it
  // cannot reach this branch.
  const extra = current.extras?.find((e) => e.knob.id === knobId);
  if (extra !== undefined) return { via: "extension", extra };
  if (typeof value === "string" && current.surface === "modes" && knobId === MODE_KNOB_ID) {
    return { via: "setMode", modeId: value };
  }
  return { via: "setConfigOption", configId: knobId };
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
