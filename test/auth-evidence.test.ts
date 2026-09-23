// The auth authority table (auth-evidence.ts): per-transition coverage —
// which evidence may move the lock, and which bears nothing. The named
// scenarios at the bottom are the bugs this table exists to prevent.
import { describe, expect, it } from "vitest";
import {
  applyAuthEvidence,
  LOGGED_OUT_REASON,
  type AuthLock,
} from "../src/orchestrator/auth-evidence";

const AT = "2026-07-21T00:00:00.000Z";
/** An RPC that started after the lock was raised — evidence earned under it. */
const AFTER = "2026-07-21T00:00:01.000Z";
/** An RPC that started before the lock — evidence earned on pre-lock credentials. */
const BEFORE = "2026-07-20T23:59:59.000Z";
const loggedOut: AuthLock = { kind: "loggedOut", reason: LOGGED_OUT_REASON, at: AT };
const promptLock: AuthLock = {
  kind: "authRequired",
  method: "session/prompt",
  reason: "run `agent login`",
  at: AT,
};
const newLock: AuthLock = { kind: "authRequired", method: "session/new", reason: null, at: AT };

describe("locking evidence", () => {
  it("a wire auth_required always locks, carrying its method", () => {
    const r = applyAuthEvidence(null, { kind: "authRequired", method: "session/prompt", reason: "log in" }, AT);
    expect(r).toEqual({
      changed: true,
      lock: { kind: "authRequired", method: "session/prompt", reason: "log in", at: AT },
    });
  });

  it("a null wire reason keeps a standing authRequired lock's reason — earlier guidance beats none", () => {
    const r = applyAuthEvidence(promptLock, { kind: "authRequired", method: "session/new", reason: null }, AT);
    expect(r).toEqual({
      changed: true,
      lock: { kind: "authRequired", method: "session/new", reason: promptLock.reason, at: AT },
    });
  });

  it("the logout text is never inherited — 'Connect to use it' on a running card would be a lying instruction", () => {
    const r = applyAuthEvidence(loggedOut, { kind: "authRequired", method: "session/new", reason: null }, AT);
    expect(r).toEqual({
      changed: true,
      lock: { kind: "authRequired", method: "session/new", reason: null, at: AT },
    });
  });

  it("an identical re-raise is no transition — repeated -32000s don't flood the stream", () => {
    const again = applyAuthEvidence(
      promptLock,
      { kind: "authRequired", method: "session/prompt", reason: promptLock.reason },
      "2026-07-21T01:00:00.000Z",
    );
    expect(again.changed).toBe(false);
  });

  it("logout succeeding is the strongest lock, not a clear", () => {
    const r = applyAuthEvidence(null, { kind: "rpcOk", method: "logout", startedAt: BEFORE }, AT);
    expect(r).toEqual({ changed: true, lock: loggedOut });
    expect(applyAuthEvidence(loggedOut, { kind: "rpcOk", method: "logout", startedAt: AFTER }, AT).changed).toBe(false);
  });

  it("a failed terminal login locks under its local method — no wire success can same-method-clear it", () => {
    const r = applyAuthEvidence(null, { kind: "loginFailed", reason: "exit 1" }, AT);
    expect(r.changed && r.lock?.kind === "authRequired" && r.lock.method).toBe("terminal-login");
    const lock = r.changed ? r.lock! : null;
    expect(applyAuthEvidence(lock, { kind: "rpcOk", method: "session/new", startedAt: AFTER }, AT).changed).toBe(false);
  });
});

describe("clearing evidence", () => {
  it("authenticate and a completed prompt clear any lock — both exercise credentials on every agent", () => {
    for (const method of ["authenticate", "session/prompt"]) {
      for (const lock of [loggedOut, promptLock, newLock]) {
        expect(applyAuthEvidence(lock, { kind: "rpcOk", method, startedAt: AFTER }, AT)).toEqual({
          changed: true,
          lock: null,
        });
      }
    }
  });

  it("a terminal login exiting 0 clears any lock", () => {
    for (const lock of [loggedOut, promptLock, newLock]) {
      expect(applyAuthEvidence(lock, { kind: "loginOk" }, AT)).toEqual({ changed: true, lock: null });
    }
    expect(applyAuthEvidence(null, { kind: "loginOk" }, AT).changed).toBe(false);
  });

  it("same-method contradiction clears — a strict agent's session/new lock heals on the next session/new", () => {
    expect(applyAuthEvidence(newLock, { kind: "rpcOk", method: "session/new", startedAt: AFTER }, AT)).toEqual({
      changed: true,
      lock: null,
    });
  });
});

describe("non-bearing evidence — the bugs this table exists to prevent", () => {
  it("session/new success never clears a witnessed logout (the Claude reconnect-launder bug)", () => {
    expect(applyAuthEvidence(loggedOut, { kind: "rpcOk", method: "session/new", startedAt: AFTER }, AT).changed).toBe(false);
  });

  it("session/new success never clears a prompt-raised lock (the Verify-away flapping bug)", () => {
    expect(applyAuthEvidence(promptLock, { kind: "rpcOk", method: "session/new", startedAt: AFTER }, AT).changed).toBe(false);
  });

  it("unrelated successes bear nothing on an unlocked agent", () => {
    expect(applyAuthEvidence(null, { kind: "rpcOk", method: "session/new", startedAt: AFTER }, AT).changed).toBe(false);
    expect(applyAuthEvidence(null, { kind: "rpcOk", method: "session/list", startedAt: AFTER }, AT).changed).toBe(false);
  });

  // Evidence is earned when the RPC starts, not when it settles: a prompt
  // that left on pre-lock credentials says nothing about the lock raised
  // while it ran — whether that lock came from a sibling session's -32000
  // or from a witnessed logout (issue #35).
  it("a success that started before the lock was raised bears nothing — the stale-evidence launder", () => {
    for (const method of ["authenticate", "session/prompt"]) {
      for (const lock of [loggedOut, promptLock]) {
        expect(applyAuthEvidence(lock, { kind: "rpcOk", method, startedAt: BEFORE }, AT).changed).toBe(false);
      }
    }
    // same-method contradiction is subject to the same ordering
    expect(applyAuthEvidence(newLock, { kind: "rpcOk", method: "session/new", startedAt: BEFORE }, AT).changed).toBe(false);
    // started in the same instant the lock was written: not after it
    expect(applyAuthEvidence(promptLock, { kind: "rpcOk", method: "session/prompt", startedAt: AT }, AT).changed).toBe(false);
  });

  it("a wire auth_required locks whenever it settles — the wire said locked, order is irrelevant", () => {
    const r = applyAuthEvidence(null, { kind: "authRequired", method: "session/prompt", reason: null }, AT);
    expect(r.changed).toBe(true);
  });
});
