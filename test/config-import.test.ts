// Import's read: a file another patchbay exported, read through this
// version's own stores — what reads, what the file carries, and what it
// holds that didn't read, named.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isNewer, readConfiguration, type ConfigurationRead } from "../src/orchestrator/config-import";
import { MODE_KNOB_ID } from "../src/orchestrator/knobs";
import { PRODUCT } from "../src/shared/product";
import { STORAGE_KEYS } from "../src/orchestrator/stores/storage-keys";

const read = (file: unknown): ConfigurationRead => {
  const outcome = readConfiguration(JSON.stringify(file));
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.read;
};

const agent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Agent ${id}`,
  command: "agent-acp",
  args: [],
  autoConnect: false,
  defaults: {},
  origin: null,
  link: null,
  previous: null,
  lastSeenVersion: null,
  ...over,
});

describe("reading a configuration file", () => {
  // The first file export wrote (2026-10-13, a build before the export's
  // release, so it names 0.86.0), kept as written. Whatever changes a
  // store's shape migrates what that store already holds; this holds the
  // same migration to every file already exported.
  it("the first exported file still reads whole: every part, every record, every secret, nothing unread", async () => {
    const text = await readFile(fileURLToPath(new URL("./goldens/configuration.2026-10-13.json", import.meta.url)), "utf8");
    const outcome = readConfiguration(text);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const r = outcome.read;
    expect(r.unread).toEqual([]);
    expect([...r.parts].sort()).toEqual(["agents", "mcpServers", "settings"]);
    expect(r.patchbayVersion).toBe("0.86.0");
    expect(r.exportedAt).toBe("2026-10-13T12:00:00.000Z");
    expect(r.agents.map((a) => a.id)).toEqual(["claude", "6f1c2a9e-3b7d-4e21-9a5f-0c8d2e4b7a13", "bare"]);
    // written before origin and link were two fields: each record split
    expect(r.agents.map((a) => a.origin)).toEqual(["claude-acp", "kimi", null]);
    expect(r.agents[0]?.link).toEqual({ distributionKind: "npx", pinnedVersion: "0.31.0" });
    expect(r.agents[1]?.link).toMatchObject({ distributionKind: "binary", pinnedVersion: "0.3.1", distribution: { cmd: "./kimi" } });
    expect(r.agents[2]?.link).toBeNull();
    expect(r.knobs).toEqual({ claude: { mode: "plan" } });
    expect(r.mcpServers.map((s) => [s.id, s.source.kind])).toEqual([
      ["keyed", "custom-http"],
      ["local", "custom-stdio"],
      ["context7", "catalog"],
      ["github", "catalog"],
    ]);
    expect(r.preferences).toMatchObject({ knobSource: "last-session", idleCloseMinutes: 45 });
    // Retired since the file was written: read past, not reported unread.
    expect(r.preferences).not.toHaveProperty("statsPrompts");
    // Written before rules had kinds: each reads as the command rule it was.
    expect(r.machineCommandRules).toEqual([
      { kind: "command", pattern: "git status", verdict: "allow" },
      { kind: "command", pattern: "rm -rf *", verdict: "deny" },
    ]);
    expect(r.machineSavedRoots).toEqual(["/home/me/notes"]);
    expect(r.secrets).toEqual({
      agents: { claude: { ANTHROPIC_API_KEY: "sk-1" } },
      mcpServers: { keyed: { env: {}, key: "secret-abc" }, local: { env: { TOKEN: "t-1" } }, context7: { env: {}, key: "ctx-key" } },
    });
  });

  it("refuses what isn't a configuration it can read, saying why", () => {
    expect(readConfiguration("{ not json")).toEqual({ ok: false, reason: "The file isn't JSON." });
    for (const file of [[], { patchbay: "something else", state: {} }, { state: {} }, null]) {
      expect(readConfiguration(JSON.stringify(file))).toEqual({ ok: false, reason: "This isn't a patchbay configuration file." });
    }
    expect(readConfiguration(JSON.stringify({ patchbay: "configuration", state: [] }))).toEqual({
      ok: false,
      reason: "The file's configuration can't be read.",
    });
    expect(readConfiguration(JSON.stringify({ patchbay: "configuration", state: {}, secrets: {} }))).toEqual({
      ok: false,
      reason: "The file holds nothing to import.",
    });
  });

  it("carries only the parts the file holds — an export of agents with none still carries the part", () => {
    expect([...read({ patchbay: "configuration", state: {}, secrets: { agents: {} } }).parts]).toEqual(["agents"]);
    expect([...read({ patchbay: "configuration", state: { [STORAGE_KEYS.preferences]: { soundOnDone: true } }, secrets: {} }).parts]).toEqual([
      "settings",
    ]);
  });

  it("a file from a newer patchbay reads, marked newer; one naming no version is never newer", () => {
    const base = { patchbay: "configuration", state: { [STORAGE_KEYS.machineSavedRoots]: ["/a"] } };
    expect(read({ ...base, patchbayVersion: "99.0.0" }).newer).toBe(true);
    expect(read({ ...base, patchbayVersion: PRODUCT.version }).newer).toBe(false);
    expect(read({ ...base, patchbayVersion: "0.1.0" }).newer).toBe(false);
    const unnamed = read(base);
    expect([unnamed.patchbayVersion, unnamed.newer]).toEqual([null, false]);
  });

  it("an older shape reads through the stores' own migrations", () => {
    const r = read({
      patchbay: "configuration",
      state: {
        [STORAGE_KEYS.agents]: [agent("a", { defaults: { mode: "plan" }, processPolicy: "per-session" })],
        [STORAGE_KEYS.mcpServers]: [
          { id: "s", name: "GitHub", source: { kind: "registry", registryId: "github", authMode: "oauth" }, routing: "auto", active: true, transport: "auto" },
        ],
        [STORAGE_KEYS.preferences]: { composerStats: false },
      },
    });
    expect(r.unread).toEqual([]);
    expect(r.agents[0]?.defaults).toEqual({ options: { [MODE_KNOB_ID]: "plan" } });
    expect(r.agents[0]).not.toHaveProperty("processPolicy");
    expect(r.mcpServers[0]?.source).toEqual({ kind: "catalog", catalogId: "github", authMode: "oauth" });
    expect(r.preferences).toEqual({ statsToolCalls: false, statsContext: false, statsPlanUsage: false });
  });

  it("names what it holds that didn't read — never dropped in silence — and reads the rest", () => {
    const r = read({
      patchbay: "configuration",
      state: {
        [STORAGE_KEYS.agents]: [agent("a"), { id: "b" }, "c"],
        [STORAGE_KEYS.lastKnobs]: { a: { mode: "plan" }, b: "plan" },
        [STORAGE_KEYS.preferences]: { soundOnDone: true, knobSource: "sometimes", laterPreference: 1 },
        [STORAGE_KEYS.machineCommandRules]: [{ pattern: "ls", verdict: "allow" }, { pattern: "x", verdict: "maybe" }],
        [STORAGE_KEYS.machineWriteScope]: [{ location: { kind: "temp" }, on: true }, { location: { kind: "path", path: "rel" }, on: true }],
        [STORAGE_KEYS.machineSavedRoots]: ["/a", 7],
        "acpPatchbay.laterThing": { x: 1 },
        [STORAGE_KEYS.usedCapabilities]: [],
      },
      secrets: {
        agents: { a: { env: { K: "v" } }, b: { env: { K: "v" } }, z: "nope" },
        mcpServers: { s: { key: "k" } },
      },
    });
    expect(r.agents.map((a) => a.id)).toEqual(["a"]);
    expect(r.knobs).toEqual({ a: { mode: "plan" } });
    expect(r.preferences).toEqual({ soundOnDone: true });
    expect(r.machineCommandRules).toEqual([{ kind: "command", pattern: "ls", verdict: "allow" }]);
    expect(r.machineWriteScope).toEqual([{ location: { kind: "temp" }, on: true }]);
    expect(r.machineSavedRoots).toEqual(["/a"]);
    expect(r.secrets).toEqual({ agents: { a: { K: "v" } }, mcpServers: {} });
    expect(r.unread).toEqual([
      "an entry this version doesn't carry (acpPatchbay.laterThing)",
      `an entry this version doesn't carry (${STORAGE_KEYS.usedCapabilities})`,
      "2 agents",
      "composer choices for 1 agent",
      "2 preferences",
      "1 command rule",
      "1 file-write place",
      "1 saved root",
      "the env values of an agent the file doesn't carry as one (b)",
      "the env values of an agent the file doesn't carry as one (z)",
      "the secrets of an MCP server the file doesn't carry as one (s)",
    ]);
  });
});

