// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A `session/update`, read into what patchbay takes from it. Every kind the
// protocol defines has one fate here, decided at compile time (the switch is
// exhaustive over the SDK's union): read into a fact a surface renders, or
// carried — shown as the agent sent it, its payload in the raw view, and
// noted — until a surface of its own is decided. Nothing an agent sends is
// dropped without a word.
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AvailableCommand, PlanEntry, PlanUsageInfo } from "../../shared/protocol";
import { planUsageOf } from "../meta";
import { present, readContent, type ContentFact } from "./content";
import type { Note } from "./notes";
import { readToolCall, readToolCallAnnounced, type ToolCallFact } from "./tool-call";

/** The prose channels: a user's message, an agent's message, its thought. */
export type ChunkChannel = "user" | "agent" | "thought";

export type SessionUpdateFact =
  | { kind: "chunk"; channel: ChunkChannel; messageId: string | null; content: ContentFact }
  /** `announced`: a `tool_call` — the call whole, defaults filled. */
  | { kind: "toolCall"; announced: boolean; call: ToolCallFact }
  | { kind: "plan"; entries: readonly PlanEntry[] }
  | { kind: "commands"; commands: readonly AvailableCommand[] }
  /** A context reading. `cost` absent = the agent didn't say this time. */
  | { kind: "usage"; used: number; size: number; cost?: { amount: number; currency: string }; plan?: PlanUsageInfo }
  | { kind: "info"; title?: string; updatedAt?: string }
  | { kind: "mode"; currentModeId: string }
  /** The whole config surface, in the knob normalizer's hands (knobs.ts
   * owns that shape's reading). */
  | { kind: "configOptions"; configOptions: unknown }
  /** A context compaction, by the agent's id for it. The spec's patch
   * rules: an absent field is unchanged; `summary` and `error` at `null`
   * clear (an empty summary clears too, read as `null`). */
  | { kind: "compaction"; compactionId: string; status: string; summary?: readonly ContentFact[] | null; error?: string | null }
  /** One content block appended to a compaction's summary. */
  | { kind: "compactionChunk"; compactionId: string; content: ContentFact }
  /** A notice: the agent telling the user something outside its answer.
   * Plain text; a missing or null description is none. */
  | { kind: "notice"; severity: string; title: string; description?: string }
  /** A kind no surface renders yet: its name and payload, shown raw. */
  | { kind: "carried"; updateKind: string; payload: unknown };

export function readSessionUpdate(update: SessionUpdate, note: Note): SessionUpdateFact {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return {
        kind: "chunk",
        channel: CHANNELS[update.sessionUpdate],
        messageId: update.messageId ?? null,
        content: readContent(update.content),
      };
    case "tool_call":
      return { kind: "toolCall", announced: true, call: readToolCallAnnounced(update) };
    case "tool_call_update":
      return { kind: "toolCall", announced: false, call: readToolCall(update) };
    case "plan":
      return { kind: "plan", entries: update.entries.map((e) => ({ content: e.content, status: e.status, ...present("priority", e.priority) })) };
    case "available_commands_update":
      return {
        kind: "commands",
        commands: update.availableCommands.map((c) => ({
          name: c.name,
          description: c.description,
          ...(c.input?.hint !== undefined ? { inputHint: c.input.hint } : {}),
        })),
      };
    case "usage_update": {
      const plan = planUsageOf(update._meta);
      return {
        kind: "usage",
        used: update.used,
        size: update.size,
        ...(update.cost != null ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {}),
        ...(plan !== null ? { plan } : {}),
      };
    }
    case "session_info_update":
      return { kind: "info", ...sessionMetaOf(update, note) };
    case "current_mode_update":
      return { kind: "mode", currentModeId: update.currentModeId };
    case "config_option_update":
      return { kind: "configOptions", configOptions: update.configOptions };
    case "compaction_update":
      return {
        kind: "compaction",
        compactionId: update.compactionId,
        status: update.status,
        ...(update.summary !== undefined ? { summary: update.summary === null || update.summary.length === 0 ? null : update.summary.map(readContent) } : {}),
        ...(update.error !== undefined ? { error: update.error } : {}),
      };
    case "compaction_summary_chunk":
      return { kind: "compactionChunk", compactionId: update.compactionId, content: readContent(update.content) };
    case "notice":
      return { kind: "notice", severity: update.severity, title: update.title, ...present("description", update.description) };
    // Each of these sits behind a client capability patchbay doesn't
    // declare — an agent that sends one anyway is shown, not silenced.
    case "plan_update":
    case "plan_removed":
    case "subagent_update":
    case "session_message":
    case "session_message_chunk": {
      const { sessionUpdate, ...payload } = update;
      note(`${sessionUpdate} has no surface yet — shown as the agent sent it`);
      return { kind: "carried", updateKind: sessionUpdate, payload };
    }
  }
}

const CHANNELS = {
  user_message_chunk: "user",
  agent_message_chunk: "agent",
  agent_thought_chunk: "thought",
} as const satisfies Record<string, ChunkChannel>;

/** A session's title and activity stamp, read one way for every message
 * that carries them (a `session/list` row, `session_info_update`): a title
 * when one came — null is a clear, taken as silence, since a blank row helps
 * no one — and a stamp when one came and parses. Absent rides as absent,
 * never as a reset. */
export function sessionMetaOf(
  info: { title?: string | null; updatedAt?: string | null },
  note: Note,
): { title?: string; updatedAt?: string } {
  let updatedAt = info.updatedAt;
  if (updatedAt != null && Number.isNaN(Date.parse(updatedAt))) {
    note("a session's updatedAt isn't a date — the stamp is ignored");
    updatedAt = null;
  }
  return { ...present("title", info.title), ...present("updatedAt", updatedAt) };
}
