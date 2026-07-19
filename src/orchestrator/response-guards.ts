// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// RESPONSE_GUARDS: the one table that says what patchbay trusts in an agent
// RPC response. The SDK validates outgoing request params and incoming
// notifications — responses arrive exactly as the agent shaped them, typed
// as if valid. Every response therefore crosses this table at pool.ts's one
// request chokepoint before anything downstream reads it: validate and
// degrade, never crash — the discipline the notification and _meta
// boundaries already have, applied to the last raw ingress.
//
// Table discipline (the capability proof table's sibling): an exhaustive
// Record over the SDK's request-method union — a new method refuses to
// compile until it gets an explicit entry — and no call site anywhere
// guards a response itself.
//
// Mechanism is check-and-spread, deliberately not schema-parse: a parse
// replaces the object and strips unknown keys, and raw-response passthrough
// is a declared door (a legacy `models` field on session/new, a
// terminal-auth recipe under an auth method's `_meta`) that a guard must
// never close. So each guard touches only the fields patchbay consumes:
// structural fields (identity, array-ness) drop the entry or fail the call;
// annotation fields degrade to absent; everything else rides through on the
// original object.
//
// Who guards what: this table owns response *structure*. The knob surface
// (modes/configOptions payloads) is guarded by its shape owner, knobs.ts —
// those fields pass through here raw. `session/list.nextCursor` also passes
// raw: degrading a malformed cursor to absent would turn a truncated walk
// into a "complete" one and license a wrongful prune — pagination policy
// belongs to the consumer.
//
// RETIRE when the SDK validates responses upstream (its schema layer
// already degrades notifications per the spec's deserialize annotations):
// delete this module plus its one call in pool.ts.
import type { AgentRequestMethod, AgentRequestResponsesByMethod } from "@agentclientprotocol/sdk";

type DropLog = (message: string) => void;

type Guard = (raw: unknown, log: DropLog) => unknown;

