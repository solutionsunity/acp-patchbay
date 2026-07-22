// _meta extension table (meta.ts): declared and parsed halves come from one
// table, payloads are trust-boundary data — malformed degrades to absent.
import { describe, expect, it } from "vitest";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import {
  clientCapabilitiesWire,
  declaredFromInitialize,
} from "../src/orchestrator/capabilities";
import { clientMetaWire, planUsageOf, terminalAuthRecipeOf } from "../src/orchestrator/meta";
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

describe("planUsageOf (usageUpdate site: _claude/rateLimit)", () => {
  it("normalizes a full reading — status mapped, epoch-seconds resetsAt to ISO", () => {
    expect(
      planUsageOf({
        "_claude/rateLimit": {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 0.82,
          resetsAt: 1_784_000_000, // seconds — year 2026
        },
      }),
    ).toEqual({
      status: "warning",
      window: "five_hour",
      utilization: 0.82,
      resetsAt: new Date(1_784_000_000 * 1000).toISOString(),
    });
  });

  it("disambiguates a milliseconds epoch by magnitude", () => {
    const ms = 1_784_000_000_000;
    expect(planUsageOf({ "_claude/rateLimit": { status: "allowed", resetsAt: ms } })).toEqual({
      status: "ok",
      window: undefined,
      utilization: undefined,
      resetsAt: new Date(ms).toISOString(),
    });
  });

  it("maps rejected to limited; extra vendor fields are stripped, not fatal", () => {
    expect(
      planUsageOf({
        "_claude/rateLimit": { status: "rejected", overageStatus: "rejected", isUsingOverage: false },
      }),
    ).toMatchObject({ status: "limited" });
  });

  it("degrades to absent on malformed payloads — including an unknown status", () => {
    expect(planUsageOf({ "_claude/rateLimit": { status: "throttled" } })).toBeNull(); // unclassifiable gauge
    expect(planUsageOf({ "_claude/rateLimit": {} })).toBeNull();
    expect(planUsageOf({ other: { status: "allowed" } })).toBeNull();
    expect(planUsageOf(undefined)).toBeNull();
    expect(planUsageOf(null)).toBeNull();
  });
});

describe("client _meta declaration", () => {
  it("clientMetaWire carries every adopted key — consume-only entries stay undeclared", () => {
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

  it("recipe-less typed methods classify by the typed-auth extension's parse", () => {
    const declared = declaredFromInitialize(
      initWith([
        { id: "t", name: "Terminal", type: "terminal", args: ["--cli"] },
        { id: "e", name: "Env", type: "env_var" },
      ]),
    );
    expect(declared.authMethods.map((m) => m.kind)).toEqual(["terminal", "env_var"]);
  });

  it("a malformed typed terminal degrades to the stable default — never a runnable kind", () => {
    const declared = declaredFromInitialize(
      initWith([{ id: "t", name: "Terminal", type: "terminal", args: "login" }]),
    );
    expect(declared.authMethods[0]!.kind).toBe("agent");
  });

  it("a malformed recipe falls back to the type field, honestly", () => {
    const declared = declaredFromInitialize(
      initWith([{ id: "x", name: "X", _meta: { "terminal-auth": { args: [] } } }]),
    );
    expect(declared.authMethods[0]!.kind).toBe("agent");
  });
});

describe("hasUnusedProbe", () => {
  const matrix: CapabilityMatrix = matrixFromDeclared(
    declaredFromInitialize(initWith([])),
  );

  it("auth methods of any kind leave nothing to probe — the free check is not an auth proof", () => {
    expect(hasUnusedProbe(matrix)).toBe(false);
  });
});
