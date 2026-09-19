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
  applySeedToFixedPoint,
  confirmedFromKnobs,
  foldSeed,
  MODE_KNOB_ID,
  NO_KNOBS,
  normalizeKnobs,
  performKnobSet,
  routeKnobSet,
  withKnobValue,
  type KnobExtra,
  type KnobWire,
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

describe("performKnobSet — one routed set, three wire paths", () => {
  function wire(response: SessionConfigOption[], onConfigSet?: () => void) {
    const calls: string[] = [];
    const w: KnobWire = {
      setMode: async (sessionId, modeId) => {
        calls.push(`set_mode ${sessionId} ${modeId}`);
      },
      setConfigOption: async (sessionId, configId, value) => {
        calls.push(`set_config_option ${sessionId} ${configId}=${String(value)}`);
        onConfigSet?.();
        return { configOptions: response };
      },
      send: async (method, params) => {
        calls.push(`${method} ${JSON.stringify(params)}`);
        return {};
      },
    };
    return { w, calls };
  }

  it("set_mode: calls the wire and returns null — display waits for current_mode_update", async () => {
    const { w, calls } = wire([]);
    const next = await performKnobSet(w, "s1", () => normalizeKnobs(MODES, undefined), { via: "setMode", modeId: "code" }, "code");
    expect(next).toBeNull();
    expect(calls).toEqual(["set_mode s1 code"]);
  });

  it("set_config_option: consumes the response onto the state as it stands when the response lands", async () => {
    const { extra } = fakeExtra("x");
    let current = normalizeKnobs(undefined, [MODEL_OPTION]);
    // the surface moved while the request was in flight (a notification, an
    // extension set) — what it carried must survive the response
    const { w, calls } = wire([{ ...MODEL_OPTION, currentValue: "opus" }], () => {
      current = normalizeKnobs(undefined, [MODEL_OPTION], [extra]);
    });
    const next = await performKnobSet(w, "s1", () => current, { via: "setConfigOption", configId: "model" }, "opus");
    expect(calls).toEqual(["set_config_option s1 model=opus"]);
    expect(next?.knobs.find((k) => k.id === "model")?.currentValue).toBe("opus");
    expect(next?.extras).toEqual([extra]);
  });

  it("extension: executes with the state at execute time and returns the executor's next state", async () => {
    const { extra, sent } = fakeExtra("x");
    const current = normalizeKnobs(undefined, [MODEL_OPTION], [extra]);
    const { w, calls } = wire([]);
    const next = await performKnobSet(w, "s1", () => current, { via: "extension", extra }, "b");
    expect(sent).toEqual([{ sessionId: "s1", value: "b" }]);
    expect(calls).toEqual([]); // the executor owns its wire; the spec paths are untouched
    expect(next?.knobs.find((k) => k.id === "x")?.currentValue).toBe("b");
  });

  it("a wire rejection propagates untouched — what it means is the caller's policy", async () => {
    const refuse = async () => {
      throw new Error("nope");
    };
    const w: KnobWire = { setMode: refuse, setConfigOption: refuse, send: async () => ({}) };
    const none = () => normalizeKnobs(undefined, undefined);
    await expect(performKnobSet(w, "s1", none, { via: "setMode", modeId: "code" }, "code")).rejects.toThrow("nope");
    await expect(performKnobSet(w, "s1", none, { via: "setConfigOption", configId: "model" }, "opus")).rejects.toThrow("nope");
  });
});

