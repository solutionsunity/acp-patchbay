// Owns capability-matrix bookkeeping and the verification triggers that are
// actually buildable today. vscode-free (like session-manager.ts) so it's
// unit-testable against the fake agent without a real extension host.
//
// architecture.md's verification-cost table draws the line precisely:
// protocol-level checks are free and automatic on connect; behavior-level
// probes cost a real agent turn and need real handlers to be honest at all.
// Today that's exactly one automatic check (session/fork round-trip) plus
// three opportunistic ones wired from elsewhere (session.load in
// session-manager.ts, usage + concurrentSessions in session-manager.ts /
// pool.ts). fs/terminal/elicitation/image verification wait on P6/P7's real
// handlers — declaring them verifiable now would be exactly the kind of lie
// bet #2 exists to prevent.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentViewEvent, CapabilityRowId, DeclaredCapabilities } from "../shared/protocol";
import { matrixFromDeclared } from "./capabilities";
import type { AgentPool } from "./pool";

export interface CapabilityVerifierHooks {
  emit(...events: AgentViewEvent[]): void;
}

export class CapabilityVerifier {
  constructor(
    private readonly pool: AgentPool,
    private readonly hooks: CapabilityVerifierHooks,
  ) {}

  /** Call on every connect (including reconnects) — replaces the agent's
   * whole matrix, which is what makes "verified resets on reconnect" true
   * without any extra bookkeeping. */
  onDeclared(agentId: string, declared: DeclaredCapabilities): void {
    this.hooks.emit({
      kind: "capabilitiesDeclared",
      agentId,
      matrix: matrixFromDeclared(declared),
      at: new Date().toISOString(),
    });
    if (declared.sessionFork) void this.verifyForkRoundTrip(agentId);
  }

  markVerified(agentId: string, row: CapabilityRowId): void {
    this.hooks.emit({ kind: "capabilityVerified", agentId, row });
  }

  /** Free RPC round-trip: session/new + session/fork in a throwaway temp-dir
   * session, never the workspace, never surfaced as a real session. A
   * declared-but-broken fork (a lying bridge) fails here and the row stays
   * honestly at declared-but-unverified. */
  private async verifyForkRoundTrip(agentId: string): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "acp-patchbay-verify-"));
    const probeSessionIds: string[] = [];
    try {
      const { sessionId } = await this.pool.newSession(agentId, dir);
      probeSessionIds.push(sessionId);
      const forked = await this.pool.fork(agentId, sessionId, dir);
      probeSessionIds.push(forked.sessionId);
      this.markVerified(agentId, "session.fork");
    } catch {
      // declared but the round-trip failed — an honest state, not an error to surface
    } finally {
      // Probe sessions must not linger in the connection's session set:
      // process-policy "auto" reads that set as real concurrent sessions
      // (hasExisting) and would needlessly isolate the user's first
      // top-level session whenever the fork half of the probe failed.
      for (const id of probeSessionIds) this.pool.forgetSession(agentId, id);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** User-run diagnostics (features.md § Settings § Agents): cost disclosed
   * first. Today that cost is genuinely zero — behavior-level probes need
   * P6/P7's real handlers before there's anything honest to exercise, so
   * running them now would spend a real agent turn probing capabilities
   * patchbay itself doesn't implement yet. Re-runs the free checks only. */
  async runDiagnostics(agentId: string): Promise<void> {
    const declared = this.pool.get(agentId)?.declared;
    if (declared?.sessionFork) await this.verifyForkRoundTrip(agentId);
  }
}
