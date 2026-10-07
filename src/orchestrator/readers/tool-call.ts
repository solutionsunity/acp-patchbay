// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A tool call, read once for both places it arrives: the session's stream
// (`tool_call`, `tool_call_update`) and a permission request, which carries
// the same update shape for the call it asks about. An update says only what
// changed — every absent field is unchanged, never a default. Only an
// announcement (`tool_call`) has defaults, the spec's own: pending, other.
import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { ToolCallKind, ToolCallStatus, ToolLocation } from "../../shared/protocol";
import { agentTerminalOf, type AgentTerminalReading } from "../meta";
import { present, readToolContent, type ToolContentFact } from "./content";

export interface ToolCallFact {
  toolCallId: string;
  title?: string;
  kind?: ToolCallKind;
  status?: ToolCallStatus;
  /** The tool's own name (the title is the human one). */
  name?: string;
  /** The wire payloads, as the agent shaped them — present iff sent. */
  rawInput?: unknown;
  rawOutput?: unknown;
  /** When present, replaces the collection — ACP's rule for both. */
  locations?: readonly ToolLocation[];
  content?: readonly ToolContentFact[];
  /** The call's `_meta`, for the extension modules that read vendor fields. */
  meta?: Readonly<Record<string, unknown>>;
  /** A terminal the agent runs itself, as its `_meta` reports it. */
  terminal?: AgentTerminalReading;
}

/** `tool_call`: the call announced whole — the spec's defaults fill what it
 * leaves out. */
export function readToolCallAnnounced(call: ToolCall): ToolCallFact & { title: string; kind: ToolCallKind; status: ToolCallStatus } {
  return { ...readToolCall(call), title: call.title, kind: call.kind ?? "other", status: call.status ?? "pending" };
}

/** `tool_call_update`, or the call a permission request asks about. */
export function readToolCall(call: ToolCallUpdate | ToolCall): ToolCallFact {
  return {
    toolCallId: call.toolCallId,
    // An empty title names nothing — taken as not sent, so a card keeps the
    // title it has.
    ...present("title", call.title || null),
    ...present("kind", call.kind),
    ...present("status", call.status),
    ...present("name", call.name),
    ...present("rawInput", call.rawInput),
    ...present("rawOutput", call.rawOutput),
    ...(call.locations != null ? { locations: readLocations(call.locations) } : {}),
    ...(call.content != null ? { content: readToolContent(call.content) } : {}),
    ...present("meta", call._meta),
    ...present("terminal", agentTerminalOf(call._meta)),
  };
}

/** ACP gives each location an absolute path and an optional line but never
 * says what the line counts from. The agents that send one count from 1 — a
 * whole-file read reports line 1, the top — so a line here is 1-based, and
 * 0 is taken as the first line rather than dropped. */
function readLocations(wire: readonly { path: string; line?: number | null }[]): ToolLocation[] {
  return wire.map((l) => ({ path: l.path, line: l.line == null ? null : Math.max(1, l.line) }));
}
