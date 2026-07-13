// The knob processor (knobs.ts) — the one place that reads the wire's
// modes/configOptions relationship. Pure, so every spec rule is testable
// without a pool: exclusivity (ACP v1 § Session Config Options: clients
// SHOULD use configOptions exclusively and ignore modes), the modes
// fallback, set routing, and the legacy seed fold.
import { describe, expect, it } from "vitest";
import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import {
  applyConfigUpdate,
  applyModeUpdate,
  confirmedFromKnobs,
  foldSeed,
  MODE_KNOB_ID,
  normalizeKnobs,
  routeKnobSet,
  withKnobValue,
  type KnobExtra,
} from "../src/orchestrator/knobs";
import { toOfferedKnobs } from "../src/orchestrator/knobs";

const MODES: SessionModeState = {
  currentModeId: "ask",
  availableModes: [
    { id: "ask", name: "Ask" },
    { id: "code", name: "Code" },
  ],
};

const MODEL_OPTION: SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "sonnet",
  options: [
    { value: "sonnet", name: "Sonnet" },
    { value: "opus", name: "Opus" },
  ],
};

// Deliberately category-free: exclusivity and routing must never depend on
// category (ACP: "MUST NOT be required for correctness").
const UNCATEGORIZED_MODE_OPTION: SessionConfigOption = {
  id: "perm",
  name: "Permissions",
  type: "select",
  currentValue: "default",
  options: [
    { value: "default", name: "Default" },
    { value: "plan", name: "Plan" },
  ],
};

describe("normalizeKnobs — the exclusivity rule", () => {
  it("configOptions present → config surface, modes ignored wholesale (no category needed)", () => {
    const n = normalizeKnobs(MODES, [UNCATEGORIZED_MODE_OPTION, MODEL_OPTION]);
    expect(n.surface).toBe("config");
    expect(n.knobs.map((k) => k.id)).toEqual(["perm", "model"]);
  });

  it("modes alone → one synthetic knob under MODE_KNOB_ID", () => {
    const n = normalizeKnobs(MODES, null);
    expect(n.surface).toBe("modes");
    expect(n.knobs).toEqual([
      {
        id: MODE_KNOB_ID,
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "ask",
        options: [
          { value: "ask", name: "Ask", description: undefined },
          { value: "code", name: "Code", description: undefined },
        ],
      },
    ]);
  });

  it("empty configOptions does not claim the surface — modes still win the fallback", () => {
    expect(normalizeKnobs(MODES, []).surface).toBe("modes");
  });

  it("neither → none, empty list", () => {
    expect(normalizeKnobs(null, null)).toEqual({ surface: "none", knobs: [] });
  });
});

describe("agent-driven updates", () => {
  it("current_mode_update applies on the modes surface", () => {
    const next = applyModeUpdate(normalizeKnobs(MODES, null), "code");
    expect(next?.knobs[0]).toMatchObject({ currentValue: "code" });
  });

  it("current_mode_update is dropped on the config surface — mapping it would need category as a correctness key", () => {
    const config = normalizeKnobs(MODES, [UNCATEGORIZED_MODE_OPTION]);
    expect(applyModeUpdate(config, "plan")).toBeNull();
  });

  it("config_option_update replaces wholesale and upgrades a modes surface", () => {
    const upgraded = applyConfigUpdate([MODEL_OPTION]);
    expect(upgraded.surface).toBe("config");
    expect(upgraded.knobs).toHaveLength(1);
  });
});

describe("routeKnobSet", () => {
  it("routes the synthetic mode knob to session/set_mode on the modes surface", () => {
    const route = routeKnobSet(normalizeKnobs(MODES, null), MODE_KNOB_ID, "code");
    expect(route).toEqual({ via: "setMode", modeId: "code" });
  });

  it("routes config knobs to session/set_config_option — including one that happens to be named 'mode'", () => {
    const config = normalizeKnobs(null, [{ ...UNCATEGORIZED_MODE_OPTION, id: "mode" }]);
    expect(routeKnobSet(config, "mode", "plan")).toEqual({ via: "setConfigOption", configId: "mode" });
  });

  it("refuses an unoffered knob, an unoffered value, and a type-mismatched value", () => {
    const modes = normalizeKnobs(MODES, null);
    expect(routeKnobSet(modes, "model", "opus")).toBeNull(); // knob not offered
    expect(routeKnobSet(modes, MODE_KNOB_ID, "yolo")).toBeNull(); // value not offered
    expect(routeKnobSet(modes, MODE_KNOB_ID, true)).toBeNull(); // boolean into a select
    const withBool = applyConfigUpdate([
      { id: "think", name: "Thinking", type: "boolean", currentValue: false },
    ]);
    expect(routeKnobSet(withBool, "think", true)).toEqual({ via: "setConfigOption", configId: "think" });
    expect(routeKnobSet(withBool, "think", "on")).toBeNull(); // string into a boolean
  });

  it("accepts values offered inside select groups", () => {
    const grouped = applyConfigUpdate([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "sonnet",
        options: [
          {
            group: "anthropic",
            name: "Anthropic",
            options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }],
          },
        ],
      },
    ]);
    expect(routeKnobSet(grouped, "model", "opus")).toEqual({ via: "setConfigOption", configId: "model" });
  });
});

