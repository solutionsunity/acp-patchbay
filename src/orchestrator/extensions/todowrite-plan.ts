// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Wire extension: a to-do list sent as a tool call instead of an ACP `plan`.
// OpenCode keeps its plan in its own `todowrite` tool and sends no `plan`
// update (1.18.35, wire-captured 2026-10-07). Every write is the whole list —
// the replace rule of a plan update — so the list IS the plan: a write that
// completes becomes the session's plan, and its tool card never shows.
//
// One write on the wire, live: a `tool_call` titled "todowrite", kind other,
// rawInput {} — the name is its only mark, no shape exists yet; then
// `in_progress` with rawInput.todos — the list PROPOSED, sent even after the
// user rejects the call, so never read as the plan; then `completed` with
// rawOutput.metadata.todos — the list the agent stored. Replayed by
// session/load, the announcement carries the list in rawInput and is titled
// "N todos" instead.
//
// So a call is held from its announcement — by the name (live) or the list's
// shape (replay) — and decided at its end. A completed write whose stored
// list reads becomes the plan. Anything else lands as the agent sent it,
// frames in order, and renders as any tool card: a failed or rejected write,
// a stored list that doesn't read, a call stranded when its turn ends (the
// holder MUST `release`). Entry words ride as said: `cancelled` is in ACP's
// draft vocabulary, and a word outside it is carried, never coerced.
//
// Adopted 2026-10-07. RETIRE when OpenCode sends `plan` updates (re-test on
// version change: ask for a to-do list and look for `plan` on the wire).
// Retirement = delete this file + its line in extensions/index.ts.
import { z } from "zod";
import type { PlanEntry } from "../../shared/protocol";
import type { ToolCallFact } from "../readers/tool-call";
import type { ToolCallReading, ToolCallRewriter } from "./index";

const TOOL_NAME = "todowrite";

const todoListSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      status: z.string().min(1),
      priority: z.string().min(1).optional(),
    }),
  ),
});

const storedSchema = z.object({ metadata: todoListSchema });

const isTodoWrite = (call: ToolCallFact): boolean =>
  call.kind === "other" && (call.title === TOOL_NAME || todoListSchema.safeParse(call.rawInput).success);

/** The plan a completed write stored, or null when its output doesn't read. */
function storedPlan(call: ToolCallFact): PlanEntry[] | null {
  const stored = storedSchema.safeParse(call.rawOutput);
  if (!stored.success) return null;
  return stored.data.metadata.todos.map((t) => ({
    content: t.content,
    status: t.status,
    ...(t.priority !== undefined ? { priority: t.priority } : {}),
  }));
}

export function createTodoWritePlanRewriter(): ToolCallRewriter {
  /** Held calls, by id: every frame so far, in arrival order. */
  const held = new Map<string, Extract<ToolCallReading, { kind: "toolCall" }>[]>();
  return {
    push(fact) {
      const id = fact.call.toolCallId;
      const frames = held.get(id);
      if (frames === undefined) {
        if (!fact.announced || !isTodoWrite(fact.call)) return [fact];
        held.set(id, [fact]);
        return [];
      }
      frames.push(fact);
      const status = fact.call.status;
      if (status !== "completed" && status !== "failed") return [];
      held.delete(id);
      const plan = status === "completed" ? storedPlan(fact.call) : null;
      return plan !== null ? [{ kind: "plan", entries: plan }] : frames;
    },
    release() {
      const frames = [...held.values()].flat();
      held.clear();
      return frames;
    },
  };
}
