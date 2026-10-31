// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Reading a configuration file a patchbay exported. The file comes from
// outside this extension host, so nothing in it counts until it reads as
// ours — and it reads the way this machine's own store does: its entries
// loaded under their keys into the same stores, so each migration a store
// runs on its own file runs on this one, and each schema skips what isn't
// the shape. Whatever the file holds that this version couldn't read is
// named, never dropped in silence.
import { z } from "zod";
import { count } from "../shared/count";
import { PRODUCT } from "../shared/product";
import type { ExportPart, KnobSeed, PreferencesView, WriteEntry } from "../shared/protocol";
import { STORED_KEYS } from "./config-export";
import { STORAGE_KEYS, type StorageKey } from "./stores/storage-keys";
import { AgentConfigStore, type AgentConfig } from "./stores/agent-configs";
import { ComposerKnobsStore } from "./stores/composer-knobs";
import { MemoryKV } from "./stores/kv";
import { McpServerConfigStore, type McpServerConfig } from "./stores/mcp-server-configs";
import { MachineRulesStore, type CommandRule } from "./stores/permission-rules";
import { PreferencesStore } from "./stores/preferences";
import { SavedRootsStore } from "./stores/saved-roots";
import { MachineWriteScopeStore } from "./stores/write-scope";

type Env = Record<string, string>;

export interface ConfigurationRead {
  /** The version that wrote the file, when it names one. */
  patchbayVersion: string | null;
  /** Written by a newer patchbay: it may hold what this one doesn't know. */
  newer: boolean;
  exportedAt: string | null;
  /** The parts the file carries. */
  parts: ReadonlySet<ExportPart>;
  agents: readonly AgentConfig[];
  knobs: Readonly<Record<string, KnobSeed>>;
  mcpServers: readonly McpServerConfig[];
  /** Only the preferences the file holds. */
  preferences: Partial<PreferencesView>;
  machineCommandRules: readonly CommandRule[];
  machineWriteScope: readonly WriteEntry[];
  machineSavedRoots: readonly string[];
  /** By the id of the record they belong to, as the file has it. */
  secrets: {
    agents: Readonly<Record<string, Env>>;
    mcpServers: Readonly<Record<string, { env: Env; key?: string }>>;
  };
  /** What the file holds that didn't read, each said once. */
  unread: readonly string[];
}

export type ReadOutcome = { ok: true; read: ConfigurationRead } | { ok: false; reason: string };

const envSchema = z.record(z.string(), z.string());
const agentSecretSchema = z.object({ env: envSchema });
const serverSecretSchema = z.object({ env: envSchema.optional(), key: z.string().min(1).optional() });

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function readConfiguration(text: string): ReadOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The file isn't JSON." };
  }
  const file = record(parsed);
  if (file === null || file.patchbay !== "configuration") {
    return { ok: false, reason: "This isn't a patchbay configuration file." };
  }
  const state = record(file.state);
  const secrets = record(file.secrets) ?? {};
  if (state === null) return { ok: false, reason: "The file's configuration can't be read." };

  const unread: string[] = [];
  const kv = new MemoryKV();
  const parts = new Set<ExportPart>();
  for (const [key, value] of Object.entries(state)) {
    const fate = Object.hasOwn(STORED_KEYS, key) ? STORED_KEYS[key as StorageKey] : undefined;
    const part = typeof fate === "object" && "readInto" in fate ? fate.readInto : fate;
    if (typeof part !== "string") {
      unread.push(`an entry this version doesn't carry (${key})`);
      continue;
    }
    parts.add(part);
    void kv.update(key, value);
  }
  if (record(secrets.agents) !== null) parts.add("agents");
  if (record(secrets.mcpServers) !== null) parts.add("mcpServers");
  if (parts.size === 0) return { ok: false, reason: "The file holds nothing to import." };

  // Built over the file's entries: each store's migrations run here, as
  // they do over this machine's own file.
  const agents = new AgentConfigStore(kv).list();
  const knobs = new ComposerKnobsStore(kv).all();
  const mcpServers = new McpServerConfigStore(kv).list();
  const preferences = new PreferencesStore(kv).chosen();
  const machineCommandRules = new MachineRulesStore(kv).get().commandRules;
  const machineWriteScope = new MachineWriteScopeStore(kv).get();
  const machineSavedRoots = new SavedRootsStore(kv, "machine").list();

  // What an entry held against what read from it — a list's items, a
  // record's keys, any other value as one.
  const short = (key: string, read: number, said: (n: number) => string) => {
    const raw = kv.get<unknown>(key);
    const held = Array.isArray(raw) ? raw.length : raw === undefined ? 0 : Object.keys(record(raw) ?? { raw }).length;
    if (held > read) unread.push(said(held - read));
  };
  short(STORAGE_KEYS.agents, agents.length, (n) => count(n, "agent"));
  short(STORAGE_KEYS.lastKnobs, Object.keys(knobs).length, (n) => `composer choices for ${count(n, "agent")}`);
  short(STORAGE_KEYS.mcpServers, mcpServers.length, (n) => count(n, "MCP server"));
  short(STORAGE_KEYS.preferences, Object.keys(preferences).length, (n) => count(n, "preference"));
  short(STORAGE_KEYS.machineCommandRules, machineCommandRules.length, (n) => count(n, "command rule"));
  short(STORAGE_KEYS.machineWriteScope, machineWriteScope.length, (n) => count(n, "file-write place"));
  short(STORAGE_KEYS.machineSavedRoots, machineSavedRoots.length, (n) => count(n, "saved root"));

  const agentSecrets: Record<string, Env> = {};
  for (const [id, row] of Object.entries(record(secrets.agents) ?? {})) {
    const read = agentSecretSchema.safeParse(row);
    if (read.success && agents.some((a) => a.id === id)) agentSecrets[id] = read.data.env;
    else unread.push(`the env values of an agent the file doesn't carry as one (${id})`);
  }
  const serverSecrets: Record<string, { env: Env; key?: string }> = {};
  for (const [id, row] of Object.entries(record(secrets.mcpServers) ?? {})) {
    const read = serverSecretSchema.safeParse(row);
    if (read.success && mcpServers.some((s) => s.id === id)) {
      serverSecrets[id] = { env: read.data.env ?? {}, ...(read.data.key !== undefined ? { key: read.data.key } : {}) };
    } else unread.push(`the secrets of an MCP server the file doesn't carry as one (${id})`);
  }

  const patchbayVersion = typeof file.patchbayVersion === "string" ? file.patchbayVersion : null;
  return {
    ok: true,
    read: {
      patchbayVersion,
      newer: patchbayVersion !== null && isNewer(patchbayVersion, PRODUCT.version),
      exportedAt: typeof file.exportedAt === "string" ? file.exportedAt : null,
      parts,
      agents,
      knobs,
      mcpServers,
      preferences,
      machineCommandRules,
      machineWriteScope,
      machineSavedRoots,
      secrets: { agents: agentSecrets, mcpServers: serverSecrets },
      unread,
    },
  };
}

/** Whether version `a` is later than `b`, by their numbered parts; one
 * that doesn't read as a version is never later. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
  const pa = parse(a);
  const pb = parse(b);
  if (pa === undefined || pb === undefined) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! > pb[i]!;
  }
  return false;
}
