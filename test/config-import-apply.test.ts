// Landing an import through the real stores: what the user ticked lands on
// the id the plan matched, whole, with what only this machine knows kept.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readConfiguration, type ConfigurationRead } from "../src/orchestrator/config-import";
import { applyImport, type ImportTargets } from "../src/orchestrator/config-import-apply";
import { localConfiguration, planImport } from "../src/orchestrator/config-import-plan";
import { AgentConfigStore } from "../src/orchestrator/stores/agent-configs";
import { ComposerKnobsStore } from "../src/orchestrator/stores/composer-knobs";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { authTypeOf, McpServerConfigStore } from "../src/orchestrator/stores/mcp-server-configs";
import { McpServerTokenStore, MemorySecrets } from "../src/orchestrator/stores/mcp-server-tokens";
import { MachineRulesStore } from "../src/orchestrator/stores/permission-rules";
import { PreferencesStore } from "../src/orchestrator/stores/preferences";
import { SavedRootsStore } from "../src/orchestrator/stores/saved-roots";
import { MachineWriteScopeStore } from "../src/orchestrator/stores/write-scope";
import { SecretEnvStore } from "../src/orchestrator/stores/secret-env";
import type { PatchbayAgentId, PatchbayMcpServerId } from "../src/shared/ids";
import { SECRET_FAMILIES } from "../src/orchestrator/stores/storage-keys";

async function golden(): Promise<ConfigurationRead> {
  const text = await readFile(fileURLToPath(new URL("./goldens/configuration.2026-10-13.json", import.meta.url)), "utf8");
  const outcome = readConfiguration(text);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.read;
}

/** A machine of real stores, and what resolving a download here does. */
function machine(resolves = true) {
  const kv = new MemoryKV();
  const secrets = new MemorySecrets();
  const resolved: string[] = [];
  const stores = {
    agentConfigs: new AgentConfigStore(kv),
    agentEnv: new SecretEnvStore(secrets, SECRET_FAMILIES.agent),
    composerKnobs: new ComposerKnobsStore(kv),
    mcpServerConfigs: new McpServerConfigStore(kv),
    mcpServerEnv: new SecretEnvStore(secrets, SECRET_FAMILIES.mcpServer),
    mcpServerTokens: new McpServerTokenStore(secrets),
    preferences: new PreferencesStore(kv),
    machineRules: new MachineRulesStore(kv),
    machineWriteScope: new MachineWriteScopeStore(kv),
    machineSavedRoots: new SavedRootsStore(kv, "machine"),
  };
  const targets: ImportTargets = {
    ...stores,
    resolveHere: async (id) => (resolved.push(id), resolves),
  };
  const local = () =>
    localConfiguration({
      ...stores,
      // As McpServersStore reads it: a header server's key only.
      headerKey: async (id) => {
        const server = stores.mcpServerConfigs.get(id as PatchbayMcpServerId);
        if (server === undefined || authTypeOf(server.source) !== "header") return undefined;
        return (await stores.mcpServerTokens.get(id as PatchbayMcpServerId))?.accessToken;
      },
    });
  return { stores, targets, local, resolved };
}

const here = { commandFound: () => true, pathExists: () => true };

