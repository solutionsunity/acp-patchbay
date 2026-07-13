// The models-field wire extension (extensions/session-models-field.ts) —
// shapes captured live from auggie 0.32.0 (docs/acp-agents-notes/auggie.md
// § Model selection rides a removed draft API). Tested through the compose
// point (extensions/index.ts), the same import core uses.
import { describe, expect, it } from "vitest";
import { sessionKnobExtras } from "../src/orchestrator/extensions";
import { MODE_KNOB_ID, normalizeKnobs, routeKnobSet } from "../src/orchestrator/knobs";

const MODES = {
  currentModeId: "default",
  availableModes: [{ id: "default", name: "Default" }],
};

const RESPONSE = {
  sessionId: "s1",
  modes: MODES,
  models: {
    availableModels: [
      { modelId: "gpt-5", name: "GPT-5", description: "legacy" },
      { modelId: "claude-opus-4-8", name: "Opus 4.8", description: null },
    ],
    currentModelId: "",
  },
};

describe("session-models-field extension", () => {
  it("degrades to no extras on absent/malformed/empty field", () => {
    expect(sessionKnobExtras({ sessionId: "s1" })).toEqual([]);
    expect(sessionKnobExtras(null)).toEqual([]);
    expect(sessionKnobExtras({ models: { availableModels: [] } })).toEqual([]);
    expect(sessionKnobExtras({ models: { availableModels: [{ name: "x" }] } })).toEqual([]);
  });

  it("synthesizes the model knob; currentValue only when offered", () => {
    const [extra] = sessionKnobExtras(RESPONSE);
    expect(extra!.knob).toMatchObject({
      id: "model",
      category: "model",
      type: "select",
      currentValue: "", // agent reported none
    });
    const withCurrent = sessionKnobExtras({
      models: { ...RESPONSE.models, currentModelId: "gpt-5" },
    });
    expect(withCurrent[0]!.knob).toMatchObject({ currentValue: "gpt-5" });
    const bogus = sessionKnobExtras({
      models: { ...RESPONSE.models, currentModelId: "not-offered" },
    });
    expect(bogus[0]!.knob).toMatchObject({ currentValue: "" });
  });

  it("end-to-end through normalize: appends to modes, routes to itself, sends session/set_model, advances optimistically", async () => {
    const n = normalizeKnobs(RESPONSE.modes, undefined, sessionKnobExtras(RESPONSE));
    expect(n.knobs.map((k) => k.id)).toEqual([MODE_KNOB_ID, "model"]);
    const route = routeKnobSet(n, "model", "claude-opus-4-8");
    if (route?.via !== "extension") throw new Error("expected extension route");
    const wire: { method: string; params: unknown }[] = [];
    const next = await route.extra.execute(
      { sessionId: "s1", send: async (method, params) => (wire.push({ method, params }), {}), current: n },
      "claude-opus-4-8",
    );
    // The removed-draft wire method, exactly as auggie 0.32.0 expects it.
    expect(wire).toEqual([
      { method: "session/set_model", params: { sessionId: "s1", modelId: "claude-opus-4-8" } },
    ]);
    // Optimistic display: no confirmation channel exists on this axis.
    expect(next?.knobs.find((k) => k.id === "model")).toMatchObject({ currentValue: "claude-opus-4-8" });
  });

  it("never synthesizes over a configOption model knob (claude-agent-acp shape)", () => {
    const claudeish = {
      sessionId: "s2",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Default" }],
        },
      ],
    };
    // Even if a hypothetical agent sent BOTH surfaces, the spec one wins.
    const both = { ...claudeish, models: RESPONSE.models };
    const n = normalizeKnobs(undefined, both.configOptions as never, sessionKnobExtras(both));
    expect(n.knobs.filter((k) => k.id === "model")).toHaveLength(1);
    expect(routeKnobSet(n, "model", "default")).toEqual({ via: "setConfigOption", configId: "model" });
  });
});
