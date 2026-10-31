// Export: the picked parts of the machine store, read from the real stores
// over one in-memory KV, beside the secrets their records name.
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/teardown";
import {
  exportConfiguration,
  STORED_KEYS,
  writeConfigurationFile,
  type ExportSources,
} from "../src/orchestrator/config-export";
import { AgentConfigStore } from "../src/orchestrator/stores/agent-configs";
import { ComposerKnobsStore } from "../src/orchestrator/stores/composer-knobs";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { McpServerConfigStore } from "../src/orchestrator/stores/mcp-server-configs";
import { MemorySecrets } from "../src/orchestrator/stores/mcp-server-tokens";
import { MachineRulesStore } from "../src/orchestrator/stores/permission-rules";
import { MachineWriteScopeStore } from "../src/orchestrator/stores/write-scope";
import { PreferencesStore } from "../src/orchestrator/stores/preferences";
import { SavedRootsStore } from "../src/orchestrator/stores/saved-roots";
import { SecretEnvStore } from "../src/orchestrator/stores/secret-env";
import { PRODUCT } from "../src/shared/product";
import type { ExportPart } from "../src/shared/protocol";
import type { PatchbayAgentId, PatchbayMcpServerId } from "../src/shared/ids";
import { SECRET_FAMILIES, STORAGE_KEYS } from "../src/orchestrator/stores/storage-keys";

async function machine() {
  const kv = new MemoryKV();
  const secrets = new MemorySecrets();
  const agentConfigs = new AgentConfigStore(kv);
  const composerKnobs = new ComposerKnobsStore(kv);
  const mcpServerConfigs = new McpServerConfigStore(kv);
  const preferences = new PreferencesStore(kv);
  const machineRules = new MachineRulesStore(kv);
  const machineRoots = new SavedRootsStore(kv, "machine");
  const machineWriteScope = new MachineWriteScopeStore(kv);
  const workspaceRoots = new SavedRootsStore(new MemoryKV(), "workspace");
  const agentEnv = new SecretEnvStore(secrets, SECRET_FAMILIES.agent);
  const mcpServerEnv = new SecretEnvStore(secrets, SECRET_FAMILIES.mcpServer);
  const keys: Record<string, string> = { keyed: "secret-abc", context7: "ctx-key" };

  // An id from before patchbay minted them, on a registry agent.
  await agentConfigs.add({
    id: "claude" as PatchbayAgentId,
    name: "Claude",
    command: "npx",
    args: ["@agentclientprotocol/claude-agent-acp@0.31.0"],
    autoConnect: true,
    defaults: { options: { model: "opus" } },
    origin: "claude-acp",
    link: { distributionKind: "npx", pinnedVersion: "0.31.0" },
    previous: null,
    lastSeenVersion: "0.31.0",
  });
  // A binary download: its command is a path into this machine's cache.
  await agentConfigs.add({
    id: "6f1c2a9e-3b7d-4e21-9a5f-0c8d2e4b7a13" as PatchbayAgentId,
    name: "Kimi CLI",
    command: "/home/me/.vscode-server/data/User/globalStorage/solutionsunity.acp-patchbay/bin-cache/kimi/0.3.1/kimi",
    args: ["acp"],
    autoConnect: false,
    defaults: {},
    origin: "kimi",
    previous: null,
    link: {
      distributionKind: "binary",
      pinnedVersion: "0.3.1",
      distribution: { archive: "https://example.test/kimi-0.3.1-linux-x64.tar.gz", cmd: "./kimi", args: ["acp"], env: {}, sha256: "ab".repeat(32) },
    },
    lastSeenVersion: null,
  });
  await agentConfigs.add({
    id: "bare" as PatchbayAgentId,
    name: "Bare",
    command: "bare-acp",
    args: [],
    autoConnect: false,
    defaults: {},
    origin: null,
    link: null,
    previous: null,
    lastSeenVersion: null,
  });
  await agentEnv.set("claude", { ANTHROPIC_API_KEY: "sk-1" });
  await composerKnobs.record("claude" as PatchbayAgentId, { mode: "plan" });
  await mcpServerConfigs.add({
    id: "keyed" as PatchbayMcpServerId,
    name: "Keyed",
    source: { kind: "custom-http", url: "https://example.test/mcp", authType: "header", headerName: "Authorization", valuePrefix: "Bearer " },
    routing: "auto",
    active: true,
    transport: "auto",
  });
  await mcpServerConfigs.add({
    id: "local" as PatchbayMcpServerId,
    name: "Local",
    source: { kind: "custom-stdio", command: "tool", args: ["--stdio"] },
    routing: ["claude"],
    active: false,
    transport: "auto",
  });
  await mcpServerConfigs.add({
    id: "context7" as PatchbayMcpServerId,
    name: "Context7",
    source: { kind: "catalog", catalogId: "context7", authMode: "header" },
    routing: { except: ["bare"] },
    active: true,
    transport: "bridge",
  });
  // Signed in with OAuth: nothing of its sign-in leaves.
  await mcpServerConfigs.add({
    id: "github" as PatchbayMcpServerId,
    name: "GitHub",
    source: { kind: "catalog", catalogId: "github", authMode: "oauth" },
    routing: "auto",
    active: true,
    transport: "auto",
  });
  await mcpServerEnv.set("local", { TOKEN: "t-1" });
  await preferences.set({ statsToolCalls: false, knobSource: "last-session", idleCloseMinutes: 45 });
  await machineRules.set([
    { kind: "command", pattern: "git status", verdict: "allow" },
    { kind: "command", pattern: "rm -rf *", verdict: "deny" },
  ]);
  await machineWriteScope.set([{ location: { kind: "path", path: "/home/me/.hermes" }, on: true }]);
  await machineRoots.add("/home/me/notes");
  await workspaceRoots.add("/home/me/workspace-only");

  const sources: ExportSources = {
    entries: [agentConfigs, composerKnobs, mcpServerConfigs, preferences, machineRules, machineWriteScope, machineRoots],
    agents: {
      ids: () => agentConfigs.list().map((c) => c.id),
      env: (id) => agentEnv.get(id),
    },
    mcpServers: {
      ids: () => mcpServerConfigs.list().map((c) => c.id),
      env: (id) => mcpServerEnv.get(id),
      headerKey: async (id) => keys[id],
    },
  };
  return { kv, sources };
}

