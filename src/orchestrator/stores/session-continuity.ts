// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Per-session continuity — what the user staged and steered on a session,
// in one row: the last agent-confirmed knob combination, user-added context
// roots and MCP servers given to the session alone, the held prompt queue, staged context chips (an
// image's or a dropped file's bytes live in the session's own folder,
// stores/session-files.ts; the row carries the path), and the composer
// draft. None of it is a cache of readable reality: agents
// reset knob state on session/load; the roots are the list this client
// intends to send at the next open (a session/list row may report the list
// the last writer set, and a reported list replaces the intended one, but
// the report is optional and most agents send none); and the rest is
// user-staged input that exists nowhere else — the same not-a-cache
// justification as the auth locks.
//
// The row is these facts' one home — the sessions store reads it whenever
// it needs one and keeps no copy — so every session has one, whatever its
// agent declares. It leaves with its session: close, a complete list walk
// no longer reporting it for its workspace, its agent removed, erase-all;
// and for an agent that cannot list, its next connect drops the rows of
// this workspace no session of the window holds — no list will ever name
// them again. A zero-turn re-mint moves the row to the session's new id.
import { basename, join } from "node:path";
import { z } from "zod";
import type { PersistedChip, PromptPart, SessionContinuity } from "../../shared/protocol";
import { ATTACHMENTS_DIR, fileChipLabel } from "../attachments";
import { RecordStore } from "./global-record-store";
import { type KV, rewriteAtOpen } from "./kv";
import type { PatchbayAgentId, PatchbayMcpServerId } from "../../shared/ids";
import { savedId } from "./saved-id";
import { STORAGE_KEYS } from "./storage-keys";

const knobSeedSchema = z.record(z.string(), z.union([z.string(), z.boolean()]));

// a prompt box gave the chip its token — said once, kept with the chip
const placed = z.literal(true).optional();

const persistedChipSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["selection", "file", "diagnostics"]),
    id: z.string().min(1),
    label: z.string(),
    content: z.string(),
    sourceUri: z.string().optional(),
    placed,
  }),
  z.object({
    kind: z.literal("image"),
    id: z.string().min(1),
    label: z.string(),
    mimeType: z.string(),
    path: z.string(),
    placed,
  }),
  z.object({
    kind: z.literal("attachment"),
    id: z.string().min(1),
    label: z.string(),
    name: z.string(),
    path: z.string(),
    mimeType: z.string().optional(),
    placed,
  }),
]) satisfies z.ZodType<PersistedChip>;

const queuedPromptSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  parts: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("text"), text: z.string() }),
        z.object({ kind: z.literal("fileRef"), path: z.string() }),
        z.object({ kind: z.literal("chip"), id: z.string().min(1) }),
      ]) satisfies z.ZodType<PromptPart>,
    )
    .optional(),
  // the composer's own form of the words — opaque here, like `draft` below
  draft: z.string().optional(),
  // the chips these words place — theirs, whatever is staged after
  chips: z.array(persistedChipSchema).optional(),
  // a cut turn's words, waiting on the user — never fired on their own
  cut: z.literal(true).optional(),
});

/** Row identity is the PAIR — the agent and its own id for the session:
 * that is what names the session again after a reload, and two agents
 * minting the same string are two different sessions — a sessionId-only
 * key would let one agent's row destroy the other's. */
const sessionContinuityEntrySchema = z.object({
  patchbayAgentId: savedId<PatchbayAgentId>(),
  sessionId: z.string().min(1),
  // The workspace the session belongs to: session/list is read per cwd, so
  // a reconcile can only judge the rows of the workspace it walked. Absent
  // only on rows written before the field existed — the first walk that
  // names such a row stamps it; one that does not drops it.
  cwd: z.string().min(1).optional(),
  knobs: knobSeedSchema.optional(),
  roots: z.array(z.string()).optional(),
  mcpServers: z.array(savedId<PatchbayMcpServerId>()).optional(),
  queue: z.array(queuedPromptSchema).optional(),
  chips: z.array(persistedChipSchema).optional(),
  draft: z.string().optional(),
  forkedFrom: z.string().min(1).optional(),
});
export type SessionContinuityEntry = z.infer<typeof sessionContinuityEntrySchema>;

