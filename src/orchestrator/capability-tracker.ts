// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Owns capability-matrix bookkeeping and the free connectivity probe.
// vscode-free (like sessions-store.ts) so it's unit-testable against the
// fake agent without a real extension host.
//
// The verification-cost distinction draws the line precisely:
// protocol-level checks are free and automatic on connect; behavior-level
// probes cost a real agent turn and need real handlers to be honest at all.
// The probe runs on *every* connect — its session/new is the concurrency,
// close, and delete proof opportunity, proves whether `auth_required`
// blocks this agent, and adds the session/fork round-trip while that row
// is still declared-but-unused. (Knob offerings are not read here: the
// settings defaults editor reads them from its own session, for the
// defaults being edited.)
// Which wire fact proves which row isn't decided here — pool.ts's wire
// chokepoints (agent RPC resolved, incoming request handled, session/update
// kind tag arrived) consult the one proof table (capabilities.ts
// CAPABILITY_PROOFS) and report through the one `onCapabilityEvidence`
// hook; no call site anywhere names a row. This file records what is
// reported and decides *when* to run the synthetic probe below.
//
// The matrix is read, never held: what the agent's connection declared,
// with the marks earned against its `agentInfo.version` read from the used
// cache — so a reconnect at the *same* version restores what was already
// proven, and only an actual version change earns a fresh, honestly-unused
// matrix.
import type { NewSessionResponse } from "@agentclientprotocol/sdk";
import type { CapabilityCell, CapabilityMatrix, CapabilityRowId } from "../shared/protocol";
import { matrixFromDeclared } from "./capabilities";
import { probeDeferredFor } from "./extensions";
import { nullLogger, type Logger } from "./logger";
import { authRequiredReasonOf, type AgentPool } from "./pool";
import type { UsedCapabilityStore } from "./stores/used-capabilities";
import type { PatchbayAgentId } from "../shared/ids";

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
  /** The agent's matrix moved — a fresh connection declared, or a row was
   * marked. */
  changed(patchbayAgentId: PatchbayAgentId): void;
  /** Announces each throwaway probe session as its session/new lands —
   * the raw response, so an observer (a test, a diagnostic) learns the
   * id the agent minted and what it answered. The tracker itself routes
   * the probe's later traffic via `isProbeSession`; settings offerings
   * come from the defaults editor's own session, never from here. */
  onProbeSession?(patchbayAgentId: PatchbayAgentId, response: NewSessionResponse): void;
  /** The agent's standing probe workspace — a real, existing directory,
   * never the user's workspace roots. Owned by the orchestrator and deleted
   * only when the agent's config is removed: a probe session may hold this
   * root agent-side for the connection's life (workspace-aware agents
   * validate and index it *after* session/new returns — observed: Auggie),
   * so an ephemeral mkdtemp/rm around the RPCs was patchbay deleting a
   * directory it had just promised away. */
  probeRoot(patchbayAgentId: PatchbayAgentId): Promise<string>;
  /** The registry entry the agent was added from — what an extension
   * module's curated entry names a vendor by. Null for a custom command. */
  registryIdOf(patchbayAgentId: PatchbayAgentId): string | null;
}

export class CapabilityTracker {
  /** Marks earned on the current connection of an agent that reports no
   * `agentInfo.version` — nothing to key them by in the used cache, so they
   * last as long as the connection. A versioned agent's marks are written
   * to the cache and read back from it. */
  private unversionedMarks = new Map<string, Partial<Record<CapabilityRowId, CapabilityCell>>>();
  /** Agents whose connect-time probe is parked until the first real
   * session (extensions/first-session-mcp-latch) — armed per connect,
   * spent by noteRealSessionOpened. */
  private deferredProbes = new Set<string>();
  /** Probe sessionId → patchbayAgentId — lets the orchestrator route an agent's
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

  /** The agent's matrix, read now: what its connection in this window
   * declared, with the marks earned against that connection's version —
   * from the used cache, or, for an agent that reports no version, from
   * this connection. Undefined until it has connected in this window. */
  matrix(patchbayAgentId: PatchbayAgentId): CapabilityMatrix | undefined {
    const live = this.pool.get(patchbayAgentId);
    if (live?.declared === undefined || live.declared === null) return undefined;
    const fresh = matrixFromDeclared(live.declared);
    const version = live.initialize?.agentInfo?.version;
    if (version !== undefined) return this.usedCache.seed(patchbayAgentId, version, fresh);
    return { ...fresh, ...this.unversionedMarks.get(patchbayAgentId) };
  }

