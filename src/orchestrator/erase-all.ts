// "Disconnect & erase all data" (plan.md P18): the explicit, user-triggered
// wipe — never automatic on any lifecycle event, because the platform gives
// no safe way to do it for the user: deactivate fires identically for
// reload, disable, and uninstall (vscode#45474), secrets survive uninstall
// (vscode#123817, open), and Memento deletion on uninstall is not a
// platform contract either. Structural interfaces so the sweep is
// unit-testable without vscode; the orchestrator supplies its real stores.
import { DEFAULT_PERMISSION_RULES, type CommandRule, type PermissionRules } from "./stores/permission-rules";

interface RecordStoreLike {
  list(): { id: string }[];
  remove(id: string): Promise<void>;
}

interface SecretsById {
  remove(id: string): Promise<void>;
}

interface Wipeable {
  wipe(): Promise<void>;
}

export interface EraseTargets {
  agentConfigs: RecordStoreLike;
  integrationConfigs: RecordStoreLike;
  usedCapabilities: RecordStoreLike;
  spawnRegistry: RecordStoreLike;
  sessionIndex: RecordStoreLike;
  agentEnv: SecretsById;
  integrationEnv: SecretsById;
  integrationTokens: SecretsById;
  permissionRules: { set(rules: PermissionRules): Promise<void> };
  machineRules: { set(rules: CommandRule[]): Promise<void> };
  decisionAudit: Wipeable;
  lastKnownView: Wipeable;
  lastConnected: Wipeable;
}

/** Deletes everything patchbay ever stored for this user. Ordering
 * constraint, recorded: SecretStorage has no enumeration API — the config
 * lists are the only key index into it, so secrets are deleted while their
 * config records still exist; a config removed first would strand its
 * secret in the OS store forever. Limits (documented in the README): this
 * window's workspaceState only — other workspaces' session indexes and
 * rules are unreachable from here — and only secrets the current config
 * lists still name. */
export async function eraseAllData(targets: EraseTargets): Promise<void> {
  // 1 — secrets, while their key index still exists.
  for (const { id } of targets.agentConfigs.list()) {
    await targets.agentEnv.remove(id);
  }
  for (const { id } of targets.integrationConfigs.list()) {
    await targets.integrationEnv.remove(id);
    await targets.integrationTokens.remove(id);
  }
  // 2 — every record store by its own listing, so strays whose config is
  // already gone (an old version's leftovers) go too.
  const recordStores: RecordStoreLike[] = [
    targets.agentConfigs,
    targets.integrationConfigs,
    targets.usedCapabilities,
    targets.spawnRegistry,
    targets.sessionIndex,
  ];
  for (const store of recordStores) {
    for (const record of store.list()) await store.remove(record.id);
  }
  // 3 — rules back to built-ins, file stores gone.
  await targets.permissionRules.set(DEFAULT_PERMISSION_RULES);
  await targets.machineRules.set([]);
  await targets.decisionAudit.wipe();
  await targets.lastKnownView.wipe();
  await targets.lastConnected.wipe();
}
