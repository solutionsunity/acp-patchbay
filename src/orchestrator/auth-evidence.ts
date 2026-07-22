// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The authority table for agent auth state — the auth sibling of
// capabilities.ts's CAPABILITY_PROOFS: one place that knows which fact may
// move the locked/unlocked state, so no call site anywhere decides what a
// wire fact means for auth. Callers report evidence; this module returns
// the transition (or "unchanged"), and the orchestrator's single writer
// applies it.
//
// The core rule is evidence bearing. An RPC settling `auth_required` is
// always bearing (the wire said locked). An RPC *succeeding* bears only on
// the lock it contradicts: `session/prompt` exercises credentials on every
// agent, so it clears any lock; any other method's success clears only a
// lock that same method raised (a strict agent's session/new failure is
// honestly contradicted by a later session/new success). A method that
// never raised the lock proves nothing by succeeding — lazy-auth agents
// pass session/new without credentials, so its success must never clear a
// witnessed logout or a prompt-raised lock. `logout` succeeding is itself
// a lock: the user's explicit action, the strongest evidence there is.
// Patchbay's own login flows (authenticate round-trip, terminal login
// exiting 0) are affirmative auth actions and clear any lock.
import { methods } from "@agentclientprotocol/sdk";

/** A standing reason the agent is unusable without login. `loggedOut` is
 * patchbay-witnessed (the logout round-trip succeeded); `authRequired`
 * carries the method whose failure raised it — the key the same-method
 * clearing rule matches against. Persisted per agent (machine store) so a
 * reload or reconnect cannot launder it: the wire has no query that would
 * let this state be re-read, so the witnessed event is the only truth. */
export type AuthLock =
  | { kind: "loggedOut"; reason: string; at: string }
  | { kind: "authRequired"; method: string; reason: string | null; at: string };

export type AuthEvidence =
  /** An outgoing agent RPC settled successfully. */
  | { kind: "rpcOk"; method: string }
  /** An outgoing agent RPC settled `auth_required` (-32000). */
  | { kind: "authRequired"; method: string; reason: string | null }
  /** A terminal login flow (recipe or typed method) exited 0. */
  | { kind: "loginOk" }
  /** A terminal login flow exited non-zero. */
  | { kind: "loginFailed"; reason: string };

export const LOGGED_OUT_REASON =
  "logged out — the process was disconnected to clear its session; Connect to use this agent again";

/** Methods whose *success* exercises credentials on every agent and so
 * clears any lock. `authenticate` is the spec's own login call; a
 * completed prompt is the one wire fact even a lazy-auth agent cannot
 * produce while logged out (it is where such agents raise -32000). */
const CLEARS_ANY_LOCK = new Set<string>([
  methods.agent.authenticate,
  methods.agent.session.prompt,
]);

/** The lock a terminal login failure raises — a local method name, chosen
 * so no wire method's success can same-method-clear it (only an
 * affirmative login or a real prompt can). */
const TERMINAL_LOGIN = "terminal-login";

export type AuthTransition =
  | { changed: false }
  | { changed: true; lock: AuthLock | null };

/** Pure transition: current lock × evidence → next lock. Illegal or
 * non-bearing evidence yields `changed: false` — never a silent write. */
export function applyAuthEvidence(
  current: AuthLock | null,
  evidence: AuthEvidence,
  at: string,
): AuthTransition {
  switch (evidence.kind) {
    case "authRequired": {
      // The wire said locked — always bearing. A null wire reason keeps a
      // standing authRequired lock's reason (the agent's earlier
      // instruction beats no guidance) — but never the logout text: "the
      // process was disconnected; Connect to use it" on a running card
      // would be a lying instruction.
      const reason =
        evidence.reason ?? (current?.kind === "authRequired" ? current.reason : null);
      if (
        current?.kind === "authRequired" &&
        current.method === evidence.method &&
        current.reason === reason
      ) {
        return { changed: false };
      }
      return { changed: true, lock: { kind: "authRequired", method: evidence.method, reason, at } };
    }
    case "loginFailed":
      return {
        changed: true,
        lock: { kind: "authRequired", method: TERMINAL_LOGIN, reason: evidence.reason, at },
      };
    case "loginOk":
      return current === null ? { changed: false } : { changed: true, lock: null };
    case "rpcOk": {
      if (evidence.method === methods.agent.logout) {
        // Logout succeeding is not a clear — it is the strongest lock.
        if (current?.kind === "loggedOut") return { changed: false };
        return { changed: true, lock: { kind: "loggedOut", reason: LOGGED_OUT_REASON, at } };
      }
      if (current === null) return { changed: false };
      if (CLEARS_ANY_LOCK.has(evidence.method)) return { changed: true, lock: null };
      // Same-method contradiction: the method that raised the lock now
      // succeeded. Anything else — session/new on a lazy-auth agent being
      // the canonical case — bears nothing and is ignored.
      if (current.kind === "authRequired" && current.method === evidence.method) {
        return { changed: true, lock: null };
      }
      return { changed: false };
    }
  }
}
