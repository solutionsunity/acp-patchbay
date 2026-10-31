// The agent-config record's persisted contract (stores/agent-configs.ts):
// a registry binary's archive facts survive the schema round trip (they
// are what a later connect re-acquires the binary from), and a record
// written before that field existed still parses — it simply carries no
// archive facts and spawns its recorded command as is. A record from when
// agents carried a process policy loses that field once, at load, and one
// from when origin and link were one field is split once, at load — copied
// from the key that version kept them under, never moved off it.
import { describe, expect, it, vi } from "vitest";
import { AgentConfigStore } from "../src/orchestrator/stores/agent-configs";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import type { PatchbayAgentId } from "../src/shared/ids";
import { STORAGE_KEYS } from "../src/orchestrator/stores/storage-keys";

const base = {
  name: "Kimi CLI",
  command: "/cache/kimi/1.2.3/kimi",
  args: ["--acp"],
  autoConnect: false,
  defaults: {},
  origin: null,
  link: null,
  previous: null,
  lastSeenVersion: null,
};

describe("agent config store — registry binary facts", () => {
  it("archive facts round-trip through a second store over the same KV", async () => {
    const kv = new MemoryKV();
    await new AgentConfigStore(kv).upsert({
      id: "kimi" as PatchbayAgentId,
      ...base,
      origin: "kimi",
      link: {
        distributionKind: "binary",
        pinnedVersion: "1.2.3",
        distribution: { archive: "https://example.test/kimi-1.2.3.tar.gz", cmd: "kimi", args: ["acp"], env: {} },
      },
    });
    const reread = new AgentConfigStore(kv).get("kimi" as PatchbayAgentId);
    expect(reread?.origin).toBe("kimi");
    expect(reread?.link).toEqual({
      distributionKind: "binary",
      pinnedVersion: "1.2.3",
      distribution: { archive: "https://example.test/kimi-1.2.3.tar.gz", cmd: "kimi", args: ["acp"], env: {} },
    });
  });

  it("a record without archive facts (written before the field) parses and carries none", async () => {
    const kv = new MemoryKV();
    await new AgentConfigStore(kv).upsert({
      id: "legacy" as PatchbayAgentId,
      ...base,
      origin: "legacy",
      link: { distributionKind: "binary", pinnedVersion: "0.9.0" },
    });
    const reread = new AgentConfigStore(kv).get("legacy" as PatchbayAgentId);
    expect(reread?.link?.distribution).toBeUndefined();
    expect(reread?.command).toBe("/cache/kimi/1.2.3/kimi");
  });

  it("npx records carry no archive facts either way", async () => {
    const kv = new MemoryKV();
    await new AgentConfigStore(kv).upsert({
      id: "kilo" as PatchbayAgentId,
      ...base,
      command: "npx",
      origin: "kilo",
      link: { distributionKind: "npx", pinnedVersion: "2.0.0" },
    });
    expect(new AgentConfigStore(kv).get("kilo" as PatchbayAgentId)?.link?.distribution).toBeUndefined();
  });
});

describe("agent config store — an archive kept before the recipe", () => {
  const KEY = STORAGE_KEYS.agents;

  it("moves to the recipe at load under the registry's names — args and env stay unknown, nothing else moves", async () => {
    const kv = new MemoryKV();
    const { origin: _o, link: _l, previous: _p, ...unsplit } = base;
    const npx = { id: "npx", ...unsplit, name: "npx", registrySource: { registryId: "kilo", distributionKind: "npx", pinnedVersion: "2.0.0" } };
    await kv.update(KEY, [
      {
        id: "kimi",
        ...unsplit,
        registrySource: {
          registryId: "kimi",
          distributionKind: "binary",
          pinnedVersion: "1.2.3",
          binary: { archiveUrl: "https://example.test/kimi-1.2.3.tar.gz", cmd: "kimi", sha256: "ab".repeat(32) },
        },
      },
      npx,
    ]);
    const store = new AgentConfigStore(kv);
    expect(store.get("kimi" as PatchbayAgentId)?.link).toEqual({
      distributionKind: "binary",
      pinnedVersion: "1.2.3",
      distribution: { archive: "https://example.test/kimi-1.2.3.tar.gz", cmd: "kimi", sha256: "ab".repeat(32) },
    });
    // only split, nothing of it moved
    const { registrySource: { registryId, ...link }, ...rest } = npx;
    expect((kv.get(KEY) as unknown[])[1]).toEqual({ ...rest, origin: registryId, link });
    // rewritten on disk: the next load has nothing left to move
    const update = vi.spyOn(kv, "update");
    new AgentConfigStore(kv);
    expect(update).not.toHaveBeenCalled();
  });
});

