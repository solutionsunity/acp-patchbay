// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The agent's answers, read (readers/initialize.ts, readers/responses.ts):
// a response arrives unvalidated, so its reader checks what it takes.
// Identity is structural — a session without an id fails its call — and
// everything else degrades to absent, noted, never to a guess; an answer
// that says nothing about a fact leaves it as it stands.
import { describe, expect, it } from "vitest";
import { readInitialize } from "../src/orchestrator/readers/initialize";
import {
  readConfigSet,
  readSessionAttached,
  readSessionList,
  readSessionOpened,
  readTurnEnd,
} from "../src/orchestrator/readers/responses";

const notes = () => {
  const said: string[] = [];
  return { said, note: (m: string) => said.push(m) };
};

describe("initialize", () => {
  it("a non-object answer fails structurally", () => {
    expect(() => readInitialize(null, () => {})).toThrow(/malformed initialize/);
  });

  it("an auth method without an id and a name drops alone; the rest keep their kind and how they run", () => {
    const { said, note } = notes();
    const fact = readInitialize(
      {
        protocolVersion: 1,
        authMethods: [
          { id: "login", name: "Log in", type: "terminal", args: ["--cli"] },
          { id: "auggie", name: "Auggie", _meta: { "terminal-auth": { command: "auggie", args: ["login"] } } },
          null,
          { id: 42, name: "broken" },
          { name: "no id" },
        ],
      },
      note,
    );
    expect(fact.declared.authMethods.map((m) => [m.id, m.kind])).toEqual([
      ["login", "terminal"],
      ["auggie", "terminal-recipe"],
    ]);
    expect(fact.logins.get("login")).toEqual({ via: "terminal", auth: { args: ["--cli"], env: {} } });
    expect(fact.logins.get("auggie")).toMatchObject({ via: "recipe", recipe: { command: "auggie" } });
    expect(said).toHaveLength(3); // one per dropped entry — NoteLog says the repeat once
  });

  // The shapes agents send a client declaring both auth.terminal and
  // _meta["terminal-auth"]: a typed method may carry the recipe too — the
  // copy for clients without auth.terminal — and the spec path is the one
  // meant for this client; a type-less method's recipe is its only login.
  it("a typed terminal method runs the spec way even when it carries a recipe; a type-less one runs its recipe (#93)", () => {
    const recipe = { "terminal-auth": { command: "opencode", args: ["auth", "login"] } };
    const fact = readInitialize(
      {
        protocolVersion: 1,
        authMethods: [
          { id: "both", name: "OpenCode 2.x", type: "terminal", args: ["--login"], _meta: recipe },
          { id: "recipe", name: "OpenCode 1.x", _meta: recipe },
          { id: "broken", name: "Malformed typed", type: "terminal", args: "--login", _meta: recipe },
          { id: "agent", name: "Codex" },
        ],
      },
      () => {},
    );
    expect(fact.declared.authMethods.map((m) => [m.id, m.kind])).toEqual([
      ["both", "terminal"],
      ["recipe", "terminal-recipe"],
      ["broken", "terminal-recipe"],
      ["agent", "agent"],
    ]);
    expect(fact.logins.get("both")).toEqual({ via: "terminal", auth: { args: ["--login"], env: {} } });
    expect(fact.logins.get("recipe")).toMatchObject({ via: "recipe", recipe: { command: "opencode", args: ["auth", "login"] } });
    expect(fact.logins.get("broken")).toMatchObject({ via: "recipe" });
    expect(fact.logins.has("agent")).toBe(false);
  });

  it("authMethods that isn't an array reads as none instead of killing connect", () => {
    expect(readInitialize({ protocolVersion: 1, authMethods: "nope" }, () => {}).declared.authMethods).toEqual([]);
  });

  it("a malformed name never costs the version — the used-capability cache's key (#80)", () => {
    const { said, note } = notes();
    expect(readInitialize({ protocolVersion: 1, agentInfo: { name: 7, version: "1.2.0" } }, note).agentInfo).toEqual({ version: "1.2.0" });
    expect(readInitialize({ protocolVersion: 1, agentInfo: { name: "x", version: 7 } }, note).agentInfo).toEqual({ name: "x" });
    expect(readInitialize({ protocolVersion: 1, agentInfo: "v1" }, note).agentInfo).toEqual({});
    expect(said.length).toBeGreaterThan(0);
  });

  it("a capability is declared only in its own shape — false, 0 or a string declares nothing (#80)", () => {
    const { said, note } = notes();
    const { declared } = readInitialize(
      {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: "yes",
          sessionCapabilities: { fork: false, list: {}, close: 0, delete: null },
          promptCapabilities: { image: true, audio: 1 },
          auth: { logout: {} },
        },
      },
      note,
    );
    expect(declared).toMatchObject({
      loadSession: false,
      sessionFork: false,
      sessionList: true,
      sessionClose: false,
      sessionDelete: false,
      promptImage: true,
      promptAudio: false,
      authLogout: true,
    });
    expect(said).toEqual([
      "initialize: loadSession isn't a boolean — read as not declared",
      "initialize: sessionCapabilities.fork isn't an object — read as not declared",
      "initialize: sessionCapabilities.close isn't an object — read as not declared",
      "initialize: promptCapabilities.audio isn't a boolean — read as not declared",
    ]);
  });
});

