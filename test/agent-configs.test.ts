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
    const current = { id: "current", ...base, name: "Kimi CLI 2", registrySource: null };
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

describe("agent config store — names", () => {
  const record = (id: string, name: string) => ({ id: id as PatchbayAgentId, ...base, name, registrySource: null });

  it("an add takes a free name; a write under a name another agent holds is refused, its own name is not", async () => {
    const store = new AgentConfigStore(new MemoryKV());
    expect(await store.add(record("a", "Claude"))).toBe("Claude");
    expect(await store.add(record("b", "Claude"))).toBe("Claude 2");
    await expect(store.upsert(record("b", "Claude"))).rejects.toThrow(/"Claude" is taken/);
    await store.upsert({ ...record("a", "Claude"), autoConnect: true });
    expect(store.list().map((c) => [c.id, c.name, c.autoConnect])).toEqual([
      ["a", "Claude", true],
      ["b", "Claude 2", false],
    ]);
  });
});

describe("agent config store — names shared before the rule held", () => {
  it("are told apart once at load — the first keeps its name, the next gets a number", async () => {
    const kv = new MemoryKV();
    await kv.update("acpPatchbay.agents", [
      { id: "a", ...base, name: "Claude", registrySource: null },
      { id: "b", ...base, name: "Claude", registrySource: null },
      { id: "c", ...base, name: "Claude 2", registrySource: null },
    ]);
    const store = new AgentConfigStore(kv);
    expect(store.list().map((c) => [c.id, c.name])).toEqual([
      ["a", "Claude"],
      ["b", "Claude 3"],
      ["c", "Claude 2"],
    ]);
    // every later write meets the rule — the one that used to share a name too
    await store.upsert({ ...store.get("b" as PatchbayAgentId)!, autoConnect: true });
    expect(store.get("b" as PatchbayAgentId)?.autoConnect).toBe(true);
  });
});
