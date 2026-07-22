// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Per-session continuity — the survives-reload family in one row: the last
// agent-confirmed knob combination, user-added context roots, the held
// prompt queue, prepared-but-unsent context chips (image bytes stay in the
// attachments stash; the row carries the file reference), and the composer
// draft. None of it is a cache of readable reality: agents reset knob
// state on session/load, ACP has no read-back for additionalDirectories,
// and the rest is user-staged input that exists nowhere else — the same
// not-a-cache justification as the auth locks. One lifetime contract:
// rows leave with their session (close, the agent's own session/list no
// longer reporting it, agent removal, zero-turn recreate, erase-all).
import { z } from "zod";
import type { SessionContinuity } from "../../shared/protocol";
import { GlobalRecordStore } from "./global-record-store";
import type { KV } from "./kv";

const knobSeedSchema = z.record(z.string(), z.union([z.string(), z.boolean()]));

const queuedPromptSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  parts: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("text"), text: z.string() }),
        z.object({ kind: z.literal("fileRef"), path: z.string() }),
      ]),
    )
    .optional(),
});

const persistedChipSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["selection", "file", "diagnostics"]),
    id: z.string().min(1),
    label: z.string(),
    content: z.string(),
    sourceUri: z.string().optional(),
  }),
  z.object({
    kind: z.literal("image"),
    id: z.string().min(1),
    label: z.string(),
    mimeType: z.string(),
    file: z.string(),
  }),
  z.object({
    kind: z.literal("attachment"),
    id: z.string().min(1),
    label: z.string(),
    path: z.string(),
    mimeType: z.string().optional(),
  }),
]);

const sessionContinuityEntrySchema = z.object({
  id: z.string().min(1), // sessionId — the same identity the known map keys by
  agentId: z.string().min(1),
  knobs: knobSeedSchema.optional(),
  roots: z.array(z.string()).optional(),
  queue: z.array(queuedPromptSchema).optional(),
  chips: z.array(persistedChipSchema).optional(),
  draft: z.string().optional(),
});
export type SessionContinuityEntry = z.infer<typeof sessionContinuityEntrySchema>;

const KEY = "acpPatchbay.sessionContinuity";
/** The short-lived predecessor (knobs only) — folded in and dropped on
 * first construction; the key never gets written again. Retire the fold
 * with the first release after 0.82.8: no published build ever wrote it. */
const LEGACY_KNOBS_KEY = "acpPatchbay.sessionKnobs";

/** Row identity is the PAIR: session ids are agent-minted, and two agents
 * minting the same string are two different sessions — a sessionId-only
 * key would let one agent's row destroy the other's. */
function rowId(agentId: string, sessionId: string): string {
  return `${agentId}\u0000${sessionId}`;
}

/** True when a field value carries nothing worth a row: absorbing these as
 * deletions keeps drained queues, sent chips, and cleared drafts from
 * leaving husk fields behind. */
function isEmpty(value: SessionContinuity[keyof SessionContinuity]): boolean {
  if (value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

export class SessionContinuityStore extends GlobalRecordStore<SessionContinuityEntry> {
  constructor(kv: KV) {
    super(kv, KEY, sessionContinuityEntrySchema);
    const legacy = kv.get<unknown[]>(LEGACY_KNOBS_KEY);
    if (legacy !== undefined) {
      for (const item of legacy) {
        const parsed = z
          .object({ id: z.string().min(1), agentId: z.string().min(1), seed: knobSeedSchema })
          .safeParse(item);
        if (parsed.success && this.read(parsed.data.id, parsed.data.agentId) === undefined) {
          // Best-effort fold: a failing disk write here loses only rows a
          // never-published build wrote — swallowed, never unhandled.
          void this
            .upsert({
              id: rowId(parsed.data.agentId, parsed.data.id),
              agentId: parsed.data.agentId,
              knobs: parsed.data.seed,
            })
            .catch(() => {});
        }
      }
      void Promise.resolve(kv.update(LEGACY_KNOBS_KEY, undefined)).catch(() => {});
    }
  }

  read(sessionId: string, agentId: string): SessionContinuity | undefined {
    const entry = this.get(rowId(agentId, sessionId));
    if (entry === undefined) return undefined;
    const { id: _i, agentId: _a, ...fields } = entry;
    return fields;
  }

  /** Merge one or more fields into the session's row. Empty values (empty
   * array, empty string, empty object, undefined) delete their field; a
   * row with no fields left is removed entirely. Synchronous up to the KV
   * write (FileKV swaps memory before returning), so interleaved patches
   * never read each other mid-merge — a contract an async KV would break. */
  patch(sessionId: string, agentId: string, fields: SessionContinuity): Promise<void> {
    const id = rowId(agentId, sessionId);
    const existing = this.get(id);
    const base: SessionContinuityEntry = existing !== undefined ? { ...existing } : { id, agentId };
    for (const key of ["knobs", "roots", "queue", "chips", "draft"] as const) {
      if (!(key in fields)) continue;
      const value = fields[key];
      if (isEmpty(value)) delete base[key];
      else (base as Record<string, unknown>)[key] = value;
    }
    const hasFields = (["knobs", "roots", "queue", "chips", "draft"] as const).some(
      (k) => base[k] !== undefined,
    );
    return hasFields ? this.upsert(base) : this.remove(id);
  }

  forget(sessionId: string, agentId: string): Promise<void> {
    return this.remove(rowId(agentId, sessionId));
  }
}
