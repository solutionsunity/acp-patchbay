// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The agents store: the one home of agents. A row per agent, read when
// asked — saved facts from their files (config, env, auth lock, last knob
// choices), live facts from the pool and the capability tracker, what the
// orchestrator's queue holds for it, and what follows from them worked out
// on the spot — and every operation on an agent: connect, stop, restart,
// upgrade, remove, save, reorder, log in, log out.
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
import {
  type AgentConfigView,
  type AgentStatus,
  type AgentSummary,
  type AgentUpdate,
  type AgentViewEvent,
  type AgentWork,
  type CapabilityMatrix,
  type CapabilityRowId,
  type ConnectAgentSource,
  type KnobSeed,
  type PreferencesView,
  type SettingsEvent,
  type VersionMove,
  isVersionMove,
} from "../shared/protocol";
import { formatCommandLine, parseCommandLine, sameCommandLine } from "../shared/command-line";
import { unlessAborted } from "./abort";
import { agentOffers, type AgentOffers } from "../shared/agent-offers";
import { agentUpdates } from "./agent-updates";
import { applyAuthEvidence, type AuthEvidence } from "./auth-evidence";
import { agentErrorText } from "./readers/agent-error";
import type { TerminalAuth } from "./readers/initialize";
import type { CapabilityTracker } from "./capability-tracker";
import { checkPathDivergence } from "./launcher-health";
import { nullLogger, type Logger } from "./logger";
import type { TerminalAuthRecipe } from "./meta";
import type { AgentPool, LaunchSpec } from "./pool";
import { mergeEnv, resolveExecutableWin32 } from "./spawn-resolve";
import { type AcpRegistryStore, packageLaunch, type RegistryAgent, resolveDistribution } from "./stores/acp-registry";
import type { RegistryReadMoment } from "../shared/registry-reads";
import type { AgentConfig, AgentConfigStore, AgentLink } from "./stores/agent-configs";
import type { AuthLockStore } from "./stores/auth-locks";
import { isResolvedBinaryPath, resolvedBinaryPath } from "./stores/binary-installer";
import type { ComposerKnobsStore } from "./stores/composer-knobs";
import type { LastConnectedStore } from "./stores/last-connected";
import type { DefaultAgentFoldStore } from "./stores/default-agent-fold";
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
  defaultAgentFold: DefaultAgentFoldStore;
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
  reset(patchbayAgentId: PatchbayAgentId, signal?: AbortSignal, consent?: () => Promise<boolean>): Promise<void>;
  goBack(patchbayAgentId: PatchbayAgentId, signal?: AbortSignal, consent?: () => Promise<boolean>): Promise<void>;
  login(patchbayAgentId: PatchbayAgentId, methodId: string, signal?: AbortSignal): Promise<void>;
  logout(patchbayAgentId: PatchbayAgentId): Promise<void>;
  stop(patchbayAgentId: PatchbayAgentId): Promise<void>;
  remove(patchbayAgentId: PatchbayAgentId): Promise<void>;
  stopAll(): Promise<void>;
}

/** A new agent's id — patchbay's own, never borrowed from a registry entry
 * or an executable. */