describe("session/new and session/fork — identity is structural", () => {
  it("no usable sessionId fails the call", () => {
    expect(() => readSessionOpened("session/new")({ sessionId: 42 }, () => {})).toThrow(/no sessionId/);
    expect(() => readSessionOpened("session/fork")({}, () => {})).toThrow(/no sessionId/);
    expect(() => readSessionOpened("session/new")(null, () => {})).toThrow(/not an object/);
  });

  it("an answer naming no knobs carries none; one that does is read through the one normalizer — extension extras included", () => {
    expect(readSessionOpened("session/new")({ sessionId: "s1" }, () => {})).toEqual({ sessionId: "s1" });
    const opened = readSessionOpened("session/new")(
      { sessionId: "s1", models: { availableModels: [{ modelId: "m", name: "M" }], currentModelId: "m" } },
      () => {},
    );
    expect(opened.knobs?.knobs.map((k) => k.id)).toEqual(["model"]);
  });
});

describe("session/load and session/resume", () => {
  it("an answer naming no knobs — or not an object — leaves the knobs as they stand (#80)", () => {
    const { said, note } = notes();
    expect(readSessionAttached("session/load")({}, note)).toEqual({});
    expect(readSessionAttached("session/resume")(null, note)).toEqual({});
    expect(said).toEqual(["session/resume: the answer isn't an object — read as naming no knobs"]);
    const attached = readSessionAttached("session/load")(
      { modes: { currentModeId: "a", availableModes: [{ id: "a", name: "A" }] } },
      note,
    );
    expect(attached.knobs?.surface).toBe("modes");
  });
});

describe("session/list", () => {
  it("identity-less rows drop; bad sort keys degrade; the next page is named", () => {
    const { said, note } = notes();
    const list = readSessionList(
      {
        sessions: [
          { sessionId: "a", cwd: "/w", title: "ok", updatedAt: "2026-07-19T00:00:00Z" },
          { sessionId: "b", cwd: "/w", updatedAt: 1752900000 },
          { cwd: "/w", title: "no identity" },
          "garbage",
        ],
        nextCursor: "p2",
      },
      note,
    );
    expect(list.sessions).toEqual([
      { sessionId: "a", cwd: "/w", title: "ok", updatedAt: "2026-07-19T00:00:00Z" },
      { sessionId: "b", cwd: "/w" },
    ]);
    expect(list.next).toEqual({ kind: "more", cursor: "p2" });
    expect(said).toHaveLength(2);
  });

  it("a row's reported roots ride only as a list of paths — anything else is read as not reported", () => {
    const list = readSessionList(
      {
        sessions: [
          { sessionId: "a", cwd: "/w", additionalDirectories: ["/x", "/y"] },
          { sessionId: "b", cwd: "/w", additionalDirectories: [] },
          { sessionId: "c", cwd: "/w" },
          { sessionId: "d", cwd: "/w", additionalDirectories: "/x" },
          { sessionId: "e", cwd: "/w", additionalDirectories: ["/x", 7] },
        ],
      },
      () => {},
    );
    expect(list.sessions.map((s) => s.additionalDirectories)).toEqual([["/x", "/y"], [], undefined, undefined, undefined]);
    expect(list.next).toEqual({ kind: "end" });
  });

  it("a cursor that can't be sent back — or no session array at all — is a page that can't be followed, never the end (#80)", () => {
    expect(readSessionList({ sessions: [], nextCursor: 99 }, () => {}).next).toEqual({ kind: "unreadable" });
    expect(readSessionList({ sessions: "x" }, () => {})).toEqual({ sessions: [], next: { kind: "unreadable" } });
    expect(readSessionList(null, () => {})).toEqual({ sessions: [], next: { kind: "unreadable" } });
  });
});

describe("session/prompt", () => {
  it("no stop reason ends the turn as unknown; usage without its counts isn't shown (absence over fake)", () => {
    const { said, note } = notes();
    expect(readTurnEnd({ stopReason: 7, usage: { totalTokens: "many" } }, note)).toEqual({ stopReason: "unknown" });
    expect(said).toHaveLength(2);
  });

  it("usage carries every count the agent broke out", () => {
    const usage = { totalTokens: 10, inputTokens: 6, outputTokens: 4, cachedReadTokens: 2, cachedWriteTokens: 1, thoughtTokens: 3 };
    expect(readTurnEnd({ stopReason: "end_turn", usage }, () => {})).toEqual({
      stopReason: "end_turn",
      usage: { total: 10, input: 6, output: 4, cached: 2, cacheWrite: 1, thought: 3 },
    });
    expect(readTurnEnd({ stopReason: "end_turn", usage: { ...usage, cachedReadTokens: "x" } }, () => {}).usage).not.toHaveProperty("cached");
  });

  it("a non-object answer still ends the turn", () => {
    expect(readTurnEnd(null, () => {})).toEqual({ stopReason: "unknown" });
  });
});

describe("session/set_config_option", () => {
  it("an answer without its required configOptions carries none — the knobs aren't wiped (#80)", () => {
    const { said, note } = notes();
    expect(readConfigSet({}, note)).toEqual({});
    expect(readConfigSet("x", note)).toEqual({});
    expect(said).toHaveLength(2);
    expect(readConfigSet({ configOptions: [] }, note)).toEqual({ configOptions: [] });
  });
});