  /** A wire fact bore on a row (pool.ts's proof-table chokepoints): marks it
   * used the first time its path is genuinely exercised, or suspect the
   * first time it rides a failed request. A row already used takes no
   * mark — suspicion never speaks over proof — and a repeat of a standing
   * mark writes nothing. */
  noteEvidence(patchbayAgentId: PatchbayAgentId, row: CapabilityRowId, evidence: "used" | "suspect"): void {
    const cell = this.matrix(patchbayAgentId)?.[row];
    if (cell === undefined || cell.used) return;
    // Used always implies declared — which is what lets rows with no
    // initialize-time claim (usage, concurrentSessions) go straight from
    // not-declared to used — and the whole cell is written, so a success
    // drops any suspect flag: success acquits. Suspicion implies declared
    // too: the attempt is itself the claim.
    if (evidence === "used") this.mark(patchbayAgentId, row, { declared: true, used: true });
    else if (cell.suspect !== true) this.mark(patchbayAgentId, row, { declared: true, used: false, suspect: true });
  }

  /** Writes one mark where the matrix reads it back from: the used cache,
   * keyed by the connection's version — persisted so a broken bridge can't
   * look clean after a restart either — or this connection's own marks. */
  private mark(patchbayAgentId: PatchbayAgentId, row: CapabilityRowId, cell: CapabilityCell): void {
    const matrix = this.matrix(patchbayAgentId);
    if (matrix === undefined) return;
    const version = this.pool.get(patchbayAgentId)?.initialize?.agentInfo?.version;
    if (version !== undefined) void this.usedCache.save(patchbayAgentId, version, { ...matrix, [row]: cell });
    else this.unversionedMarks.set(patchbayAgentId, { ...this.unversionedMarks.get(patchbayAgentId), [row]: cell });
    this.hooks.changed(patchbayAgentId);
  }

  /** Call on every connect (including reconnects), once the fresh
   * connection's `initialize` answer is in the pool. An agent reporting no
   * `agentInfo.version` never seeds from or saves to the used cache —
   * everything still works, its marks just last as long as the connection. */
  onDeclared(patchbayAgentId: PatchbayAgentId): void {
    this.unversionedMarks.delete(patchbayAgentId);
    this.hooks.changed(patchbayAgentId);
    // Every connect probes: the session/new is the concurrency/close/
    // delete/fork proof opportunity — deliberately NOT an auth proof; its
    // success is non-bearing evidence (auth-evidence.ts). Only the fork
    // sub-check keeps a version-keyed skip, inside probe() itself.
    // Exception: a latched agent's probe waits for the first real session
    // (extensions/first-session-mcp-latch — the probe must not spend the
    // process's one honored mcpServers slot); re-armed on every connect
    // because the latch is per-process.
    if (probeDeferredFor(this.hooks.registryIdOf(patchbayAgentId))) {
      this.deferredProbes.add(patchbayAgentId);
      this.log.info(`${patchbayAgentId}: connect-time probe deferred until first real session (first-session-mcp-latch)`);
      return;
    }
    this.log.debug(`${patchbayAgentId}: connect-time probe starting (fork where still unproven)`);
    void this.probe(patchbayAgentId);
  }

