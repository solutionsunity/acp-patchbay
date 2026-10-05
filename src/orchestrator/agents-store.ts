// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The agents store: the one home of agents. A row per agent, read when
// asked — saved facts from their files (config, env, auth lock, last knob
// choices), live facts from the pool and the capability tracker, what the
// orchestrator's queue holds for it, and what follows from them worked out
// on the spot — and every operation on an agent: connect, stop, restart,
// upgrade, remove, save, reorder, log in, log out, verify.
// A store only: its operations are plain, and nothing else starts or stops
// an agent's process. When an operation on an agent's connection runs is
// the orchestrator's call — every door reaches those through its gates;
// saves never wait. The views get each row whole, re-sent whenever any of
// its facts moves.
// vscode-free: the login task, warnings, the sessions side and the views
// are hooks; the questions before a connection ends are the caller's.
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import type {
  AgentConfigView,
  AgentStatus,
  AgentSummary,
  AgentUpdate,
  AgentViewEvent,
  AgentWork,
  CapabilityMatrix,
  CapabilityRowId,
  ConnectAgentSource,
  KnobSeed,
  PreferencesView,
  SettingsEvent,
} from "../shared/protocol";
import { formatCommandLine, parseCommandLine } from "../shared/command-line";
import { unlessAborted } from "./abort";
import { agentUpdates } from "./agent-updates";
import { applyAuthEvidence, type AuthEvidence } from "./auth-evidence";
import { terminalAuthOf, type TerminalAuth } from "./capabilities";
import type { CapabilityTracker, ProbeOutcome } from "./capability-tracker";
import { foldSeed } from "./knobs";
import { checkPathDivergence } from "./launcher-health";
import { nullLogger, type Logger } from "./logger";
import { terminalAuthRecipeOf, type TerminalAuthRecipe } from "./meta";
import type { AgentPool, LaunchSpec } from "./pool";
import { resolveExecutableWin32 } from "./spawn-resolve";
import { type AcpRegistryStore, type RegistryAgent, resolveDistribution } from "./stores/acp-registry";
import type { AgentConfig, AgentConfigStore } from "./stores/agent-configs";
import type { AuthLockStore } from "./stores/auth-locks";
import { resolvedBinaryPath } from "./stores/binary-installer";
import type { ComposerKnobsStore } from "./stores/composer-knobs";
import type { LastConnectedStore } from "./stores/last-connected";
import type { SecretEnvStore } from "./stores/secret-env";
import type { UsedCapabilityStore } from "./stores/used-capabilities";
import type { PatchbayAgentId } from "../shared/ids";

/** Where an agent's facts live — the files its saved facts are read from,
 * the pool its live facts come from — and the directories its launches and
 * probes use. */
export interface AgentsStoreDeps {
  pool: AgentPool;
  configs: AgentConfigStore;
  /** The agent family of SecretStorage env records. */
  env: SecretEnvStore;
  authLocks: AuthLockStore;
  usedCapabilities: UsedCapabilityStore;
  composerKnobs: ComposerKnobsStore;
  lastConnected: LastConnectedStore;
  registry: AcpRegistryStore;
  tracker: CapabilityTracker;
  /** What the orchestrator's queue holds for the agent, the running
   * operation first — read for the row, never kept. */
  busy: (patchbayAgentId: PatchbayAgentId) => readonly AgentWork["kind"][];
  /** The cwd every spawn and new session starts in. */
  workspaceCwd: string;
  /** Downloaded binaries, by agent and version. */
  binaryCacheDir: string;
  /** Each agent's standing throwaway workspace lives below this. */
  probeRootBase: string;
}

export interface AgentsStoreHooks {
  /** Agent facts both views show — the same events to each. */
  emit(...events: AgentViewEvent[]): void;
  /** Settings-only facts: the config list, env values included. */
  emitSettings(...events: SettingsEvent[]): void;
  /** A warning the user sees once, never a gate. */
  warn(message: string): void;
  /** Runs a login recipe as a visible task — its exit code, or undefined
   * when the exit is unknown. */
  runLoginTask(name: string, recipe: TerminalAuthRecipe): Promise<number | undefined>;
  /** The agent is being removed — its sessions leave with it. Called once
   * its process is down, before its own facts are purged. */
  removed(patchbayAgentId: PatchbayAgentId): void;
  /** The agent's auth lock just cleared. */
  authCleared(patchbayAgentId: PatchbayAgentId): void;
  /** A save moved the agent's stored defaults. */
  defaultsChanged(patchbayAgentId: PatchbayAgentId): void;
}

/** The operations on agents' connections — every door reaches them through
 * the orchestrator's gates, which decide when each runs. One that takes a
 * `signal` stops where it is once the signal aborts, and throws its
 * reason. */
export interface ConnectionOperations {
  connect(patchbayAgentId: PatchbayAgentId, signal?: AbortSignal): Promise<void>;
  restart(patchbayAgentId: PatchbayAgentId, signal?: AbortSignal): Promise<void>;
  upgrade(patchbayAgentId: PatchbayAgentId, signal?: AbortSignal, consent?: () => Promise<boolean>): Promise<void>;
  login(patchbayAgentId: PatchbayAgentId, methodId: string, signal?: AbortSignal): Promise<void>;
  logout(patchbayAgentId: PatchbayAgentId): Promise<void>;
  verify(patchbayAgentId: PatchbayAgentId): Promise<ProbeOutcome>;
  stop(patchbayAgentId: PatchbayAgentId): Promise<void>;
  remove(patchbayAgentId: PatchbayAgentId): Promise<void>;
  stopAll(): Promise<void>;
}