function record(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** Identity guard for responses patchbay never reads (empty-object
 * responses, and methods core never calls — extension modules going through
 * pool.unstableRequest own their shapes and never reach this table). */
const unconsumed: Guard = (raw) => raw;

/** A structurally unusable response fails the call honestly — same error
 * surface as any RPC failure, and the chokepoint's catch marks the
 * capability rows suspect on the way out. */
function structural(method: string, what: string): never {
  throw new Error(`malformed ${method} response — ${what}`);
}

/** One auth method entry: id/name are structural (a button needs both),
 * description degrades to absent, everything else — `type`, `_meta` (the
 * terminal-auth recipe site) — rides through on the original object. */
function guardAuthMethod(entry: unknown, log: DropLog): Record<string, unknown> | null {
  const e = record(entry);
  if (e === null || !isString(e.id) || e.id === "" || !isString(e.name)) {
    log("initialize: dropped malformed authMethods entry");
    return null;
  }
  return { ...e, description: isString(e.description) ? e.description : undefined };
}

/** One session/list row: identity (sessionId, cwd) is structural — a row
 * without it is dropped whole; title and updatedAt (the drawer's sort key)
 * degrade to absent so one malformed field can never poison the snapshot
 * the webview renders from. */
function guardListedSession(entry: unknown, log: DropLog): Record<string, unknown> | null {
  const e = record(entry);
  if (e === null || !isString(e.sessionId) || e.sessionId === "" || !isString(e.cwd)) {
    log("session/list: dropped malformed row");
    return null;
  }
  return {
    ...e,
    title: isString(e.title) ? e.title : undefined,
    updatedAt: isString(e.updatedAt) ? e.updatedAt : undefined,
  };
}

/** Turn usage is display-only — absence over fake: a malformed shape drops
 * wholesale rather than rendering invented numbers. */
function guardUsage(raw: unknown, log: DropLog): unknown {
  if (raw == null) return undefined;
  const u = record(raw);
  if (
    u === null ||
    typeof u.totalTokens !== "number" ||
    typeof u.inputTokens !== "number" ||
    typeof u.outputTokens !== "number"
  ) {
    log("session/prompt: malformed usage — dropped");
    return undefined;
  }
  return typeof u.cachedReadTokens === "number" || u.cachedReadTokens == null
    ? u
    : { ...u, cachedReadTokens: undefined };
}

/** Attach responses (session/load, /resume, set_config_option): nothing in
 * them is structural to patchbay — the knob payloads inside are the shape
 * owner's (knobs.ts) to guard — but a non-object response must still land
 * as an empty one, not a downstream property read on null. */
function guardAttachShaped(method: string): Guard {
  return (raw, log) => {
    if (record(raw) !== null) return raw;
    log(`${method}: response is not an object — treated as empty`);
    return {};
  };
}

const RESPONSE_GUARDS: Record<AgentRequestMethod, Guard> = {
  initialize: (raw, log) => {
    const r = record(raw) ?? structural("initialize", "not an object");
    const out = { ...r };
    if (r.authMethods != null) {
      if (Array.isArray(r.authMethods)) {
        out.authMethods = r.authMethods
          .map((entry) => guardAuthMethod(entry, log))
          .filter((entry) => entry !== null);
      } else {
        log("initialize: authMethods is not an array — treated as absent");
        delete out.authMethods;
      }
    }
    if (r.agentInfo != null) {
      const info = record(r.agentInfo);
      if (info === null) {
        log("initialize: agentInfo is not an object — treated as absent");
        delete out.agentInfo;
      } else if (!isString(info.name) || !isString(info.version)) {
        // version keys the used-capability cache — a non-string one must
        // become absent, never a garbage cache key
        log("initialize: malformed agentInfo name/version — treated as absent");
        delete out.agentInfo;
      }
    }
    return out;
  },
  // A session that cannot be addressed does not exist — identity is the
  // whole response, so there is nothing to degrade to.
  "session/new": (raw) => {
    const r = record(raw) ?? structural("session/new", "not an object");
    if (!isString(r.sessionId) || r.sessionId === "") structural("session/new", "no sessionId");
    return r;
  },
  "session/fork": (raw) => {
    const r = record(raw) ?? structural("session/fork", "not an object");
    if (!isString(r.sessionId) || r.sessionId === "") structural("session/fork", "no sessionId");
    return r;
  },
  "session/load": guardAttachShaped("session/load"),
  "session/resume": guardAttachShaped("session/resume"),
  "session/set_config_option": guardAttachShaped("session/set_config_option"),
  "session/list": (raw, log) => {
    const r = record(raw);
    if (r === null) {
      log("session/list: response is not an object — treated as empty");
      return { sessions: [] };
    }
    if (!Array.isArray(r.sessions)) {
      log("session/list: sessions is not an array — treated as empty");
      return { ...r, sessions: [] };
    }
    return {
      ...r, // nextCursor deliberately untouched — see header
      sessions: r.sessions
        .map((entry) => guardListedSession(entry, log))
        .filter((entry) => entry !== null),
    };
  },
  "session/prompt": (raw, log) => {
    const r = record(raw);
    if (r === null) {
      // The turn's content already streamed via notifications — failing the
      // whole prompt over a bad envelope would error a turn that happened.
      log("session/prompt: response is not an object — stop reason unknown");
      return { stopReason: "unknown" };
    }
    const out: Record<string, unknown> = { ...r, usage: guardUsage(r.usage, log) };
    if (!isString(r.stopReason) || r.stopReason === "") {
      log("session/prompt: malformed stopReason — recorded as unknown");
      out.stopReason = "unknown";
    }
    return out;
  },
  // Empty-object responses — patchbay reads nothing from them.
  authenticate: unconsumed,
  logout: unconsumed,
  "session/delete": unconsumed,
  "session/close": unconsumed,
  "session/set_mode": unconsumed,
  // Never called by core (no pool method exists); listed only because the
  // Record is exhaustive on purpose.
  "providers/list": unconsumed,
  "providers/set": unconsumed,
  "providers/disable": unconsumed,
  "nes/start": unconsumed,
  "nes/suggest": unconsumed,
  "nes/close": unconsumed,
};

/** The chokepoint call (pool.ts): every settled agent RPC's response passes
 * through its table entry before anyone reads it. A throw is structural
 * failure and rides the caller's normal error path. */
export function guardResponse<M extends AgentRequestMethod>(
  method: M,
  raw: unknown,
  log: DropLog,
): AgentRequestResponsesByMethod[M] {
  return RESPONSE_GUARDS[method](raw, log) as AgentRequestResponsesByMethod[M];
}
