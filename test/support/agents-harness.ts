// The agents store wired the way the orchestrator wires it — the pool's
// reports go to the store, the capability tracker under it, the queue and
// the gates over it, every saved fact in memory — minus vscode. One wiring
// for every suite that drives agents over the real fake agent, so none of
// them carries its own copy of a writer.
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentGates, type AgentOperation, type GateAsks } from "../../src/orchestrator/agent-gates";
import { AgentsStore, type AgentsStoreDeps, type AgentsStoreHooks } from "../../src/orchestrator/agents-store";
import { CapabilityTracker } from "../../src/orchestrator/capability-tracker";
import { AgentPool, type LaunchResolver } from "../../src/orchestrator/pool";
import { Queue } from "../../src/orchestrator/queue";
import { AcpRegistryStore } from "../../src/orchestrator/stores/acp-registry";
import { AgentConfigStore } from "../../src/orchestrator/stores/agent-configs";
import { AuthLockStore } from "../../src/orchestrator/stores/auth-locks";
import { ComposerKnobsStore } from "../../src/orchestrator/stores/composer-knobs";
import { MemorySecrets } from "../../src/orchestrator/stores/mcp-server-tokens";
import { MemoryKV } from "../../src/orchestrator/stores/kv";
import { LastConnectedStore } from "../../src/orchestrator/stores/last-connected";
import { DefaultAgentFoldStore } from "../../src/orchestrator/stores/default-agent-fold";
import { SecretEnvStore } from "../../src/orchestrator/stores/secret-env";
import { UsedCapabilityStore } from "../../src/orchestrator/stores/used-capabilities";
import {
  initialAgentViewState,
  reduceAgentView,
  type AgentSummary,
  type AgentViewEvent,
  type AgentViewState,
} from "../../src/shared/protocol";
import { stubFsTerminalHooks } from "./stub-hooks";
import type { PatchbayAgentId } from "../../src/shared/ids";

export interface AgentsHarness {
  pool: AgentPool;
  tracker: CapabilityTracker;
  /** The store itself — its operations run here unqueued, as a unit. */
  agents: AgentsStore;
  /** The doors' way to the connection operations: through the queue. */
  gates: AgentGates;
  deps: AgentsStoreDeps;
  events: AgentViewEvent[];
  state(): AgentViewState;
  /** The agent's row as the views hold it. */
  row(patchbayAgentId: PatchbayAgentId): AgentSummary | undefined;
  /** Agents the store reported removed — the sessions side's cue. */
  removed: string[];
  /** Every onProbeSession announcement, in order — the probe's raw
   * session/new response (spec-pure-core: raw, tests reach into it). */
  probes: { patchbayAgentId: PatchbayAgentId; sessionId: string; modes: unknown; configOptions: unknown }[];
  /** A saved config — and so a row in the views — for an agent a suite
   * connects through the pool directly: the store acts only on agents that
   * exist (auth evidence for an unknown one is dropped). */
  seedAgent(patchbayAgentId: PatchbayAgentId, registryId?: string): void;
}

