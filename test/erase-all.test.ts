// The erase sweep leaves factory state: each owner erases its own facts
// (agents, MCP servers, sessions — their suites hold how), every other
// store is wiped here, rules back to built-ins, file stores gone. Real
// stores over MemoryKV and a real temp dir; only vscode itself is absent.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "./support/teardown";
import { eraseAllData } from "../src/orchestrator/erase-all";
import { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { LastActiveSessionStore } from "../src/orchestrator/stores/last-active-session";
import { LastConnectedStore } from "../src/orchestrator/stores/last-connected";
import { DefaultAgentFoldStore } from "../src/orchestrator/stores/default-agent-fold";
import { PreferencesStore } from "../src/orchestrator/stores/preferences";
import { DEFAULT_PREFERENCES } from "../src/shared/protocol";
import { DEFAULT_PERMISSION_RULES, MachineRulesStore, PermissionRulesStore } from "../src/orchestrator/stores/permission-rules";
import { MachineWriteScopeStore } from "../src/orchestrator/stores/write-scope";
import { commandOf } from "../src/orchestrator/process-tree";
import { SpawnRegistryStore } from "../src/orchestrator/stores/spawn-registry";
import { SavedRootsStore } from "../src/orchestrator/stores/saved-roots";
import type { PatchbayAgentId } from "../src/shared/ids";
import { STORAGE_KEYS } from "../src/orchestrator/stores/storage-keys";

let dir: string;
beforeEach(async () => {
  dir = await tempDir("patchbay-erase-");
});

describe("eraseAllData", () => {
  it("leaves factory state: each owner erases its facts, every other store is wiped, rules back to built-ins", async () => {
    const globalKv = new MemoryKV();
    const workspaceKv = new MemoryKV();

    const spawnRegistry = new SpawnRegistryStore(globalKv);
    const permissionRules = new PermissionRulesStore(workspaceKv);
    const machineRules = new MachineRulesStore(globalKv);
    const machineWriteScope = new MachineWriteScopeStore(globalKv);
    const decisionAudit = new DecisionAuditStore(dir);
    const lastConnected = new LastConnectedStore(workspaceKv);
    const defaultAgentFold = new DefaultAgentFoldStore(globalKv);
    const lastActiveSession = new LastActiveSessionStore(workspaceKv);
    const preferences = new PreferencesStore(globalKv);
    const workspaceSavedRoots = new SavedRootsStore(workspaceKv, "workspace");
    const machineSavedRoots = new SavedRootsStore(globalKv, "machine");

    // A lived-in install.
    // One of this window's own processes: another window's records stay
    // its own (spawn-registry.test.ts).
    const host = { pid: process.pid, command: await commandOf(process.pid) };
    await globalKv.update(STORAGE_KEYS.spawnRegistry, [{ id: "4242", pid: 4242, command: "node agent.js", kind: "agent", at: "2026-07-21T00:00:00Z", owner: host }]);
    expect(spawnRegistry.list()).toHaveLength(1);
    await permissionRules.set({ commandRules: [{ kind: "command", pattern: "npm *", verdict: "allow" }], writeScope: [{ location: { kind: "alwaysAsk" }, on: true }] });
    await machineRules.set([{ kind: "command", pattern: "git status", verdict: "allow" }]);
    await machineWriteScope.set([{ location: { kind: "path", path: "/home/me/.hermes" }, on: true }]);
    await decisionAudit.append({ kind: "permission", decision: "allow" });
    await lastConnected.write(["claude" as PatchbayAgentId]);
    await lastActiveSession.set({ patchbayAgentId: "a" as PatchbayAgentId, sessionId: "s1" });
    await preferences.set({ soundOnDone: true, idleCloseMinutes: 15 });
    await workspaceSavedRoots.add("/src/lib");
    await machineSavedRoots.add("/src/odoo");
    let stashWiped = false;

    const erased: string[] = [];
    const owner = (name: string) => ({ eraseAll: async () => void erased.push(name) });

    await eraseAllData({
      agents: owner("agents"), mcpServers: owner("mcpServers"), sessions: owner("sessions"),
      spawnRegistry, permissionRules, machineRules, machineWriteScope,
      decisionAudit, lastConnected, defaultAgentFold, lastActiveSession,
      preferences, workspaceSavedRoots, machineSavedRoots,
      tempStashes: { wipe: async () => { stashWiped = true; } },
    });

    expect(erased).toEqual(["agents", "mcpServers", "sessions"]);

    expect(stashWiped).toBe(true);
    expect(spawnRegistry.list()).toEqual([]);
    expect(permissionRules.get()).toEqual(DEFAULT_PERMISSION_RULES);
    expect(machineRules.get()).toEqual({ commandRules: [] });
    expect(machineWriteScope.get()).toEqual([]);
    expect(await decisionAudit.tail(5)).toEqual([]);
    expect(await lastConnected.consume()).toEqual([]);
    expect(lastActiveSession.get()).toBeUndefined();
    expect(preferences.get()).toEqual(DEFAULT_PREFERENCES);
    expect(workspaceSavedRoots.list()).toEqual([]);
    expect(machineSavedRoots.list()).toEqual([]);
    await expect(stat(join(dir, "decision-audit.jsonl"))).rejects.toThrow();
  });
});
