import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { CapabilityTracker } from "../../src/orchestrator/capability-tracker";
import type { AttachedServer } from "../../src/orchestrator/mcp-servers-store";
import { AgentPool } from "../../src/orchestrator/pool";
import type { SessionGates } from "../../src/orchestrator/session-gates";
import { SessionsStore } from "../../src/orchestrator/sessions-store";
import { MemoryKV } from "../../src/orchestrator/stores/kv";
import { SessionContinuityStore } from "../../src/orchestrator/stores/session-continuity";
import { SessionFilesStore } from "../../src/orchestrator/stores/session-files";
import { UsedCapabilityStore } from "../../src/orchestrator/stores/used-capabilities";
import { initialAgentViewState, reduceAgentView, type AgentViewEvent, type AgentViewState } from "../../src/shared/protocol";
import type { PatchbayAgentId, PatchbaySessionId } from "../../src/shared/ids";
import { gatesFor } from "./session-gates";
import { stubFsTerminalHooks } from "./stub-hooks";

/** Wires a pool + sessions store the way Orchestrator does, minus vscode —
 * `cwd` is the test's own folder: the session files and every session's cwd. */
export function sessionsHarness(cwd: string, opts?: {
  /** Idle reaper period — default null (disabled) so tests opt in. */
  idleCloseMs?: number;
  /** Stand-in for the reducer-derived unseen (blue) mark. */
  isUnseen?(patchbaySessionId: PatchbaySessionId): boolean;
  /** Stand-in for the orchestrator's auth-lock read — the turn-start door
   * consults it before any transcript write or wire call. */
  authLocked?(patchbayAgentId: PatchbayAgentId): boolean;
  /** Shared across two harnesses to simulate a window reload: the durable
   * per-session continuity row is the only state that survives. */
  continuityStore?: SessionContinuityStore;
  /** Stand-in for the orchestrator's pinned-panel list: sessions on view
   * in their own window, active-pointer or not. */
  pinned?: ReadonlySet<string>;
  /** Stand-in for the orchestrator's connect-on-demand — records the asks. */
  onConnectForSession?(patchbaySessionId: PatchbaySessionId): void;
  /** Stand-in for the open workspace's folders (reality read, never stored)
   * — the first is the cwd; the rest must reach the agent as additional
   * directories. Mutable through the returned array to simulate a folder
   * change. */
  workspaceRoots?: readonly string[];
  /** Stand-in for the orchestrator's saved-roots read — this workspace's
   * list, then every workspace's, as stored (duplicates and all). */
  savedRoots?: readonly string[];
  /** Folders gone from disk — stand-in for the orchestrator's reality
   * read. Mutable through the returned array. */
  missingRoots?: readonly string[];
  /** Stand-in for the agents' queue: what a session's work enters behind.
   * Absent, agents' rows hold nothing. */
  agentSettled?(patchbayAgentId: PatchbayAgentId): Promise<void>;
  /** Stand-in for the orchestrator's composition of a session's MCP
   * servers. Absent, an attach gives none. */
  mcpServersFor?(
    contextToken: string,
    patchbayAgentId: PatchbayAgentId,
  ): Promise<{ servers: McpServer[]; given: readonly AttachedServer[] }>;
}): {
  pool: AgentPool;
  sessions: SessionsStore;
  /** The orchestrator's gates over the store — every operation on a
   * session's connection goes through them. */
  gates: SessionGates;
  capabilityTracker: CapabilityTracker;
  files: SessionFilesStore;
  events: AgentViewEvent[];
  /** Events delivered through the silent (replay-window) path — also in
   * `events`, so `state()` stays the full canonical reduction. */
  silentEvents: AgentViewEvent[];
  resyncCount(): number;
  state(): AgentViewState;
  workspaceRoots: string[];
  /** Every `rootsChanged` the store fired — the orchestrator's cue to
   * tell the session's MCP subprocesses. */
  rootsChanged: string[];
  missingRoots: string[];
  /** Every `rootsMissing` report — the orchestrator's cue to republish the
   * saved roots with their missing marks. */
  rootsMissing: string[][];
} {
  const events: AgentViewEvent[] = [];
  const silentEvents: AgentViewEvent[] = [];
  const workspaceRoots = [...(opts?.workspaceRoots ?? [])];
  const rootsChanged: string[] = [];
  const missingRoots = [...(opts?.missingRoots ?? [])];
  const rootsMissing: string[][] = [];
  const continuity = opts?.continuityStore ?? new SessionContinuityStore(new MemoryKV());
  const files = new SessionFilesStore(join(cwd, "session-files"));
  let resyncs = 0;
  let sessions!: SessionsStore;
  let capabilityTracker!: CapabilityTracker;
  const pool = new AgentPool({
    onStatusChanged: (patchbayAgentId, status) => sessions.agentStatusChanged(patchbayAgentId, status),
    onDeclaredCaptured: (patchbayAgentId) => capabilityTracker.onDeclared(patchbayAgentId),
    onSessionUpdate: (patchbayAgentId, notification) => sessions.handleUpdate(patchbayAgentId, notification),
    onCapabilityEvidence: (patchbayAgentId, row, evidence) => capabilityTracker.noteEvidence(patchbayAgentId, row, evidence),
    ...stubFsTerminalHooks(),
  });
  capabilityTracker = new CapabilityTracker(pool, new UsedCapabilityStore(new MemoryKV()), {
    registryIdOf: () => null,
    changed: () => {},
    probeRoot: async () => cwd, // exists for the test's life — the contract
  });
  sessions = new SessionsStore(
    pool,
    {
      emit: (...evs) => events.push(...evs),
      emitSilent: (...evs) => {
        events.push(...evs);
        silentEvents.push(...evs);
      },
      resyncView: () => {
        resyncs += 1;
      },
      workspaceRoots: () => workspaceRoots,
      savedRoots: () => opts?.savedRoots ?? [],
      rootExists: (path) => !missingRoots.includes(path),
      rootsMissing: (paths) => rootsMissing.push([...paths]),
      rootsChanged: (patchbaySessionId) => rootsChanged.push(patchbaySessionId),
      currentTranscript: (patchbaySessionId) =>
        events.reduce(reduceAgentView, initialAgentViewState).transcripts[patchbaySessionId] ?? [],
      capabilities: (patchbayAgentId) => capabilityTracker.matrix(patchbayAgentId),
      isActiveSession: (patchbaySessionId) =>
        events.reduce(reduceAgentView, initialAgentViewState).activePatchbaySessionId === patchbaySessionId ||
        (opts?.pinned?.has(patchbaySessionId) ?? false),
      isUnseen: (patchbaySessionId) => opts?.isUnseen?.(patchbaySessionId) ?? false,
      authLocked: (patchbayAgentId) => opts?.authLocked?.(patchbayAgentId) ?? false,
    },
    continuity,
    files,
    () => cwd,
    opts?.mcpServersFor,
  );
  const gates = gatesFor(sessions, (event) => events.push(event), {
    idleCloseMs: opts?.idleCloseMs ?? null,
    connect: (patchbaySessionId) => opts?.onConnectForSession?.(patchbaySessionId),
    ...(opts?.agentSettled !== undefined ? { agentSettled: opts.agentSettled } : {}),
  });
  return {
    pool,
    sessions,
    gates,
    capabilityTracker,
    files,
    events,
    silentEvents,
    resyncCount: () => resyncs,
    state: () => events.reduce(reduceAgentView, initialAgentViewState),
    workspaceRoots,
    rootsChanged,
    missingRoots,
    rootsMissing,
  };
}
