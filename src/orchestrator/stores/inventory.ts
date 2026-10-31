// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What the Data page says patchbay keeps in VS Code's storage — every key,
// read as stored. Typed over the key table, so a key added there without
// its row here does not build: nothing kept goes unshown. Counts only,
// never values.
import { count } from "../../shared/count";
import type { DataInventoryRow } from "../../shared/protocol";
import { STORAGE_KEYS, type StorageKey } from "./storage-keys";

/** How much a stored value holds: a list's items, a record's keys. */
function size(raw: unknown): number {
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === "object" && raw !== null) return Object.keys(raw).length;
  return raw === undefined ? 0 : 1;
}

const counted = (noun: string) => (raw: unknown) => count(size(raw), noun);
const marked = (set: string, unset: string) => (raw: unknown) => (raw === undefined ? unset : set);

/** Each key: its label, where it lives — this machine (globalStorage) or
 * this workspace (workspaceState) — and what its detail counts. */
const ROWS: Record<StorageKey, { label: string; scope: "machine" | "workspace"; detail: (raw: unknown) => string }> = {
  [STORAGE_KEYS.agents]: { label: "Agent configs", scope: "machine", detail: counted("agent") },
  [STORAGE_KEYS.lastKnobs]: { label: "Composer knobs (last used)", scope: "machine", detail: counted("agent record") },
  [STORAGE_KEYS.mcpServers]: { label: "MCP server configs", scope: "machine", detail: counted("server") },
  [STORAGE_KEYS.preferences]: { label: "Preferences", scope: "machine", detail: counted("preference set") },
  [STORAGE_KEYS.machineCommandRules]: { label: "Command rules — this machine", scope: "machine", detail: counted("rule") },
  [STORAGE_KEYS.machineWriteScope]: { label: "File writes — this machine", scope: "machine", detail: counted("place set") },
  [STORAGE_KEYS.machineSavedRoots]: { label: "Saved roots — every workspace", scope: "machine", detail: counted("folder") },
  [STORAGE_KEYS.usedCapabilities]: { label: "Used-capability cache", scope: "machine", detail: counted("agent record") },
  [STORAGE_KEYS.authLocks]: { label: "Sign-outs witnessed", scope: "machine", detail: counted("agent") },
  [STORAGE_KEYS.sessionContinuity]: { label: "Sessions' saved state", scope: "machine", detail: counted("session") },
  [STORAGE_KEYS.spawnRegistry]: { label: "Spawn registry", scope: "machine", detail: counted("process record") },
  [STORAGE_KEYS.defaultAgentFolded]: {
    label: "Old default-agent setting",
    scope: "machine",
    detail: marked("folded into auto-connect", "never set"),
  },
  [STORAGE_KEYS.legacyStateRecovery]: { label: "One-time recovery", scope: "machine", detail: marked("done", "not run") },
  [STORAGE_KEYS.permissionRules]: {
    label: "Command rules & file writes — this workspace",
    scope: "workspace",
    detail: (raw) => {
      const rules = (raw ?? {}) as { commandRules?: unknown; writeScope?: unknown };
      return `${count(size(rules.commandRules), "rule")} · ${count(size(rules.writeScope), "file-write override")}`;
    },
  },
  [STORAGE_KEYS.savedRoots]: { label: "Saved roots — this workspace", scope: "workspace", detail: counted("folder") },
  [STORAGE_KEYS.lastConnected]: { label: "Agents running at the last close", scope: "workspace", detail: counted("agent") },
  [STORAGE_KEYS.lastActiveSession]: { label: "Last open session", scope: "workspace", detail: marked("one", "none") },
};

/** The rows for every key, read from where each lives. */
export function storedRows(read: { machine(key: string): unknown; workspace(key: string): unknown }): DataInventoryRow[] {
  return (Object.entries(ROWS) as [StorageKey, (typeof ROWS)[StorageKey]][]).map(([key, row]) => ({
    id: key,
    label: row.label,
    placement: row.scope === "machine" ? "globalStorage file" : "workspaceState",
    detail: row.detail(row.scope === "machine" ? read.machine(key) : read.workspace(key)),
  }));
}
