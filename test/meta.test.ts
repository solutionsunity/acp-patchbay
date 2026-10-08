// _meta extension table (meta.ts): declared and parsed halves come from one
// table, payloads are trust-boundary data — malformed degrades to absent.
import { describe, expect, it } from "vitest";
import { clientCapabilitiesWire } from "../src/orchestrator/capabilities";
import { readInitialize } from "../src/orchestrator/readers/initialize";
import { agentTerminalOf, clientMetaWire, planUsageOf, terminalAuthRecipeOf } from "../src/orchestrator/meta";

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

function initWith(authMethods: unknown): unknown {
  return { protocolVersion: 1, authMethods };
}

/** The declared table an initialize answer is read into. */
function declaredOf(raw: unknown) {
  return readInitialize(raw, () => {}).declared;
}

describe("auth method kind classification", () => {
  it("a type-less method's recipe is its login, not the schema default (Auggie)", () => {
    const declared = declaredOf(
      initWith([{ id: "auggie-login", name: "Log in with Auggie", _meta: { "terminal-auth": recipe } }]),
    );
    expect(declared.authMethods[0]!.kind).toBe("terminal-recipe");
  });

  it('type: "terminal" with a recipe is terminal — the recipe is the copy for clients without auth.terminal (#93)', () => {
    const declared = declaredOf(
      initWith([
        { id: "claude-ai-login", name: "Claude Subscription", type: "terminal", args: ["--cli"], _meta: { "terminal-auth": recipe } },
      ]),
    );
    expect(declared.authMethods[0]!.kind).toBe("terminal");
  });

  it("type-less without a recipe stays the schema default: agent", () => {
    const declared = declaredOf(initWith([{ id: "login", name: "Log in" }]));
    expect(declared.authMethods[0]!.kind).toBe("agent");
  });

  it("recipe-less methods classify by the wire's own type", () => {
    const declared = declaredOf(
      initWith([
        { id: "t", name: "Terminal", type: "terminal", args: ["--cli"] },
        { id: "a", name: "Agent", type: "agent" },
        { id: "e", name: "Env", type: "env_var" },
        { id: "o", name: "Future", type: "oauth" },
      ]),
    );
    // env_var left the spec and oauth was never in it: a type patchbay
    // cannot drive is shown, never run — and never passed to `authenticate`,
    // which the spec allows only for the agent type.
    expect(declared.authMethods.map((m) => m.kind)).toEqual([
      "terminal",
      "agent",
      "unsupported",
      "unsupported",
    ]);
  });

  it("a malformed typed terminal is never a runnable kind", () => {
    const declared = declaredOf(
      initWith([
        { id: "t", name: "Terminal", type: "terminal", args: "login" },
        { id: "e", name: "Env", type: "terminal", env: ["A"] },
      ]),
    );
    expect(declared.authMethods.map((m) => m.kind)).toEqual(["unsupported", "unsupported"]);
  });

  it("a malformed recipe falls back to the type field, honestly", () => {
    const declared = declaredOf(
      initWith([{ id: "x", name: "X", _meta: { "terminal-auth": { args: [] } } }]),
    );
    expect(declared.authMethods[0]!.kind).toBe("agent");
  });
});

describe("agentTerminalOf — a command the agent runs itself (#80)", () => {
  it("reads an output chunk and the exit, under the terminal's id", () => {
    expect(agentTerminalOf({ terminal_output_delta: { terminal_id: "c1", data: "1 passed\n" } })).toEqual({ terminalId: "c1", output: "1 passed\n" });
    expect(agentTerminalOf({ terminal_exit: { terminal_id: "c1", exit_code: 0, signal: null } })).toEqual({
      terminalId: "c1",
      exit: { exitCode: 0, signal: null },
    });
    expect(
      agentTerminalOf({ terminal_output_delta: { terminal_id: "c1", data: "x" }, terminal_exit: { terminal_id: "c1", exit_code: 1 } }),
    ).toEqual({ terminalId: "c1", output: "x", exit: { exitCode: 1, signal: null } });
  });

  it("anything else is no terminal — and nothing is declared, so claude-agent-acp keeps its own rendering", () => {
    expect(agentTerminalOf(undefined)).toBeNull();
    expect(agentTerminalOf({ terminal_output_delta: { data: "no id" } })).toBeNull();
    expect(agentTerminalOf({ terminal_info: { terminal_id: "c1" } })).toBeNull();
    expect(clientMetaWire()).not.toHaveProperty("terminal_output");
    expect(clientMetaWire()).not.toHaveProperty("terminal_output_delta");
  });
});
