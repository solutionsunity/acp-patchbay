// The agent-config record's persisted contract (stores/agent-configs.ts):
// a registry binary's archive facts survive the schema round trip (they
// are what a later connect re-acquires the binary from), and a record
// written before that field existed still parses — it simply carries no
// archive facts and spawns its recorded command as is.
import { describe, expect, it } from "vitest";
import { AgentConfigStore } from "../src/orchestrator/stores/agent-configs";
import { MemoryKV } from "../src/orchestrator/stores/kv";

const base = {
  name: "Kimi CLI",
  command: "/cache/kimi/1.2.3/kimi",
  args: ["--acp"],
  processPolicy: "auto" as const,
  autoConnect: false,
  defaults: {},
  lastSeenVersion: null,
};

describe("agent config store — registry binary facts", () => {
  it("archive facts round-trip through a second store over the same KV", async () => {
    const kv = new MemoryKV();
    await new AgentConfigStore(kv).upsert({
      id: "kimi",
      ...base,
      registrySource: {
        registryId: "kimi",
        distributionKind: "binary",
        pinnedVersion: "1.2.3",
        binary: { archiveUrl: "https://example.test/kimi-1.2.3.tar.gz", cmd: "kimi" },
      },
    });
    const reread = new AgentConfigStore(kv).get("kimi");
    expect(reread?.registrySource).toEqual({
      registryId: "kimi",
      distributionKind: "binary",
      pinnedVersion: "1.2.3",
      binary: { archiveUrl: "https://example.test/kimi-1.2.3.tar.gz", cmd: "kimi" },
    });
  });

  it("a record without archive facts (written before the field) parses and carries none", async () => {
    const kv = new MemoryKV();
    await new AgentConfigStore(kv).upsert({
      id: "legacy",
      ...base,
      registrySource: { registryId: "legacy", distributionKind: "binary", pinnedVersion: "0.9.0" },
    });
    const reread = new AgentConfigStore(kv).get("legacy");
    expect(reread?.registrySource?.binary).toBeUndefined();
    expect(reread?.command).toBe("/cache/kimi/1.2.3/kimi");
  });

  it("npx records carry no archive facts either way", async () => {
    const kv = new MemoryKV();
    await new AgentConfigStore(kv).upsert({
      id: "kilo",
      ...base,
      command: "npx",
      registrySource: { registryId: "kilo", distributionKind: "npx", pinnedVersion: "2.0.0" },
    });
    expect(new AgentConfigStore(kv).get("kilo")?.registrySource?.binary).toBeUndefined();
  });
});
