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
import { STORAGE_KEYS, type StorageKey } from "./stores/storage-keys";

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

/** Who erases each stored key — an owner (its facts and the secrets they
 * key), or the store that holds it here — and the one key the erase keeps,
 * with why. Typed over the key table, so a key added there without its
 * eraser does not build. */
const ERASED_BY: Readonly<
  Record<StorageKey, "agents" | "mcpServers" | "sessions" | Exclude<keyof EraseTargets, "decisionAudit" | "tempStashes"> | { kept: string }>
> = {
  [STORAGE_KEYS.agents]: "agents",
  [STORAGE_KEYS.lastKnobs]: "agents",
  [STORAGE_KEYS.usedCapabilities]: "agents",
  [STORAGE_KEYS.authLocks]: "agents",
  [STORAGE_KEYS.mcpServers]: "mcpServers",
  [STORAGE_KEYS.sessionContinuity]: "sessions",
  [STORAGE_KEYS.preferences]: "preferences",
  [STORAGE_KEYS.machineCommandRules]: "machineRules",
  [STORAGE_KEYS.machineWriteScope]: "machineWriteScope",
  [STORAGE_KEYS.machineSavedRoots]: "machineSavedRoots",
  [STORAGE_KEYS.spawnRegistry]: "spawnRegistry",
  [STORAGE_KEYS.defaultAgentFolded]: "defaultAgentFold",
  [STORAGE_KEYS.permissionRules]: "permissionRules",
  [STORAGE_KEYS.savedRoots]: "workspaceSavedRoots",
  [STORAGE_KEYS.lastConnected]: "lastConnected",
  [STORAGE_KEYS.lastActiveSession]: "lastActiveSession",
  [STORAGE_KEYS.legacyStateRecovery]: {
    kept: "it marks the one-time recovery done — erased, the recovery would run again and could bring back what was just erased",
  },
};

/** Deletes everything patchbay ever stored for this user: every key by its
 * eraser, then the files beside them. Its limits: this window's
 * workspaceState only — other workspaces' rules are unreachable from here —
 * and only secrets the stored records still name (SecretStorage can't be
 * listed; each owner removes its secrets while its records still key them). */
export async function eraseAllData(targets: EraseTargets): Promise<void> {
  const done = new Set<string>();
  for (const eraser of Object.values(ERASED_BY)) {
    if (typeof eraser !== "string" || done.has(eraser)) continue;
    done.add(eraser);
    if (eraser === "agents" || eraser === "mcpServers" || eraser === "sessions") await targets[eraser].eraseAll();
    else if (eraser === "permissionRules") await targets.permissionRules.set(DEFAULT_PERMISSION_RULES);
    else if (eraser === "machineRules") await targets.machineRules.set([]);
    else if (eraser === "machineWriteScope") await targets.machineWriteScope.set([]);
    else await targets[eraser].wipe();
  }
  await targets.decisionAudit.wipe();
  await targets.tempStashes.wipe();
}
