// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The one compose point for wire-extension modules. Core call sites import
// only from here; adopting or retiring an extension edits only this directory. No
// registry, no loader — a spread of hand-named calls is the whole
// mechanism until ≥3 extensions demand shared machinery.
import type { KnobExtra } from "../knobs";
import type { SessionUpdateFact } from "../readers/session-update";
import { createAugmentSnippetRewriter } from "./augment-code-snippet";
import { sessionModelsExtras } from "./session-models-field";
import { createTodoWritePlanRewriter } from "./todowrite-plan";

/** Every extension-synthesized knob a raw session response carries
 * (session/new, /load, /resume). Each module degrades to absent on its
 * own, so this is safe on any agent's response. */
export function sessionKnobExtras(response: unknown): KnobExtra[] {
  return [...sessionModelsExtras(response)];
}

export { probeDeferredFor } from "./first-session-mcp-latch";

export { turnAuthFailureReasonOf } from "./turn-auth-failure";

/** A stateful text filter over one prose run's delta stream. `push` may
 * withhold a suffix that could still become a wire-extension shape;
 * whoever closes the run MUST `flush` so the tail lands (raw) instead of
 * vanishing. */
export interface ProseRewriter {
  push(text: string): string;
  flush(): string;
}

/** The rewriter an agent prose run's deltas pass through (the sessions store's
 * agent_message_chunk arm — the one wire site where agent prose becomes
 * render text). Each module's rewrite is shape-gated: text that isn't its
 * deviation passes through byte-identical, so this is safe on any agent's
 * stream. */
export function createProseRewriter(): ProseRewriter {
  return createAugmentSnippetRewriter();
}

/** A tool-call fact as it arrives, and what one can stand for. */
export type ToolCallReading = Extract<SessionUpdateFact, { kind: "toolCall" | "plan" }>;

/** A stateful filter over one session's tool-call facts. `push` may hold a
 * call back, or hand out the fact it stands for; whoever ends a turn or a
 * replay MUST `release`, so a held call lands as the agent sent it instead
 * of vanishing. */
export interface ToolCallRewriter {
  push(fact: Extract<SessionUpdateFact, { kind: "toolCall" }>): ToolCallReading[];
  release(): Extract<SessionUpdateFact, { kind: "toolCall" }>[];
}

/** The rewriter a session's tool-call facts pass through (the session
 * stream's toolCall arm). Each module is shape-gated: a call that isn't its
 * deviation passes through untouched, so this is safe on any agent's
 * stream. */
export function createToolCallRewriter(): ToolCallRewriter {
  return createTodoWritePlanRewriter();
}
