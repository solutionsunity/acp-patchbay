// The agents-card action cluster's derivation (card-controls.ts) — the state
// matrix and the cross-control invariants, including regressions for the
// three logout bugs.
import { describe, expect, it } from "vitest";
import { agentCardControls, type AgentCardInputs } from "../src/webview/settings/card-controls";
import type {
  AgentConfigView,
  AgentSummary,
  AgentUpdate,
  AgentWork,
  AuthMethodView,
  CapabilityMatrix,
  CapabilityRowId,
} from "../src/shared/protocol";
import type { PatchbayAgentId } from "../src/shared/ids";

const ROWS: readonly CapabilityRowId[] = [
  "fs.readTextFile", "fs.writeTextFile", "terminal", "elicitation",
  "resources.subscribe", "prompt.image", "prompt.audio",
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
const undrivable: AuthMethodView = { id: "key", name: "API key", description: null, kind: "unsupported" };
const typedTerminal: AuthMethodView = { id: "cli", name: "CLI login", description: null, kind: "terminal" };

function summary(over: Partial<AgentSummary> = {}): AgentSummary {
  return { id: "a1" as PatchbayAgentId, name: "Agent", status: "running", needsAuth: false, authMethods: [], busy: [], ...over };
}

const config = { id: "a1", registrySource: null } as unknown as AgentConfigView;

/** The card's inputs — the row's matrix, auth methods, update fact and
 * busy state given flat, for brevity, and folded into the row. */
function inputs(
  over: Partial<AgentCardInputs> & {
    matrix?: CapabilityMatrix;
    authMethods?: readonly AuthMethodView[];
    update?: AgentUpdate;
    busy?: readonly AgentWork[];
  } = {},
): AgentCardInputs {
  const { matrix, authMethods, update, busy, ...rest } = over;
  const agent = "agent" in rest ? rest.agent : summary();
  return {
    config,
    ...rest,
    agent:
      agent === undefined
        ? undefined
        : {
            ...agent,
            capabilities: matrix ?? agent.capabilities ?? matrixOf(),
            authMethods: authMethods ?? agent.authMethods,
            update: update ?? agent.update,
            busy: busy ?? agent.busy,
          },
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

  it("needsAuth + runnable login: login only — no logout", () => {
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
      expect(c.logout.show).toBe(false);
    }
  });

  it("needsAuth without a runnable login method: the login control renders its note", () => {
    const c = agentCardControls(inputs({
      agent: summary({ needsAuth: true }),
      matrix: matrixOf({ auth: { declared: true, used: true } }),
      authMethods: [undrivable],
    }));
    expect(c.login.show).toBe(true); // renders the no-runnable-method note
  });

  // A typed terminal method (adopted typed-auth extension) is runnable —
  // login only, same shape as the stable/recipe kinds.
  it("needsAuth with a typed terminal method: login only — it is runnable now", () => {
    const c = agentCardControls(inputs({
      agent: summary({ needsAuth: true }),
      matrix: matrixOf({ auth: { declared: true, used: true } }),
      authMethods: [typedTerminal],
    }));
    expect(c.login.show).toBe(true);
  });

  // Whatever the queue holds dims the controls that would only wait behind
  // it — in-flight disables, never unmounts — and Stop never dims.
  it("busy with work: controls dim, stop still offered", () => {
    for (const kind of ["connect", "restart", "login", "logout"] as const) {
      const c = agentCardControls(inputs({
        agent: summary({ needsAuth: true }),
        authMethods: [typedTerminal],
        busy: [{ kind }],
      }));
      expect(c.login.disabled).toBe(true);
      expect(c.logout.disabled).toBe(true);
      expect(c.stop.show).toBe(true);
    }
    const idle = agentCardControls(inputs({ agent: summary({ needsAuth: true }), authMethods: [typedTerminal] }));
    expect(idle.login.disabled).toBe(false);
  });

  // Logout disconnects the agent's process (the agents store's logout),
  // leaving a stopped card with needsAuth still set — it must offer
  // Connect, never a dead Log in: authenticate is an RPC on the live
  // connection, and the fresh connect re-derives auth state anyway.
  it("stopped + needsAuth (post-logout): connect only — no login", () => {
    const c = agentCardControls(inputs({
      agent: summary({ status: "stopped", needsAuth: true }),
      authMethods: [agentMethod],
    }));
    expect(c.login.show).toBe(false);
    expect(c.connect.show).toBe(true);
  });

  // Stop cuts in on anything the agent's queue holds, a launch's download
  // included — so it is there from the launch on, and Connect, which would
  // only join what runs, is not.
  it("a launch under way: Stop offered, Connect not", () => {
    const c = agentCardControls(inputs({ agent: summary({ status: "reconnecting" }), busy: [{ kind: "connect" }] }));
    expect(c.stop).toEqual({ show: true, busy: false });
    expect(c.connect.show).toBe(false);
  });

  it("work held on a stopped agent — an upgrade between its stop and its launch: Stop offered, Connect not", () => {
    const c = agentCardControls(inputs({ agent: summary({ status: "stopped" }), busy: [{ kind: "upgrade", to: "1.2.0" }] }));
    expect(c.stop.show).toBe(true);
    expect(c.connect.show).toBe(false);
  });

  it("Stop and Remove each spin while their own operation runs — Stop never disabled", () => {
    const stopping = agentCardControls(inputs({ busy: [{ kind: "stop" }] }));
    expect(stopping.stop).toEqual({ show: true, busy: true });
    expect(stopping.remove.busy).toBe(false);
    const removing = agentCardControls(inputs({ agent: summary({ status: "stopped" }), busy: [{ kind: "remove" }] }));
    expect(removing.remove).toEqual({ show: true, busy: true });
    expect(removing.stop.busy).toBe(false);
    expect(removing.connect.show).toBe(false);
  });

  it("not running: connect (config present), no logout/stop", () => {
    const c = agentCardControls(inputs({ agent: summary({ status: "stopped" }) }));
    expect(c.connect.show).toBe(true);
    expect(c.logout.show).toBe(false);
    expect(c.stop.show).toBe(false);
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

  it("upgrade: shows the orchestrator's update fact, and nothing without one", () => {
    expect(agentCardControls(inputs({ update: { from: "1.0.0", to: "1.2.0" } })).upgrade).toEqual({
      upgrading: false,
      from: "1.0.0",
      to: "1.2.0",
    });
    expect(agentCardControls(inputs()).upgrade).toBeNull();
  });

  // Once the upgrade saves the new pin the update fact is gone — the chip
  // keeps saying what is happening, from the queue.
  it("upgrade: an upgrade the queue holds outranks the offer, and outlives it", () => {
    const busy: AgentWork[] = [{ kind: "upgrade", to: "1.2.0" }];
    expect(agentCardControls(inputs({ update: { from: "1.0.0", to: "1.2.0" }, busy })).upgrade).toEqual({
      upgrading: true,
      to: "1.2.0",
    });
    expect(agentCardControls(inputs({ busy })).upgrade).toEqual({ upgrading: true, to: "1.2.0" });
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

  // Connect and Stop are never both offered: one starts what isn't there,
  // the other ends what is.
  it("connect/stop exclusivity holds across the state matrix", () => {
    for (const status of ["running", "stopped", "crashed", "reconnecting", "untested"] as const) {
      for (const busy of [[], [{ kind: "connect" }], [{ kind: "stop" }], [{ kind: "remove" }]] as AgentWork[][]) {
        const c = agentCardControls(inputs({ agent: summary({ status }), busy }));
        expect(c.connect.show && c.stop.show).toBe(false);
        expect(c.connect.show || c.stop.show).toBe(true);
      }
    }
  });
});
