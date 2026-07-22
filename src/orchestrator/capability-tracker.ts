// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Owns capability-matrix bookkeeping and the free connectivity probe.
// vscode-free (like session-manager.ts) so it's unit-testable against the
// fake agent without a real extension host.
//
// The verification-cost distinction draws the line precisely:
// protocol-level checks are free and automatic on connect; behavior-level
// probes cost a real agent turn and need real handlers to be honest at all.
// The probe runs on *every* connect — its session/new doubles as the
// knob-offering read (offerings are connection state, read fresh each
// connect), proves whether `auth_required` blocks this agent, and adds the
// session/fork round-trip while that row is still declared-but-unused.
// Marking a row *used* doesn't happen here, though — pool.ts's wire
// chokepoints (agent RPC resolved, incoming request handled, session/update
// kind tag arrived) consult the one proof table (capabilities.ts
// CAPABILITY_PROOFS) and fire the one `onCapabilityEvidence` hook; no call
// site anywhere names a row. This file only decides *when* to run the
// synthetic probe below and persists whatever pool.ts reports.
//
// Used to reset on every reconnect (a side effect of always rebuilding the
// matrix fresh); it's now version-keyed — a reconnect at the *same* `agentInfo.version` restores what was
// already proven, and only an actual version change earns a fresh,
// honestly-unused matrix.
import { RequestError, type NewSessionResponse } from "@agentclientprotocol/sdk";
import {
  type AgentViewEvent,
  type CapabilityMatrix,
  type CapabilityRowId,
  type DeclaredCapabilities,
} from "../shared/protocol";
import { matrixFromDeclared } from "./capabilities";
import { probeDeferredFor } from "./extensions";
import { nullLogger, type Logger } from "./logger";
import type { AgentPool } from "./pool";
import type { UsedCapabilityStore } from "./stores/used-capabilities";

/** What the free probe actually observed — callers that need to react to
 * auth state (terminal-recipe login's restart escalation) read this instead
 * of guessing from side effects. "skipped" = the probe never ran: no
 * connection/declared caps to probe against, or the agent's first-session
 * latch defers it — the terminal-login path treats both as "restart to
 * find out", which is the right move for a stopped agent too. "failed" =
 * round-trip broke for a non-auth reason (an honest declared-but-unproven
 * state, not an error to surface). */
export type ProbeOutcome = "ok" | "auth_required" | "failed" | "skipped";

export interface CapabilityTrackerHooks {
  emit(...events: AgentViewEvent[]): void;
  /** Reads the matrix as it stands *after* an emit already applied — lets
   * the tracker persist the whole row set wholesale without holding its
   * own copy of state that could drift from the canonical one. */
  currentMatrix(agentId: string): CapabilityMatrix | undefined;
  /** Connect-time knob-offering read (offerings are read, never stored) —
   * the probe's session/new response carries the agent's current knob
   * surface. Passed raw (a new surface — spec or extension — must never
   * ripple this signature);
   * the receiver normalizes. Follow-up notifications for the probe session
   * route here via `isProbeSession`. */
  onOfferings?(agentId: string, response: NewSessionResponse): void;
  /** The agent's standing probe workspace — a real, existing directory,
   * never the user's workspace roots. Owned by the orchestrator and deleted
   * only when the agent's config is removed: a probe session may hold this
   * root agent-side for the connection's life (workspace-aware agents
   * validate and index it *after* session/new returns — observed: Auggie),
   * so an ephemeral mkdtemp/rm around the RPCs was patchbay deleting a
   * directory it had just promised away. */
  probeRoot(agentId: string): Promise<string>;
}

export class CapabilityTracker {
  /** agentId → the `agentInfo.version` its current connection reported —
   * what persisted used state gets saved and seeded against. */
  private versions = new Map<string, string>();
  /** Agents whose connect-time probe is parked until the first real
   * session (extensions/first-session-mcp-latch) — armed per connect,
   * spent by noteRealSessionOpened. */
  private deferredProbes = new Set<string>();
  /** Probe sessionId → agentId — lets the orchestrator route an agent's
   * late config_option_update notifications for a throwaway probe session
   * into the offerings instead of dropping them (some agents deliver the
   * option surface only after session/new returns). Pruned per agent at
   * each new probe, so it never holds more than the latest probe session. */
  private probeSessions = new Map<string, string>();

  constructor(
    private readonly pool: AgentPool,
    private readonly usedCache: UsedCapabilityStore,
    private readonly hooks: CapabilityTrackerHooks,
    /** Output-channel seam (logger.ts). */
    private readonly log: Logger = nullLogger,
  ) {}

