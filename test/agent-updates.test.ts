// Issue #37: "update available" is one orchestrator fact — computed from
// the registry and each config's pin and last seen version, and read by
// every surface that offers an upgrade.
import { describe, expect, it } from "vitest";
import { agentUpdates } from "../src/orchestrator/agent-updates";

const config = (id: string, registryId: string | null, pinnedVersion: string, lastSeenVersion: string | null = null) => ({
  id,
  registrySource: registryId === null ? null : { registryId, pinnedVersion },
  lastSeenVersion,
});

describe("agent updates", () => {
  it("a registry version ahead of the pin is an update, linked through the config's registry id", () => {
    const registry = [{ id: "reg-a", version: "1.2.0" }];
    expect(agentUpdates(registry, [config("a1", "reg-a", "1.0.0")])).toEqual({ a1: { from: "1.0.0", to: "1.2.0" } });
  });

  it("nothing to offer: current pin, custom command, or an agent the registry doesn't list", () => {
    const registry = [{ id: "reg-a", version: "1.0.0" }];
    expect(agentUpdates(registry, [config("a1", "reg-a", "1.0.0")])).toEqual({});
    expect(agentUpdates(registry, [config("c1", null, "")])).toEqual({});
    expect(agentUpdates(registry, [config("b1", "reg-b", "1.0.0")])).toEqual({});
  });

  it("the running agent already reporting the latest outranks a stale pin", () => {
    const registry = [{ id: "reg-a", version: "1.2.0" }];
    expect(agentUpdates(registry, [config("a1", "reg-a", "1.0.0", "1.2.0")])).toEqual({});
  });
});