describe("landing an import", () => {
  it("on an empty machine, every ticked item lands with its secrets; a download is resolved for this machine", async () => {
    const read = await golden();
    const m = machine();
    const plan = planImport(read, await m.local(), here);
    const outcome = await applyImport(read, plan, new Set(plan.items.map((i) => i.id)), m.targets);

    expect(outcome).toEqual({ landed: 11, failures: [] });
    expect(m.stores.agentConfigs.list().map((a) => a.id)).toEqual(read.agents.map((a) => a.id));
    expect(await m.stores.agentEnv.get("claude")).toEqual({ ANTHROPIC_API_KEY: "sk-1" });
    expect(m.stores.composerKnobs.get("claude" as PatchbayAgentId)).toEqual({ mode: "plan" });
    expect(m.resolved).toEqual(["6f1c2a9e-3b7d-4e21-9a5f-0c8d2e4b7a13"]);
    // The version an agent last answered with is this machine's to learn.
    expect(m.stores.agentConfigs.get("claude" as PatchbayAgentId)?.lastSeenVersion).toBeNull();
    expect((await m.stores.mcpServerTokens.get("keyed" as PatchbayMcpServerId))?.accessToken).toBe("secret-abc");
    expect(await m.stores.mcpServerTokens.get("github" as PatchbayMcpServerId)).toBeNull();
    expect(await m.stores.mcpServerEnv.get("local")).toEqual({ TOKEN: "t-1" });
    expect(m.stores.preferences.get()).toMatchObject({ knobSource: "last-session", idleCloseMinutes: 45 });
    expect(m.stores.machineRules.get().commandRules).toEqual(read.machineCommandRules);
    expect(m.stores.machineSavedRoots.list()).toEqual(["/home/me/notes"]);
  });

  // #129: a way back names a recipe — a downloaded one names the exporting
  // machine's build, never this one's.
  it("a downloaded way back stays on the machine it names; a package's travels", async () => {
    const read = await golden();
    const binaryBack = { distributionKind: "binary" as const, pinnedVersion: "0.3.0", distribution: { archive: "https://example.test/kimi-0.3.0-linux-x64.tar.gz", cmd: "./kimi" } };
    const npxBack = { distributionKind: "npx" as const, pinnedVersion: "0.30.0", distribution: { package: "@agentclientprotocol/claude-agent-acp@0.30.0", args: [], env: {} } };
    const carried = {
      ...read,
      agents: read.agents.map((a) =>
        a.id === "claude" ? { ...a, previous: npxBack } : a.link?.distributionKind === "binary" ? { ...a, previous: binaryBack } : a,
      ),
    };
    const m = machine();
    const plan = planImport(carried, await m.local(), here);
    await applyImport(carried, plan, new Set(plan.items.map((i) => i.id)), m.targets);
    expect(m.stores.agentConfigs.get("claude" as PatchbayAgentId)?.previous).toEqual(npxBack);
    expect(m.stores.agentConfigs.get("6f1c2a9e-3b7d-4e21-9a5f-0c8d2e4b7a13" as PatchbayAgentId)?.previous).toBeNull();
  });

  it("only what is ticked lands — and an unchanged item is never rewritten", async () => {
    const read = await golden();
    const m = machine();
    const plan = planImport(read, await m.local(), here);
    const outcome = await applyImport(read, plan, new Set(["agent:bare", "savedRoot:/home/me/notes", "nothing:here"]), m.targets);
    expect(outcome.landed).toBe(2);
    expect(m.stores.agentConfigs.list().map((a) => a.id)).toEqual(["bare"]);
    expect(m.stores.mcpServerConfigs.list()).toEqual([]);
  });

  it("a matched agent is replaced whole on this machine's id, keeping the version it last answered with", async () => {
    const read = await golden();
    const m = machine();
    const theirs = read.agents.find((a) => a.id === "claude")!;
    await m.stores.agentConfigs.add({ ...theirs, id: "local-claude" as PatchbayAgentId, autoConnect: false, lastSeenVersion: "0.30.0" });
    await m.stores.agentEnv.set("local-claude", { OLD: "1" });
    await m.stores.composerKnobs.record("local-claude" as PatchbayAgentId, { mode: "code" });
    const plan = planImport(read, await m.local(), here);
    await applyImport(read, plan, new Set(["agent:claude"]), m.targets);

    expect(m.stores.agentConfigs.list().map((a) => [a.id, a.autoConnect, a.lastSeenVersion])).toEqual([["local-claude", true, "0.30.0"]]);
    expect(await m.stores.agentEnv.get("local-claude")).toEqual({ ANTHROPIC_API_KEY: "sk-1" });
    expect(m.stores.composerKnobs.get("local-claude" as PatchbayAgentId)).toEqual({ mode: "plan" });
  });

  it("a server's routing lands on the ids its agents landed on; a sign-in stays with an unchanged connection", async () => {
    const read = await golden();
    const m = machine();
    const claude = read.agents.find((a) => a.id === "claude")!;
    const github = read.mcpServers.find((s) => s.id === "github")!;
    await m.stores.agentConfigs.add({ ...claude, id: "local-claude" as PatchbayAgentId });
    await m.stores.mcpServerConfigs.add({ ...github, active: false });
    await m.stores.mcpServerTokens.set("github" as PatchbayMcpServerId, { accessToken: "signed-in-here" });
    const plan = planImport(read, await m.local(), here);
    await applyImport(read, plan, new Set(["mcpServer:local", "mcpServer:github"]), m.targets);

    expect(m.stores.mcpServerConfigs.get("local" as PatchbayMcpServerId)?.routing).toEqual(["local-claude"]);
    expect(m.stores.mcpServerConfigs.get("github" as PatchbayMcpServerId)?.active).toBe(true);
    expect((await m.stores.mcpServerTokens.get("github" as PatchbayMcpServerId))?.accessToken).toBe("signed-in-here");
  });

  it("a rule replaces its pattern's verdict in place or joins the list; this machine's other rules stay", async () => {
    const read = await golden();
    const m = machine();
    await m.stores.machineRules.set([
      { kind: "command", pattern: "ls", verdict: "allow" },
      { kind: "command", pattern: "git status", verdict: "ask" },
    ]);
    const plan = planImport(read, await m.local(), here);
    await applyImport(read, plan, new Set(["commandRule:command:git status", "commandRule:command:rm -rf *"]), m.targets);
    expect(m.stores.machineRules.get().commandRules).toEqual([
      { kind: "command", pattern: "ls", verdict: "allow" },
      { kind: "command", pattern: "git status", verdict: "allow" },
      { kind: "command", pattern: "rm -rf *", verdict: "deny" },
    ]);
  });

  it("a file-write place's answer lands in its place or joins the list; this machine's other places stay", async () => {
    const hermes = { kind: "path", path: "/home/me/.hermes" } as const;
    const read: ConfigurationRead = {
      ...(await golden()),
      machineWriteScope: [{ location: { kind: "temp" }, on: true }, { location: hermes, on: true }],
    };
    const m = machine();
    await m.stores.machineWriteScope.set([{ location: { kind: "path", path: "/srv/infra" }, on: true }, { location: { kind: "temp" }, on: false }]);
    const plan = planImport(read, await m.local(), here);
    await applyImport(read, plan, new Set(["writeLocation:temp", "writeLocation:/home/me/.hermes"]), m.targets);
    expect(m.stores.machineWriteScope.get()).toEqual([
      { location: { kind: "path", path: "/srv/infra" }, on: true },
      { location: { kind: "temp" }, on: true },
      { location: hermes, on: true },
    ]);
  });

  it("says what didn't land, or landed with a word to say — and lands the rest", async () => {
    const read = await golden();
    const m = machine(false);
    // Another agent here already holds the name the file gives "bare".
    await m.stores.agentConfigs.add({ ...read.agents.find((a) => a.id === "bare")!, id: "other" as PatchbayAgentId, name: "Agent X" });
    const renamed: ConfigurationRead = { ...read, agents: read.agents.map((a) => (a.id === "bare" ? { ...a, name: "Agent X" } : a)) };
    // Matched by id, then renamed in the file to a name another agent here holds.
    await m.stores.agentConfigs.add({ ...read.agents.find((a) => a.id === "claude")!, name: "Claude" });
    const clash: ConfigurationRead = { ...renamed, agents: renamed.agents.map((a) => (a.id === "claude" ? { ...a, name: "Agent X" } : a)) };
    const plan = planImport(clash, await m.local(), here);
    const outcome = await applyImport(clash, plan, new Set(plan.items.filter((i) => i.kind === "agent").map((i) => i.id)), m.targets);

    expect(outcome.failures).toEqual([
      expect.stringMatching(/^Agent X: /),
      "Kimi CLI: the registry has no download of it for this machine — it stays as the file had it",
    ]);
    expect(outcome.landed).toBe(1);
    expect(m.stores.agentConfigs.get("6f1c2a9e-3b7d-4e21-9a5f-0c8d2e4b7a13" as PatchbayAgentId)).toBeDefined();
  });
});
