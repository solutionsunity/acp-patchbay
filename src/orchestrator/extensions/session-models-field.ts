// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Wire extension: the legacy top-level `models` field + `session/set_model`
// — a real ACP draft that was never stabilized and was REMOVED from the
// protocol June 1, 2026 (agentclientprotocol.com/rfds/updates), superseded
// by configOptions category:"model". Some agents still ship it (Auggie
// 0.32.0, ~28 models, `currentModelId: ""` at session-open).
//
// Adopted 2026-07-13. RETIRE when Auggie migrates to configOptions — the
// draft is removed upstream, so it will never appear in any SDK; vendor
// migration is the only exit. Retirement = delete this file + its line in
// extensions/index.ts.
import { z } from "zod";
import { withKnobValue, type KnobExtra } from "../knobs";

/** Deliberately "model" — the id claude-agent-acp gives its configOption
 * model knob — so normalize's generic id-dedup makes a spec surface win
 * wherever both could exist (they never coexist on one agent today). */
const MODEL_KNOB_ID = "model";

const modelsFieldSchema = z.object({
  availableModels: z.array(
    z.object({
      modelId: z.string().min(1),
      name: z.string(),
      description: z.union([z.string(), z.null()]).optional(),
    }),
  ),
  currentModelId: z.string().optional(),
});

/** Reads the legacy `models` field off a raw session response (the response
 * is typed without it — no SDK release carries it — so it arrives as
 * unknown and is validated here, the one door that knows the shape).
 * Absent/malformed/empty → no extra (degrade-to-absent, never a throw).
 *
 * The synthesized knob's `currentValue` is the agent's `currentModelId`
 * only when it names a real offered value; otherwise "" (no selection →
 * the picker shows a placeholder, never a value the agent didn't report).
 *
 * The executor: this axis has NO confirmation channel on the wire (no
 * model update notification, no model in usage_update, empty set_model
 * response — dossier), so — this knob alone — the displayed value advances
 * optimistically from the user's own pick: the sole fact in existence, and
 * no agent state is being trusted (there is none). */
export function sessionModelsExtras(response: unknown): KnobExtra[] {
  if (typeof response !== "object" || response === null) return [];
  const parsed = modelsFieldSchema.safeParse((response as { models?: unknown }).models);
  if (!parsed.success || parsed.data.availableModels.length === 0) return [];
  const options = parsed.data.availableModels.map((m) => ({
    value: m.modelId,
    name: m.name,
    description: m.description ?? undefined,
  }));
  const current = parsed.data.currentModelId ?? "";
  return [
    {
      knob: {
        id: MODEL_KNOB_ID,
        name: "Model",
        category: "model", // UX-only (glyph choice) — never read back for routing
        type: "select",
        currentValue: options.some((o) => o.value === current) ? current : "",
        options,
      },
      execute: async (deps, value) => {
        if (typeof value !== "string") return null; // select knob — routeKnobSet already guards
        await deps.send("session/set_model", { sessionId: deps.sessionId, modelId: value });
        return withKnobValue(deps.current, MODEL_KNOB_ID, value);
      },
    },
  ];
}
