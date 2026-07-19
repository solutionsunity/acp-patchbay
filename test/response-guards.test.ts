// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The response trust boundary (response-guards.ts): every agent RPC
// response is validated-and-degraded at pool's request chokepoint. Pure
// table, so every rule is testable without a wire: structural fields fail
// or drop, annotations degrade to absent, and — the door that must stay
// open — unknown keys ride through untouched.
import { describe, expect, it } from "vitest";
import { guardResponse } from "../src/orchestrator/response-guards";

const drops = () => {
  const messages: string[] = [];
  return { messages, log: (m: string) => messages.push(m) };
};

describe("initialize", () => {
  it("a non-object response fails structurally", () => {
    const { log } = drops();
    expect(() => guardResponse("initialize", null, log)).toThrow(/malformed initialize/);
  });

  it("malformed authMethods entries drop singly; valid ones keep their unknown keys (_meta recipe site)", () => {
    const { messages, log } = drops();
    const guarded = guardResponse(
      "initialize",
      {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [
          { id: "login", name: "Log in", type: "terminal", _meta: { recipe: true } },
          null,
          { id: 42, name: "broken" },
          { name: "no id" },
        ],
      },
      log,
    );
    expect(guarded.authMethods).toHaveLength(1);
    expect(guarded.authMethods![0]).toMatchObject({ id: "login", _meta: { recipe: true } });
    expect(messages).toHaveLength(3);
  });

  it("authMethods that is not an array degrades to absent instead of killing connect", () => {
    const { log } = drops();
    const guarded = guardResponse("initialize", { protocolVersion: 1, authMethods: "nope" }, log);
    expect(guarded.authMethods).toBeUndefined();
  });

  it("a malformed agentInfo degrades to absent — never a garbage version cache key", () => {
    const { log } = drops();
    expect(
      guardResponse("initialize", { protocolVersion: 1, agentInfo: { name: "x", version: 7 } }, log)
        .agentInfo,
    ).toBeUndefined();
    expect(
      guardResponse("initialize", { protocolVersion: 1, agentInfo: "v1" }, log).agentInfo,
    ).toBeUndefined();
  });

  it("unknown top-level keys pass through (raw-response doors stay open)", () => {
    const { log } = drops();
    const guarded = guardResponse("initialize", { protocolVersion: 1, vendorExtra: { a: 1 } }, log);
    expect((guarded as Record<string, unknown>).vendorExtra).toEqual({ a: 1 });
  });
});

describe("session/new and session/fork — identity is structural", () => {
  it("no usable sessionId fails the call", () => {
    const { log } = drops();
    expect(() => guardResponse("session/new", { sessionId: 42 }, log)).toThrow(/no sessionId/);
    expect(() => guardResponse("session/fork", {}, log)).toThrow(/no sessionId/);
    expect(() => guardResponse("session/new", null, log)).toThrow(/not an object/);
  });

  it("a valid response passes through whole — models field and all", () => {
    const { log } = drops();
    const raw = { sessionId: "s1", models: { availableModels: [] }, configOptions: "raw-for-knobs" };
    expect(guardResponse("session/new", raw, log)).toBe(raw);
  });
});

describe("session/list", () => {
  it("identity-less rows drop; bad sort keys degrade; row extras survive", () => {
    const { messages, log } = drops();
    const guarded = guardResponse(
      "session/list",
      {
        sessions: [
          { sessionId: "a", cwd: "/w", title: "ok", updatedAt: "2026-07-19T00:00:00Z" },
          { sessionId: "b", cwd: "/w", updatedAt: 1752900000, _meta: { keep: 1 } },
          { cwd: "/w", title: "no identity" },
          "garbage",
        ],
        nextCursor: "p2",
      },
      log,
    );
    expect(guarded.sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
    expect(guarded.sessions[1]).toMatchObject({ updatedAt: undefined, _meta: { keep: 1 } });
    expect(guarded.nextCursor).toBe("p2");
    expect(messages).toHaveLength(2);
  });

  it("a malformed cursor passes through untouched — truncation policy is the consumer's", () => {
    const { log } = drops();
    const guarded = guardResponse("session/list", { sessions: [], nextCursor: 99 }, log);
    expect((guarded as Record<string, unknown>).nextCursor).toBe(99);
  });

  it("non-array sessions / non-object response degrade to empty, never throw", () => {
    const { log } = drops();
    expect(guardResponse("session/list", { sessions: "x" }, log).sessions).toEqual([]);
    expect(guardResponse("session/list", null, log).sessions).toEqual([]);
  });
});

describe("session/prompt", () => {
  it("malformed stopReason records as unknown; malformed usage drops (absence over fake)", () => {
    const { log } = drops();
    const guarded = guardResponse(
      "session/prompt",
      { stopReason: 7, usage: { totalTokens: "many" } },
      log,
    );
    expect(guarded.stopReason).toBe("unknown");
    expect(guarded.usage).toBeUndefined();
  });

  it("valid usage passes; a malformed cachedReadTokens degrades alone", () => {
    const { log } = drops();
    const usage = { totalTokens: 10, inputTokens: 6, outputTokens: 4, cachedReadTokens: "x" };
    const guarded = guardResponse("session/prompt", { stopReason: "end_turn", usage }, log);
    expect(guarded.usage).toMatchObject({ totalTokens: 10, cachedReadTokens: undefined });
  });

  it("a non-object response still ends the turn honestly", () => {
    const { log } = drops();
    expect(guardResponse("session/prompt", null, log)).toEqual({ stopReason: "unknown" });
  });
});

describe("attach-shaped responses degrade to empty objects", () => {
  it("session/load, session/resume, set_config_option: null becomes {} (knob payloads stay raw for knobs.ts)", () => {
    const { log } = drops();
    expect(guardResponse("session/load", null, log)).toEqual({});
    expect(guardResponse("session/resume", undefined, log)).toEqual({});
    expect(guardResponse("session/set_config_option", "x", log)).toEqual({});
    const raw = { modes: "raw", configOptions: [{ broken: true }] };
    expect(guardResponse("session/load", raw, log)).toBe(raw);
  });
});