/** `dir` holds the probe workspaces and the registry cache. */
export function agentsHarness(
  dir: string,
  opts: {
    /** The machine file — pass one to share saved facts with a second
     * harness. */
    kv?: MemoryKV;
    /** Replaces the store's default hooks. */
    hooks?: Partial<AgentsStoreHooks>;
    /** Replaces the gates' defaults: no open work, every question answered
     * yes. */
    asks?: Partial<GateAsks>;
    /** The pool's launch phase — absent, specs spawn as given. */
    resolveLaunch?: LaunchResolver;
  } = {},
): AgentsHarness {
  const kv = opts.kv ?? new MemoryKV();
  const events: AgentViewEvent[] = [];
  const removed: string[] = [];
  const probes: AgentsHarness["probes"] = [];
  const state = () => events.reduce(reduceAgentView, initialAgentViewState);
  let agents!: AgentsStore;
  const pool = new AgentPool({
    onStatusChanged: (patchbayAgentId, status, detail) => agents.noteStatus(patchbayAgentId, status, detail),
    onDeclaredCaptured: (patchbayAgentId) => agents.noteDeclared(patchbayAgentId),
    onSessionUpdate: () => {},
    onCapabilityEvidence: (patchbayAgentId, row, evidence) => agents.noteEvidence(patchbayAgentId, row, evidence),
    onAuthWireFact: (patchbayAgentId, method, settled, startedAt, reason) =>
      agents.noteAuthWireFact(patchbayAgentId, method, settled, startedAt, reason),
    ...stubFsTerminalHooks(),
  }, undefined, { resolveLaunch: opts.resolveLaunch });
  const queue = new Queue<AgentOperation, PatchbayAgentId>((patchbayAgentId) => agents.publish(patchbayAgentId));
  const usedCapabilities = new UsedCapabilityStore(kv);
  const tracker = new CapabilityTracker(pool, usedCapabilities, {
    changed: (patchbayAgentId) => agents.publish(patchbayAgentId),
    registryIdOf: (patchbayAgentId) => agents.config(patchbayAgentId)?.registrySource?.registryId ?? null,
    onProbeSession: (patchbayAgentId, response: acp.NewSessionResponse) =>
      probes.push({
        patchbayAgentId,
        sessionId: response.sessionId,
        modes: response.modes,
        configOptions: response.configOptions,
      }),
    probeRoot: (patchbayAgentId) => agents.probeRoot(patchbayAgentId),
  });
  const deps: AgentsStoreDeps = {
    pool,
    configs: new AgentConfigStore(kv),
    env: new SecretEnvStore(new MemorySecrets(), "acpPatchbay.agent"),
    authLocks: new AuthLockStore(kv),
    usedCapabilities,
    composerKnobs: new ComposerKnobsStore(kv),
    lastConnected: new LastConnectedStore(new MemoryKV()),
    defaultAgentFold: new DefaultAgentFoldStore(kv),
    registry: new AcpRegistryStore(join(dir, "registry"), () => {}),
    tracker,
    busy: (patchbayAgentId) => queue.held(patchbayAgentId),
    workspaceCwd: dir,
    binaryCacheDir: join(dir, "bin-cache"),
    probeRootBase: join(dir, "probe"),
  };
  agents = new AgentsStore(deps, {
    emit: (...evs) => events.push(...evs),
    emitSettings: () => {},
    warn: () => {},
    runLoginTask: async () => 0,
    removed: (patchbayAgentId) => removed.push(patchbayAgentId),
    authCleared: () => {},
    defaultsChanged: () => {},
    ...opts.hooks,
  });
  /** A saved agent; `registryId` saves it as added from that registry entry. */
  const seedAgent = (patchbayAgentId: PatchbayAgentId, registryId?: string) => {
    // MemoryKV writes land before the promise resolves — the record is
    // there by the time this returns.
    void deps.configs.upsert({
      id: patchbayAgentId,
      name: patchbayAgentId,
      command: process.execPath,
      args: [],
      autoConnect: false,
      defaults: {},
      registrySource: registryId === undefined ? null : { registryId, distributionKind: "npx", pinnedVersion: "1.0.0" },
      lastSeenVersion: null,
    });
    agents.publish(patchbayAgentId);
  };
  const row = (patchbayAgentId: PatchbayAgentId) => state().agents.find((a) => a.id === patchbayAgentId);
  const gates = new AgentGates(agents, queue, {
    name: (patchbayAgentId) => agents.name(patchbayAgentId),
    openWork: () => ({ conversations: 0, turns: 0 }),
    confirm: async () => true,
    ...opts.asks,
  });
  return { pool, tracker, agents, gates, deps, events, state, row, removed, probes, seedAgent };
}