// A fabricated extension extra (spec-pure-core: knobs.ts only ever sees
// this opaque shape — the real modules are tested in extensions tests).
function fakeExtra(id: string): { extra: KnobExtra; sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    extra: {
      knob: {
        id,
        name: "Extra",
        category: "model",
        type: "select",
        currentValue: "",
        options: [
          { value: "a", name: "A" },
          { value: "b", name: "B" },
        ],
      },
      execute: async (deps, value) => {
        sent.push({ sessionId: deps.sessionId, value });
        return typeof value === "string" ? withKnobValue(deps.current, id, value) : null;
      },
    },
  };
}

describe("extension extras (the wire-extension door)", () => {
  it("accepted extras append to the surface and are remembered for routing", () => {
    const { extra } = fakeExtra("model");
    const n = normalizeKnobs(MODES, null, [extra]);
    expect(n.surface).toBe("modes");
    expect(n.knobs.map((k) => k.id)).toEqual([MODE_KNOB_ID, "model"]);
    expect(n.extras).toEqual([extra]);
  });

  it("an extra whose id a spec-surface knob owns is dropped — the spec surface wins", () => {
    const { extra } = fakeExtra("model");
    const n = normalizeKnobs(MODES, [MODEL_OPTION], [extra]);
    expect(n.surface).toBe("config");
    expect(n.knobs.filter((k) => k.id === "model")).toHaveLength(1);
    expect(n.extras).toBeUndefined();
    // ...and its set routes as an ordinary config option, never an extension.
    expect(routeKnobSet(n, "model", "opus")).toEqual({ via: "setConfigOption", configId: "model" });
  });

  it("routes an extension knob to its own executor, value-guarded like any knob", async () => {
    const { extra, sent } = fakeExtra("model");
    const n = normalizeKnobs(MODES, null, [extra]);
    const route = routeKnobSet(n, "model", "a");
    expect(route).toEqual({ via: "extension", extra });
    expect(routeKnobSet(n, "model", "unoffered")).toBeNull();
    expect(routeKnobSet(n, "model", true)).toBeNull();
    if (route?.via !== "extension") throw new Error("unreachable");
    const next = await route.extra.execute({ sessionId: "s1", send: async () => ({}), current: n }, "a");
    expect(sent).toEqual([{ sessionId: "s1", value: "a" }]);
    expect(next?.knobs.find((k) => k.id === "model")).toMatchObject({ currentValue: "a" });
  });

  it("survives a current_mode_update and a config_option_update untouched", () => {
    const { extra } = fakeExtra("model");
    const n = normalizeKnobs(MODES, null, [extra]);
    const afterMode = applyModeUpdate(n, "code");
    expect(afterMode?.extras).toEqual([extra]);
    expect(afterMode?.knobs.map((k) => k.id)).toEqual([MODE_KNOB_ID, "model"]);
    // A config replace carries the prior state so the independent axis stays.
    const afterConfig = applyConfigUpdate([UNCATEGORIZED_MODE_OPTION], n);
    expect(afterConfig.surface).toBe("config");
    expect(afterConfig.knobs.map((k) => k.id)).toEqual(["perm", "model"]);
    expect(afterConfig.extras).toEqual([extra]);
    // ...unless the new config surface takes the id over.
    const collided = applyConfigUpdate([MODEL_OPTION], n);
    expect(collided.knobs.filter((k) => k.id === "model")).toHaveLength(1);
    expect(collided.extras).toBeUndefined();
  });

  it("withKnobValue advances only the named select knob", () => {
    const { extra } = fakeExtra("model");
    const n = normalizeKnobs(MODES, null, [extra]);
    const advanced = withKnobValue(n, "model", "b");
    expect(advanced.knobs.find((k) => k.id === "model")).toMatchObject({ currentValue: "b" });
    expect(advanced.knobs.find((k) => k.id === MODE_KNOB_ID)).toMatchObject({ currentValue: "ask" });
  });
});

describe("seeds and projections", () => {
  it("foldSeed: legacy mode/modeId land under MODE_KNOB_ID, explicit options win", () => {
    expect(foldSeed({ mode: "plan", options: { model: "opus" } })).toEqual({ mode: "plan", model: "opus" });
    expect(foldSeed({ modeId: "plan" })).toEqual({ mode: "plan" });
    expect(foldSeed({ mode: "plan", options: { [MODE_KNOB_ID]: "code" } })).toEqual({ mode: "code" });
    expect(foldSeed({})).toEqual({});
  });

  it("confirmedFromKnobs records the whole combination id-keyed", () => {
    expect(confirmedFromKnobs(normalizeKnobs(MODES, [MODEL_OPTION]))).toEqual({ model: "sonnet" });
    expect(confirmedFromKnobs(normalizeKnobs(MODES, null))).toEqual({ [MODE_KNOB_ID]: "ask" });
  });

  it("toOfferedKnobs flattens groups and drops current values", () => {
    const offered = toOfferedKnobs(
      applyConfigUpdate([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "sonnet",
          options: [
            { group: "anthropic", name: "Anthropic", options: [{ value: "opus", name: "Opus" }] },
            { group: "openai", name: "OpenAI", options: [{ value: "gpt", name: "GPT" }] },
          ],
        },
        { id: "think", name: "Thinking", type: "boolean", currentValue: true },
      ]).knobs,
    );
    expect(offered).toEqual([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        values: [
          { value: "opus", name: "Opus" },
          { value: "gpt", name: "GPT" },
        ],
      },
      { id: "think", name: "Thinking", category: undefined, type: "boolean", values: [] },
    ]);
  });
});
