// Typed-auth wire extension (auth-method-types.ts): the RFD's unstable
// `type`/`args`/`env` surface parses here and only here — malformed
// degrades to the stable default, and the client opt-in rides initialize.
import { describe, expect, it } from "vitest";
import { clientCapabilitiesWire } from "../src/orchestrator/capabilities";
import { authCapabilityWire, typedAuthMethodOf } from "../src/orchestrator/extensions";

describe("typedAuthMethodOf", () => {
  it("parses a full typed terminal method — args appended, env merged, by the executor", () => {
    expect(
      typedAuthMethodOf({ id: "t", name: "T", type: "terminal", args: ["login"], env: { A: "1" } }),
    ).toEqual({ kind: "terminal", terminal: { type: "terminal", args: ["login"], env: { A: "1" } } });
  });

  it("defaults args and env — a bare typed terminal is legal per the RFD", () => {
    expect(typedAuthMethodOf({ id: "t", name: "T", type: "terminal" })).toEqual({
      kind: "terminal",
      terminal: { type: "terminal", args: [], env: {} },
    });
  });

  it("classifies env_var without carrying an executor half", () => {
    expect(typedAuthMethodOf({ id: "e", name: "E", type: "env_var" })).toEqual({ kind: "env_var" });
  });

  it("degrades to absent — no typed surface, unknown type, malformed terminal, junk", () => {
    expect(typedAuthMethodOf({ id: "a", name: "A" })).toBeNull();
    expect(typedAuthMethodOf({ id: "a", name: "A", type: "oauth" })).toBeNull();
    expect(typedAuthMethodOf({ id: "t", name: "T", type: "terminal", args: "login" })).toBeNull();
    expect(typedAuthMethodOf({ id: "t", name: "T", type: "terminal", env: ["A"] })).toBeNull();
    expect(typedAuthMethodOf(null)).toBeNull();
    expect(typedAuthMethodOf("terminal")).toBeNull();
  });
});

describe("auth.terminal client opt-in", () => {
  it("authCapabilityWire is the RFD's declaration shape", () => {
    expect(authCapabilityWire()).toEqual({ auth: { terminal: true } });
  });

  it("clientCapabilitiesWire rides the declaration — an agent gating typed terminal offers on it sees the opt-in", () => {
    expect((clientCapabilitiesWire() as { auth?: unknown }).auth).toEqual({ terminal: true });
  });
});