describe("a file's keys are data, never names to look up", () => {
  // JSON text, not an object literal: only parsed text makes `__proto__`
  // a key of its own, as a file can.
  it("a key named like an object's own machinery is an entry this version doesn't carry", () => {
    const keys = ["__proto__", "constructor", "toString", "hasOwnProperty"];
    const state = `{${keys.map((k) => `"${k}": { "polluted": true }`).join(", ")}, "${STORAGE_KEYS.preferences}": { "soundOnDone": true }}`;
    const outcome = readConfiguration(`{"patchbay": "configuration", "state": ${state}}`);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.read.unread).toEqual(keys.map((k) => `an entry this version doesn't carry (${k})`));
    expect(outcome.read.preferences).toEqual({ soundOnDone: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("isNewer", () => {
  it("orders by numbered parts; what doesn't read as a version is never newer", () => {
    expect(isNewer("0.88.0", "0.86.0")).toBe(true);
    expect(isNewer("0.86.1", "0.86.0")).toBe(true);
    expect(isNewer("1.0.0", "0.99.9")).toBe(true);
    expect(isNewer("0.86.0", "0.86.0")).toBe(false);
    expect(isNewer("0.84.4", "0.86.0")).toBe(false);
    expect(isNewer("0.100.0", "0.99.0")).toBe(true);
    expect(isNewer("next", "0.86.0")).toBe(false);
  });
});