/** A new agent's id — patchbay's own, never borrowed from a registry entry
 * or an executable. */
function mintAgentId(): PatchbayAgentId {
  return randomUUID() as PatchbayAgentId;
}

export class AgentsStore implements ConnectionOperations {
  /** PATH divergence already warned, per agent and exact version pair. */
  private readonly divergenceWarned = new Set<string>();

  constructor(
    private readonly deps: AgentsStoreDeps,
    private readonly hooks: AgentsStoreHooks,
    /** Output-channel seam (logger.ts). */
    private readonly log: Logger = nullLogger,
  ) {}

  // ── reads ─────────────────────────────────────────────────────────────────

  /** The agent's saved config, read from the file — undefined once removed. */
  config(patchbayAgentId: PatchbayAgentId): AgentConfig | undefined {
    return this.deps.configs.get(patchbayAgentId);
  }

  /** The spawnable spec its saved config stands for. */
  spec(patchbayAgentId: PatchbayAgentId): LaunchSpec | undefined {
    const config = this.config(patchbayAgentId);
    return config === undefined ? undefined : this.specFromConfig(config);
  }

  name(patchbayAgentId: PatchbayAgentId): string | undefined {
    return this.config(patchbayAgentId)?.name;
  }

  /** The agent as the views show it, every fact read now — undefined once it
   * has no saved config. */
  row(patchbayAgentId: PatchbayAgentId): AgentSummary | undefined {
    const config = this.config(patchbayAgentId);
    return config === undefined ? undefined : this.rowOf(config);
  }

  rows(): AgentSummary[] {
    return this.deps.configs.list().map((config) => this.rowOf(config));
  }

  /** The agent's capability matrix, read now (capability-tracker.ts). */
  matrix(patchbayAgentId: PatchbayAgentId): CapabilityMatrix | undefined {
    return this.deps.tracker.matrix(patchbayAgentId);
  }

  /** The update fact, worked out now — the registry's version against each
   * config's pin and the version that last answered (agent-updates.ts). */
  updates(): ReadonlyMap<PatchbayAgentId, AgentUpdate> {
    return agentUpdates(this.deps.registry.current().agents, this.deps.configs.list());
  }

  authLocked(patchbayAgentId: PatchbayAgentId): boolean {
    return this.deps.authLocks.lockFor(patchbayAgentId) !== null;
  }

  /** The knob seed a fresh session of this agent starts from: its configured
   * defaults, or — when the preference says so — the last combination the
   * agent confirmed on it, falling back to the defaults when it has none
   * (an agent whose knobs were never touched has no record). */
  knobSeed(patchbayAgentId: PatchbayAgentId, source: PreferencesView["knobSource"]): KnobSeed | undefined {
    const defaults = this.spec(patchbayAgentId)?.defaults;
    if (source !== "last-session") return defaults;
    return this.deps.composerKnobs.get(patchbayAgentId) ?? defaults;
  }

  /** A user-set, agent-confirmed knob combination — the one write of the
   * last-session seed. */
  recordKnobs(patchbayAgentId: PatchbayAgentId, seed: KnobSeed): void {
    void this.deps.composerKnobs.record(patchbayAgentId, seed);
  }

