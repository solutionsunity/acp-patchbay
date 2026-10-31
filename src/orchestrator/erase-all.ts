// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// "Disconnect & erase all data": the explicit, user-triggered
// wipe — never automatic on any lifecycle event, because the platform gives
// no safe way to do it for the user: deactivate fires identically for
// reload, disable, and uninstall (vscode#45474), secrets survive uninstall
// (vscode#123817, open), and Memento deletion on uninstall is not a
// platform contract either. Structural interfaces so the sweep is
// unit-testable without vscode; the orchestrator supplies its real stores.
import { DEFAULT_PERMISSION_RULES, type CommandRule, type PermissionRules } from "./stores/permission-rules";
import type { WriteEntry } from "../shared/protocol";

interface Wipeable {
  wipe(): Promise<void>;
}

/** Facts that have an owner are erased by it — it knows the order its
 * secrets and records go in; every other store is wiped here. */
interface Erasable {
  eraseAll(): Promise<void>;
}

export interface EraseTargets {
  agents: Erasable;
  mcpServers: Erasable;
  sessions: Erasable;
  spawnRegistry: Wipeable;
  permissionRules: { set(rules: PermissionRules): Promise<void> };
  machineRules: { set(rules: CommandRule[]): Promise<void> };
  machineWriteScope: { set(entries: readonly WriteEntry[]): Promise<void> };
  decisionAudit: Wipeable;
  lastConnected: Wipeable;
  defaultAgentFold: Wipeable;
  lastActiveSession: Wipeable;
  preferences: Wipeable;
  workspaceSavedRoots: Wipeable;
  machineSavedRoots: Wipeable;
  /** The preview and diff temp stashes: image previews and diff
   * snapshots are user content — "deletes everything patchbay ever
   * stored" includes them, not just the rows that referenced them. */
  tempStashes: Wipeable;
}

/** Deletes everything patchbay ever stored for this user. Its limits: this
 * window's workspaceState only — other workspaces' rules are unreachable
 * from here — and only secrets the stored records still name
 * (SecretStorage can't be listed; each owner removes its secrets while its
 * records still key them). */
export async function eraseAllData(targets: EraseTargets): Promise<void> {
  await targets.agents.eraseAll();
  await targets.mcpServers.eraseAll();
  await targets.sessions.eraseAll();
  await targets.spawnRegistry.wipe();
  // rules back to built-ins, file stores gone
  await targets.permissionRules.set(DEFAULT_PERMISSION_RULES);
  await targets.machineRules.set([]);
  await targets.machineWriteScope.set([]);
  await targets.decisionAudit.wipe();
  await targets.lastConnected.wipe();
  await targets.defaultAgentFold.wipe();
  await targets.lastActiveSession.wipe();
  await targets.preferences.wipe();
  await targets.workspaceSavedRoots.wipe();
  await targets.machineSavedRoots.wipe();
  await targets.tempStashes.wipe();
}