const at = new Date("2026-10-13T12:00:00.000Z");
const exported = async (...parts: ExportPart[]) => exportConfiguration(new Set(parts), (await machine()).sources, at);

describe("configuration export", () => {
  it("carries every part as the machine store holds it, under the keys it is stored by, beside the secrets its records name", async () => {
    const { kv, sources } = await machine();
    const file = await exportConfiguration(new Set<ExportPart>(["agents", "mcpServers", "settings"]), sources, at);

    expect(file.patchbay).toBe("configuration");
    expect(file.patchbayVersion).toBe(PRODUCT.version);
    expect(file.exportedAt).toBe("2026-10-13T12:00:00.000Z");
    expect(file.state).toEqual({
      [STORAGE_KEYS.agents]: kv.get(STORAGE_KEYS.agents),
      [STORAGE_KEYS.lastKnobs]: kv.get(STORAGE_KEYS.lastKnobs),
      [STORAGE_KEYS.mcpServers]: kv.get(STORAGE_KEYS.mcpServers),
      [STORAGE_KEYS.preferences]: kv.get(STORAGE_KEYS.preferences),
      [STORAGE_KEYS.machineCommandRules]: kv.get(STORAGE_KEYS.machineCommandRules),
      [STORAGE_KEYS.machineWriteScope]: kv.get(STORAGE_KEYS.machineWriteScope),
      [STORAGE_KEYS.machineSavedRoots]: kv.get(STORAGE_KEYS.machineSavedRoots),
    });
    // A record with nothing secret stored has no row.
    expect(file.secrets).toEqual({
      agents: { claude: { env: { ANTHROPIC_API_KEY: "sk-1" } } },
      mcpServers: { keyed: { key: "secret-abc" }, local: { env: { TOKEN: "t-1" } }, context7: { key: "ctx-key" } },
    });
  });

  it("carries only the parts picked — no other part's entries or secrets", async () => {
    const agents = await exported("agents");
    expect(Object.keys(agents.state)).toEqual([STORAGE_KEYS.agents, STORAGE_KEYS.lastKnobs]);
    expect(Object.keys(agents.secrets)).toEqual(["agents"]);

    const servers = await exported("mcpServers");
    expect(Object.keys(servers.state)).toEqual([STORAGE_KEYS.mcpServers]);
    expect(Object.keys(servers.secrets)).toEqual(["mcpServers"]);

    const settings = await exported("settings");
    expect(Object.keys(settings.state)).toEqual([
      STORAGE_KEYS.preferences,
      STORAGE_KEYS.machineCommandRules,
      STORAGE_KEYS.machineWriteScope,
      STORAGE_KEYS.machineSavedRoots,
    ]);
    expect(settings.secrets).toEqual({});
  });

  it("never carries the workspace's own saved roots", async () => {
    const file = await exported("agents", "mcpServers", "settings");
    expect(JSON.stringify(file)).not.toContain("workspace-only");
  });

  it("an entry never written is left out, not carried empty", async () => {
    const empty = new MemoryKV();
    const file = await exportConfiguration(
      new Set<ExportPart>(["settings"]),
      {
        entries: [new PreferencesStore(empty), new MachineRulesStore(empty), new MachineWriteScopeStore(empty), new SavedRootsStore(empty, "machine")],
        agents: { ids: () => [], env: async () => ({}) },
        mcpServers: { ids: () => [], env: async () => ({}), headerKey: async () => undefined },
      },
      at,
    );
    expect(file.state).toEqual({});
  });

  it("a carried key with no store to read it from fails the export — never a file missing it", async () => {
    const { sources } = await machine();
    const withoutKnobs = { ...sources, entries: sources.entries.filter((e) => e.key !== STORAGE_KEYS.lastKnobs) };
    await expect(exportConfiguration(new Set<ExportPart>(["agents"]), withoutKnobs, at)).rejects.toThrow(
      `no store was given for ${STORAGE_KEYS.lastKnobs}`,
    );
  });

  it.skipIf(process.platform === "win32")("the file is written readable by its owner only — an existing one too", async () => {
    const dir = await tempDir("patchbay-export-");
    const path = join(dir, "config.json");
    await writeFile(path, "old", { mode: 0o644 });
    const file = await exported("agents");
    await writeConfigurationFile(path, file);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(file);
  });
});

// The Export card says what its Settings part carries — words a person
// reads, so not composed from key names; held here instead to the export's
// own key table: a key the part gains fails until the card names it.
describe("the Export card's Settings part", () => {
  it("names every stored key the part carries", async () => {
    const said: Readonly<Record<string, string>> = {
      [STORAGE_KEYS.preferences]: "preferences",
      [STORAGE_KEYS.machineCommandRules]: "command rule",
      [STORAGE_KEYS.machineWriteScope]: "file writes",
      [STORAGE_KEYS.machineSavedRoots]: "saved root",
    };
    const carried = Object.entries(STORED_KEYS).flatMap(([key, fate]) => (fate === "settings" ? [key] : []));
    expect(Object.keys(said).sort()).toEqual(carried.sort());
    const card = await readFile(new URL("../src/webview/settings/import-export.tsx", import.meta.url), "utf8");
    expect(Object.values(said).filter((words) => !card.includes(words))).toEqual([]);
  });
});
