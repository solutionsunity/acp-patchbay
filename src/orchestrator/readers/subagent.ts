// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A sub-agent's association and the messages sessions send each other, read
// into what patchbay takes from them. Both are upserts under the spec's
// patch rules: an absent field leaves what was stored, `null` clears it, a
// value replaces it whole — so absent rides as absent and null as null,
// never one standing in for the other.
import { isAbsolute } from "node:path";
import { RequestError, type SessionMessage, type SessionMessageChunk, type SubagentUpdate } from "../acp";
import { agentErrorText } from "./agent-error";
import { readContent, type ContentFact } from "./content";
import type { Note } from "./notes";

/** A sub-agent's current work, as reported: `running`, `requires_action`,
 * `idle`, `unknown`, or a value the spec leaves open — kept as sent.
 * `stopReason` and `error` only ever ride an idle report. */
export interface SubagentStateFact {
  state: string;
  stopReason?: string;
  /** Why its work failed, read whole — on an idle report stopped by error. */
  error?: string;
}

/** The fields of a sub-agent's association one update patches. */
export interface SubagentPatch {
  title?: string | null;
  description?: string | null;
  /** What the user may do to it — replaced whole; `null` or `{}` grant
   * nothing. */
  capabilities?: { cancel: boolean } | null;
  state?: SubagentStateFact | null;
  cwd?: string | null;
  additionalDirectories?: readonly string[] | null;
}

export interface SubagentFact {
  kind: "subagent";
  /** The agent's id for the child — the outer session is its parent. */
  childSessionId: string;
  patch: SubagentPatch;
}

/** The fields of a session-directed message one upsert patches. */
export interface SessionMessagePatch {
  senderSessionId?: string | null;
  recipientSessionId?: string | null;
  senderMessageId?: string | null;
  recipientMessageId?: string | null;
  /** Replaces the content whole; `null` and `[]` clear it. */
  content?: readonly ContentFact[] | null;
}

export interface SessionMessageFact {
  kind: "sessionMessage";
  messageId: string;
  patch: SessionMessagePatch;
}

export interface SessionMessageChunkFact {
  kind: "sessionMessageChunk";
  messageId: string;
  content: ContentFact;
}

export function readSubagentUpdate(update: SubagentUpdate, note: Note): SubagentFact {
  return {
    kind: "subagent",
    childSessionId: update.sessionId,
    patch: {
      ...patched("title", update.title),
      ...patched("description", update.description),
      ...readPatched("capabilities", update.capabilities, (c) => ({ cancel: c.cancel != null })),
      ...readPatched("state", update.state, readState),
      ...readPatched("cwd", update.cwd, (cwd) => {
        if (isAbsolute(cwd)) return cwd;
        note("a sub-agent's cwd isn't an absolute path — it inherits its parent's");
        return null;
      }),
      ...readPatched("additionalDirectories", update.additionalDirectories, (dirs) => {
        const absolute = dirs.filter((d) => isAbsolute(d));
        if (absolute.length < dirs.length) note("a sub-agent's additional directory isn't an absolute path — left out");
        return absolute;
      }),
    },
  };
}

function readState(state: NonNullable<SubagentUpdate["state"]>): SubagentStateFact {
  const { stopReason, error } = state as { stopReason?: unknown; error?: unknown };
  return {
    state: state.state,
    ...(state.state === "idle" && typeof stopReason === "string" ? { stopReason } : {}),
    ...(state.state === "idle" && stopReason === "error" && error != null ? { error: errorText(error) } : {}),
  };
}

/** A JSON-RPC error object, read the one way every agent error is. */
function errorText(error: unknown): string {
  const { code, message, data } = (typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown; data?: unknown };
  return agentErrorText(new RequestError(typeof code === "number" ? code : -32603, typeof message === "string" ? message : "failed", data));
}

export function readSessionMessage(update: SessionMessage): SessionMessageFact {
  return {
    kind: "sessionMessage",
    messageId: update.messageId,
    patch: {
      ...patched("senderSessionId", update.senderSessionId),
      ...patched("recipientSessionId", update.recipientSessionId),
      ...patched("senderMessageId", update.senderMessageId),
      ...patched("recipientMessageId", update.recipientMessageId),
      ...readPatched("content", update.content, (content) => (content.length === 0 ? null : content.map(readContent))),
    },
  };
}

export function readSessionMessageChunk(update: SessionMessageChunk): SessionMessageChunkFact {
  return { kind: "sessionMessageChunk", messageId: update.messageId, content: readContent(update.content) };
}

/** One field under the patch rules: absent stays absent, null rides as
 * null, a value as it came. */
function patched<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V | null } {
  return readPatched(key, value, (v) => v);
}

/** The same, the value read. */
function readPatched<K extends string, V, R>(key: K, value: V | null | undefined, read: (value: V) => R | null): { [P in K]?: R | null } {
  if (value === undefined) return {};
  return { [key]: value === null ? null : read(value) } as { [P in K]?: R | null };
}
