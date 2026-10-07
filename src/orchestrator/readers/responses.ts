// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The agent's answers to patchbay's session requests, read. A response
// arrives unvalidated (wire-shape.ts), so each reader checks what it takes:
// identity is structural — a session/new without a sessionId fails its
// call — and everything else degrades to absent, noted, never to a guess.
// An absent field is unchanged: an attach that says nothing about the
// session's knobs leaves them as they stand.
import type { TurnUsage } from "../../shared/protocol";
import { sessionKnobExtras } from "../extensions";
import { normalizeKnobs, type NormalizedKnobs } from "../knobs";
import type { Note } from "./notes";
import { isString, record, structural } from "./wire-shape";

/** session/new, session/fork: the session the agent made, and the knobs it
 * offers there. */
export interface SessionOpenedFact {
  sessionId: string;
  knobs?: NormalizedKnobs;
}

/** session/load, session/resume: the knobs the agent offers on the
 * reattached session — absent when the answer names none. */
export interface SessionAttachedFact {
  knobs?: NormalizedKnobs;
}

/** One row of the agent's session list. Identity (sessionId, cwd) is the
 * row; the rest is what the agent said, when it said it. */
export interface ListedSessionFact {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  /** Absent = not reported, which never clears a session's roots. */
  additionalDirectories?: readonly string[];
}

export interface SessionListFact {
  sessions: readonly ListedSessionFact[];
  /** Where the walk goes next: done, the next page, or a cursor that can't
   * be sent back — which truncates the walk, never reads as done. */
  next: { kind: "end" } | { kind: "more"; cursor: string } | { kind: "unreadable" };
}

/** session/prompt: why the turn ended — the agent's own word, or "unknown"
 * when it gave none — and what it cost, when it said. */
export interface TurnEndFact {
  stopReason: string;
  usage?: TurnUsage;
}

/** session/set_config_option: the config surface the agent answered with,
 * in the knob normalizer's hands — absent when the answer carried none. */
export interface ConfigSetFact {
  configOptions?: unknown;
}

export const readSessionOpened =
  (method: "session/new" | "session/fork") =>
  (raw: unknown, note: Note): SessionOpenedFact => {
    // A session that cannot be addressed does not exist — identity is the
    // whole response, so there is nothing to degrade to.
    const r = record(raw) ?? structural(method, "not an object");
    if (!isString(r.sessionId) || r.sessionId === "") structural(method, "no sessionId");
    const knobs = knobsOf(r, note);
    return { sessionId: r.sessionId, ...(knobs !== undefined ? { knobs } : {}) };
  };

export const readSessionAttached =
  (method: "session/load" | "session/resume") =>
  (raw: unknown, note: Note): SessionAttachedFact => {
    const r = record(raw);
    if (r === null) {
      note(`${method}: the answer isn't an object — read as naming no knobs`);
      return {};
    }
    const knobs = knobsOf(r, note);
    return knobs !== undefined ? { knobs } : {};
  };

export function readSessionList(raw: unknown, note: Note): SessionListFact {
  const r = record(raw);
  if (r === null || !Array.isArray(r.sessions)) {
    // Nothing to page through either: the walk ends without a prune.
    note("session/list: the answer carries no session array — read as an unreadable page");
    return { sessions: [], next: { kind: "unreadable" } };
  }
  const next: SessionListFact["next"] =
    r.nextCursor == null ? { kind: "end" } : isString(r.nextCursor) ? { kind: "more", cursor: r.nextCursor } : { kind: "unreadable" };
  if (next.kind === "unreadable") note("session/list: nextCursor isn't a string — the walk stops there");
  return { sessions: r.sessions.flatMap((entry) => readListedSession(entry, note)), next };
}

export function readTurnEnd(raw: unknown, note: Note): TurnEndFact {
  const r = record(raw);
  if (r === null) {
    // The turn's content already streamed — failing the prompt over a bad
    // envelope would error a turn that happened.
    note("session/prompt: the answer isn't an object — the turn ends with an unknown stop reason");
    return { stopReason: "unknown" };
  }
  let stopReason = r.stopReason;
  if (!isString(stopReason) || stopReason === "") {
    note("session/prompt: no stop reason — the turn ends as unknown");
    stopReason = "unknown";
  }
  const usage = readUsage(r.usage, note);
  return { stopReason: stopReason as string, ...(usage !== undefined ? { usage } : {}) };
}

export function readConfigSet(raw: unknown, note: Note): ConfigSetFact {
  const r = record(raw);
  if (r === null || r.configOptions === undefined) {
    // The spec requires the full surface here; without it the new state is
    // unknown, and the knobs stay as they stand.
    note("session/set_config_option: the answer carries no configOptions — the knobs stay as they were");
    return {};
  }
  return { configOptions: r.configOptions };
}

/** For answers patchbay reads nothing from (authenticate, logout, delete,
 * close, set_mode — the last because a bridge may report a rejected change
 * as made; the agent's own notification is the confirmation). */
export function readNothing(): void {}

/** A session response's knob surface, through the one normalizer —
 * spec surfaces plus extension-owned extras; undefined when the response
 * carries none of them at all. */
function knobsOf(r: Record<string, unknown>, note: Note): NormalizedKnobs | undefined {
  const extras = sessionKnobExtras(r);
  if (r.modes == null && r.configOptions == null && extras.length === 0) return undefined;
  return normalizeKnobs(r.modes, r.configOptions, extras, note);
}

/** Title, stamp and roots degrade to absent so one malformed field can never
 * poison the row; absent roots read as "not reported". */
function readListedSession(entry: unknown, note: Note): ListedSessionFact[] {
  const e = record(entry);
  if (e === null || !isString(e.sessionId) || e.sessionId === "" || !isString(e.cwd)) {
    note("session/list: a row without a sessionId and a cwd — dropped");
    return [];
  }
  const dirs = e.additionalDirectories;
  let additionalDirectories: string[] | undefined;
  if (dirs != null) {
    if (Array.isArray(dirs) && dirs.every((d) => isString(d) && d !== "")) additionalDirectories = dirs as string[];
    else note("session/list: a row's additionalDirectories isn't a list of paths — read as not reported");
  }
  return [
    {
      sessionId: e.sessionId,
      cwd: e.cwd,
      ...(isString(e.title) ? { title: e.title } : {}),
      ...(isString(e.updatedAt) ? { updatedAt: e.updatedAt } : {}),
      ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
    },
  ];
}

/** Turn usage is display-only — absence over fake: a shape missing its
 * required counts drops whole rather than rendering invented numbers. */
function readUsage(raw: unknown, note: Note): TurnUsage | undefined {
  if (raw == null) return undefined;
  const u = record(raw);
  if (u === null || typeof u.totalTokens !== "number" || typeof u.inputTokens !== "number" || typeof u.outputTokens !== "number") {
    note("session/prompt: usage without its counts — not shown");
    return undefined;
  }
  const count = (key: string, as: "cached" | "cacheWrite" | "thought") => (typeof u[key] === "number" ? { [as]: u[key] } : {});
  return {
    total: u.totalTokens,
    input: u.inputTokens,
    output: u.outputTokens,
    ...count("cachedReadTokens", "cached"),
    ...count("cachedWriteTokens", "cacheWrite"),
    ...count("thoughtTokens", "thought"),
  };
}
