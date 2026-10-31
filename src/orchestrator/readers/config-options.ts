// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The reader for an agent's knob surface — its config options and its
// modes, wherever they arrive (a session response, a set_config_option
// answer, a config_option_update). Read once here, at the wire's edge; what
// leaves is typed, and what was dropped is said through the reader's note.
import { z } from "zod";
import type { SessionConfigSelectGroupView, SessionConfigSelectValueView, SessionKnobView } from "../../shared/protocol";
import type { Note } from "./notes";

/** The modes surface as read: the current mode, and the modes offered. */
export interface ModeState {
  currentModeId: string;
  modes: SessionConfigSelectValueView[];
}

// ── trust-boundary guards ───────────────────────────────────────────────────
// Session responses (session/new, /load, /resume, set_config_option) and
// the config_option_update notification reach this module unvalidated —
// the SDK checks outgoing request params only, so modes and config options
// here are agent-supplied claims, not facts. Validate and degrade, never
// crash: a malformed or unrecognized entry (the unstable surface explicitly
// allows new variants) drops, said through the note, and the rest of the
// knob surface survives. Degrade granularity mirrors the spec
// schema's own deserialize guidance: structural fields drop the entry,
// annotation fields (description, category) default to absent.

const selectValueSchema = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().nullish().catch(undefined),
});

const selectGroupSchema = z.object({
  group: z.string(),
  name: z.string(),
  options: z.array(z.unknown()),
});

const optionCommon = {
  id: z.string(),
  name: z.string(),
  description: z.string().nullish().catch(undefined),
  category: z.string().nullish().catch(undefined),
};

const selectOptionSchema = z.object({
  ...optionCommon,
  type: z.literal("select"),
  currentValue: z.string(),
  options: z.array(z.unknown()),
});

const booleanOptionSchema = z.object({
  ...optionCommon,
  type: z.literal("boolean"),
  currentValue: z.boolean(),
});

const modeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish().catch(undefined),
});

const modeStateSchema = z.object({
  currentModeId: z.string(),
  availableModes: z.array(z.unknown()),
});

function idOf(value: unknown): string {
  if (typeof value === "object" && value !== null && "id" in value) {
    return `"${String((value as { id: unknown }).id)}"`;
  }
  return "<unshaped>";
}

/** A select option's offered values: value entries or group entries, each
 * guarded singly. The wire type is homogeneous (all values or all groups);
 * on a malformed mix the parseable entries of the first-seen shape win. */
function sanitizeSelectOptions(
  entries: readonly unknown[],
  optionId: string,
  note: Note,
): readonly SessionConfigSelectValueView[] | readonly SessionConfigSelectGroupView[] {
  const values: SessionConfigSelectValueView[] = [];
  const groups: SessionConfigSelectGroupView[] = [];
  for (const entry of entries) {
    const group = selectGroupSchema.safeParse(entry);
    if (group.success) {
      groups.push({
        group: group.data.group,
        name: group.data.name,
        options: sanitizeSelectOptions(group.data.options, optionId, note) as SessionConfigSelectValueView[],
      });
      continue;
    }
    const value = selectValueSchema.safeParse(entry);
    if (value.success) {
      values.push({
        value: value.data.value,
        name: value.data.name,
        description: value.data.description ?? undefined,
      });
      continue;
    }
    note(`knobs: dropped malformed select entry on config option ${optionId}`);
  }
  return groups.length > 0 ? groups : values;
}

/** One config option through the union guard — null (logged) when it fits
 * no known variant. */
function sanitizeConfigOption(raw: unknown, note: Note): SessionKnobView | null {
  const bool = booleanOptionSchema.safeParse(raw);
  if (bool.success) {
    const o = bool.data;
    return {
      id: o.id,
      name: o.name,
      description: o.description ?? undefined,
      category: o.category ?? undefined,
      type: "boolean",
      currentValue: o.currentValue,
    };
  }
  const select = selectOptionSchema.safeParse(raw);
  if (select.success) {
    const o = select.data;
    return {
      id: o.id,
      name: o.name,
      description: o.description ?? undefined,
      category: o.category ?? undefined,
      type: "select",
      currentValue: o.currentValue,
      options: sanitizeSelectOptions(o.options, `"${o.id}"`, note),
    };
  }
  note(`knobs: dropped malformed or unrecognized config option ${idOf(raw)}`);
  return null;
}

/** An agent's config options, read: each through the union guard, dropped
 * singly (said once) when it fits no known variant. */
export function readConfigOptions(raw: unknown, note: Note): SessionKnobView[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    note("knobs: configOptions is not an array — surface ignored");
    return [];
  }
  return raw.map((o) => sanitizeConfigOption(o, note)).filter((k) => k !== null);
}

/** The modes surface through the guard: malformed wholesale → absent (the
 * fallback simply doesn't exist this attach); malformed individual modes
 * drop singly. */
export function readModeState(raw: unknown, note: Note): ModeState | null {
  if (raw == null) return null;
  const state = modeStateSchema.safeParse(raw);
  if (!state.success) {
    note("knobs: malformed modes state — surface ignored");
    return null;
  }
  const modes: SessionConfigSelectValueView[] = [];
  for (const entry of state.data.availableModes) {
    const mode = modeSchema.safeParse(entry);
    if (!mode.success) {
      note(`knobs: dropped malformed mode entry ${idOf(entry)}`);
      continue;
    }
    modes.push({
      value: mode.data.id,
      name: mode.data.name,
      description: mode.data.description ?? undefined,
    });
  }
  return { currentModeId: state.data.currentModeId, modes };
}
