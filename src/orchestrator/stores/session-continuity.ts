// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Per-session continuity — the survives-reload family in one row: the last
// agent-confirmed knob combination, user-added context roots, the held
// prompt queue, prepared-but-unsent context chips (image bytes stay in the
// attachments stash; the row carries the file reference), and the composer
// draft. None of it is a cache of readable reality: agents reset knob
// state on session/load; the roots are the list this client intends to
// send at the next open (a session/list row may report the list the last
// writer set, and a reported list replaces the intended one, but the
// report is optional and most agents send none); and the rest is
// user-staged input that exists nowhere else — the same
// not-a-cache justification as the auth locks.
//
// A row has exactly one reader after a reload: the agent's own session/list
// naming the session again, after which the open ladder (load, then resume)
// brings it back. So a row exists only where that reader can come —
// `continuityReachable` is the one predicate, consulted by the writer and
// at connect — and it leaves with its session: close, a complete list walk
// no longer reporting it for its workspace, its agent removed or found
// unable to bring sessions back, zero-turn recreate, erase-all.
import { z } from "zod";
import type { DeclaredCapabilities, SessionContinuity } from "../../shared/protocol";
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
  // the composer's own form of the words — opaque here, like `draft` below
  draft: z.string().optional(),
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
  // The workspace the session belongs to: session/list is read per cwd, so
  // a reconcile can only judge the rows of the workspace it walked. Absent
  // only on rows written before the field existed — the first walk that
  // names such a row stamps it; one that does not drops it.
  cwd: z.string().min(1).optional(),
  knobs: knobSeedSchema.optional(),
  roots: z.array(z.string()).optional(),
  queue: z.array(queuedPromptSchema).optional(),
  chips: z.array(persistedChipSchema).optional(),
  draft: z.string().optional(),
});
export type SessionContinuityEntry = z.infer<typeof sessionContinuityEntrySchema>;

const KEY = "acpPatchbay.sessionContinuity";

const FIELDS = ["knobs", "roots", "queue", "chips", "draft"] as const;

/** Row identity is the PAIR: session ids are agent-minted, and two agents
 * minting the same string are two different sessions — a sessionId-only
 * key would let one agent's row destroy the other's. */
function rowId(agentId: string, sessionId: string): string {
  return `${agentId}\u0000${sessionId}`;
}

/** Whether a row written for this agent can ever be read back: its own
 * `session/list` must name the session after a reload, and the open ladder
 * needs a rung — `session/load` or `session/resume` — to bring it back.
 * Either alone reaches nothing: a list without a rung shows rows that
 * cannot open; a rung without a list has no id to open. */
export function continuityReachable(
  declared: Pick<DeclaredCapabilities, "sessionList" | "loadSession" | "sessionResume"> | null | undefined,
): boolean {
  return declared != null && declared.sessionList && (declared.loadSession || declared.sessionResume);
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
  }

  read(sessionId: string, agentId: string): SessionContinuity | undefined {
    const entry = this.get(rowId(agentId, sessionId));
    if (entry === undefined) return undefined;
    const { id: _i, agentId: _a, cwd: _c, ...fields } = entry;
    return fields;
  }

  /** Merge one or more fields into the session's row. Empty values (empty
   * array, empty string, empty object, undefined) delete their field; a
   * row with no fields left is removed entirely. Synchronous up to the KV
   * write (FileKV swaps memory before returning), so interleaved patches
   * never read each other mid-merge — a contract an async KV would break. */
  patch(sessionId: string, agentId: string, cwd: string, fields: SessionContinuity): Promise<void> {
    const id = rowId(agentId, sessionId);
    const existing = this.get(id);
    const base: SessionContinuityEntry = existing !== undefined ? { ...existing, cwd } : { id, agentId, cwd };
    for (const key of FIELDS) {
      if (!(key in fields)) continue;
      const value = fields[key];
      if (isEmpty(value)) delete base[key];
      else (base as Record<string, unknown>)[key] = value;
    }
    const hasFields = FIELDS.some((k) => base[k] !== undefined);
    return hasFields ? this.upsert(base) : this.remove(id);
  }

  forget(sessionId: string, agentId: string): Promise<void> {
    return this.remove(rowId(agentId, sessionId));
  }

  /** The agent's rows for one workspace against what its complete list
   * walk reported: a row `keep` rejects leaves. A row with no cwd on record
   * is judged by the same call — stamped when kept, dropped when not — since
   * no later walk could place it either. Other workspaces' rows are not
   * this walk's to judge. */
  reconcile(agentId: string, cwd: string, keep: (sessionId: string) => boolean): Promise<void> {
    return this.rewrite((current) =>
      current.flatMap((row) => {
        if (row.agentId !== agentId || (row.cwd !== undefined && row.cwd !== cwd)) return [row];
        if (!keep(row.id.slice(agentId.length + 1))) return [];
        return [row.cwd === undefined ? { ...row, cwd } : row];
      }),
    );
  }

  /** Every row of the agent, every workspace: the agent is gone, or its
   * handshake says no row of its sessions can ever be read back. */
  forgetAgent(agentId: string): Promise<void> {
    return this.rewrite((current) => current.filter((row) => row.agentId !== agentId));
  }
}