describe("applySeedToFixedPoint — a surface conditioned on its own selections", () => {
  /** A fake wire: `effort` exists only once model=pro is set. */
  const EFFORT: SessionConfigOption = {
    id: "effort",
    name: "Effort",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  };
  const PRO_MODEL: SessionConfigOption = {
    ...MODEL_OPTION,
    options: [
      { value: "sonnet", name: "Sonnet" },
      { value: "pro", name: "Pro" },
    ],
  };
  /** `effort` is offered on every model when `always`, only on "pro"
   * otherwise; a model switch always resets it to its default (the shape
   * that defeats set-once seeding). `refuse` lists values the agent
   * rejects — the set "succeeds" but the surface keeps its value. */
  function wire(opts: { always?: boolean; refuse?: string[] } = {}) {
    let surface = applyConfigUpdate(opts.always ? [PRO_MODEL, EFFORT] : [PRO_MODEL]);
    const sets: string[] = [];
    const set = async (_route: unknown, knobId: string, value: string | boolean) => {
      sets.push(`${knobId}=${String(value)}`);
      const accepted = !(opts.refuse ?? []).includes(String(value));
      const options = surface.knobs.map((k) => (k.id === knobId && accepted ? { ...k, currentValue: value } : k));
      const model = options.find((k) => k.id === "model")?.currentValue;
      const effort = knobId === "model" ? EFFORT : (options.find((k) => k.id === "effort") ?? EFFORT);
      const withEffort =
        opts.always || model === "pro"
          ? [...options.filter((k) => k.id !== "effort"), effort]
          : options.filter((k) => k.id !== "effort");
      surface = applyConfigUpdate(withEffort as unknown as SessionConfigOption[]);
    };
    return { current: () => surface, set, sets };
  }

  it("lands an entry whose knob appears only after an earlier entry's set — regardless of key order", async () => {
    const w = wire();
    await applySeedToFixedPoint({ effort: "high", model: "pro" }, w.current, w.set);
    expect(w.sets).toEqual(["model=pro", "effort=high"]);
    expect(confirmedFromKnobs(w.current())).toEqual({ model: "pro", effort: "high" });
  });

  it("re-asks an entry a later set reset — convergence, not set-once", async () => {
    const w = wire({ always: true });
    await applySeedToFixedPoint({ effort: "high", model: "pro" }, w.current, w.set);
    expect(w.sets).toEqual(["effort=high", "model=pro", "effort=high"]);
    expect(confirmedFromKnobs(w.current())).toEqual({ model: "pro", effort: "high" });
  });

  it("skips what the surface already holds — a seed matching the agent costs no wire", async () => {
    const w = wire({ always: true });
    await applySeedToFixedPoint({ model: "sonnet", effort: "medium" }, w.current, w.set);
    expect(w.sets).toEqual([]);
  });

  it("skips what the surface never offers, without re-asking — terminates", async () => {
    const w = wire();
    await applySeedToFixedPoint({ nothing: "x", model: "sonnet", effort: "high" }, w.current, w.set);
    expect(w.sets).toEqual([]); // sonnet already held; effort never appears for sonnet; `nothing` never exists
  });

  it("never re-asks a rejected entry when nothing else moved", async () => {
    const w = wire({ always: true, refuse: ["high"] });
    await applySeedToFixedPoint({ effort: "high" }, w.current, w.set);
    expect(w.sets).toEqual(["effort=high"]);
  });

  it("re-asks a rejected entry once per neighbour that fired after it, then stops", async () => {
    const w = wire({ always: true, refuse: ["high"] });
    await applySeedToFixedPoint({ effort: "high", model: "pro" }, w.current, w.set);
    // model fired after effort's set — it may have disturbed it; the second
    // refusal has no neighbour after it, so it stands.
    expect(w.sets).toEqual(["effort=high", "model=pro", "effort=high"]);
  });

  it("terminates when two knobs reset each other", async () => {
    const A: SessionConfigOption = { ...EFFORT, id: "a", currentValue: "low" };
    const B: SessionConfigOption = { ...EFFORT, id: "b", currentValue: "low" };
    let surface = applyConfigUpdate([A, B]);
    const sets: string[] = [];
    const set = async (_r: unknown, knobId: string, value: string | boolean) => {
      sets.push(`${knobId}=${String(value)}`);
      // setting either knob resets the other to "low"
      surface = applyConfigUpdate(
        surface.knobs.map((k) => ({ ...k, currentValue: k.id === knobId ? value : "low" })) as unknown as SessionConfigOption[],
      );
    };
    await applySeedToFixedPoint({ a: "high", b: "high" }, () => surface, set);
    expect(sets.length).toBeLessThanOrEqual(6); // ≤ (seed size + 1) passes × seed size
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

// ── trust boundary: session responses arrive unvalidated (the SDK checks
// outgoing request params only), so the knob surface must validate-and-
// degrade — a malformed or unrecognized entry drops singly, the rest of the
// surface survives, and connect never crashes (acp-matrix fixture finding).
describe("trust boundary — malformed knob surfaces degrade, never throw", () => {
  it("an under-shaped config option (no type/options) drops; valid siblings survive", () => {
    const dropped: string[] = [];
    const n = normalizeKnobs(
      null,
      [{ id: "mystery", name: "Mystery" }, MODEL_OPTION],
      undefined,
      (m) => dropped.push(m),
    );
    expect(n.surface).toBe("config");
    expect(n.knobs.map((k) => k.id)).toEqual(["model"]);
    expect(dropped).toHaveLength(1);
  });

  it("an unknown option variant (a future type) drops instead of crashing", () => {
    const n = normalizeKnobs(null, [
      { id: "slider", name: "Slider", type: "range", currentValue: 3, min: 0, max: 10 },
      MODEL_OPTION,
    ]);
    expect(n.knobs.map((k) => k.id)).toEqual(["model"]);
  });

  it("configOptions that is not an array is ignored; the modes fallback still stands", () => {
    const n = normalizeKnobs(MODES, "not-an-array");
    expect(n.surface).toBe("modes");
    expect(n.knobs.map((k) => k.id)).toEqual([MODE_KNOB_ID]);
  });

  it("an all-malformed configOptions list yields the modes fallback, not an empty config surface", () => {
    const n = normalizeKnobs(MODES, [{ nothing: true }, 42]);
    expect(n.surface).toBe("modes");
  });

  it("malformed select entries drop singly inside an otherwise valid option", () => {
    const n = normalizeKnobs(null, [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "a",
        options: [{ value: "a", name: "A" }, { value: 7 }, null],
      },
    ]);
    const knob = n.knobs[0]!;
    expect(knob.type).toBe("select");
    expect(knob.type === "select" && knob.options).toEqual([{ value: "a", name: "A", description: undefined }]);
  });

  it("malformed annotation fields (description/category) degrade to absent, keeping the option", () => {
    const n = normalizeKnobs(null, [{ ...MODEL_OPTION, description: 99, category: { deep: true } }]);
    expect(n.knobs[0]).toMatchObject({ id: "model", description: undefined, category: undefined });
  });

  it("a malformed modes state is ignored wholesale; malformed modes drop singly", () => {
    expect(normalizeKnobs({ currentModeId: 5 }, null)).toEqual(NO_KNOBS);
    const n = normalizeKnobs(
      { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: 3 }, "x"] },
      null,
    );
    expect(n.surface).toBe("modes");
    const mode = n.knobs[0]!;
    expect(mode.type === "select" && mode.options).toEqual([
      { value: "ask", name: "Ask", description: undefined },
    ]);
  });

  it("applyConfigUpdate tolerates malformed state the same way", () => {
    const next = applyConfigUpdate([{ id: "broken" }, MODEL_OPTION]);
    expect(next.surface).toBe("config");
    expect(next.knobs.map((k) => k.id)).toEqual(["model"]);
  });
});
