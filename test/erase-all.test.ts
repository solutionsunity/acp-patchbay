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
import { LastConnectedStore } from "../src/orchestrator/stores/last-connected";
import { LastKnownViewStore } from "../src/orchestrator/stores/last-known-view";
import { DEFAULT_PERMISSION_RULES, MachineRulesStore, PermissionRulesStore } from "../src/orchestrator/stores/permission-rules";
import { SecretEnvStore } from "../src/orchestrator/stores/secret-env";
import { SessionIndexStore } from "../src/orchestrator/stores/session-index";
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
    const sessionIndex = new SessionIndexStore(workspaceKv);
    const agentEnv = new SecretEnvStore(secrets, "acpPatchbay.agent");
    const integrationEnv = new SecretEnvStore(secrets, "acpPatchbay.integration");
    const integrationTokens = new IntegrationTokenStore(secrets);
    const permissionRules = new PermissionRulesStore(workspaceKv);
    const machineRules = new MachineRulesStore(globalKv);
    const decisionAudit = new DecisionAuditStore(dir);
    const lastKnownView = new LastKnownViewStore(dir);
    const lastConnected = new LastConnectedStore(workspaceKv);

    // A lived-in install.
    await agentConfigs.upsert({ id: "claude", name: "Claude", command: "claude-code-acp", args: [], processPolicy: "auto", autoConnect: true, defaults: {}, registrySource: null, lastSeenVersion: "1.0.0" });
    await agentEnv.set("claude", { ANTHROPIC_API_KEY: "sk-secret" });
    await integrationConfigs.upsert({ id: "github", name: "GitHub", source: { kind: "registry", registryId: "github", authMode: "header" }, routing: "auto", active: true });
    await integrationEnv.set("github", { GITHUB_PAT: "ghp-secret" });
    await integrationTokens.set("github", { accessToken: "gho-secret" });
    await usedCapabilities.save("claude", "1.0.0", matrixFromDeclared({ loadSession: true, sessionFork: false, sessionResume: false, sessionList: false, sessionClose: false, promptImage: false, promptAudio: false, promptEmbeddedContext: false, mcpHttp: false, mcpSse: false, authMethods: [] }));
    // A stray from a removed agent — no config left, must still go.
    await usedCapabilities.save("ghost", "0.1.0", matrixFromDeclared({ loadSession: false, sessionFork: false, sessionResume: false, sessionList: false, sessionClose: false, promptImage: false, promptAudio: false, promptEmbeddedContext: false, mcpHttp: false, mcpSse: false, authMethods: [] }));
    await spawnRegistry.add(4242, "node agent.js", "agent");
    await sessionIndex.upsert({ id: "s1", agentId: "claude", title: "work", createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    await permissionRules.set({ commandRules: [{ pattern: "npm *", verdict: "allow" }], fileWriteScope: "always-ask" });
    await machineRules.set([{ pattern: "git status", verdict: "allow" }]);
    await decisionAudit.append({ kind: "permission", decision: "allow" });
    await lastKnownView.save("s1", [], "2026-01-01T00:00:00Z");
    await lastConnected.write(["claude"]);

    await eraseAllData({
      agentConfigs, integrationConfigs, usedCapabilities,
      spawnRegistry, sessionIndex, agentEnv, integrationEnv,
      integrationTokens, permissionRules, machineRules: machineRules,
      decisionAudit, lastKnownView, lastConnected,
    });

    expect(agentConfigs.list()).toEqual([]);
    expect(integrationConfigs.list()).toEqual([]);
    expect(usedCapabilities.list()).toEqual([]); // ghost gone too
    expect(spawnRegistry.list()).toEqual([]);
    expect(sessionIndex.list()).toEqual([]);
    expect(await agentEnv.get("claude")).toEqual({});
    expect(await integrationEnv.get("github")).toEqual({});
    expect(await integrationTokens.get("github")).toBeNull();
    expect(permissionRules.get()).toEqual(DEFAULT_PERMISSION_RULES);
    expect(machineRules.get()).toEqual({ commandRules: [] });
    expect(await decisionAudit.tail(5)).toEqual([]);
    expect(await lastKnownView.load("s1")).toBeNull();
    expect(await lastConnected.consume()).toEqual([]);
    await expect(stat(join(dir, "decision-audit.jsonl"))).rejects.toThrow();
  });
});
