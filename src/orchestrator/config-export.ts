// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What leaves this machine when the user exports their configuration: the
// machine store's own entries, each under the key it is stored by and as
// stored there, beside the secrets those entries name — the env values and
// header keys their owner typed. An OAuth token never leaves: a provider
// that rotates refresh tokens can revoke the sign-in on both machines once
// the second one refreshes a token the first already spent. The file is
// the user's to keep and move; nothing in it is shaped for anything but
// this extension's own import.
import { chmod, writeFile } from "node:fs/promises";
import { PRODUCT } from "../shared/product";
import type { ExportPart } from "../shared/protocol";
import type { StoredEntry } from "./stores/kv";
import { STORAGE_KEYS, type StorageKey } from "./stores/storage-keys";

type Env = Record<string, string>;

/** Every key patchbay stores in a KV, and its fate in an export: the part
 * that carries it, why it never leaves, or — an earlier version's key — the
 * part an older file's entry is read into, never written to a new one.
 * Typed over the key table, so a key added there without a row here does
 * not build — nothing new is left out unannounced. */
export const STORED_KEYS: Readonly<Record<StorageKey, ExportPart | { never: string } | { readInto: ExportPart }>> = {
  [STORAGE_KEYS.agents]: "agents",
  [STORAGE_KEYS.agentsBefore090]: { readInto: "agents" },
  [STORAGE_KEYS.lastKnobs]: "agents",
  [STORAGE_KEYS.mcpServers]: "mcpServers",
  [STORAGE_KEYS.preferences]: "settings",
  [STORAGE_KEYS.machineCommandRules]: "settings",
  [STORAGE_KEYS.machineWriteScope]: "settings",
  [STORAGE_KEYS.machineSavedRoots]: "settings",
  [STORAGE_KEYS.usedCapabilities]: { never: "what an agent proved on this machine — earned again by use on the next" },
  [STORAGE_KEYS.authLocks]: { never: "a sign-out witnessed on this machine — the next one's agents sign in for themselves" },
  [STORAGE_KEYS.sessionContinuity]: { never: "sessions held by this machine's agents" },
  [STORAGE_KEYS.spawnRegistry]: { never: "processes running on this machine" },
  [STORAGE_KEYS.defaultAgentFolded]: { never: "marks this machine's old default-agent setting as folded in" },
  [STORAGE_KEYS.legacyStateRecovery]: { never: "marks this machine's one-time recovery as done" },
  [STORAGE_KEYS.permissionRules]: { never: "this workspace's own" },
  [STORAGE_KEYS.savedRoots]: { never: "this workspace's own" },
  [STORAGE_KEYS.lastConnected]: { never: "this workspace's agents at its last close" },
  [STORAGE_KEYS.lastActiveSession]: { never: "this workspace's last open session" },
};

/** Where an export reads from: the stores that hold a carried key, and
 * the secrets the agents' and MCP servers' records name. */
export interface ExportSources {
  entries: readonly StoredEntry[];
  agents: {
    ids(): readonly string[];
    env(id: string): Promise<Env>;
  };
  mcpServers: {
    ids(): readonly string[];
    env(id: string): Promise<Env>;
    headerKey(id: string): Promise<string | undefined>;
  };
}

export interface ConfigurationFile {
  /** What the file is — the one mark an import knows it by. */
  patchbay: "configuration";
  /** The version that wrote it: an import by an older one says the file
   * may hold what it doesn't know. */
  patchbayVersion: string;
  exportedAt: string;
  /** Machine-store entries by their key, as stored. */
  state: Record<string, unknown>;
  /** By the id of the record they belong to; a record with nothing
   * stored has no row. */
  secrets: {
    agents?: Record<string, { env: Env }>;
    mcpServers?: Record<string, { env?: Env; key?: string }>;
  };
}

export async function exportConfiguration(
  parts: ReadonlySet<ExportPart>,
  sources: ExportSources,
  now: Date = new Date(),
): Promise<ConfigurationFile> {
  const state: Record<string, unknown> = {};
  for (const [key, fate] of Object.entries(STORED_KEYS)) {
    if (typeof fate !== "string" || !parts.has(fate)) continue;
    const entry = sources.entries.find((e) => e.key === key);
    if (entry === undefined) throw new Error(`no store was given for ${key}`);
    const value = entry.stored();
    if (value !== undefined) state[key] = value;
  }
  const secrets: ConfigurationFile["secrets"] = {};
  if (parts.has("agents")) {
    const agents: Record<string, { env: Env }> = {};
    for (const id of sources.agents.ids()) {
      const env = await sources.agents.env(id);
      if (Object.keys(env).length > 0) agents[id] = { env };
    }
    secrets.agents = agents;
  }
  if (parts.has("mcpServers")) {
    const servers: Record<string, { env?: Env; key?: string }> = {};
    for (const id of sources.mcpServers.ids()) {
      const env = await sources.mcpServers.env(id);
      const key = await sources.mcpServers.headerKey(id);
      const row = {
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(key !== undefined ? { key } : {}),
      };
      if (Object.keys(row).length > 0) servers[id] = row;
    }
    secrets.mcpServers = servers;
  }
  return { patchbay: "configuration", patchbayVersion: PRODUCT.version, exportedAt: now.toISOString(), state, secrets };
}

/** The file's text, wherever it is written. */
export function configurationText(file: ConfigurationFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Readable by its owner only — it holds what their secret storage holds.
 * A file that already existed keeps its mode through a write, hence the
 * chmod after. */
export async function writeConfigurationFile(path: string, file: ConfigurationFile): Promise<void> {
  await writeFile(path, configurationText(file), { mode: 0o600 });
  await chmod(path, 0o600);
}