  /** A removed agent's live marks leave with it: its connection's own
   * marks, a parked probe, its probe sessions. */
  forget(patchbayAgentId: PatchbayAgentId): void {
    this.unversionedMarks.delete(patchbayAgentId);
    this.deferredProbes.delete(patchbayAgentId);
    for (const [sessionId, owner] of this.probeSessions) {
      if (owner === patchbayAgentId) this.probeSessions.delete(sessionId);
    }
  }

  /** A real session opened on this agent's connection (the sessions store's
   * attach ceremony fires this via the orchestrator). Two duties: real
   * adoption supersedes probe identity — the agent just minted this id
   * for a real session, so any probe entry still carrying it names a
   * session that necessarily ended agent-side (covers close/delete-
   * incapable agents that reap and recycle on their own). And it is the
   * deferred-probe trigger: the first-session privilege is spent where
   * it belongs, so the probe can run — once per connect; onDeclared
   * re-arms the deferral on reconnect. */
  noteRealSessionOpened(patchbayAgentId: PatchbayAgentId, sessionId: string): void {
    if (this.probeSessions.get(sessionId) === patchbayAgentId) this.probeSessions.delete(sessionId);
    if (!this.deferredProbes.delete(patchbayAgentId)) return;
    this.log.debug(`${patchbayAgentId}: deferred probe starting (first real session opened)`);
    void this.probe(patchbayAgentId);
  }

  /** Whether this session is one of the tracker's throwaway probes.
   * Agent-scoped on purpose: session ids are only unique within one
   * agent's connection, so a bare-sessionId lookup would let one agent's
   * lingering probe entry capture another agent's real session whose id
   * happens to match. */
  isProbeSession(patchbayAgentId: PatchbayAgentId, sessionId: string): boolean {
    return this.probeSessions.get(sessionId) === patchbayAgentId;
  }

  /** Whether this agent's first-session privilege is still unspent — any
   * other throwaway session (the defaults editor's) must wait as the probe
   * does, or it would take the one honored mcpServers slot. */
  isProbeDeferred(patchbayAgentId: PatchbayAgentId): boolean {
    return this.deferredProbes.has(patchbayAgentId);
  }

