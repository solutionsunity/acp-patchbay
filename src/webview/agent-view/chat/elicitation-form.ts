// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The elicitation card's logic as pure functions — extracted for the
// reason composer-controls.ts and roots-controls.ts are: every state the
// card can be in is named in a test, never an inline render expression.
// For forms, the spec asks a client to validate before replying and to pre-fill
// declared defaults, and says accepted content should conform to the
// requested schema. So: a field the user left empty is omitted, never sent
// as "" (an unpicked choice would arrive as a value the agent never
// offered); a required one blocks Send; and every limit the form declares
// is checked on what would actually be sent.
import type { ElicitationBlock, ElicitationField } from "../../../shared/protocol";

/** Where a link card stands, from the user's answer and the agent's
 * follow-up together:
 *  - `ask`: not answered — address, warnings, Open / Decline / Cancel;
 *  - `waiting`: opened, the agent still waits on the page — Open again;
 *  - `opened`: opened, and the session stopped waiting on it;
 *  - `completed`: the agent reported the page done — whether or not the
 *    user ever clicked, since the agent can finish another way;
 *  - `settled`: declined, cancelled, or withdrawn. */
export type LinkCardPhase = "ask" | "waiting" | "opened" | "completed" | "settled";

export function linkCardPhase(block: Pick<ElicitationBlock, "resolution" | "linkState">): LinkCardPhase {
  if (block.linkState === "completed") return "completed";
  if (block.resolution === null) return "ask";
  if (block.resolution.outcome !== "accepted") return "settled";
  return block.linkState === "waiting" ? "waiting" : "opened";
}

/** What the user has in each field right now: text-like and choice fields
 * as the string the control holds ("" = nothing given), multi-choice as the
 * picked values. */
export type Draft = Readonly<Record<string, string | readonly string[]>>;

/** The card's starting state: each field at its declared default. A
 * boolean without one starts unanswered — showing "No" and sending nothing
 * would be two different truths. */
export function initialDraft(fields: readonly ElicitationField[]): Draft {
  const draft: Record<string, string | readonly string[]> = {};
  for (const f of fields) {
    if (f.type === "multiselect") draft[f.name] = Array.isArray(f.default) ? f.default : [];
    else draft[f.name] = f.default === undefined || Array.isArray(f.default) ? "" : String(f.default);
  }
  return draft;
}

function formatProblem(format: NonNullable<ElicitationField["format"]>, value: string): string | undefined {
  switch (format) {
    case "email":
      return /^[^\s@]+@[^\s@]+$/.test(value) ? undefined : "not an email address";
    case "uri":
      return URL.canParse(value) ? undefined : "not a URL";
    case "date": {
      // A real calendar day, not only the shape: 2026-13-40 fits the shape.
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      const day = m === null ? null : new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
      return day !== null && day.toISOString().startsWith(value) ? undefined : "not a date (YYYY-MM-DD)";
    }
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : "not a date and time";
  }
}

/** The agent's pattern, unanchored as JSON Schema reads it. One that
 * doesn't compile is the agent's bug, never held against the user. */
function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "u").test(value);
  } catch {
    return true;
  }
}

/** One field's typed value and its problem, if any. `undefined` value =
 * nothing given (left out of the answer). */
function check(f: ElicitationField, raw: string | readonly string[] | undefined): {
  value?: unknown;
  problem?: string;
} {
  if (f.type === "multiselect") {
    const picks = Array.isArray(raw) ? raw : [];
    // Required reads as "give an answer": for a multi-choice, at least one pick.
    if (picks.length === 0) return f.required ? { problem: "required" } : {};
    if (f.minItems !== undefined && picks.length < f.minItems) return { problem: `pick at least ${f.minItems}` };
    if (f.maxItems !== undefined && picks.length > f.maxItems) return { problem: `pick at most ${f.maxItems}` };
    return { value: [...picks] };
  }
  const text = typeof raw === "string" ? raw : "";
  if (text === "") return f.required ? { problem: "required" } : {};
  switch (f.type) {
    case "boolean":
      return { value: text === "true" };
    case "select":
      return (f.options ?? []).some((o) => o.value === text) ? { value: text } : { problem: "pick one of the options" };
    case "number":
    case "integer": {
      const n = Number(text);
      if (!Number.isFinite(n)) return { problem: "a number" };
      if (f.type === "integer" && !Number.isInteger(n)) return { problem: "a whole number" };
      if (f.minimum !== undefined && n < f.minimum) return { problem: `at least ${f.minimum}` };
      if (f.maximum !== undefined && n > f.maximum) return { problem: `at most ${f.maximum}` };
      return { value: n };
    }
    case "string": {
      const length = [...text].length;
      if (f.minLength !== undefined && length < f.minLength) return { problem: `at least ${f.minLength} characters` };
      if (f.maxLength !== undefined && length > f.maxLength) return { problem: `at most ${f.maxLength} characters` };
      if (f.pattern !== undefined && !matchesPattern(f.pattern, text)) {
        return { problem: "doesn't match the expected format" };
      }
      const formatted = f.format === undefined ? undefined : formatProblem(f.format, text);
      return formatted === undefined ? { value: text } : { problem: formatted };
    }
  }
}

/** What Send would carry, and what stops it: Send is allowed exactly when
 * `problems` is empty. */
export function answerOf(
  fields: readonly ElicitationField[],
  draft: Draft,
): { content: Record<string, unknown>; problems: Record<string, string> } {
  const content: Record<string, unknown> = {};
  const problems: Record<string, string> = {};
  for (const f of fields) {
    const { value, problem } = check(f, draft[f.name]);
    if (problem !== undefined) problems[f.name] = problem;
    else if (value !== undefined) content[f.name] = value;
  }
  return { content, problems };
}
