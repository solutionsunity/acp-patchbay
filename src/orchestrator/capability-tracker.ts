// Owns capability-matrix bookkeeping and the free connectivity probe.
// vscode-free (like session-manager.ts) so it's unit-testable against the
// fake agent without a real extension host.
//
// architecture.md's verification-cost table draws the line precisely:
// protocol-level checks are free and automatic on connect; behavior-level
// probes cost a real agent turn and need real handlers to be honest at all.
// Today that's exactly one automatic check (session/new + session/fork
// round-trip, which also proves whether `auth_required` blocks this agent).
// Marking a row *used* doesn't happen here, though — it happens in pool.ts
// itself, at the exact point each RPC succeeds or a wire notification's kind
// tag arrives (one `onCapabilityUsed` hook, fired alike for auth,
// session.fork, session.load, usage, concurrentSessions). This file only
// decides *when* to run the synthetic probe below and persists whatever
// pool.ts reports. fs/terminal/elicitation/image marking wait on P6/P7's
// real handlers — declaring them checkable now would be exactly the kind of
// lie bet #2 exists to prevent.
//
// Used to reset on every reconnect (a side effect of always rebuilding the
// matrix fresh); it's now version-keyed (capability-verification.md,
// amended) — a reconnect at the *same* `agentInfo.version` restores what was
// already proven, and only an actual version change earns a fresh,
// honestly-unused matrix.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  hasUnusedProbe,
  type AgentViewEvent,
  type CapabilityMatrix,
  type CapabilityRowId,
  type DeclaredCapabilities,
} from "../shared/protocol";
import { matrixFromDeclared } from "./capabilities";
import { nullLogger, type Logger } from "./logger";
import type { AgentPool } from "./pool";
import type { UsedCapabilityStore } from "./stores/used-capabilities";

export interface CapabilityTrackerHooks {
  emit(...events: AgentViewEvent[]): void;
  /** Reads the matrix as it stands *after* an emit already applied — lets
   * the tracker persist the whole row set wholesale without holding its
   * own copy of state that could drift from the canonical one. */
  currentMatrix(agentId: string): CapabilityMatrix | undefined;
}

export class CapabilityTracker {
  /** agentId → the `agentInfo.version` its current connection reported —
   * what persisted used state gets saved and seeded against. */
  private versions = new Map<string, string>();

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
  onDeclared(agentId: string, declared: DeclaredCapabilities, version: string | null): void {
    const fresh = matrixFromDeclared(declared);
    const seeded = version !== null ? this.usedCache.seed(agentId, version, fresh) : fresh;
    if (version !== null) this.versions.set(agentId, version);
    else this.versions.delete(agentId);
    this.hooks.emit({
      kind: "capabilitiesDeclared",
      agentId,
      matrix: seeded,
      authMethods: declared.authMethods,
      at: new Date().toISOString(),
    });
    if (version !== null && seeded !== fresh) {
      this.log.debug(`${agentId}: used-state seeded from cache for v${version}`);
    }
    if (hasUnusedProbe(seeded, declared.authMethods)) {
      this.log.debug(`${agentId}: free connectivity probe starting (session/new + fork where declared)`);
      void this.probe(agentId);
    }
  }

  markUsed(agentId: string, row: CapabilityRowId): void {
    this.hooks.emit({ kind: "capabilityUsed", agentId, row });
    this.persist(agentId);
  }

  private persist(agentId: string): void {
    const version = this.versions.get(agentId);
    const matrix = this.hooks.currentMatrix(agentId);
    if (version === undefined || matrix === undefined) return;
    void this.usedCache.save(agentId, version, matrix);
  }

  /** Free RPC round-trip: session/new (+ session/fork, when declared) in a
   * throwaway temp-dir session, never the workspace, never surfaced as a
   * real session. Marking `auth`/`session.fork` used happens inside pool.ts
   * itself, right where each call succeeds — this only has to make the
   * calls. A declared-but-broken fork (a lying bridge) fails here and the
   * row stays honestly at declared-but-unused. An `auth_required` error is
   * not "broken" — it's the honest, expected outcome for an agent that
   * needs `authenticate` first, surfaced as its own state rather than
   * folded into "check failed". */
  private async probe(agentId: string): Promise<void> {
    const declared = this.pool.get(agentId)?.declared;
    if (declared === undefined || declared === null) return;
    const dir = await mkdtemp(join(tmpdir(), "acp-patchbay-verify-"));
    const probeSessionIds: string[] = [];
    try {
      const { sessionId } = await this.pool.newSession(agentId, dir);
      probeSessionIds.push(sessionId);
      this.hooks.emit({ kind: "agentAuthResolved", agentId });
      if (declared.sessionFork) {
        const forked = await this.pool.fork(agentId, sessionId, dir);
        probeSessionIds.push(forked.sessionId);
      }
    } catch (err) {
      if (err instanceof RequestError && err.code === -32000) {
        this.log.info(`${agentId}: probe hit auth_required — Log in to proceed`);
        this.hooks.emit({ kind: "agentAuthRequired", agentId });
      } else {
        // declared but the round-trip failed — an honest state, not an error to surface
        this.log.debug(`${agentId}: probe round-trip failed — ${(err as Error).message}`);
      }
    } finally {
      // Probe sessions must not linger in the connection's session set:
      // process-policy "auto" reads that set as real concurrent sessions
      // (hasExisting) and would needlessly isolate the user's first
      // top-level session whenever the fork half of the probe failed.
      for (const id of probeSessionIds) this.pool.forgetSession(agentId, id);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** User-run Verify (features.md § Settings § Agents), also the "Verify
   * after add" default: cost disclosed first. Today that cost is genuinely
   * zero — behavior-level probes need P6/P7's real handlers before there's
   * anything honest to exercise, so running them now would spend a real
   * agent turn probing capabilities patchbay itself doesn't implement yet.
   * Re-runs the free checks only. */
  async verify(agentId: string): Promise<void> {
    await this.probe(agentId);
  }

  /** Stable `authenticate` round trip, then retries the probe so a
   * successful login is reflected immediately rather than waiting for the
   * next real session attempt. Failure (rejected, cancelled, agent-side
   * error) surfaces plainly — `agentAuthRequired` stays set, never silently
   * cleared on a failed attempt. */
  async authenticate(agentId: string, methodId: string): Promise<void> {
    await this.pool.authenticate(agentId, methodId);
    await this.probe(agentId);
  }
}
