// Issue #37: "update available" is one orchestrator fact — computed from
// the registry and each config's pin, and read by every surface that
// offers an upgrade. #129: the pin against the registry's latest, nothing
// else — the version the agent reports is another naming scheme.
import { describe, expect, it } from "vitest";
import { agentUpdates } from "../src/orchestrator/agent-updates";
import type { PatchbayAgentId } from "../src/shared/ids";

const config = (id: string, origin: string | null, pinnedVersion: string | null) => ({
  id: id as PatchbayAgentId,
  origin,
  link: pinnedVersion === null ? null : { pinnedVersion },
});

describe("agent updates", () => {
  it("a registry version ahead of the pin is an update, linked through the config's origin", () => {
    const registry = [{ id: "reg-a", version: "1.2.0" }];
    expect(agentUpdates(registry, [config("a1", "reg-a", "1.0.0")])).toEqual(new Map([["a1", { from: "1.0.0", to: "1.2.0" }]]));
  });

  it("nothing to offer: current pin, custom command, edited command, or an agent the registry doesn't list", () => {
    const registry = [{ id: "reg-a", version: "1.2.0" }];
    expect(agentUpdates([{ id: "reg-a", version: "1.0.0" }], [config("a1", "reg-a", "1.0.0")])).toEqual(new Map());
    expect(agentUpdates(registry, [config("c1", null, null)])).toEqual(new Map());
    // edited: its origin kept, its pin gone — Reset is its way back, not Upgrade
    expect(agentUpdates(registry, [config("e1", "reg-a", null)])).toEqual(new Map());
    expect(agentUpdates(registry, [config("b1", "reg-b", "1.0.0")])).toEqual(new Map());
  });
});
