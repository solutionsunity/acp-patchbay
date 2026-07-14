// The agents-card action cluster's derivation (card-controls.ts) — the state
// matrix and the cross-control invariants, including regressions for the
// three logout/verify bugs (ui-rendering-strategy.md § Control logic).
import { describe, expect, it } from "vitest";
import { agentCardControls, type AgentCardInputs } from "../src/webview/settings/card-controls";
import type {
  AgentConfigView,
  AgentSummary,
  AuthMethodView,
  CapabilityMatrix,
  CapabilityRowId,
  RegistryAgentView,
} from "../src/shared/protocol";

const ROWS: readonly CapabilityRowId[] = [
  "fs.readTextFile", "fs.writeTextFile", "terminal", "elicitation",
  "roots.listChanged", "resources.subscribe", "prompt.image", "prompt.audio",
  "prompt.embeddedContext", "session.fork", "session.load", "session.resume",
  "session.list", "session.delete", "session.close",
  "session.additionalDirectories", "mcp.http", "mcp.sse", "usage",
  "concurrentSessions", "auth", "auth.logout",
];

function matrixOf(overrides: Partial<Record<CapabilityRowId, { declared: boolean; used: boolean }>> = {}): CapabilityMatrix {
  const m = {} as Record<CapabilityRowId, { declared: boolean; used: boolean }>;
  for (const row of ROWS) m[row] = overrides[row] ?? { declared: false, used: false };
  return m as CapabilityMatrix;
}

const agentMethod: AuthMethodView = { id: "claude-login", name: "Log in with Claude", description: null, kind: "agent" };
const terminalOnly: AuthMethodView = { id: "cli", name: "CLI login", description: null, kind: "terminal" };

function summary(over: Partial<AgentSummary> = {}): AgentSummary {
  return { id: "a1", name: "Agent", status: "running", needsAuth: false, ...over };
}

const config = { id: "a1", registrySource: null } as unknown as AgentConfigView;

function inputs(over: Partial<AgentCardInputs> = {}): AgentCardInputs {
  return {
    agent: summary(),
    config,
    matrix: matrixOf(),
    authMethods: [],
    registryAgents: [],
    verifying: false,
    ...over,
  };
}