  /** An agent's standing throwaway workspace (`probe/<patchbayAgentId>`) — the
   * capability probe's and the defaults editor's sessions both open here,
   * never in a user workspace root. Created idempotently, deleted only with
   * the agent's config (`remove`): a workspace-aware agent may hold it
   * agent-side past session/new. */
  async probeRoot(patchbayAgentId: PatchbayAgentId): Promise<string> {
    const dir = join(this.deps.probeRootBase, patchbayAgentId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  // ── publishing to the views ───────────────────────────────────────────────

  /** Sends the agent's row to both views as it reads now — or its removal,
   * once it has no saved config. */
  publish(patchbayAgentId: PatchbayAgentId): void {
    const row = this.row(patchbayAgentId);
    this.hooks.emit(row !== undefined ? { kind: "agentUpserted", agent: row } : { kind: "agentRemoved", patchbayAgentId });
  }

  /** Every row — a config change can move any row's name, command or
   * update — then the config list for the Settings forms: env values ride
   * the Settings channel to their owner; the form shows what is stored, and
   * SecretStorage stays the only place they rest. The rows go out before
   * any env read, so at startup every configured agent is in both views
   * from the first frame, with an honest status before any connect. */
  async publishAll(): Promise<void> {
    this.publishRows();
    const configs: AgentConfigView[] = await Promise.all(
      this.deps.configs.list().map(async (c) => ({
        id: c.id,
        name: c.name,
        command: c.command,
        args: c.args,
        env: await this.deps.env.get(c.id),
        autoConnect: c.autoConnect,
        defaults: foldSeed(c.defaults),
        registrySource: c.registrySource,
        lastSeenVersion: c.lastSeenVersion,
      })),
    );
    this.hooks.emitSettings({ kind: "agentConfigsChanged", configs });
  }

  /** The registry moved — every row's update fact is read again. */
  registryChanged(): void {
    this.publishRows();
  }

  private publishRows(): void {
    for (const row of this.rows()) this.hooks.emit({ kind: "agentUpserted", agent: row });
  }

  // ── what the pool reports ─────────────────────────────────────────────────

  /** The process's status, as the pool saw it change. */
  noteStatus(patchbayAgentId: PatchbayAgentId, status: AgentStatus, detail?: string): void {
    this.publish(patchbayAgentId);
    const suffix = detail !== undefined ? ` — ${detail}` : "";
    if (status === "crashed") this.log.error(`${patchbayAgentId}: crashed${suffix}`);
    else this.log.info(`${patchbayAgentId}: ${status}${suffix}`);
  }

  /** A fresh connection's `initialize` answer is in the pool: its claims
   * reach the matrix, and the version that actually answered is recorded. */
  noteDeclared(patchbayAgentId: PatchbayAgentId): void {
    this.deps.tracker.onDeclared(patchbayAgentId);
    const version = this.deps.pool.get(patchbayAgentId)?.initialize?.agentInfo?.version;
    if (version !== undefined) void this.recordSeenVersion(patchbayAgentId, version);
  }

  /** The single sink for pool.ts's proof-table hits (capabilities.ts
   * CAPABILITY_PROOFS) — the tracker marks the row, and the matrix it
   * reads moves. */
  noteEvidence(patchbayAgentId: PatchbayAgentId, row: CapabilityRowId, evidence: "used" | "suspect"): void {
    this.deps.tracker.noteEvidence(patchbayAgentId, row, evidence);
  }

  /** One agent RPC's auth bearing, as the pool's wire chokepoint reports
   * it, read as evidence for the authority table. */
  noteAuthWireFact(
    patchbayAgentId: PatchbayAgentId,
    method: string,
    settled: "ok" | "auth_required",
    startedAt: string,
    reason?: string | null,
  ): void {
    this.noteAuthEvidence(
      patchbayAgentId,
      settled === "ok"
        ? { kind: "rpcOk", method, startedAt }
        : { kind: "authRequired", method, reason: reason ?? null },
    );
  }

  /** The one writer for agent auth state. Every caller — pool's wire
   * chokepoint, the terminal login flows — reports what it *witnessed*;
   * the authority table (auth-evidence.ts) decides what that does to the
   * lock, the lock persists machine-scoped, and only a real transition
   * re-sends the row. Nothing else writes the lock. */
  private noteAuthEvidence(patchbayAgentId: PatchbayAgentId, evidence: AuthEvidence): void {
    // Evidence for an agent that no longer exists writes nothing: a
    // terminal login left open across a Remove would otherwise re-create
    // a lock entry for a deleted id and poison a future re-add.
    if (this.config(patchbayAgentId) === undefined) {
      this.log.debug(`auth evidence for unknown agent ${patchbayAgentId} dropped (${evidence.kind})`);
      return;
    }
    const result = applyAuthEvidence(this.deps.authLocks.lockFor(patchbayAgentId), evidence, new Date().toISOString());
    if (!result.changed) return;
    if (result.lock === null) {
      this.deps.authLocks.remove(patchbayAgentId).catch((err: Error) => {
        this.log.error(`${patchbayAgentId}: auth-lock remove failed — ${err.message}`);
      });
      this.publish(patchbayAgentId);
      // The auth row's off-table proof source (recorded at
      // CAPABILITY_PROOFS.auth) — deliberately only the affirmative auth
      // actions: an authenticate round-trip or a terminal login exiting 0.
      // Other clears (a completed prompt, a same-method contradiction)
      // honestly end the lock but never exercised patchbay's auth path —
      // a transient -32000 healing itself must not mark the row used.
      if (
        evidence.kind === "loginOk" ||
        (evidence.kind === "rpcOk" && evidence.method === methods.agent.authenticate)
      ) {
        this.noteEvidence(patchbayAgentId, "auth", "used");
      }
      // Words held at the turn-start door were waiting for exactly this:
      // an idle session has no coming turn end to drain them. The lock is
      // already cleared in memory (FileKV swaps synchronously), so the
      // drain reads the new truth.
      this.hooks.authCleared(patchbayAgentId);
    } else {
      this.deps.authLocks.upsert({ id: patchbayAgentId, lock: result.lock }).catch((err: Error) => {
        this.log.error(`${patchbayAgentId}: auth-lock write failed — ${err.message}`);
      });
      this.publish(patchbayAgentId);
    }
  }

  /** `agentInfo.version` is reality ("reality is the source of
   * truth") — recorded on the config so the registry's live version
   * can be compared against what actually answered, driving "update
   * available" without ever trusting the pinned ask over the wire's fact. */
  private async recordSeenVersion(patchbayAgentId: PatchbayAgentId, version: string): Promise<void> {
    const existing = this.config(patchbayAgentId);
    if (existing === undefined || existing.lastSeenVersion === version) return;
    // Knob offerings need no reset here: they're connection-scoped, and a
    // version can only change on a fresh connect, which already dropped
    // them with the old connection.
    await this.deps.configs.upsert({ ...existing, lastSeenVersion: version });
    await this.publishAll();
  }

  // ── operations ────────────────────────────────────────────────────────────
  // Plain: when one runs is the orchestrator's call, made at its gates. An
  // operation that composes others calls them directly.

  /** Connects a saved agent — already done when it runs. The single
   * env-injection point: values are read fresh from SecretStorage per
   * connect (stores/secret-env.ts) — the spec and the config store never
   * carry them. It spawns what the store says, the same reading a restart
   * makes, so a re-added agent keeps its stored defaults from the first
   * connect. Throws when the agent has no saved config, or when the connect
   * fails (the pool already reported the crash and its reason) or is
   * stopped. */
  async connect(patchbayAgentId: PatchbayAgentId, signal?: AbortSignal): Promise<void> {
    if (this.deps.pool.get(patchbayAgentId)?.status === "running") return;
    const spec = this.spec(patchbayAgentId);
    if (spec === undefined) throw new Error("no saved launch configuration — re-add it in Settings");
    const env = await this.deps.env.get(patchbayAgentId);
    const merged = { ...spec, env: { ...spec.env, ...env } };
    await this.deps.pool.connect(merged, { signal });
    void this.warnOnPathDivergence(merged, this.config(patchbayAgentId)?.registrySource?.registryId ?? null);
  }

  /** Intentional stop — reads as "stopped", never "crashed". */
  stop(patchbayAgentId: PatchbayAgentId): Promise<void> {
    return this.deps.pool.stop(patchbayAgentId);
  }

  /** Every connection down on the shutdown budget, in parallel. */
  stopAll(): Promise<void> {
    return this.deps.pool.disposeAll();
  }

  /** Restart is a spawn, so it reads reality like any connect: the current
   * config spec and fresh SecretStorage env — never the pool entry's
   * connect-time snapshot (a command edit or key rotation in Settings must
   * reach the very next spawn). No config behind the connection: the
   * snapshot is all there is, and pool.restart falls back to it. */
  async restart(patchbayAgentId: PatchbayAgentId, signal?: AbortSignal): Promise<void> {
    const spec = this.spec(patchbayAgentId);
    if (spec === undefined) {
      await this.deps.pool.restart(patchbayAgentId, { signal });
      return;
    }
    const env = await this.deps.env.get(patchbayAgentId);
    await this.deps.pool.restart(patchbayAgentId, { spec: { ...spec, env: { ...spec.env, ...env } }, signal });
  }

  /** Re-resolves the registry's current (possibly newer) pinned version and
   * reconnects — the same launch a first Add takes, so the version-keyed
   * used-capability cache and the launch phase's download confirmation
   * both apply exactly as they would for a brand-new agent. Resolved before
   * anything stops: a registry that no longer lists the agent, or lists
   * nothing this platform can run, leaves it as it is. A running agent is
   * stopped only on `consent`, asked at that moment — the caller's
   * question, so it is never asked for an upgrade that can't happen.
   * Stopped before the new pin is saved, the agent keeps its version. */
  async upgrade(patchbayAgentId: PatchbayAgentId, signal?: AbortSignal, consent?: () => Promise<boolean>): Promise<void> {
    const config = this.config(patchbayAgentId);
    const registryId = config?.registrySource?.registryId;
    if (config === undefined || registryId === undefined) return;
    const listed = this.deps.registry.current().agents.find((a) => a.id === registryId);
    const launch = listed === undefined ? null : this.registryLaunch(listed, patchbayAgentId);
    if (launch === null) return;
    if (this.deps.pool.get(patchbayAgentId)?.status === "running") {
      if (consent !== undefined && !(await consent())) return;
      await this.deps.pool.stop(patchbayAgentId);
    }
    signal?.throwIfAborted();
    await this.saveUpgrade(config, launch.spec, launch.registrySource);
    try {
      await this.connect(patchbayAgentId, signal);
    } catch {
      // the pool already put how the launch ended — its crash and reason,
      // or a stop — on the row
    }
  }

  /** Remove is stop + forget ("add, edit, and remove agents") —
   * the process goes down, the agent leaves
   * both channel states via the `agentRemoved` event, its per-agent facts
   * (used capabilities, observed knobs) are purged so a future re-add
   * starts honest, its live state goes with them — the pool's entry, the
   * tracker's marks — and its session rows leave the drawer. Patchbay
   * holds no session history — the sessions live on in the agent's own
   * store and reappear via session/list on a re-add. */
  async remove(patchbayAgentId: PatchbayAgentId): Promise<void> {
    await this.deps.pool.stop(patchbayAgentId);
    this.hooks.removed(patchbayAgentId);
    await this.deps.configs.remove(patchbayAgentId);
    await this.deps.usedCapabilities.remove(patchbayAgentId);
    await this.deps.composerKnobs.remove(patchbayAgentId);
    await this.deps.env.remove(patchbayAgentId);
    await this.deps.authLocks.remove(patchbayAgentId);
    await rm(join(this.deps.probeRootBase, patchbayAgentId), { recursive: true, force: true }).catch(() => {});
    this.deps.pool.forget(patchbayAgentId);
    this.deps.tracker.forget(patchbayAgentId);
    this.publish(patchbayAgentId);
    await this.publishAll();
  }

  /** Add's save half: a registry agent or a custom command is saved as a
   * new agent under an id patchbay mints — one registry entry or one
   * executable added twice is two agents — and a saved agent is taken as
   * it stands. Returns the agent to connect — nothing when the source names
   * nothing this machine can run. Like every save it never waits: the card
   * exists from the click, and every download the launch needs then
   * happens on it as a connect phase. */
  async saveFrom(source: ConnectAgentSource): Promise<PatchbayAgentId | undefined> {
    if ("patchbayAgentId" in source) return this.config(source.patchbayAgentId)?.id;
    const patchbayAgentId = mintAgentId();
    let spec: LaunchSpec;
    let registrySource: AgentConfig["registrySource"] = null;
    if ("registryId" in source) {
      const agent = this.deps.registry.current().agents.find((a) => a.id === source.registryId);
      if (agent === undefined) return undefined;
      const resolved = this.registryLaunch(agent, patchbayAgentId);
      if (resolved === null) return undefined; // can't run on this platform
      ({ spec, registrySource } = resolved);
    } else {
      const parsed = parseCommandLine(source.command);
      if (parsed === null) return undefined;
      spec = {
        patchbayAgentId,
        name: parsed.command,
        command: parsed.command,
        args: parsed.args,
        env: {},
        cwd: this.deps.workspaceCwd,
      };
    }
    await this.add(spec, registrySource);
    return patchbayAgentId;
  }

  /** The Settings Agents page (add, edit, and remove agents,
   * including launch configuration per agent) — persists globally. The
   * Edit form sends the launch line raw (parsing is
   * logic), so an empty args array means "parse `command` here" — the same
   * quote-aware house parser custom Add uses, never a naive split.
   * `config.env` is the form's full desired set — what is in the box is
   * what gets stored, to SecretStorage only (stores/secret-env.ts). A
   * config for an agent the store doesn't hold is added under an id the
   * store mints, and a name no other agent holds — a view never chooses an
   * agent's id. */
  async save(config: AgentConfigView): Promise<void> {
    let { command, args } = { command: config.command, args: [...config.args] };
    if (args.length === 0) {
      const parsed = parseCommandLine(command);
      if (parsed === null) {
        this.log.error(`agent config ${config.id}: command line has an unterminated quote`);
        return;
      }
      ({ command } = parsed);
      args = parsed.args;
    }
    const prior = this.config(config.id);
    const patchbayAgentId = prior?.id ?? mintAgentId();
    await this.deps.env.set(patchbayAgentId, { ...config.env });
    // Identity/wire facts never round-trip through the form: the webview's
    // copies of `lastSeenVersion` and `registrySource` are patch-lag stale
    // the moment a connect or an Upgrade lands mid-edit — the store's own
    // values are the truth the form has no business carrying back.
    const record: AgentConfig = {
      id: patchbayAgentId,
      name: config.name,
      command,
      args,
      autoConnect: config.autoConnect,
      // The view's folded seed is stored under `options` alone — the legacy
      // `mode` field is read (foldSeed) but never written again.
      defaults: { options: { ...config.defaults } },
      registrySource: prior?.registrySource ?? config.registrySource,
      lastSeenVersion: prior?.lastSeenVersion ?? config.lastSeenVersion,
    };
    if (prior === undefined) await this.deps.configs.add(record);
    else await this.deps.configs.upsert(record);
    await this.publishAll();
    // The store moved; an open editor re-reads the surface for the new
    // defaults from the agent (a no-op when no editor is open).
    this.hooks.defaultsChanged(patchbayAgentId);
  }

  /** The Settings list order — a view's picture of it at drop time. */
  async reorder(patchbayAgentIds: readonly PatchbayAgentId[]): Promise<void> {
    await this.deps.configs.reorder(patchbayAgentIds);
    await this.publishAll();
  }

  /** Log in with one of the agent's declared methods. A method patchbay
   * cannot drive never reaches a wire call: the card shows no button for
   * it, and this is the writer holding the same line — `authenticate`
   * belongs to the agent type alone. Failure leaves needsAuth set — the
   * honest signal, no separate reply channel. `signal` stops the wait on a
   * terminal login — never its terminal. */
  async login(patchbayAgentId: PatchbayAgentId, methodId: string, signal?: AbortSignal): Promise<void> {
    // The method as the connection's own `initialize` declared it — its
    // kind (capabilities.ts's one classification), and the raw entry a
    // terminal recipe or typed terminal method is read from. Command paths
    // are machine-absolute and stay host-side; the webview only ever sees
    // the kind.
    const live = this.deps.pool.get(patchbayAgentId);
    if (live?.declared?.authMethods.find((m) => m.id === methodId)?.kind === "unsupported") {
      this.log.warn(`${patchbayAgentId}: ignored a login on "${methodId}" — patchbay can't run this method's type`);
      return;
    }
    const method = live?.initialize?.authMethods?.find((m) => m.id === methodId);
    // A recipe wins over the wire's type, the same precedence the kind is
    // classified by.
    const recipe = method === undefined ? null : terminalAuthRecipeOf(method._meta);
    if (recipe !== null) {
      // terminal-recipe method: the login runs in a visible terminal,
      // `authenticate` is never called on it (meta.ts).
      await this.loginViaTerminal(patchbayAgentId, recipe, signal);
      return;
    }
    const typed = method === undefined ? null : terminalAuthOf(method);
    if (typed !== null) {
      // the spec's terminal auth method: same executor,
      // recipe composed from the agent's own spawn spec at click time —
      // `authenticate` is never called on it either, so a login's
      // success is always terminal-ran-plus-reprobe, never the RPC's
      // word for it.
      await this.typedLoginViaTerminal(patchbayAgentId, typed, signal);
      return;
    }
    await this.deps.tracker.authenticate(patchbayAgentId, methodId);
  }

  /** The logout round-trip — needsAuth is raised by the tracker itself (a
   * successful logout IS the auth state; no probe) — then the agent's
   * process is disconnected. Policy, not a quirk workaround: a process that
   * has held credentials is never trusted to shed them (spawn-time-only
   * auth reads are live behavior — auggie dossier), so killing it is the
   * only clear-out that needs no agent cooperation. The card lands on
   * stopped + the logout reason, and the lock persists (auth-evidence.ts) —
   * a reconnect carries it until real login evidence clears it. */
  async logout(patchbayAgentId: PatchbayAgentId): Promise<void> {
    await this.deps.tracker.logout(patchbayAgentId);
    await this.deps.pool.stop(patchbayAgentId);
  }

  /** The free protocol check (Settings Verify, "Verify after add") —
   * returns what the probe observed, so the terminal-login flow can react
   * to a still-locked agent. */
  verify(patchbayAgentId: PatchbayAgentId): Promise<ProbeOutcome> {
    return this.deps.tracker.verify(patchbayAgentId);
  }

  // ── window lifecycle ──────────────────────────────────────────────────────

  /** What this window connects at startup, as the sources Add takes: the
   * union of every config flagged auto-connect
   * and the reload-continuation stamp (stores/last-connected.ts — what was
   * still running at the last shutdown, honored only while fresh). The
   * union's two halves answer different questions — "always there" vs.
   * "was there when the window reloaded" — so neither subsumes the other:
   * a flagged agent the user manually stopped before reload stays in the
   * flagged half (autoConnect means every window open); a manually
   * connected, unflagged agent rides only the stamp and therefore survives
   * reload but not quit-and-reopen-later. Always the user's own configured
   * choices, never patchbay picking an agent for them (the routing
   * scope decision is about choosing among agents for a task, not this).
   * `legacyDefault` is the old `acpPatchbay.defaultAgent` setting
   * (superseded by the per-agent flag): folded into the config once, so the
   * old setting keeps working without two mechanisms living on. */
  async startupSources(legacyDefault: string): Promise<ConnectAgentSource[]> {
    // The setting names an agent by its id, or by the registry entry it was
    // added from: one added from it since is that agent, and with none on
    // this machine the registry path adds it — once, since the next start
    // finds it by its registry id.
    const legacy =
      legacyDefault === ""
        ? undefined
        : (this.config(legacyDefault as PatchbayAgentId) ??
          this.deps.configs.list().find((c) => c.registrySource?.registryId === legacyDefault));
    if (legacy !== undefined && !legacy.autoConnect) {
      await this.deps.configs.upsert({ ...legacy, autoConnect: true });
      await this.publishAll();
      this.log.info(`migrated acpPatchbay.defaultAgent ("${legacyDefault}") to the per-agent auto-connect flag`);
    }
    const stamped = await this.deps.lastConnected.consume();
    const flagged = this.deps.configs.list().filter((c) => c.autoConnect).map((c) => c.id);
    const sources = [...new Set([...flagged, ...stamped])].flatMap((patchbayAgentId): ConnectAgentSource[] => {
      if (this.config(patchbayAgentId) !== undefined) return [{ patchbayAgentId }];
      this.log.debug(`startup connect: ${patchbayAgentId} has no config (removed since the stamp) — skipped`);
      return [];
    });
    return legacyDefault !== "" && legacy === undefined ? [...sources, { registryId: legacyDefault }] : sources;
  }

  /** Reload-continuation stamp, written before any killing at shutdown —
   * the running set as it stood when the window went down is what the next
   * activate restores (if it comes soon enough to be a reload;
   * last-connected.ts). */
  stampRunning(): Promise<void> {
    return this.deps.lastConnected.write(
      this.deps.pool.list().filter((v) => v.status === "running").map((v) => v.spec.patchbayAgentId),
    );
  }

  /** "Disconnect & erase all data" wiped the files: every agent the views
   * show leaves them, and the config list republishes empty. */
  async erased(shownPatchbayAgentIds: readonly PatchbayAgentId[]): Promise<void> {
    for (const patchbayAgentId of shownPatchbayAgentIds) this.hooks.emit({ kind: "agentRemoved", patchbayAgentId });
    await this.publishAll();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private rowOf(config: AgentConfig): AgentSummary {
    const live = this.deps.pool.get(config.id);
    // needsAuth reads the persisted lock (auth-evidence.ts), never a
    // literal: a logout witnessed before a reload or a reconnect is still
    // the truth — the wire has nothing to re-read it from.
    const lock = this.deps.authLocks.lockFor(config.id);
    // A process running or starting answers for what it was spawned with;
    // otherwise the config is what the next Connect runs.
    const launch = live?.status === "running" || live?.status === "reconnecting" ? live.spec : config;
    const update = agentUpdates(this.deps.registry.current().agents, [config]).get(config.id);
    return {
      id: config.id,
      name: config.name,
      // No process this window: `untested` until it has ever answered
      // `initialize` (`lastSeenVersion` is the durable marker), `stopped`
      // after.
      status: live?.status ?? (config.lastSeenVersion === null ? "untested" : "stopped"),
      detail: live?.detail,
      // A crash carries the process's own last words; every other status
      // drops them — stale stderr on a running agent would be a lie.
      stderr: live?.status === "crashed" && live.stderrTail.length > 0 ? live.stderrTail : undefined,
      command: formatCommandLine(launch.command, launch.args),
      needsAuth: lock !== null,
      authReason: lock?.reason ?? undefined,
      capabilities: this.deps.tracker.matrix(config.id),
      capabilitiesResetAt: live?.initializedAt ?? undefined,
      protocolVersion: live?.initialize?.protocolVersion,
      authMethods: live?.declared?.authMethods ?? [],
      update,
      busy: this.deps
        .busy(config.id)
        .map((kind) =>
          kind === "upgrade" ? { kind, to: update?.to ?? config.registrySource?.pinnedVersion } : { kind },
        ),
    };
  }

  /** The spawnable spec a stored config stands for — the one reading of a
   * record. env deliberately
   * empty: values live in SecretStorage and are joined onto the spec at
   * spawn time (`connect`), read fresh per connect — never cached here.
   * Stored {mode, options} folds to the knob-id-keyed seed (the one door
   * legacy defaults re-enter memory through). A binary agent's archive
   * facts ride along so a connect after a cache wipe re-acquires it as a
   * launch phase instead of dying on a missing file. */
  private specFromConfig(agent: AgentConfig): LaunchSpec {
    const source = agent.registrySource;
    return {
      patchbayAgentId: agent.id,
      name: agent.name,
      command: agent.command,
      args: agent.args,
      env: {},
      cwd: this.deps.workspaceCwd,
      defaults: foldSeed(agent.defaults),
      ...(source?.distributionKind === "binary" && source.binary !== undefined
        ? { binary: { ...source.binary, distribution: source.registryId, version: source.pinnedVersion } }
        : {}),
    };
  }

  /** Resolves a registry agent's declared distribution into a spawnable
   * spec — no I/O: npx/uvx are ecosystem-managed installs (spawning them
   * *is* installing), and a `binary` distribution rides the spec as archive
   * facts for the connect's launch phase to acquire, on the card, behind
   * the download confirmation. `command` for a binary is the cached path
   * the phase will resolve to — deterministic, so the config is honest
   * before anything is downloaded. Null when the agent can't run on this
   * platform (the reason is already on the picker row). */
  private registryLaunch(
    agent: RegistryAgent,
    patchbayAgentId: PatchbayAgentId,
  ): { spec: LaunchSpec; registrySource: AgentConfig["registrySource"] } | null {
    const launch = resolveDistribution(agent);
    const cwd = this.deps.workspaceCwd;
    if ("error" in launch) return null;
    switch (launch.kind) {
      case "npx":
      case "uvx":
        return {
          spec: { patchbayAgentId, name: agent.name, command: launch.command, args: [...launch.args], env: { ...launch.env }, cwd },
          registrySource: { registryId: agent.id, distributionKind: launch.kind, pinnedVersion: agent.version },
        };
      case "binary": {
        const pinnedDigest = launch.sha256 === null ? {} : { sha256: launch.sha256 };
        return {
          spec: {
            patchbayAgentId,
            name: agent.name,
            command: resolvedBinaryPath(this.deps.binaryCacheDir, agent.id, agent.version, launch.cmd),
            args: [...launch.args],
            env: { ...launch.env },
            cwd,
            binary: { distribution: agent.id, archiveUrl: launch.archiveUrl, version: agent.version, cmd: launch.cmd, ...pinnedDigest },
          },
          registrySource: {
            registryId: agent.id,
            distributionKind: "binary",
            pinnedVersion: agent.version,
            binary: { archiveUrl: launch.archiveUrl, cmd: launch.cmd, ...pinnedDigest },
          },
        };
      }
    }
  }

  /** Saves a new agent as a global config — "add" and "connect" are one
   * action (adding an agent means it's activated — checked spawnable, ready
   * to start conversations on), not two decoupled steps a user could leave
   * half-done. It takes a name no other agent holds. */
  private async add(spec: LaunchSpec, registrySource: AgentConfig["registrySource"]): Promise<void> {
    await this.mergeRegistryEnv(spec);
    await this.deps.configs.add({
      id: spec.patchbayAgentId,
      name: spec.name,
      command: spec.command,
      args: [...spec.args],
      autoConnect: false,
      defaults: {},
      registrySource,
      lastSeenVersion: null,
    });
    await this.publishAll();
  }

  /** Upgrade's save: the registry's new launch and pin replace the old
   * ones; the agent's own facts — its name, auto-connect, defaults, the
   * version that last answered — stay as they are. */
  private async saveUpgrade(
    config: AgentConfig,
    spec: LaunchSpec,
    registrySource: AgentConfig["registrySource"],
  ): Promise<void> {
    await this.mergeRegistryEnv(spec);
    await this.deps.configs.upsert({ ...config, command: spec.command, args: [...spec.args], registrySource });
    await this.publishAll();
  }

  /** Registry-declared launch env (part of the distribution recipe) goes to
   * the same SecretStorage record user-entered env lives in — one source
   * at spawn time. Registry values win for their own keys; the user's
   * other keys survive an Upgrade. */
  private async mergeRegistryEnv(spec: LaunchSpec): Promise<void> {
    if (Object.keys(spec.env).length === 0) return;
    const stored = await this.deps.env.get(spec.patchbayAgentId);
    await this.deps.env.set(spec.patchbayAgentId, { ...stored, ...spec.env });
  }

  /** Two installs, one memory: a PATH-installed sibling CLI shares the
   * agent's per-user state store with the copy patchbay runs — by design,
   * but a wide version gap means two writers of different vintages on one
   * store (launcher-health.ts PATH_SIBLINGS). Warning only, never a gate;
   * once per exact version pair so reconnects don't nag. */
  private async warnOnPathDivergence(spec: LaunchSpec, registryId: string | null): Promise<void> {
    try {
      const d = await checkPathDivergence(spec, registryId);
      if (d === null) return;
      const key = `${spec.patchbayAgentId}:${d.pathVersion}:${d.bundledVersion}`;
      if (this.divergenceWarned.has(key)) return;
      this.divergenceWarned.add(key);
      this.hooks.warn(
        `${spec.name}: the \`${d.bin}\` on your PATH is v${d.pathVersion}, but patchbay runs v${d.bundledVersion}. Both share the same ${d.bin} state (sessions, auth, config) — a wide version gap between the two writers can bite. Consider updating the PATH install.`,
      );
    } catch {
      // A diagnostic nicety must never affect a connect.
    }
  }

  /** terminal-auth login (meta.ts): runs the method's recipe as a VS Code
   * task (login-task.ts) — front and center in the agent's own flow, the
   * executable and args handed over as an array so no shell command line is
   * ever composed here.
   *
   * The command's *result* is listened to, never guessed: the task's
   * process-end exit code is real evidence. Zero → the affirmative fact the
   * authority table clears on (noteAuthEvidence loginOk), then a re-probe
   * as corroboration and offering re-read (same span as Verify, so the
   * card reads "Verifying…") — and if the probe *still* says auth_required,
   * restart the process: the recipe wrote credentials outside it, and a CLI
   * that reads auth at spawn never re-reads them. Non-zero → loginFailed
   * evidence, locking with the exit code as the card's reason. An unknown
   * exit (task never started, terminated, terminal closed mid-run) is not
   * affirmative: no evidence noted, the fallback probe runs, and the lock
   * heals later through a same-method success or a completed prompt.
   *
   * The login is waited on until the task reports. Stopped before that,
   * the agent stops waiting, and the terminal stays the user's to finish,
   * use or close; what the task then reports is the login's result all the
   * same and is noted by the same rules — the return code is the only word
   * on it — while the probe and the restart, which need the process the
   * stop ended, don't run. */
  private async loginViaTerminal(
    patchbayAgentId: PatchbayAgentId,
    recipe: TerminalAuthRecipe,
    signal?: AbortSignal,
  ): Promise<void> {
    const name = recipe.label ?? `${this.name(patchbayAgentId) ?? patchbayAgentId} login`;
    const reported = this.hooks.runLoginTask(name, recipe).then((exitCode) => {
      this.log.info(`${patchbayAgentId}: login command finished (exit ${exitCode ?? "unknown"})`);
      if (exitCode !== undefined && exitCode !== 0) {
        this.noteAuthEvidence(patchbayAgentId, {
          kind: "loginFailed",
          reason: `login command failed (exit ${exitCode}) — check the terminal output and try again`,
        });
      }
      // Exit 0 is the affirmative evidence — it clears the lock (the
      // authority table's call); the probe below is corroboration and the
      // offering re-read, not the clearer: on a lazy-auth agent its
      // session/new success bears nothing either way. An *unknown* exit
      // (task never started, terminated, terminal closed mid-run) is not
      // affirmative — no evidence is noted, and the lock heals later
      // through a same-method success or a completed prompt.
      if (exitCode === 0) this.noteAuthEvidence(patchbayAgentId, { kind: "loginOk" });
      return exitCode;
    });
    const exitCode = await unlessAborted(reported, signal);
    signal?.throwIfAborted();
    if (exitCode !== undefined && exitCode !== 0) return;
    const outcome = await this.verify(patchbayAgentId);
    // "skipped" = the probe is latch-deferred (first-session-mcp-latch) —
    // no corroboration is possible without spending the latch slot, and
    // the latched vendor is also the spawn-time-credential-read vendor:
    // restart unconditionally, same reasoning as the auth_required arm.
    if (exitCode === 0 && outcome === "skipped") {
      this.log.info(
        `${patchbayAgentId}: login succeeded but the probe is latch-deferred — restarting so the process reads the fresh credentials`,
      );
      await this.restart(patchbayAgentId, signal);
      return;
    }
    if (outcome === "auth_required") {
      // The recipe wrote credentials *outside* the running process, and the
      // process still answers auth_required: a CLI that reads auth state at
      // spawn never re-reads it (observed: auggie 0.32.0, dossier). The only
      // honest re-check is the one the user would do by hand — a fresh
      // spawn. One restart per login attempt, no loop: if the new process
      // still needs auth, the wire chokepoint re-raises it and the card
      // shows Log in again.
      this.log.info(
        `${patchbayAgentId}: login succeeded but the running process still reports auth_required — restarting it to pick up the fresh credentials`,
      );
      await this.restart(patchbayAgentId, signal);
    }
  }

  /** The spec's terminal auth method: the wire pins the
   * command to the agent's own spawn — spec read fresh from the store (a
   * Settings edit applies here exactly as it would to the next spawn) with
   * SecretStorage env merged at the last moment, the method's args APPENDED
   * to the spawn args and its env layered over the spawn env. On Windows
   * the command is absolutized the same way a spawn would be — a bare
   * name would otherwise be resolved by the task engine's own PATH walk,
   * which knows nothing of the planted-`npx.cmd` hazard spawn-resolve
   * guards, and it must not win here any more than it can at spawn;
   * not-found falls back to the bare name and lets the task report it. */
  private async typedLoginViaTerminal(patchbayAgentId: PatchbayAgentId, typed: TerminalAuth, signal?: AbortSignal): Promise<void> {
    const spec = this.spec(patchbayAgentId);
    if (spec === undefined) {
      this.log.warn(`typed terminal login: no configured spec for ${patchbayAgentId}`);
      return;
    }
    const secretEnv = await this.deps.env.get(patchbayAgentId);
    const env = { ...spec.env, ...secretEnv, ...typed.env };
    const command =
      process.platform === "win32"
        ? (resolveExecutableWin32(spec.command, { ...process.env, ...env }) ?? spec.command)
        : spec.command;
    await this.loginViaTerminal(patchbayAgentId, { command, args: [...spec.args, ...typed.args], env }, signal);
  }
}