  /** Call on every connect (including reconnects). `version` is the fresh
   * connection's `agentInfo.version` (null when the agent didn't report
   * one — everything still works, it just never seeds from/saves to the
   * persisted cache, same as before this existed). */
  onDeclared(
    agentId: string,
    declared: DeclaredCapabilities,
    version: string | null,
    protocolVersion: number,
  ): void {
    const fresh = matrixFromDeclared(declared);
    const seeded = version !== null ? this.usedCache.seed(agentId, version, fresh) : fresh;
    if (version !== null) this.versions.set(agentId, version);
    else this.versions.delete(agentId);
    this.hooks.emit({
      kind: "capabilitiesDeclared",
      agentId,
      matrix: seeded,
      authMethods: declared.authMethods,
      protocolVersion,
      at: new Date().toISOString(),
    });
    if (version !== null && seeded !== fresh) {
      this.log.debug(`${agentId}: used-state seeded from cache for v${version}`);
    }
    // Every connect probes: the session/new is the knob-offering read
    // (offerings are connection state) and the concurrency/fork proof
    // opportunity — deliberately NOT an auth proof; its success is
    // non-bearing evidence (auth-evidence.ts). Only the fork sub-check
    // keeps a version-keyed skip, inside probe() itself.
    // Exception: a latched agent's probe waits for the first real session
    // (extensions/first-session-mcp-latch — the probe must not spend the
    // process's one honored mcpServers slot); re-armed on every connect
    // because the latch is per-process.
    if (probeDeferredFor(agentId)) {
      this.deferredProbes.add(agentId);
      this.log.info(`${agentId}: connect-time probe deferred until first real session (first-session-mcp-latch)`);
      return;
    }
    this.log.debug(`${agentId}: connect-time probe starting (offering read; fork where still unproven)`);
    void this.probe(agentId);
  }

  /** A real session opened on this agent's connection (session-manager's
   * attach ceremony fires this via the orchestrator). Two duties: real
   * adoption supersedes probe identity — the agent just minted this id
   * for a real session, so any probe entry still carrying it names a
   * session that necessarily ended agent-side (covers close/delete-
   * incapable agents that reap and recycle on their own). And it is the
   * deferred-probe trigger: the first-session privilege is spent where
   * it belongs, so the probe can run — once per connect; onDeclared
   * re-arms the deferral on reconnect. */
  noteRealSessionOpened(agentId: string, sessionId: string): void {
    if (this.probeSessions.get(sessionId) === agentId) this.probeSessions.delete(sessionId);
    if (!this.deferredProbes.delete(agentId)) return;
    this.log.debug(`${agentId}: deferred probe starting (first real session opened)`);
    void this.probe(agentId);
  }

  /** Whether this session is one of the tracker's throwaway probes.
   * Agent-scoped on purpose: session ids are only unique within one
   * agent's connection, so a bare-sessionId lookup would let one agent's
   * lingering probe entry capture another agent's real session whose id
   * happens to match. */
  isProbeSession(agentId: string, sessionId: string): boolean {
    return this.probeSessions.get(sessionId) === agentId;
  }

  markUsed(agentId: string, row: CapabilityRowId): void {
    this.hooks.emit({ kind: "capabilityUsed", agentId, row });
    this.persist(agentId);
  }

  /** Suspicion, not conviction: the row rode a failed request. Persisted
   * version-keyed exactly like used — a broken bridge must not look clean
   * after a restart — and cleared the moment a success proves the row
   * (used wins; the reducer drops the flag). */
  markSuspect(agentId: string, row: CapabilityRowId): void {
    this.hooks.emit({ kind: "capabilitySuspect", agentId, row });
    this.persist(agentId);
  }

  private persist(agentId: string): void {
    const version = this.versions.get(agentId);
    const matrix = this.hooks.currentMatrix(agentId);
    if (version === undefined || matrix === undefined) return;
    void this.usedCache.save(agentId, version, matrix);
  }

