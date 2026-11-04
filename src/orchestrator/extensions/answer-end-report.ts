// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Wire extension: the end of an answer, reported on a usage update. A turn
// ends when `session/prompt` answers, and claude-agent-acp keeps that answer
// back while a background sub-agent the turn set going is alive — though the
// agent's answer is over, and a second `session/prompt` is taken at once and
// settles the first. So a session reads as busy, and the user's words wait,
// for as long as the sub-agent runs. What the bridge does say is
// `_meta["_claude/origin"]` on the usage update it sends at each of the
// model's results: `human` when the user's prompt is what it answered,
// `task-notification` when it woke by itself because background work ended.
//
// Shape-gated, and only the two kinds seen on the wire: any other kind, or
// the key gone, is no report at all, and a session behaves as the spec has
// it — its turn ends when the prompt answers.
//
// Adopted 2026-11-04 (claude-agent-acp 0.100.0). RETIRE when the bridge
// answers `session/prompt` at the turn's result for a client declaring
// `subagents` — delete this file and its line in extensions/index.ts; the
// `answerEnd` fact goes with it, and an answer with no turn open is then
// known by arriving outside one.
import { z } from "zod";

const report = z.object({ "_claude/origin": z.object({ kind: z.enum(["human", "task-notification"]) }) });

/** What ended: the answer to the user's prompt, or one the agent gave
 * unprompted — null when the update doesn't say. */
export function answerEndOf(meta: unknown): "prompted" | "unprompted" | null {
  const read = report.safeParse(meta);
  if (!read.success) return null;
  return read.data["_claude/origin"].kind === "human" ? "prompted" : "unprompted";
}
