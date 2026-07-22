// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The agent card's action-cluster view-model — the ONE derivation between
// SettingsState slices and the card's controls. Every control whose rules read domain state has its
// entry here; the JSX reads `controls.x` and stays dumb. Cross-control
// invariants (login/logout exclusivity, in-flight gating) live — and are
// unit-tested — in this one place instead of drifting across inline
// predicates, which is how the logout/verify regressions happened.
import type {
  AgentConfigView,
  AgentSummary,
  AuthMethodView,
  CapabilityMatrix,
  RegistryAgentView,
} from "../../shared/protocol";
import { hasUnusedProbe } from "../../shared/protocol";

export interface AgentCardInputs {
  /** Orchestrator summary — undefined for a configured-but-never-seen agent. */
  agent: AgentSummary | undefined;
  /** Persisted config — undefined for a transient (connected, not saved) agent. */
  config: AgentConfigView | undefined;
  matrix: CapabilityMatrix | undefined;
  authMethods: readonly AuthMethodView[];
  registryAgents: readonly RegistryAgentView[];
  /** The shared in-progress signal (verifyingAgents[id]) — a verify or
   * logout round-trip is in flight. */
  verifying: boolean;
}

export interface AgentCardControls {
  /** Log-in control (method picker + button, or the no-runnable-method
   * note — LoginControl renders whichever applies from `methods`). */
  login: { show: boolean; disabled: boolean };
  logout: { show: boolean; disabled: boolean };
  stop: { show: boolean };
  verify: { show: boolean; disabled: boolean; busy: boolean };
  connect: { show: boolean };
  /** Non-null when the registry is ahead of the pinned version — drives
   * both the badge and the Upgrade button. Never auto-applied. */
  upgrade: { from: string; to: string } | null;
  edit: { show: boolean };
  remove: { show: boolean };
}

/** The wire's runnable subset — "agent"-kind (stable `authenticate`),
 * "terminal-recipe" (adopted terminal-auth extension), and "terminal"
 * (adopted typed-auth extension — the agent's own command re-run in a
 * terminal with the method's args appended). "env_var" stays declared but
 * never wired to a button. One filter for the Log-in control's method list
 * and every predicate that asks "can patchbay drive a login here?". */
export function runnableLoginMethods(methods: readonly AuthMethodView[]): readonly AuthMethodView[] {
  return methods.filter(
    (m) => m.kind === "agent" || m.kind === "terminal-recipe" || m.kind === "terminal",
  );
}

/** Registry version vs. what this config is pinned to — null when there's
 * nothing to compare (custom command, or already current). Linked through
 * the config's own registrySource.registryId — never the config id, which
 * may predate the registry naming. */
export function updateAvailable(
  registryAgents: readonly RegistryAgentView[],
  config: AgentConfigView | undefined,
): { from: string; to: string } | null {
  if (config?.registrySource == null) return null;
  const latest = registryAgents.find((r) => r.id === config.registrySource!.registryId)?.version;
  if (latest == null || latest === config.registrySource.pinnedVersion) return null;
  // The wire's own fact outranks the pinned ask: a connection that already
  // reported the registry's latest (a launcher serving a newer build than
  // the pin) has no upgrade to offer — badging it would let the pin lie
  // about reality.
  if (config.lastSeenVersion === latest) return null;
  return { from: config.registrySource.pinnedVersion, to: latest };
}

export function agentCardControls(inputs: AgentCardInputs): AgentCardControls {
  const { agent, config, matrix, authMethods, registryAgents, verifying } = inputs;
  // No summary at all = the orchestrator never saw this config — the honest
  // unknown is "untested", never a claimed "stopped".
  const status = agent?.status ?? "untested";
  const running = status === "running";
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
    // stopped-but-logged-out card (logout disconnects the process —
    // orchestrator.logoutAgent) offers Connect; the lock rides through the
    // reconnect and the card comes back still logged out. Disabled while a
    // verify/authenticate/logout round-trip is in flight — one bracket,
    // refcounted, dims them together.
    login: { show: running && needsAuth, disabled: verifying },
    // Offered only on a declared auth.logout — the spec's "Clients MUST
    // NOT call it" otherwise. Hidden while needsAuth (nothing to log out
    // of — and never both login and logout); *disabled*, never unmounted,
    // while in flight, so the open AlertDialog is never yanked from the
    // tree (Radix rule).
    logout: {
      show: running && !needsAuth && matrix?.["auth.logout"]?.declared === true,
      disabled: verifying,
    },
    // Never disabled — killing a hung process is the escape hatch and
    // must stay reachable even mid-verify.
    stop: { show: running },
    verify: { show: running && needsVerify, disabled: verifying, busy: verifying },
    connect: { show: !running && config !== undefined },
    upgrade: updateAvailable(registryAgents, config),
    edit: { show: true },
    remove: { show: config !== undefined },
  };
}