function mintPatchbayAgentId(): PatchbayAgentId {
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

  /** The registry entry the agent runs as: its origin while linked — an
   * edited command is the user's own, never taken for the registry's. */
  linkedRegistryId(patchbayAgentId: PatchbayAgentId): string | null {
    const config = this.config(patchbayAgentId);
    return config?.link == null ? null : config.origin;
  }

  /** What the agent's own facts allow on it, read now (agent-offers.ts) —
   * every operation that needs one refuses without it. */
  private offers(config: AgentConfig): AgentOffers {
    return agentOffers({ matrix: this.deps.tracker.matrix(config.id), ...config });
  }

  /** The update fact, worked out now — the registry's version against each
   * config's pin (agent-updates.ts). */
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
        defaults: c.defaults.options ?? {},
        origin: c.origin,
        link: c.link === null ? null : { distributionKind: c.link.distributionKind, pinnedVersion: c.link.pinnedVersion },
        previousVersion: c.previous?.pinnedVersion ?? null,
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
    const merged = await this.launch(patchbayAgentId);
    if (merged === undefined) throw new Error("no saved launch configuration — re-add it in Settings");
    await this.spawn(merged, signal);
  }

  /** A launch handed to the pool — done once the agent answered
   * `initialize`. */
  private async spawn(spec: LaunchSpec, signal?: AbortSignal): Promise<void> {
    await this.deps.pool.connect(spec, { signal });
    void this.warnOnPathDivergence(spec, this.linkedRegistryId(spec.patchbayAgentId));
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
    const spec = await this.launch(patchbayAgentId);
    await this.deps.pool.restart(patchbayAgentId, spec === undefined ? { signal } : { spec, signal });
  }

  /** The agent's launch as configured, read now: the saved spec with its
   * SecretStorage env merged — what the next spawn's launch phase starts
   * from. */
  private async launch(patchbayAgentId: PatchbayAgentId): Promise<LaunchSpec | undefined> {
    const config = this.config(patchbayAgentId);
    return config === undefined ? undefined : this.launchOf(config);
  }

  /** A config's launch with its SecretStorage env merged — saved or not. */
  private async launchOf(config: AgentConfig): Promise<LaunchSpec> {
    const spec = this.specFromConfig(config);
    return { ...spec, env: mergeEnv(spec.env, await this.deps.env.get(config.id)) };
  }

  /** A linked agent on the registry's current (possibly newer) version. The
   * link it replaces is kept as the one way back. */
  upgrade(patchbayAgentId: PatchbayAgentId, signal?: AbortSignal, consent?: () => Promise<boolean>): Promise<void> {
    return this.move(patchbayAgentId, "upgrade", signal, consent);
  }

  /** An edited agent linked again, to the registry's current entry for the
   * one it was added from — its edited command replaced by the registry's. */
  reset(patchbayAgentId: PatchbayAgentId, signal?: AbortSignal, consent?: () => Promise<boolean>): Promise<void> {
    return this.move(patchbayAgentId, "reset", signal, consent);
  }

  /** An upgraded agent back on the link the Upgrade replaced — exactly, from
   * the recipe kept with it; a binary's archive is checked against the
   * digest kept with it, and a source that stopped serving it fails the
   * launch for all to see. */
  goBack(patchbayAgentId: PatchbayAgentId, signal?: AbortSignal, consent?: () => Promise<boolean>): Promise<void> {
    return this.move(patchbayAgentId, "goBack", signal, consent);
  }

  /** The one path an agent's version moves by — Upgrade, Reset and Back
   * alike — taking the same launch a first Add takes, so the version-keyed
   * used-capability cache and the launch phase's download confirmation
   * both apply exactly as they would for a brand-new agent. A registry
   * link is resolved from a fresh read before anything stops — never from
   * the copy a chip or a menu was shown from: a registry that no longer
   * lists the agent, or lists nothing this platform can run, leaves it as
   * it is, said once. A running agent is stopped only on `consent`, asked
   * at that moment — the caller's question, so it is never asked for a move
   * that can't happen.
   *
   * The new version becomes the agent's only once it has started: it is
   * launched unsaved, and saved once it answered `initialize`. One that
   * doesn't start leaves the agent on the version it had — said once, with
   * why, and running again if it was running before. Stopped before it
   * started, the move is cancelled: the version stays, nothing restarts. */
  private async move(
    patchbayAgentId: PatchbayAgentId,
    move: VersionMove,
    signal?: AbortSignal,
    consent?: () => Promise<boolean>,
  ): Promise<void> {
    const config = this.config(patchbayAgentId);
    if (config === undefined || !this.offers(config)[move]) return;
    const link = move === "goBack" ? config.previous : await this.freshLink(config, move);
    if (link === null) {
      this.hooks.warn(`${config.name}: the ACP registry lists nothing this machine can run for it — it stays as it is.`);
      return;
    }
    const moved = this.relinked(config, link, move === "upgrade" ? this.previousAfterUpgrade(config, link) : null);
    if (moved === null) return;
    const wasRunning = this.deps.pool.get(patchbayAgentId)?.status === "running";
    if (wasRunning) {
      if (consent !== undefined && !(await consent())) return;
      await this.deps.pool.stop(patchbayAgentId);
    }
    signal?.throwIfAborted();
    try {
      await this.spawn(await this.launchOf(moved), signal);
    } catch (err) {
      // the pool already put how the launch ended — its crash and reason,
      // or a stop — on the row
      if (signal?.aborted) return;
      this.hooks.warn(
        `${config.name}: ${MOVE_PHRASE[move](link.pinnedVersion)} didn't start — ${agentErrorText(err)}. It stays on ${config.link?.pinnedVersion ?? "its own command"}.`,
      );
      if (wasRunning) await this.connect(patchbayAgentId, signal).catch(() => {});
      return;
    }
    await this.saveMove(config, moved);
  }

  /** The way back an Upgrade leaves: the link it replaces — when that is a
   * different version and its recipe rebuilds the launch; an upgrade to the
   * version already pinned keeps the way back it had. */
  private previousAfterUpgrade(config: AgentConfig, next: AgentLink): AgentLink | null {
    const current = config.link;
    if (current === null || current.pinnedVersion === next.pinnedVersion) return config.previous;
    return config.origin !== null && this.linkLaunch(config.origin, current) !== null ? current : null;
  }

  /** An imported agent this machine downloads: its launch and pin
   * re-resolved from a fresh registry read for this platform, as an Upgrade
   * resolves them — the file's were another machine's cache and build.
   * False when the registry serves nothing this platform runs; the agent
   * then stays as the file had it. */
  async resolveHere(patchbayAgentId: PatchbayAgentId): Promise<boolean> {
    // An edited agent's command is its own, on any machine: it is
    // unlinked, never re-resolved over.
    const imported = this.config(patchbayAgentId);
    if (imported !== undefined && (await this.relink(imported)) && this.config(patchbayAgentId)?.link === null) return true;
    const config = this.config(patchbayAgentId);
    const link = config === undefined ? null : await this.freshLink(config, "import");
    const moved = config === undefined || link === null ? null : this.relinked(config, link, config.previous);
    if (config === undefined || moved === null) return false;
    await this.saveMove(config, moved);
    return true;
  }

  /** Every registry agent's link put right — run once the registry's
   * copy is loaded, before any agent starts, and after an import. */
  async relinkAll(): Promise<void> {
    let moved = false;
    for (const config of this.deps.configs.list()) moved = (await this.relink(config)) || moved;
    if (moved) await this.publishAll();
  }

  /** A registry agent's link as its record proves it. An agent stored
   * before its recipe was kept gets it from the registry's copy, while that
   * still lists the pinned version — otherwise its next Upgrade writes it.
   * And an agent whose command isn't its recipe's was edited while an edit
   * still kept the link, which let the registry's launch run over the
   * command typed: it is unlinked, keeping its origin. A binary's command
   * is the archive's executable under whatever cache root it was written
   * with. True when the record moved. */
  private async relink(config: AgentConfig): Promise<boolean> {
    const { origin, link } = config;
    if (origin === null || link === null) return false;
    const listed = this.deps.registry.current().agents.find((a) => a.id === origin && a.version === link.pinnedVersion);
    const resolved = listed === undefined ? undefined : resolveDistribution(listed);
    let linked: AgentLink;
    let edited: boolean;
    if (link.distributionKind === "binary") {
      const published = resolved !== undefined && "kind" in resolved && resolved.kind === "binary" ? resolved.published : undefined;
      const recipe = link.distribution?.args === undefined && published !== undefined ? keptRecipe(published) : link.distribution;
      linked = { ...link, distribution: recipe };
      edited =
        recipe !== undefined &&
        (!isResolvedBinaryPath(config.command, origin, link.pinnedVersion, recipe.cmd) ||
          (recipe.args !== undefined && !sameCommandLine(config, { command: config.command, args: recipe.args })));
    } else {
      const published = resolved !== undefined && "kind" in resolved && resolved.kind === link.distributionKind ? resolved.published : undefined;
      const recipe = link.distribution ?? (published === undefined ? undefined : keptRecipe(published));
      linked = { ...link, distribution: recipe };
      edited = recipe !== undefined && !sameCommandLine(config, packageLaunch(link.distributionKind, recipe));
    }
    if (edited) {
      await this.deps.configs.upsert({ ...config, link: null, previous: null });
      this.log.info(`${config.id}: its command was edited while an edit kept its link — it no longer follows the ACP registry`);
      return true;
    }
    if (linked.distribution === link.distribution) return false;
    await this.deps.configs.upsert({ ...config, link: linked });
    return true;
  }

  /** The registry's link for the agent's origin from a fresh read of the
   * registry — never from a copy shown earlier. Null when the registry no
   * longer lists it, or lists nothing this platform can run. */
  private async freshLink(config: AgentConfig, moment: RegistryReadMoment): Promise<AgentLink | null> {
    const { origin } = config;
    if (origin === null) return null;
    await this.deps.registry.read(moment);
    const listed = this.deps.registry.current().agents.find((a) => a.id === origin);
    return listed === undefined ? null : registryLink(listed);
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

  /** An imported agent landed on this machine, whole, on `record.id` — its
   * env and composer choices as the file carries them. What this machine
   * knows of the agent on its own stays: the version it last answered
   * with. A downloaded way back names the exporting machine's build, so it
   * stays there. Returns the name it holds here: a taken one gets a
   * number. */
  async landImported(record: AgentConfig, env: Readonly<Record<string, string>>, knobs: KnobSeed | undefined): Promise<string> {
    const mine = this.config(record.id);
    const landed: AgentConfig = {
      ...record,
      previous: record.previous?.distributionKind === "binary" ? null : record.previous,
      lastSeenVersion: mine?.lastSeenVersion ?? null,
    };
    let name = landed.name;
    if (mine === undefined) name = await this.deps.configs.add(landed);
    else await this.deps.configs.upsert(landed);
    await this.deps.env.set(record.id, { ...env });
    if (knobs === undefined) await this.deps.composerKnobs.remove(record.id);
    else await this.deps.composerKnobs.record(record.id, knobs);
    return name;
  }

  /** Every agent's facts gone — the erase. Their env first, while the
   * records still key it: SecretStorage can't be listed, so a record gone
   * first would strand its secret for good. Then each store whole, strays
   * an older version left behind included. */
  async eraseAll(): Promise<void> {
    for (const { id } of this.deps.configs.list()) await this.deps.env.remove(id);
    await this.deps.configs.wipe();
    await this.deps.usedCapabilities.wipe();
    await this.deps.authLocks.wipe();
    await this.deps.composerKnobs.wipe();
  }

  /** Add's save half: a registry agent or a custom command is saved as a
   * new agent under an id patchbay mints — one registry entry or one
   * executable added twice is two agents — and a saved agent is taken as
   * it stands. Returns the agent to connect — nothing when the source names
   * nothing this machine can run. A registry entry is resolved from a
   * fresh read of the registry, never from the copy the list was shown
   * from. Beyond that one read the save never waits: every download the
   * launch needs happens on the card as a connect phase. */
  async saveFrom(source: ConnectAgentSource): Promise<PatchbayAgentId | undefined> {
    if ("patchbayAgentId" in source) return this.config(source.patchbayAgentId)?.id;
    const patchbayAgentId = mintPatchbayAgentId();
    let spec: LaunchSpec;
    let linked: { origin: string; link: AgentLink } | null = null;
    if ("registryId" in source) {
      await this.deps.registry.read("add");
      const agent = this.deps.registry.current().agents.find((a) => a.id === source.registryId);
      const link = agent === undefined ? null : registryLink(agent);
      const launch = link === null ? null : this.linkLaunch(source.registryId, link);
      if (agent === undefined || link === null || launch === null) return undefined; // can't run on this platform
      spec = { patchbayAgentId, name: agent.name, ...launch, cwd: this.deps.workspaceCwd };
      linked = { origin: agent.id, link };
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
    await this.add(spec, linked);
    return patchbayAgentId;
  }

  /** The Settings Agents page (add, edit, and remove agents,
   * including launch configuration per agent) — persists globally.
   * `commandLine` is the launch line as typed, sent only when the user
   * changed it — parsing is logic, done here by the same quote-aware house
   * parser custom Add uses, never a naive split. Without one the stored
   * command stays: a save from a knob or a toggle carries a copy of it
   * back, never an edit. A changed line on a registry agent unlinks it —
   * what was typed is what runs, and no Upgrade may write the registry's
   * line over it; only the user's Reset links it again. `config.env` is the
   * form's full desired set — what is in the box is what gets stored, to SecretStorage
   * only (stores/secret-env.ts). A config for an agent the store doesn't
   * hold is added under an id the store mints, and a name no other agent
   * holds — a view never chooses an agent's id. */
  async save(config: AgentConfigView, commandLine?: string): Promise<void> {
    const prior = this.config(config.id);
    const typed = commandLine === undefined ? undefined : parseCommandLine(commandLine);
    if (typed === null) {
      this.log.error(`agent config ${config.id}: command line has an unterminated quote`);
      return;
    }
    const { command, args } = typed ?? prior ?? { command: config.command, args: [...config.args] };
    const edited = prior !== undefined && typed !== undefined && !sameCommandLine(prior, typed);
    const patchbayAgentId = prior?.id ?? mintPatchbayAgentId();
    // Identity/wire facts never round-trip through the form: the webview's
    // copies of `lastSeenVersion`, `origin` and `link` are patch-lag stale
    // the moment a connect or an Upgrade lands mid-edit — the store's own
    // values are the truth the form has no business carrying back; the
    // view's copy speaks only for an agent the store doesn't hold yet.
    const record: AgentConfig = {
      id: patchbayAgentId,
      name: config.name,
      command,
      args: [...args],
      autoConnect: config.autoConnect,
      // The view's seed is stored as the defaults' `options`.
      defaults: { options: { ...config.defaults } },
      origin: prior !== undefined ? prior.origin : config.origin,
      link: edited ? null : prior !== undefined ? prior.link : config.link,
      previous: edited || prior === undefined ? null : prior.previous,
      lastSeenVersion: prior?.lastSeenVersion ?? config.lastSeenVersion,
    };
    if (edited && prior?.link) this.log.info(`${prior.id}: its command was edited — it no longer follows the ACP registry`);
    try {
      if (prior === undefined) await this.deps.configs.add(record);
      else await this.deps.configs.upsert(record);
    } catch (err) {
      // A name another agent holds: the form says so before Save; this is
      // the write's own refusal, and nothing of the edit is kept.
      this.log.error(`agent config ${patchbayAgentId}: ${err instanceof Error ? err.message : String(err)}`);
      await this.publishAll();
      return;
    }
    await this.deps.env.set(patchbayAgentId, { ...config.env });
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
    // The method as the connection's own `initialize` was read — its kind,
    // and how patchbay runs it (a spec terminal method first, then a
    // recipe, the same order the kind is classified by). Command paths
    // stay host-side; the webview only ever sees the kind.
    const live = this.deps.pool.get(patchbayAgentId);
    if (live?.declared?.authMethods.find((m) => m.id === methodId)?.kind === "unsupported") {
      this.log.warn(`${patchbayAgentId}: ignored a login on "${methodId}" — patchbay can't run this method's type`);
      return;
    }
    const run = live?.initialize?.logins.get(methodId);
    if (live !== undefined && run?.via === "terminal") {
      // the spec's terminal auth method: the agent's own launch plus the
      // method's args — `authenticate` is never called on it, so a login's
      // success is always terminal-ran-plus-reprobe, never the RPC's word
      // for it.
      await this.typedLoginViaTerminal(patchbayAgentId, live.spec, run.auth, signal);
      return;
    }
    if (live !== undefined && run?.via === "recipe") {
      // terminal-recipe method: the agent's command as it wrote it, over
      // the env the agent runs in — the user's keys reach the login that
      // writes the credentials the agent reads with them, and a managed
      // runtime's PATH reaches the shim the recipe names. `authenticate`
      // is never called on it either (meta.ts).
      await this.loginViaTerminal(patchbayAgentId, { ...run.recipe, env: mergeEnv(live.spec.env, run.recipe.env) }, signal);
      return;
    }
    await this.deps.tracker.authenticate(patchbayAgentId, methodId);
  }

  /** The logout round-trip — needsAuth is raised by the tracker itself (a
   * successful logout IS the auth state; no probe) — then the agent's
   * process is disconnected. Policy, not a quirk workaround: a process that
   * has held credentials is never trusted to shed them (spawn-time-only
   * auth reads are live behavior — observed in auggie), so killing it is the
   * only clear-out that needs no agent cooperation. The card lands on
   * stopped + the logout reason, and the lock persists (auth-evidence.ts) —
   * a reconnect carries it until real login evidence clears it. */
  async logout(patchbayAgentId: PatchbayAgentId): Promise<void> {
    const config = this.config(patchbayAgentId);
    if (config === undefined || !this.offers(config).logout) {
      this.log.warn(`${patchbayAgentId}: ignored a logout — the agent doesn't declare one`);
      return;
    }
    await this.deps.tracker.logout(patchbayAgentId);
    await this.deps.pool.stop(patchbayAgentId);
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
    // this machine the registry path adds it — the next start finds it by
    // its registry id and flags it. A value flagged once is folded: never
    // again (the setting can't be cleared, so the record consumes it).
    const unfolded = legacyDefault !== "" && legacyDefault !== this.deps.defaultAgentFold.folded();
    const legacy = !unfolded
      ? undefined
      : (this.config(legacyDefault as PatchbayAgentId) ??
        this.deps.configs.list().find((c) => c.origin === legacyDefault));
    if (legacy !== undefined) {
      if (!legacy.autoConnect) {
        await this.deps.configs.upsert({ ...legacy, autoConnect: true });
        await this.publishAll();
        this.log.info(`migrated acpPatchbay.defaultAgent ("${legacyDefault}") to the per-agent auto-connect flag`);
      }
      await this.deps.defaultAgentFold.record(legacyDefault);
    }
    const stamped = await this.deps.lastConnected.consume();
    const flagged = this.deps.configs.list().filter((c) => c.autoConnect).map((c) => c.id);
    const sources = [...new Set([...flagged, ...stamped])].flatMap((patchbayAgentId): ConnectAgentSource[] => {
      if (this.config(patchbayAgentId) !== undefined) return [{ patchbayAgentId }];
      this.log.debug(`startup connect: ${patchbayAgentId} has no config (removed since the stamp) — skipped`);
      return [];
    });
    return unfolded && legacy === undefined ? [...sources, { registryId: legacyDefault }] : sources;
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

  /** The stores moved under the views (an erase, an import): an agent the
   * views show that the store no longer holds leaves them, and every row
   * and the config list republish from the store. */
  async republish(shownPatchbayAgentIds: readonly PatchbayAgentId[]): Promise<void> {
    const held = new Set(this.deps.configs.list().map((c) => c.id));
    for (const patchbayAgentId of shownPatchbayAgentIds) {
      if (!held.has(patchbayAgentId)) this.hooks.emit({ kind: "agentRemoved", patchbayAgentId });
    }
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
      version: {
        ...(config.link === null ? {} : { pinned: config.link.pinnedVersion }),
        ...(config.lastSeenVersion === null ? {} : { reported: config.lastSeenVersion }),
      },
      update,
      busy: this.deps.busy(config.id).map((kind) => {
        if (!isVersionMove(kind)) return { kind };
        // the version it moves to while known, the new pin once saved
        const to =
          kind === "upgrade"
            ? update?.to
            : kind === "goBack"
              ? config.previous?.pinnedVersion
              : this.deps.registry.current().agents.find((a) => a.id === config.origin)?.version;
        return { kind, to: to ?? config.link?.pinnedVersion };
      }),
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
    const { origin, link } = agent;
    return {
      patchbayAgentId: agent.id,
      name: agent.name,
      command: agent.command,
      args: agent.args,
      env: {},
      cwd: this.deps.workspaceCwd,
      defaults: agent.defaults.options ?? {},
      ...(origin !== null && link?.distributionKind === "binary" && link.distribution !== undefined
        ? { binary: archiveFacts(origin, link.pinnedVersion, link.distribution) }
        : {}),
    };
  }

  /** The launch a link's recipe stands for — its command line and the env
   * it sets; no I/O: npx/uvx are ecosystem-managed installs (spawning them
   * *is* installing), and a `binary` one is the cached path the connect's
   * launch phase acquires it to, on the card, behind the download
   * confirmation — deterministic, so the config is honest before anything
   * is downloaded. Null when the recipe is unknown (a record stored before
   * it was kept): the launch can't be rebuilt from it. */
  private linkLaunch(origin: string, link: AgentLink): { command: string; args: string[]; env: Record<string, string> } | null {
    if (link.distributionKind === "binary") {
      const recipe = link.distribution;
      if (recipe?.args === undefined) return null;
      return {
        command: resolvedBinaryPath(this.deps.binaryCacheDir, origin, link.pinnedVersion, recipe.cmd),
        args: [...recipe.args],
        env: { ...recipe.env },
      };
    }
    const recipe = link.distribution;
    return recipe === undefined ? null : { ...packageLaunch(link.distributionKind, recipe), env: { ...recipe.env } };
  }

  /** The agent on another link — its launch rebuilt from the link's recipe,
   * its own facts as they are. Null when the recipe can't rebuild it. */
  private relinked(config: AgentConfig, link: AgentLink, previous: AgentLink | null): AgentConfig | null {
    const launch = config.origin === null ? null : this.linkLaunch(config.origin, link);
    return launch === null ? null : { ...config, command: launch.command, args: launch.args, link, previous };
  }

  /** Saves a new agent as a global config — "add" and "connect" are one
   * action (adding an agent means it's activated — checked spawnable, ready
   * to start conversations on), not two decoupled steps a user could leave
   * half-done. It takes a name no other agent holds. */
  private async add(spec: LaunchSpec, linked: { origin: string; link: AgentLink } | null): Promise<void> {
    // The env is the user's from here on: a registry recipe's env seeds it,
    // once — nothing writes it after (see `noteEnvChange`).
    if (Object.keys(spec.env).length > 0) await this.deps.env.set(spec.patchbayAgentId, { ...spec.env });
    await this.deps.configs.add({
      id: spec.patchbayAgentId,
      name: spec.name,
      command: spec.command,
      args: [...spec.args],
      autoConnect: false,
      defaults: {},
      origin: linked?.origin ?? null,
      link: linked?.link ?? null,
      previous: null,
      lastSeenVersion: null,
    });
    await this.publishAll();
  }

  /** A move's save: the new launch, link and way back replace the old
   * ones on the agent as it stands now; its own facts — its name, env,
   * auto-connect, defaults, the version that last answered — stay as they
   * are. It bears only on the launch it was resolved from: a Save doesn't
   * wait for a move, so an agent whose launch was edited while the new
   * version started keeps the edit — the newer word — and one removed
   * meanwhile stays removed. */
  private async saveMove(from: AgentConfig, moved: AgentConfig): Promise<void> {
    const now = this.config(from.id);
    if (now === undefined || moved.link === null || !sameLaunch(now, from)) return;
    await this.deps.configs.upsert({ ...now, command: moved.command, args: moved.args, link: moved.link, previous: moved.previous });
    await this.noteEnvChange(now, moved.link);
    await this.publishAll();
  }

  /** The env is the user's: Add seeds it from the registry's recipe, and a
   * move never writes it. What differs between the env of the agent's old
   * recipe and its new one is said instead — keys it now sets or sets
   * differently, and keys it no longer sets — for the user to take or
   * leave. An agent with no old recipe — edited before a Reset, or stored
   * before its recipe was kept — has no old env to compare: the new one is
   * read against the user's own env, whose values are never shown — they
   * may be secrets. */
  private async noteEnvChange(config: AgentConfig, next: AgentLink): Promise<void> {
    const before = config.link?.distribution?.env;
    const after = next.distribution?.env ?? {};
    const base = before ?? (await this.deps.env.get(config.id));
    const changes = [
      ...Object.entries(after).flatMap(([key, value]) =>
        !(key in base)
          ? [`now sets ${key}=${value}`]
          : base[key] === value
            ? []
            : [`now sets ${key}=${value} (${before === undefined ? "yours differs" : `was ${base[key]}`})`],
      ),
      ...(before === undefined ? [] : Object.keys(before).filter((key) => !(key in after)).map((key) => `no longer sets ${key}`)),
    ];
    if (changes.length === 0) return;
    this.hooks.warn(
      `${config.name} ${next.pinnedVersion}: the ACP registry's env for this version differs — ${changes.join("; ")}. Your env is unchanged; edit it in Settings › Agents to take any of this.`,
    );
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
   * as corroboration and offering re-read — and if the probe *still* says auth_required,
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
    // the free check again: whether the login took
    const outcome = await this.deps.tracker.recheck(patchbayAgentId);
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
      // spawn never re-reads it (observed: auggie 0.32.0). The only
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

  /** The spec's terminal auth method: the wire pins the command to the
   * agent's own spawn — `spec` is the launch the running agent was spawned
   * from, as its launch phase resolved it (a registry binary's cached path,
   * a managed runtime's PATH; the configured launch has neither, and on a
   * machine with no Node of its own its `npx` names nothing), the method's
   * args APPENDED to the spawn args and its env layered over the spawn env.
   * On Windows the command is absolutized the same way a spawn would be — a
   * bare name would otherwise be resolved by the task engine's own PATH
   * walk, which knows nothing of the planted-`npx.cmd` hazard spawn-resolve
   * guards, and it must not win here any more than it can at spawn;
   * not-found falls back to the bare name and lets the task report it. */
  private async typedLoginViaTerminal(
    patchbayAgentId: PatchbayAgentId,
    spec: LaunchSpec,
    typed: TerminalAuth,
    signal?: AbortSignal,
  ): Promise<void> {
    const env = mergeEnv(spec.env, typed.env);
    const command =
      process.platform === "win32"
        ? (resolveExecutableWin32(spec.command, mergeEnv(process.env, env)) ?? spec.command)
        : spec.command;
    await this.loginViaTerminal(patchbayAgentId, { command, args: [...spec.args, ...typed.args], env }, signal);
  }
}

/** How a move names itself when it didn't start. */
const MOVE_PHRASE: Record<VersionMove, (to: string) => string> = {
  upgrade: (to) => `the upgrade to ${to}`,
  reset: (to) => `the reset to the ACP registry's ${to}`,
  goBack: (to) => `going back to ${to}`,
};

/** The registry's entry as a link: its version, and its recipe for this
 * platform kept whole. Null when nothing here runs it (the reason is
 * already on the picker row). */
function registryLink(agent: RegistryAgent): AgentLink | null {
  const resolved = resolveDistribution(agent);
  if ("error" in resolved) return null;
  return resolved.kind === "binary"
    ? { distributionKind: "binary", pinnedVersion: agent.version, distribution: keptRecipe(resolved.published) }
    : { distributionKind: resolved.kind, pinnedVersion: agent.version, distribution: keptRecipe(resolved.published) };
}

/** Whether two configs launch the same thing: the same line from the same
 * registry pin (or both unlinked). */
function sameLaunch(a: AgentConfig, b: AgentConfig): boolean {
  return sameCommandLine(a, b) && a.origin === b.origin && a.link?.pinnedVersion === b.link?.pinnedVersion;
}

/** A registry binary's archive as the launch phase takes it: where it is
 * downloaded from, the executable inside it and the digest published with
 * it — cached and looked up by the registry id and version. */
function archiveFacts(
  registryId: string,
  version: string,
  target: { archive: string; cmd: string; sha256?: string },
): NonNullable<LaunchSpec["binary"]> {
  return {
    distribution: registryId,
    version,
    archiveUrl: target.archive,
    cmd: target.cmd,
    ...(target.sha256 === undefined ? {} : { sha256: target.sha256 }),
  };
}

/** The registry's recipe as a registry agent keeps it — its own copy, never
 * a reference into the registry's reading. */
function keptRecipe<T extends { args: readonly string[]; env: Readonly<Record<string, string>> }>(published: T): T {
  return { ...published, args: [...published.args], env: { ...published.env } };
}