describe("agentCardControls", () => {
  it("running + logged in + declared auth.logout: logout shown, login hidden", () => {
    const c = agentCardControls(inputs({ matrix: matrixOf({ "auth.logout": { declared: true, used: false } }) }));
    expect(c.logout.show).toBe(true);
    expect(c.login.show).toBe(false);
    expect(c.stop.show).toBe(true);
  });

  it("undeclared auth.logout never offers logout (spec: MUST NOT call)", () => {
    expect(agentCardControls(inputs()).logout.show).toBe(false);
  });

  // Regression: logged-out card with a runnable Log in must NOT offer
  // Verify — a lazy-auth agent (Claude) passes session/new without
  // credentials, so Verify would wipe the logged-out state. Must hold
  // even with the probe still unused (the realistic fresh-connect shape:
  // auth.used=false, fork declared-unused) — the OR form leaked Verify
  // through hasUnusedProbe exactly there.
  it("needsAuth + runnable login: login only — no verify, no logout", () => {
    const probeStates = [
      matrixOf({ "auth.logout": { declared: true, used: true }, auth: { declared: true, used: true } }),
      matrixOf({ auth: { declared: true, used: false }, "session.fork": { declared: true, used: false } }),
    ];
    for (const matrix of probeStates) {
      const c = agentCardControls(inputs({
        agent: summary({ needsAuth: true }),
        matrix,
        authMethods: [agentMethod],
      }));
      expect(c.login.show).toBe(true);
      expect(c.verify.show).toBe(false);
      expect(c.logout.show).toBe(false);
    }
  });

  // The escape hatch survives: auth resolvable only out of band (Auggie's
  // "run `auggie login`") still gets a manual re-check.
  it("needsAuth without a runnable login method: verify offered as the escape hatch", () => {
    const c = agentCardControls(inputs({
      agent: summary({ needsAuth: true }),
      matrix: matrixOf({ auth: { declared: true, used: true } }),
      authMethods: [terminalOnly],
    }));
    expect(c.login.show).toBe(true); // renders the no-runnable-method note
    expect(c.verify.show).toBe(true);
  });

  it("unused probe (fresh fork claim) still gates verify on", () => {
    const c = agentCardControls(inputs({ matrix: matrixOf({ "session.fork": { declared: true, used: false } }) }));
    expect(c.verify.show).toBe(true);
    expect(c.verify.busy).toBe(false);
  });

  // Regression: in-flight disables — never unmounts — and covers login too.
  it("verifying: login/logout/verify disabled, stop still offered", () => {
    const c = agentCardControls(inputs({
      agent: summary({ needsAuth: true }),
      matrix: matrixOf({ auth: { declared: true, used: true } }),
      authMethods: [terminalOnly],
      verifying: true,
    }));
    expect(c.login.disabled).toBe(true);
    expect(c.logout.disabled).toBe(true);
    expect(c.verify.disabled).toBe(true);
    expect(c.verify.busy).toBe(true);
    expect(c.stop.show).toBe(true);
  });

  // Logout disconnects the agent's processes (orchestrator.logoutAgent),
  // leaving a stopped card with needsAuth still set — it must offer
  // Connect, never a dead Log in: authenticate is an RPC on the live
  // connection, and the fresh connect re-derives auth state anyway.
  it("stopped + needsAuth (post-logout): connect only — no login, no verify", () => {
    const c = agentCardControls(inputs({
      agent: summary({ status: "stopped", needsAuth: true }),
      authMethods: [agentMethod],
    }));
    expect(c.login.show).toBe(false);
    expect(c.verify.show).toBe(false);
    expect(c.connect.show).toBe(true);
  });

  it("not running: connect (config present), no logout/stop/verify", () => {
    const c = agentCardControls(inputs({ agent: summary({ status: "stopped" }) }));
    expect(c.connect.show).toBe(true);
    expect(c.logout.show).toBe(false);
    expect(c.stop.show).toBe(false);
    expect(c.verify.show).toBe(false);
  });

  it("never-seen config (no summary): untested — connect offered, nothing running-only", () => {
    const c = agentCardControls(inputs({ agent: undefined }));
    expect(c.connect.show).toBe(true);
    expect(c.stop.show).toBe(false);
  });

  it("transient agent (no config): no connect, no remove; edit always shown", () => {
    const c = agentCardControls(inputs({ agent: summary({ status: "stopped" }), config: undefined }));
    expect(c.connect.show).toBe(false);
    expect(c.remove.show).toBe(false);
    expect(c.edit.show).toBe(true);
  });

  it("upgrade: registry ahead of pinned version, linked via registrySource", () => {
    const pinned = { id: "a1", registrySource: { registryId: "reg-a", distributionKind: "npx", pinnedVersion: "1.0.0" } } as unknown as AgentConfigView;
    const registry = [{ id: "reg-a", version: "1.2.0" }] as unknown as readonly RegistryAgentView[];
    expect(agentCardControls(inputs({ config: pinned, registryAgents: registry })).upgrade).toEqual({ from: "1.0.0", to: "1.2.0" });
    expect(agentCardControls(inputs({ config: pinned, registryAgents: [{ id: "reg-a", version: "1.0.0" }] as unknown as readonly RegistryAgentView[] })).upgrade).toBeNull();
    expect(agentCardControls(inputs()).upgrade).toBeNull();
  });

  // The invariant no inline predicate ever enforced: across the whole
  // state matrix, login and logout are never both shown.
  it("login/logout exclusivity holds across the state matrix", () => {
    for (const needsAuth of [true, false]) {
      for (const declared of [true, false]) {
        for (const status of ["running", "stopped", "crashed", "reconnecting", "untested"] as const) {
          const c = agentCardControls(inputs({
            agent: summary({ status, needsAuth }),
            matrix: matrixOf({ "auth.logout": { declared, used: false } }),
            authMethods: [agentMethod],
          }));
          expect(c.login.show && c.logout.show).toBe(false);
        }
      }
    }
  });
});
