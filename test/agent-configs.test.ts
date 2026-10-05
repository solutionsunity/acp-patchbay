// The agent-config record's persisted contract (stores/agent-configs.ts):
// a registry binary's archive facts survive the schema round trip (they
// are what a later connect re-acquires the binary from), and a record
// written before that field existed still parses — it simply carries no
// archive facts and spawns its recorded command as is. A record from when
// agents carried a process policy loses that field once, at load.
import { describe, expect, it, vi } from "vitest";
import { AgentConfigStore } from "../src/orchestrator/stores/agent-configs";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import type { PatchbayAgentId } from "../src/shared/ids";

const base = {
  name: "Kimi CLI",
  command: "/cache/kimi/1.2.3/kimi",
  args: ["--acp"],
  autoConnect: false,
  defaults: {},
  lastSeenVersion: null,
};

describe("agent config store — registry binary facts", () => {
  it("archive facts round-trip through a second store over the same KV", async () => {
    const kv = new MemoryKV();
    await new AgentConfigStore(kv).upsert({
      id: "kimi" as PatchbayAgentId,
      ...base,
      registrySource: {
        registryId: "kimi",
        distributionKind: "binary",
        pinnedVersion: "1.2.3",
        binary: { archiveUrl: "https://example.test/kimi-1.2.3.tar.gz", cmd: "kimi" },
      },
    });
    const reread = new AgentConfigStore(kv).get("kimi" as PatchbayAgentId);
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
      id: "legacy" as PatchbayAgentId,
      ...base,
      registrySource: { registryId: "legacy", distributionKind: "binary", pinnedVersion: "0.9.0" },
    });
    const reread = new AgentConfigStore(kv).get("legacy" as PatchbayAgentId);
    expect(reread?.registrySource?.binary).toBeUndefined();
    expect(reread?.command).toBe("/cache/kimi/1.2.3/kimi");
  });

  it("npx records carry no archive facts either way", async () => {
    const kv = new MemoryKV();
    await new AgentConfigStore(kv).upsert({
      id: "kilo" as PatchbayAgentId,
      ...base,
      command: "npx",
      registrySource: { registryId: "kilo", distributionKind: "npx", pinnedVersion: "2.0.0" },
    });
    expect(new AgentConfigStore(kv).get("kilo" as PatchbayAgentId)?.registrySource?.binary).toBeUndefined();
  });
});

describe("agent config store — the retired process policy", () => {
  const KEY = "acpPatchbay.agents";

  it("drops the field from every stored record at load, and touches nothing else", async () => {
    const kv = new MemoryKV();
    const old = { id: "old", ...base, registrySource: null, processPolicy: "isolated" };
    // fails the schema (empty id) — still only loses the retired key
    const malformed = { id: "", processPolicy: "auto", extra: 1 };
    const current = { id: "current", ...base, registrySource: null };
    await kv.update(KEY, [old, malformed, current]);

    const store = new AgentConfigStore(kv);

    const { processPolicy: _old, ...oldKept } = old;
    const { processPolicy: _malformed, ...malformedKept } = malformed;
    expect(kv.get(KEY)).toEqual([oldKept, malformedKept, current]);
    expect(store.list().map((c) => c.id)).toEqual(["old", "current"]);
  });

  it("writes nothing when no record carries it", async () => {
    const kv = new MemoryKV();
    await kv.update(KEY, [{ id: "current", ...base, registrySource: null }]);
    const update = vi.spyOn(kv, "update");

    new AgentConfigStore(kv);

    expect(update).not.toHaveBeenCalled();
  });
});

describe("agent config store — a mode saved as its own field", () => {
  const KEY = "acpPatchbay.agents";
  const record = (id: string, defaults: unknown) => ({ id, name: id, command: "agent", args: [], defaults });

  it("is rewritten under the mode knob's id at load — an option set for that id still wins, nothing else moves", async () => {
    const kv = new MemoryKV();
    await kv.update(KEY, [
      record("a", { mode: "plan", options: { model: "opus" } }),
      record("b", { mode: "plan", options: { mode: "code" } }),
      record("c", { options: { model: "sonnet" } }),
      record("d", { mode: "" }),
    ]);
    const store = new AgentConfigStore(kv);
    const defaults = (id: string) => store.get(id as PatchbayAgentId)?.defaults;
    expect(defaults("a")).toEqual({ options: { mode: "plan", model: "opus" } });
    expect(defaults("b")).toEqual({ options: { mode: "code" } });
    expect(defaults("c")).toEqual({ options: { model: "sonnet" } });
    expect(defaults("d")).toEqual({});
    // rewritten on disk: the next load has nothing left to fold
    expect((kv.get(KEY) as { defaults: object }[]).some((r) => "mode" in r.defaults)).toBe(false);
  });
});