// Every window on a machine shares its store, and one not yet reloaded
// after an update still runs the version before — which writes back only
// the fields it knows. The current shape lives under its own key, so an
// older window's writes can strip nothing from it.
describe("agent config store — the key an earlier version still writes", () => {
  const { origin: _o, link: _l, previous: _p, ...unsplit } = base;
  const earlier = [
    { id: "kilo", ...unsplit, name: "Kilo", registrySource: { registryId: "kilo", distributionKind: "npx", pinnedVersion: "2.0.0" } },
  ];

  it("copies the earlier records once, in the current shape, and leaves the earlier key as it was", async () => {
    const kv = new MemoryKV();
    await kv.update(STORAGE_KEYS.agentsBefore090, earlier);
    const store = new AgentConfigStore(kv);
    expect(store.get("kilo" as PatchbayAgentId)).toMatchObject({ origin: "kilo", link: { pinnedVersion: "2.0.0" } });
    expect(kv.get(STORAGE_KEYS.agentsBefore090)).toEqual(earlier);
  });

  it("an older window's write afterwards — its records stripped of what it doesn't know — reaches nothing here", async () => {
    const kv = new MemoryKV();
    await kv.update(STORAGE_KEYS.agentsBefore090, earlier);
    new AgentConfigStore(kv);
    await kv.update(STORAGE_KEYS.agentsBefore090, [{ ...earlier[0], registrySource: null, lastSeenVersion: "2.0.0" }]);
    expect(new AgentConfigStore(kv).get("kilo" as PatchbayAgentId)).toMatchObject({ origin: "kilo", link: { pinnedVersion: "2.0.0" } });
  });

  it("erasing every record erases the earlier copy too", async () => {
    const kv = new MemoryKV();
    await kv.update(STORAGE_KEYS.agentsBefore090, earlier);
    await new AgentConfigStore(kv).wipe();
    expect(kv.get(STORAGE_KEYS.agents)).toBeUndefined();
    expect(kv.get(STORAGE_KEYS.agentsBefore090)).toBeUndefined();
  });
});

describe("agent config store — the retired process policy", () => {
  const KEY = STORAGE_KEYS.agents;

  it("drops the field from every stored record at load, and touches nothing else", async () => {
    const kv = new MemoryKV();
    const old = { id: "old", ...base, processPolicy: "isolated" };
    // fails the schema (empty id) — still only loses the retired key
    const malformed = { id: "", processPolicy: "auto", extra: 1 };
    const current = { id: "current", ...base, name: "Kimi CLI 2" };
    await kv.update(KEY, [old, malformed, current]);

    const store = new AgentConfigStore(kv);

    const { processPolicy: _old, ...oldKept } = old;
    const { processPolicy: _malformed, ...malformedKept } = malformed;
    expect(kv.get(KEY)).toEqual([oldKept, malformedKept, current]);
    expect(store.list().map((c) => c.id)).toEqual(["old", "current"]);
  });

  it("writes nothing when no record carries it", async () => {
    const kv = new MemoryKV();
    await kv.update(KEY, [{ id: "current", ...base }]);
    const update = vi.spyOn(kv, "update");

    new AgentConfigStore(kv);

    expect(update).not.toHaveBeenCalled();
  });
});

describe("agent config store — a mode saved as its own field", () => {
  const KEY = STORAGE_KEYS.agents;
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
  const record = (id: string, name: string) => ({ id: id as PatchbayAgentId, ...base, name });

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
    await kv.update(STORAGE_KEYS.agents, [
      { id: "a", ...base, name: "Claude" },
      { id: "b", ...base, name: "Claude" },
      { id: "c", ...base, name: "Claude 2" },
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

describe("agent config store — origin and link, once one field", () => {
  const KEY = STORAGE_KEYS.agents;
  const { origin: _o, link: _l, previous: _p, ...unsplit } = base;
  const recipe = { package: "@kilo/acp@2.0.0", args: [], env: {} };

  it("splits at load: the registry id becomes the origin, the rest the link — an edited agent stays custom, its id never read as an origin", async () => {
    const kv = new MemoryKV();
    await kv.update(KEY, [
      { id: "linked", ...unsplit, name: "Linked", registrySource: { registryId: "kilo", distributionKind: "npx", pinnedVersion: "2.0.0", distribution: recipe } },
      // edited before the split: the edit dropped its source whole
      { id: "claude-acp", ...unsplit, name: "Edited", registrySource: null },
      // a source without its registry id, written by hand: nothing to keep
      { id: "handmade", ...unsplit, name: "Handmade", registrySource: { distributionKind: "npx", pinnedVersion: "1.0.0" } },
      // fails the schema (empty id) — only split, nothing else touched
      { id: "", registrySource: { registryId: "kilo", distributionKind: "npx", pinnedVersion: "1.0.0" }, extra: 1 },
    ]);

    const store = new AgentConfigStore(kv);

    expect(store.get("linked" as PatchbayAgentId)).toMatchObject({
      origin: "kilo",
      link: { distributionKind: "npx", pinnedVersion: "2.0.0", distribution: recipe },
      previous: null,
    });
    expect(store.get("claude-acp" as PatchbayAgentId)).toMatchObject({ origin: null, link: null, previous: null });
    expect(store.get("handmade" as PatchbayAgentId)).toMatchObject({ origin: null, link: null });
    expect((kv.get(KEY) as unknown[])[3]).toEqual({ id: "", origin: "kilo", link: { distributionKind: "npx", pinnedVersion: "1.0.0" }, extra: 1 });
    // rewritten on disk: the next load has nothing left to split
    expect((kv.get(KEY) as object[]).some((r) => "registrySource" in r)).toBe(false);
    const update = vi.spyOn(kv, "update");
    new AgentConfigStore(kv);
    expect(update).not.toHaveBeenCalled();
  });
});
