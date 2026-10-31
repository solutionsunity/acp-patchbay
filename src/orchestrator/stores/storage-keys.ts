// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Every name patchbay keeps data under outside its own files: the keys of
// VS Code's state (the machine and workspace stores) and the key families
// of its secret storage. They are the on-disk contract — a renamed key
// reads as nothing, and what the user had under the old one is lost — so
// each is spelled here once, and every store reads its own from here.

/** The state keys, by what each holds. A record whose stored shape changes
 * moves to a new key: every window on this machine shares the store, one
 * not yet reloaded still runs the version before, and that version writes
 * back only the fields it knows. */
export const STORAGE_KEYS = {
  agents: "acpPatchbay.agentConfigs",
  /** The agents as 0.88 and before kept them — still written by a window
   * on such a version. Read once, to fill `agents` where it is empty. */
  agentsBefore090: "acpPatchbay.agents",
  lastKnobs: "acpPatchbay.lastKnobs",
  mcpServers: "acpPatchbay.integrations",
  preferences: "acpPatchbay.preferences",
  machineCommandRules: "acpPatchbay.machineCommandRules",
  machineWriteScope: "acpPatchbay.machineWriteScope",
  machineSavedRoots: "acpPatchbay.machineSavedRoots",
  usedCapabilities: "acpPatchbay.usedCapabilities",
  authLocks: "acpPatchbay.authLocks",
  sessionContinuity: "acpPatchbay.sessionContinuity",
  spawnRegistry: "acpPatchbay.spawnRegistry",
  defaultAgentFolded: "acpPatchbay.defaultAgentFolded",
  legacyStateRecovery: "acpPatchbay.legacyStateRecovery",
  permissionRules: "acpPatchbay.permissionRules",
  savedRoots: "acpPatchbay.savedRoots",
  lastConnected: "acpPatchbay.lastConnected",
  lastActiveSession: "acpPatchbay.lastActiveSession",
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/** The secret-storage key families: each secret sits at
 * `<family>.<id>.<what>` — an agent's env, an MCP server's env and token. */
export const SECRET_FAMILIES = {
  agent: "acpPatchbay.agent",
  mcpServer: "acpPatchbay.integration",
} as const;
