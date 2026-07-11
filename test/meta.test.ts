// _meta extension table (meta.ts): declared and parsed halves come from one
// table, payloads are trust-boundary data — malformed degrades to absent.
import { describe, expect, it } from "vitest";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import {
  clientCapabilitiesWire,
  declaredFromInitialize,
} from "../src/orchestrator/capabilities";
import { clientMetaWire, terminalAuthRecipeOf } from "../src/orchestrator/meta";
import { hasUnusedProbe, type CapabilityMatrix } from "../src/shared/protocol";
import { matrixFromDeclared } from "../src/orchestrator/capabilities";

const recipe = {
  command: "/usr/bin/node",
  args: ["/opt/agent/index.js", "login"],
  label: "Agent Login",
  env: { AGENT_FAST_EXIT: "1" },
};

describe("terminalAuthRecipeOf", () => {
  it("parses a full recipe", () => {
    expect(terminalAuthRecipeOf({ "terminal-auth": recipe })).toEqual(recipe);
  });

  it("defaults args to empty and tolerates omitted label/env", () => {
    expect(terminalAuthRecipeOf({ "terminal-auth": { command: "auggie" } })).toEqual({
      command: "auggie",
      args: [],
    });
  });

  it("degrades to absent on malformed payloads — never a half-parsed recipe", () => {
    expect(terminalAuthRecipeOf({ "terminal-auth": { args: ["login"] } })).toBeNull(); // no command
    expect(terminalAuthRecipeOf({ "terminal-auth": { command: "" } })).toBeNull();
    expect(terminalAuthRecipeOf({ "terminal-auth": true })).toBeNull();
    expect(terminalAuthRecipeOf({ other: recipe })).toBeNull();
    expect(terminalAuthRecipeOf(undefined)).toBeNull();
    expect(terminalAuthRecipeOf(null)).toBeNull();
    expect(terminalAuthRecipeOf("terminal-auth")).toBeNull();
  });
});

describe("client _meta declaration", () => {
  it("clientMetaWire carries every adopted key", () => {
    expect(clientMetaWire()).toEqual({ "terminal-auth": true });
  });

  it("clientCapabilitiesWire rides the declaration — declared and parsed can't drift", () => {
    expect(clientCapabilitiesWire()._meta).toEqual({ "terminal-auth": true });
  });
});

function initWith(authMethods: unknown): InitializeResponse {
  return { protocolVersion: 1, authMethods } as InitializeResponse;
}

describe("auth method kind classification", () => {
  it("a parseable recipe wins over the type field (Auggie ships one on a type-less method)", () => {
    const declared = declaredFromInitialize(
      initWith([{ id: "auggie-login", name: "Log in with Auggie", _meta: { "terminal-auth": recipe } }]),
    );
    expect(declared.authMethods[0]!.kind).toBe("terminal-recipe");
  });

  it('type: "terminal" with a recipe is still terminal-recipe (Claude labels honestly)', () => {
    const declared = declaredFromInitialize(
      initWith([
        { id: "claude-ai-login", name: "Claude Subscription", type: "terminal", args: ["--cli"], _meta: { "terminal-auth": recipe } },
      ]),
    );
    expect(declared.authMethods[0]!.kind).toBe("terminal-recipe");
  });

  it("type-less without a recipe stays the schema default: agent", () => {
    const declared = declaredFromInitialize(initWith([{ id: "login", name: "Log in" }]));
    expect(declared.authMethods[0]!.kind).toBe("agent");
  });

  it("recipe-less unstable types stay declared-but-unwired", () => {
    const declared = declaredFromInitialize(
      initWith([
        { id: "t", name: "Terminal", type: "terminal", args: ["--cli"] },
        { id: "e", name: "Env", type: "env_var" },
      ]),
    );
    expect(declared.authMethods.map((m) => m.kind)).toEqual(["terminal", "env_var"]);
  });

  it("a malformed recipe falls back to the type field, honestly", () => {
    const declared = declaredFromInitialize(
      initWith([{ id: "x", name: "X", _meta: { "terminal-auth": { args: [] } } }]),
    );
    expect(declared.authMethods[0]!.kind).toBe("agent");
  });
});

describe("hasUnusedProbe with terminal-recipe methods", () => {
  const matrix: CapabilityMatrix = matrixFromDeclared(
    declaredFromInitialize(initWith([])),
  );

  it("a terminal-recipe method keeps the auth probe pending until proven", () => {
    const methods = [{ id: "l", name: "L", description: null, kind: "terminal-recipe" as const }];
    expect(hasUnusedProbe(matrix, methods)).toBe(true);
  });

  it("recipe-less unstable methods alone leave nothing to probe", () => {
    const methods = [{ id: "t", name: "T", description: null, kind: "terminal" as const }];
    expect(hasUnusedProbe(matrix, methods)).toBe(false);
  });
});