  /** Free RPC round-trip: session/new (+ session/fork, while still
   * declared-but-unused) in a throwaway session rooted at the agent's
   * standing probe dir (hooks.probeRoot), never the workspace, never
   * surfaced as a real session. Doubles as the connect-time
   * offering read: the session/new response's modes/configOptions go out via
   * onOfferings. Marking `auth`/`session.fork` used happens inside pool.ts
   * itself, right where each call succeeds — this only has to make the
   * calls. A declared-but-broken fork (a lying bridge) fails here and the
   * row stays honestly at declared-but-unused. An `auth_required` error is
   * not "broken" — it's the honest, expected outcome for an agent that
   * needs `authenticate` first, surfaced as its own state rather than
   * folded into "check failed". */
  private async probe(agentId: string): Promise<ProbeOutcome> {
    const declared = this.pool.get(agentId)?.declared;
    if (declared === undefined || declared === null) return "skipped";
    for (const [sessionId, owner] of this.probeSessions) {
      if (owner === agentId) this.probeSessions.delete(sessionId);
    }
    const dir = await this.hooks.probeRoot(agentId);
    const probeSessionIds: string[] = [];
    try {
      const response = await this.pool.newSession(agentId, dir);
      probeSessionIds.push(response.sessionId);
      this.probeSessions.set(response.sessionId, agentId);
      this.hooks.onOfferings?.(agentId, response);
      // Deliberately NO auth-state write here: session/new succeeding is
      // non-bearing evidence on lazy-auth agents (Claude passes it while
      // logged out), so what it means is the authority table's call
      // (auth-evidence.ts, fed by pool's wire chokepoint) — a probe can
      // clear only a lock its own method raised, never a witnessed logout.
      const forkStillUnproven =
        declared.sessionFork && !(this.hooks.currentMatrix(agentId)?.["session.fork"].used ?? false);
      if (forkStillUnproven) {
        const forked = await this.pool.fork(agentId, response.sessionId, dir);
        probeSessionIds.push(forked.sessionId);
      }
      // Close, then delete, the throwaway sessions where the agent supports
      // each — probe hygiene first (a list-capable agent's own history must
      // not accrete one junk session per connect), with the session.close
      // and session.delete used-proofs falling out of the same free
      // round-trips (delete is spec-idempotent; close frees what delete
      // doesn't cover on close-only agents).
      // Each successful round-trip also retires the id from probeSessions:
      // once the agent-side session is ended, the id belongs to the agent
      // again and may legally be re-minted for a future real session — a
      // lingering registration would silently swallow that real session's
      // updates and auto-deny its permission requests. Close-incapable
      // agents keep their entries (their probe session genuinely lives on
      // agent-side, so late traffic on it must still be routed here).
      if (declared.sessionClose) {
        for (const id of probeSessionIds) {
          await this.pool.closeSession(agentId, id);
          this.probeSessions.delete(id);
        }
      }
      if (declared.sessionDelete) {
        for (const id of probeSessionIds) {
          await this.pool.deleteSession(agentId, id);
          this.probeSessions.delete(id);
        }
      }
      return "ok";
    } catch (err) {
      if (err instanceof RequestError && err.code === -32000) {
        // needsAuth itself was already raised through pool.ts's wire
        // chokepoint (onAuthWireFact → the orchestrator's one auth-state
        // writer); this only names the friendly next step in the log.
        this.log.info(`${agentId}: probe hit auth_required — Log in to proceed`);
        return "auth_required";
      }
      // declared but the round-trip failed — an honest state, not an error to surface
      this.log.debug(`${agentId}: probe round-trip failed — ${(err as Error).message}`);
      return "failed";
    } finally {
      // Probe sessions must not linger in the connection's session set:
      // process-policy "auto" reads that set as real concurrent sessions
      // (hasExisting) and would needlessly isolate the user's first
      // top-level session whenever the fork half of the probe failed.
      // The probe root itself is NOT cleaned here — its lifetime is the
      // agent's config, not this call (see hooks.probeRoot).
      for (const id of probeSessionIds) this.pool.forgetSession(agentId, id);
    }
  }

  /** User-run Verify, also the "Verify
   * after add" default: cost disclosed first. Today that cost is genuinely
   * zero — behavior-level probes need real handlers before there's
   * anything honest to exercise, so running them now would spend a real
   * agent turn probing capabilities patchbay itself doesn't implement yet.
   * Re-runs the free checks only. */
  async verify(agentId: string): Promise<ProbeOutcome> {
    // A latched agent's probe stays parked (first-session-mcp-latch): a
    // user-run Verify must not spend the process's one honored mcpServers
    // slot on a throwaway session — same deferral onDeclared honors.
    if (this.deferredProbes.has(agentId)) {
      this.log.info(`${agentId}: verify skipped — probe deferred until first real session`);
      return "skipped";
    }
    return await this.probe(agentId);
  }

  /** Stable `authenticate` round trip, then retries the probe so a
   * successful login is reflected immediately rather than waiting for the
   * next real session attempt. Failure (rejected, cancelled, agent-side
   * error) surfaces plainly — `agentAuthRequired` stays set, never silently
   * cleared on a failed attempt. The trailing probe honors the same latch
   * deferral as verify; auth state doesn't need it (the authenticate
   * success itself is the authority's clearing evidence). */
  async authenticate(agentId: string, methodId: string): Promise<void> {
    await this.pool.authenticate(agentId, methodId);
    if (this.deferredProbes.has(agentId)) return;
    await this.probe(agentId);
  }

  /** Stable `logout` round trip — and no probe after it: probing would ask
   * the agent a question the wire cannot answer honestly (lazy-auth agents
   * pass session/new while logged out). The auth-state consequence is not
   * decided here at all: pool's wire chokepoint reports "logout settled
   * ok" and the authority table (auth-evidence.ts) turns that into the
   * strongest lock there is — cleared only by an affirmative login or a
   * completed prompt, never by a reconnect's probe.
   *
   * The orchestrator disconnects the agent's processes right after this
   * returns (logoutAgent): a process that has held credentials is never
   * trusted to shed them — auth state read at spawn and never re-read is
   * live agent behavior (auggie dossier, 2026-07-14), and its logout-side
   * mirror (a process that keeps working after revocation) is a security
   * hazard. The lock's reason doubles as the stopped card's explanation. */
  async logout(agentId: string): Promise<void> {
    await this.pool.logout(agentId);
  }
}
