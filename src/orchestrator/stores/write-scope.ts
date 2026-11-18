// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// File-write scope: the places where an agent's writes are approved
// without asking — the workspace's folders, the roots added to a session,
// the system temp dir, folders the user adds — each switched on or off,
// under a mute (always ask) that sets every place aside without forgetting
// it. Two layers, one entry shape: the machine layer (this file's store —
// every workspace on this machine) and the workspace layer
// (permission-rules.ts, beside the command rules), whose answer overrides
// the machine's for that workspace alone, either way — the order the
// command rules keep. A folder belongs to the layer it was added at: the
// machine's reach every workspace, one a workspace added is its own. A
// switch the machine never set answers by its default (the workspace on,
// the rest off). An answer may name the agents it is for
// (shared/agent-scope.ts): for any other agent it isn't there, and the
// next layer, then the default, answers.
import { isAbsolute } from "node:path";
import { z } from "zod";
import { appliesTo, scopeOf, withoutAgent, withScope, type AgentScope } from "../../shared/agent-scope";
import { sameWriteLocation, type WriteEntry, type WriteLocation, type WriteScopeRowView } from "../../shared/protocol";
import type { PatchbayAgentId } from "../../shared/ids";
import { type KV, type StoredEntry, rewriteAtOpen } from "./kv";
import { reachSchema } from "./reach-schema";
import { STORAGE_KEYS } from "./storage-keys";

const locationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("alwaysAsk") }),
  z.object({ kind: z.literal("workspace") }),
  z.object({ kind: z.literal("sessionRoots") }),
  z.object({ kind: z.literal("temp") }),
  z.object({ kind: z.literal("path"), path: z.string().refine(isAbsolute) }),
]);
const entrySchema = z.object({ location: locationSchema, on: z.boolean(), agents: reachSchema<PatchbayAgentId>().optional() }) satisfies z.ZodType<WriteEntry>;

/** The stored entries that are entries, each place once (its first): any
 * other value — or a stored value that isn't a list — is skipped. */
export function readWriteEntries(stored: unknown): WriteEntry[] {
  if (!Array.isArray(stored)) return [];
  const entries: WriteEntry[] = [];
  for (const item of stored) {
    const parsed = entrySchema.safeParse(item);
    if (parsed.success && !entries.some((e) => sameWriteLocation(e.location, parsed.data.location))) entries.push(parsed.data);
  }
  return entries;
}

/** A layer's entries with one place's answer set — in its place when the
 * layer holds it, for the agents it was for, appended for every agent when
 * not; null drops it. */
export function withWriteEntry(entries: readonly WriteEntry[], location: WriteLocation, on: boolean | null): WriteEntry[] {
  const rest = entries.filter((e) => !sameWriteLocation(e.location, location));
  if (on === null) return rest;
  const held = rest.length < entries.length;
  return held ? entries.map((e) => (sameWriteLocation(e.location, location) ? { ...e, location, on } : e)) : [...entries, { location, on }];
}

/** A layer's entries with one place's answer for `scope`'s agents — an
 * answer the layer doesn't hold yet is added as `standing`, what holds
 * there now, so naming its agents changes nothing for them. */
export function withWriteScope(entries: readonly WriteEntry[], location: WriteLocation, scope: AgentScope, standing: boolean): WriteEntry[] {
  const held = entries.some((e) => sameWriteLocation(e.location, location));
  return held
    ? entries.map((e) => (sameWriteLocation(e.location, location) ? withScope(e, scope) : e))
    : [...entries, withScope<WriteEntry>({ location, on: standing }, scope)];
}

/** A layer's entries with a removed agent named in none: an answer for it
 * alone goes with it. */
export function writeEntriesWithout(entries: readonly WriteEntry[], agent: PatchbayAgentId): WriteEntry[] {
  return entries.flatMap((e) => withoutAgent(e, agent) ?? []);
}

const SWITCHES: readonly WriteLocation[] = [{ kind: "alwaysAsk" }, { kind: "workspace" }, { kind: "sessionRoots" }, { kind: "temp" }];

/** Every place, the switches first, then the machine's folders in its
 * order, then the ones only this workspace added — each with both layers'
 * answers, the agents each is for, and the one that holds for `agent`
 * (null: an agent no answer names): a layer's answer counts only where it
 * is for that agent. */
export function writeScopeRows(
  machine: readonly WriteEntry[],
  workspace: readonly WriteEntry[],
  agent: PatchbayAgentId | null = null,
): WriteScopeRowView[] {
  const folders = [...machine, ...workspace]
    .map((e) => e.location)
    .filter((l, i, all) => l.kind === "path" && all.findIndex((o) => sameWriteLocation(o, l)) === i);
  return [...SWITCHES, ...folders].map((location) => {
    const at = (layer: readonly WriteEntry[]) => layer.find((e) => sameWriteLocation(e.location, location));
    const standing = location.kind === "path" ? null : location.kind === "workspace";
    const [m, w] = [at(machine), at(workspace)];
    const holds = (entry: WriteEntry | undefined) => (entry !== undefined && appliesTo(entry, agent) ? entry.on : null);
    return {
      location,
      machine: m?.on ?? standing,
      machineAgents: m === undefined ? "auto" : scopeOf(m),
      workspace: w?.on ?? null,
      workspaceAgents: w === undefined ? "auto" : scopeOf(w),
      on: holds(w) ?? holds(m) ?? standing ?? false,
    };
  });
}

const KEY = STORAGE_KEYS.machineWriteScope;
const KEY_BEFORE = STORAGE_KEYS.machineWriteScopeBefore092;

/** The machine layer — the machine store, every workspace on this
 * machine. Holds only what the user set: defaults are filled in by
 * writeScopeRows, never stored. */
export class MachineWriteScopeStore implements StoredEntry {
  readonly key = KEY;

  constructor(private readonly kv: KV) {
    // Once, at construction, where this key holds nothing yet: the places
    // an earlier version kept under its own key are copied, never moved —
    // a window still on that version keeps its key.
    const earlier = kv.get<unknown>(KEY_BEFORE);
    if (kv.get<unknown>(KEY) === undefined && Array.isArray(earlier)) rewriteAtOpen(kv.update(KEY, earlier));
  }

  stored(): unknown {
    return this.kv.get(KEY);
  }

  get(): WriteEntry[] {
    return readWriteEntries(this.kv.get<unknown>(KEY));
  }

  async set(entries: readonly WriteEntry[]): Promise<void> {
    await this.kv.update(KEY, entries);
  }

  async forgetAgent(agent: PatchbayAgentId): Promise<void> {
    await this.set(writeEntriesWithout(this.get(), agent));
  }

  /** Every place goes — the earlier version's copy with it; the key stays
   * held, empty, so nothing is copied back. */
  async wipe(): Promise<void> {
    await this.set([]);
    await this.kv.update(KEY_BEFORE, undefined);
  }
}