const KEY = STORAGE_KEYS.sessionContinuity;

/** Every field a row saves — keyed by the type, so a field added to
 * `SessionContinuity` and missing here fails the build instead of being
 * silently never saved. */
const SAVED: Record<keyof SessionContinuity, true> = {
  knobs: true,
  roots: true,
  mcpServers: true,
  queue: true,
  chips: true,
  draft: true,
  forkedFrom: true,
};
const FIELDS = Object.keys(SAVED) as (keyof SessionContinuity)[];

/** True when a field value carries nothing worth a row: absorbing these as
 * deletions keeps drained queues, sent chips, and cleared drafts from
 * leaving husk fields behind. */
function isEmpty(value: SessionContinuity[keyof SessionContinuity]): boolean {
  if (value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

const isRow = (row: SessionContinuityEntry, patchbayAgentId: PatchbayAgentId, sessionId: string) =>
  row.patchbayAgentId === patchbayAgentId && row.sessionId === sessionId;

export class SessionContinuityStore extends RecordStore<SessionContinuityEntry> {
  constructor(private readonly machine: KV) {
    super(machine, KEY, sessionContinuityEntrySchema);
    const kv = machine;
    // Once, at construction, where this key holds nothing yet: the rows an
    // earlier version kept under its own key are copied, never moved — a
    // window still on that version keeps reading and writing its key, and
    // a row in this one's shape would fail its schema there and be dropped
    // with everything it holds. Copied in today's shape: a row stored
    // before the pair had fields of its own carries it as one composite
    // `id` — the agent, a NUL, the agent's id for the session — next to an
    // `agentId`, and becomes `patchbayAgentId` and `sessionId`; an image
    // chip stored before a session kept its own files names its file in
    // the temp stash (`file`), and takes that file's `path`; an attached
    // file stored before a chip kept the file's own name takes it from its
    // label, which every such chip spelled "File: <name>"; and a held
    // prompt's chips, which had no place in its words and were sent ahead
    // of them, are placed there — in front. Every other field as stored.
    const earlier = kv.get<unknown>(STORAGE_KEYS.sessionContinuityBefore092);
    if (kv.get<unknown>(KEY) !== undefined || !Array.isArray(earlier)) return;
    const composite = (r: unknown): r is { id: string; agentId: string } =>
      typeof r === "object" &&
      r !== null &&
      "id" in r &&
      "agentId" in r &&
      typeof r.id === "string" &&
      typeof r.agentId === "string" &&
      r.id.startsWith(`${r.agentId}\u0000`);
    const stashedImage = (c: unknown): c is { kind: "image"; file: string } =>
      typeof c === "object" && c !== null && "kind" in c && c.kind === "image" && "file" in c && typeof c.file === "string";
    const unnamedFile = (c: unknown): c is { kind: "attachment"; label: string; path: string } =>
      typeof c === "object" &&
      c !== null &&
      "kind" in c &&
      c.kind === "attachment" &&
      !("name" in c) &&
      "label" in c &&
      typeof c.label === "string" &&
      "path" in c &&
      typeof c.path === "string";
    const listOf = (r: unknown, field: "chips" | "queue" | "parts"): unknown[] => {
      const list = typeof r === "object" && r !== null ? (r as Record<string, unknown>)[field] : undefined;
      return Array.isArray(list) ? list : [];
    };
    const fileLabel = fileChipLabel("");
    const chip = (c: unknown): unknown => {
      if (stashedImage(c)) {
        const { file, ...rest } = c;
        return { ...rest, path: join(ATTACHMENTS_DIR, file) };
      }
      if (unnamedFile(c)) {
        return { ...c, name: c.label.startsWith(fileLabel) ? c.label.slice(fileLabel.length) : basename(c.path) };
      }
      return c;
    };
    const held = (q: unknown): unknown => {
      const chips = listOf(q, "chips").map(chip);
      if (chips.length === 0) return q;
      const ids = chips.flatMap((c) =>
        typeof c === "object" && c !== null && "id" in c && typeof c.id === "string" ? [{ kind: "chip", id: c.id }] : [],
      );
      const words = listOf(q, "parts");
      const text = (q as { text?: unknown }).text;
      return { ...(q as object), chips, parts: [...ids, ...(words.length > 0 ? words : [{ kind: "text", text }])] };
    };
    rewriteAtOpen(kv.update(
      KEY,
      earlier.map((r: unknown) => {
        let row = r;
        if (composite(row)) {
          const { id, agentId, ...rest } = row;
          row = { patchbayAgentId: agentId, sessionId: id.slice(agentId.length + 1), ...rest };
        }
        const chips = listOf(row, "chips");
        const queue = listOf(row, "queue");
        return {
          ...(row as object),
          ...(chips.length > 0 ? { chips: chips.map(chip) } : {}),
          ...(queue.length > 0 ? { queue: queue.map(held) } : {}),
        };
      }),
    ));
  }

  /** Every row goes — the earlier version's copies with them. */
  override async wipe(): Promise<void> {
    await super.wipe();
    await this.machine.update(STORAGE_KEYS.sessionContinuityBefore092, undefined);
  }

  read(patchbayAgentId: PatchbayAgentId, sessionId: string): SessionContinuity | undefined {
    const entry = this.list().find((row) => isRow(row, patchbayAgentId, sessionId));
    if (entry === undefined) return undefined;
    const { patchbayAgentId: _a, sessionId: _s, cwd: _c, ...fields } = entry;
    return fields;
  }

  /** Merge one or more fields into the session's row. Empty values (empty
   * array, empty string, empty object, undefined) delete their field; a
   * row with no fields left is removed entirely. Synchronous up to the KV
   * write (FileKV swaps memory before returning), so interleaved patches
   * never read each other mid-merge — a contract an async KV would break. */
  patch(patchbayAgentId: PatchbayAgentId, sessionId: string, cwd: string, fields: SessionContinuity): Promise<void> {
    return this.rewrite((current) => {
      const index = current.findIndex((row) => isRow(row, patchbayAgentId, sessionId));
      const base: SessionContinuityEntry = index !== -1 ? { ...current[index]!, cwd } : { patchbayAgentId, sessionId, cwd };
      for (const key of FIELDS) {
        if (!(key in fields)) continue;
        const value = fields[key];
        if (isEmpty(value)) delete base[key];
        else (base as Record<string, unknown>)[key] = value;
      }
      const rest = current.filter((_, i) => i !== index);
      if (!FIELDS.some((k) => base[k] !== undefined)) return rest;
      if (index === -1) return [...rest, base];
      return current.map((row, i) => (i === index ? base : row));
    });
  }

  forget(patchbayAgentId: PatchbayAgentId, sessionId: string): Promise<void> {
    return this.rewrite((current) => current.filter((row) => !isRow(row, patchbayAgentId, sessionId)));
  }

  /** The agent's rows for one workspace against what its complete list
   * walk reported: a row `keep` rejects leaves. A row with no cwd on record
   * is judged by the same call — stamped when kept, dropped when not — since
   * no later walk could place it either. Other workspaces' rows are not
   * this walk's to judge. */
  reconcile(patchbayAgentId: PatchbayAgentId, cwd: string, keep: (sessionId: string) => boolean): Promise<void> {
    return this.rewrite((current) =>
      current.flatMap((row) => {
        if (row.patchbayAgentId !== patchbayAgentId || (row.cwd !== undefined && row.cwd !== cwd)) return [row];
        if (!keep(row.sessionId)) return [];
        return [row.cwd === undefined ? { ...row, cwd } : row];
      }),
    );
  }

  /** Every row of the agent, every workspace: the agent is gone. */
  forgetAgent(patchbayAgentId: PatchbayAgentId): Promise<void> {
    return this.rewrite((current) => current.filter((row) => row.patchbayAgentId !== patchbayAgentId));
  }
}