  /** Free RPC round-trip: session/new (+ session/fork, while still
   * declared-but-unused) in a throwaway session rooted at the agent's
   * standing probe dir (hooks.probeRoot), never the workspace, never
   * surfaced as a real session; the raw session/new response is announced
   * via onProbeSession. Marking `auth`/`session.fork` used happens inside pool.ts
   * itself, right where each call succeeds — this only has to make the
   * calls. A declared-but-broken fork (a lying bridge) fails here and the
   * row stays honestly at declared-but-unused. An `auth_required` error is
   * not "broken" — it's the honest, expected outcome for an agent that
   * needs `authenticate` first, surfaced as its own state rather than
   * folded into "check failed". */
  private async probe(patchbayAgentId: PatchbayAgentId): Promise<ProbeOutcome> {
    const declared = this.pool.get(patchbayAgentId)?.declared;
    if (declared === undefined || declared === null) return "skipped";
    for (const [sessionId, owner] of this.probeSessions) {
      if (owner === patchbayAgentId) this.probeSessions.delete(sessionId);
    }
    const dir = await this.hooks.probeRoot(patchbayAgentId);
    const probeSessionIds: string[] = [];
    try {
      const response = await this.pool.newSession(patchbayAgentId, dir);
      probeSessionIds.push(response.sessionId);
      this.probeSessions.set(response.sessionId, patchbayAgentId);
      this.hooks.onProbeSession?.(patchbayAgentId, response);
      // Deliberately NO auth-state write here: session/new succeeding is
      // non-bearing evidence on lazy-auth agents (Claude passes it while
      // logged out), so what it means is the authority table's call
      // (auth-evidence.ts, fed by pool's wire chokepoint) — a probe can
      // clear only a lock its own method raised, never a witnessed logout.
      const forkStillUnproven =
        declared.sessionFork && !(this.matrix(patchbayAgentId)?.["session.fork"].used ?? false);
      if (forkStillUnproven) {
        const forked = await this.pool.fork(patchbayAgentId, response.sessionId, dir);
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
          await this.pool.closeSession(patchbayAgentId, id);
          this.probeSessions.delete(id);
        }
      }
      if (declared.sessionDelete) {
        for (const id of probeSessionIds) {
          await this.pool.deleteSession(patchbayAgentId, id);
          this.probeSessions.delete(id);
        }
      }
      return "ok";
    } catch (err) {
      if (authRequiredReasonOf(err) !== null) {
        // needsAuth itself was already raised through pool.ts's wire
        // chokepoint (onAuthWireFact → the orchestrator's one auth-state
        // writer); this only names the friendly next step in the log.
        this.log.info(`${patchbayAgentId}: probe hit auth_required — Log in to proceed`);
        return "auth_required";
      }
      // declared but the round-trip failed — an honest state, not an error to surface
      this.log.debug(`${patchbayAgentId}: probe round-trip failed — ${(err as Error).message}`);
      return "failed";
    } finally {
      // Probe sessions must not linger in the connection's session set:
      // the concurrent-sessions proof counts that set, and the user's own
      // first session/new would then read as a second session — proven by
      // patchbay's throwaway, not by real use.
      // The probe root itself is NOT cleaned here — its lifetime is the
      // agent's config, not this call (see hooks.probeRoot).
      for (const id of probeSessionIds) this.pool.forgetSession(patchbayAgentId, id);
    }
  }

  /** User-run Verify, also the "Verify
   * after add" default: cost disclosed first. Today that cost is genuinely
   * zero — behavior-level probes need real handlers before there's
   * anything honest to exercise, so running them now would spend a real
   * agent turn probing capabilities patchbay itself doesn't implement yet.
   * Re-runs the free checks only. */
  async verify(patchbayAgentId: PatchbayAgentId): Promise<ProbeOutcome> {
    // A latched agent's probe stays parked (first-session-mcp-latch): a
    // user-run Verify must not spend the process's one honored mcpServers
    // slot on a throwaway session — same deferral onDeclared honors.
    if (this.deferredProbes.has(patchbayAgentId)) {
      this.log.info(`${patchbayAgentId}: verify skipped — probe deferred until first real session`);
      return "skipped";
    }
    return await this.probe(patchbayAgentId);
  }

  /** Stable `authenticate` round trip, then retries the probe so a
   * successful login is reflected immediately rather than waiting for the
   * next real session attempt. Failure (rejected, cancelled, agent-side
   * error) surfaces plainly — the auth lock stays set, never silently
   * cleared on a failed attempt. The trailing probe honors the same latch
   * deferral as verify; auth state doesn't need it (the authenticate
   * success itself is the authority's clearing evidence). */
  async authenticate(patchbayAgentId: PatchbayAgentId, methodId: string): Promise<void> {
    await this.pool.authenticate(patchbayAgentId, methodId);
    if (this.deferredProbes.has(patchbayAgentId)) return;
    await this.probe(patchbayAgentId);
  }

  /** Stable `logout` round trip — and no probe after it: probing would ask
   * the agent a question the wire cannot answer honestly (lazy-auth agents
   * pass session/new while logged out). The auth-state consequence is not
   * decided here at all: pool's wire chokepoint reports "logout settled
   * ok" and the authority table (auth-evidence.ts) turns that into the
   * strongest lock there is — cleared only by an affirmative login or a
   * completed prompt, never by a reconnect's probe.
   *
   * The agents store disconnects the agent's process right after this
   * returns (its logout): a process that has held credentials is never
   * trusted to shed them — auth state read at spawn and never re-read is
   * live agent behavior (auggie dossier, 2026-07-14), and its logout-side
   * mirror (a process that keeps working after revocation) is a security
   * hazard. The lock's reason doubles as the stopped card's explanation. */
  async logout(patchbayAgentId: PatchbayAgentId): Promise<void> {
    await this.pool.logout(patchbayAgentId);
  }
}
