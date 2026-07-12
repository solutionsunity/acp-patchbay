// P18 gate (store half): the erase sweep leaves factory state — every
// record store empty (strays included), every secret the config lists name
// deleted, rules back to built-ins, file stores gone. Real stores over
// MemoryKV/MemorySecrets and a real temp dir; only vscode itself is absent.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eraseAllData } from "../src/orchestrator/erase-all";
import { AgentConfigStore } from "../src/orchestrator/stores/agent-configs";
import { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
import { IntegrationConfigStore } from "../src/orchestrator/stores/integration-configs";
import { IntegrationTokenStore, MemorySecrets } from "../src/orchestrator/stores/integration-tokens";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { LastActiveSessionStore } from "../src/orchestrator/stores/last-active-session";
import { LastConnectedStore } from "../src/orchestrator/stores/last-connected";
import { ComposerKnobsStore } from "../src/orchestrator/stores/composer-knobs";
import { PreferencesStore } from "../src/orchestrator/stores/preferences";
import { DEFAULT_PREFERENCES } from "../src/shared/protocol";
import { DEFAULT_PERMISSION_RULES, MachineRulesStore, PermissionRulesStore } from "../src/orchestrator/stores/permission-rules";
import { SecretEnvStore } from "../src/orchestrator/stores/secret-env";
import { SpawnRegistryStore } from "../src/orchestrator/stores/spawn-registry";
import { UsedCapabilityStore } from "../src/orchestrator/stores/used-capabilities";
import { matrixFromDeclared } from "../src/orchestrator/capabilities";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "patchbay-erase-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("eraseAllData", () => {
  it("leaves factory state: records, secrets, rules, files — strays included", async () => {
    const globalKv = new MemoryKV();
    const workspaceKv = new MemoryKV();
    const secrets = new MemorySecrets();

    const agentConfigs = new AgentConfigStore(globalKv);
    const integrationConfigs = new IntegrationConfigStore(globalKv);
    const usedCapabilities = new UsedCapabilityStore(globalKv);
    const spawnRegistry = new SpawnRegistryStore(globalKv);
    const agentEnv = new SecretEnvStore(secrets, "acpPatchbay.agent");
    const integrationEnv = new SecretEnvStore(secrets, "acpPatchbay.integration");
    const integrationTokens = new IntegrationTokenStore(secrets);
    const permissionRules = new PermissionRulesStore(workspaceKv);
    const machineRules = new MachineRulesStore(globalKv);
    const decisionAudit = new DecisionAuditStore(dir);
    const lastConnected = new LastConnectedStore(workspaceKv);
    const lastActiveSession = new LastActiveSessionStore(workspaceKv);
    const preferences = new PreferencesStore(globalKv);
    const composerKnobs = new ComposerKnobsStore(globalKv);

    // A lived-in install.
    await agentConfigs.upsert({ id: "claude", name: "Claude", command: "claude-code-acp", args: [], processPolicy: "auto", autoConnect: true, defaults: {}, registrySource: null, lastSeenVersion: "1.0.0" });
    await agentEnv.set("claude", { ANTHROPIC_API_KEY: "sk-secret" });
    await integrationConfigs.upsert({ id: "github", name: "GitHub", source: { kind: "registry", registryId: "github", authMode: "header" }, routing: "auto", active: true, transport: "auto" });
    await integrationEnv.set("github", { GITHUB_PAT: "ghp-secret" });
    await integrationTokens.set("github", { accessToken: "gho-secret" });
    await usedCapabilities.save("claude", "1.0.0", matrixFromDeclared({ loadSession: true, sessionFork: false, sessionResume: false, sessionList: false, sessionDelete: false, sessionClose: false, promptImage: false, promptAudio: false, promptEmbeddedContext: false, mcpHttp: false, mcpSse: false, authMethods: [], authLogout: false, sessionAdditionalDirectories: false }));
    // A stray from a removed agent — no config left, must still go.
    await usedCapabilities.save("ghost", "0.1.0", matrixFromDeclared({ loadSession: false, sessionFork: false, sessionResume: false, sessionList: false, sessionDelete: false, sessionClose: false, promptImage: false, promptAudio: false, promptEmbeddedContext: false, mcpHttp: false, mcpSse: false, authMethods: [], authLogout: false, sessionAdditionalDirectories: false }));
    await spawnRegistry.add(4242, "node agent.js", "agent");
    await permissionRules.set({ commandRules: [{ pattern: "npm *", verdict: "allow" }], fileWriteScope: "always-ask" });
    await machineRules.set([{ pattern: "git status", verdict: "allow" }]);
    await decisionAudit.append({ kind: "permission", decision: "allow" });
    await lastConnected.write(["claude"]);
    await lastActiveSession.set("s1");
    await preferences.set({ soundOnDone: true, idleCloseMinutes: 15 });
    await composerKnobs.record("claude", { mode: "code" });

    await eraseAllData({
      agentConfigs, integrationConfigs, usedCapabilities,
      spawnRegistry, agentEnv, integrationEnv,
      integrationTokens, permissionRules, machineRules: machineRules,
      decisionAudit, lastConnected, lastActiveSession,
      preferences, composerKnobs,
    });

    expect(agentConfigs.list()).toEqual([]);
    expect(integrationConfigs.list()).toEqual([]);
    expect(usedCapabilities.list()).toEqual([]); // ghost gone too
    expect(spawnRegistry.list()).toEqual([]);
    expect(await agentEnv.get("claude")).toEqual({});
    expect(await integrationEnv.get("github")).toEqual({});
    expect(await integrationTokens.get("github")).toBeNull();
    expect(permissionRules.get()).toEqual(DEFAULT_PERMISSION_RULES);
    expect(machineRules.get()).toEqual({ commandRules: [] });
    expect(await decisionAudit.tail(5)).toEqual([]);
    expect(await lastConnected.consume()).toEqual([]);
    expect(lastActiveSession.get()).toBeUndefined();
    expect(preferences.get()).toEqual(DEFAULT_PREFERENCES);
    expect(composerKnobs.get("claude")).toBeUndefined();
    expect(composerKnobs.count()).toBe(0);
    await expect(stat(join(dir, "decision-audit.jsonl"))).rejects.toThrow();
  });
});
