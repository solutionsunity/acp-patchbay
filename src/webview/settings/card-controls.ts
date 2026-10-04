// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The agent card's action-cluster view-model — the ONE derivation between
// SettingsState slices and the card's controls. Every control whose rules read domain state has its
// entry here; the JSX reads `controls.x` and stays dumb. Cross-control
// invariants (login/logout exclusivity, in-flight gating) live — and are
// unit-tested — in this one place instead of drifting across inline
// predicates, which is how the logout/verify regressions happened.
import type { AgentConfigView, AgentSummary, AgentWork, AuthMethodView } from "../../shared/protocol";
import { hasUnusedProbe } from "../../shared/protocol";
import { upgradeOffer, type UpgradeOffer } from "../shared/agent-work";

export interface AgentCardInputs {
  /** The orchestrator's row — its matrix, auth methods, update fact and
   * busy state ride on it; undefined for a configured-but-never-seen
   * agent. */
  agent: AgentSummary | undefined;
  /** Persisted config — undefined for a transient (connected, not saved) agent. */
  config: AgentConfigView | undefined;
}

export interface AgentCardControls {
  /** Log-in control (method picker + button, or the no-runnable-method
   * note — LoginControl renders whichever applies from `methods`). */
  login: { show: boolean; disabled: boolean };
  logout: { show: boolean; disabled: boolean };
  /** Never disabled — it cuts in on whatever the agent's queue holds. */
  stop: { show: boolean; busy: boolean };
  verify: { show: boolean; disabled: boolean; busy: boolean };
  connect: { show: boolean };
  /** Non-null when the registry is ahead of the pinned version, or while an
   * upgrade runs — drives the upgrade chip, which is both the indicator and
   * the action. Never auto-applied. */
  upgrade: UpgradeOffer | null;
  edit: { show: boolean };
  remove: { show: boolean; busy: boolean };
}

/** The wire's runnable subset — "agent"-kind (`authenticate`),
 * "terminal-recipe" (adopted terminal-auth extension), and "terminal"
 * (the spec's terminal type — the agent's own command re-run in a
 * terminal with the method's args appended). "unsupported" stays declared
 * but never wired to a button. One filter for the Log-in control's method list
 * and every predicate that asks "can patchbay drive a login here?". */
export function runnableLoginMethods(methods: readonly AuthMethodView[]): readonly AuthMethodView[] {
  return methods.filter(
    (m) => m.kind === "agent" || m.kind === "terminal-recipe" || m.kind === "terminal",
  );
}

export function agentCardControls(inputs: AgentCardInputs): AgentCardControls {
  const { agent, config } = inputs;
  const matrix = agent?.capabilities;
  // Anything the agent's queue holds dims the controls that would only
  // queue behind it; Verify, Stop and Remove each spin while their own
  // operation runs or waits.
  const busy = agent?.busy ?? [];
  const working = busy.length > 0;
  const holds = (kind: AgentWork["kind"]) => busy.some((w) => w.kind === kind);
  const authMethods = agent?.authMethods ?? [];
  // No summary at all = the orchestrator never saw this config — the honest
  // unknown is "untested", never a claimed "stopped".
  const status = agent?.status ?? "untested";
  const running = status === "running";
  // Something to stop: the process, its launch, or work its queue holds.
  const live = running || status === "reconnecting" || working;
  const needsAuth = agent?.needsAuth === true;
  const hasRunnableLogin = runnableLoginMethods(authMethods).length > 0;
  // Verify gates on hasUnusedProbe (protocol.ts): fork-declared-unproven
  // is the one thing the free check can still resolve — the auth clause is
  // gone with the auth row's proof redefinition, or the button would
  // promise a check it structurally cannot perform. On a needsAuth card,
  // Verify appears solely as the escape hatch when no runnable login
  // method exists (auth resolved out of band; the probe heals a lock its
  // own method raised, a prompt heals the rest). Never both — UX clarity,
  // not the invariant holder: the authority table already refuses
  // non-bearing clears, so a stray Verify can no longer "verify away" a
  // logged-out state.
  const needsVerify = needsAuth
    ? !hasRunnableLogin
    : matrix !== undefined && hasUnusedProbe(matrix);

  return {
    // Running-gated: authenticate is an RPC on the live connection, so a
    // stopped-but-logged-out card (logout disconnects the process — the
    // agents store's logout) offers Connect; the lock rides through the
    // reconnect and the card comes back still logged out.
    login: { show: running && needsAuth, disabled: working },
    // Offered only on a declared auth.logout — the spec's "Clients MUST
    // NOT call it" otherwise. Hidden while needsAuth (nothing to log out
    // of — and never both login and logout); dimmed while the queue holds
    // work it would only wait behind.
    logout: {
      show: running && !needsAuth && matrix?.["auth.logout"]?.declared === true,
      disabled: working,
    },
    // Killing a hung process is the escape hatch, so Stop is there from
    // the launch on — a download included — whatever the queue holds;
    // Connect only while there is nothing to stop.
    stop: { show: live, busy: holds("stop") },
    verify: { show: running && needsVerify, disabled: working, busy: holds("verify") },
    connect: { show: !live && config !== undefined },
    upgrade: upgradeOffer(agent),
    edit: { show: true },
    remove: { show: config !== undefined, busy: holds("remove") },
  };
}
