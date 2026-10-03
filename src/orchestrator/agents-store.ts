// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The agents store: the one home of agents. Saved facts are read from their
// files when asked (config, env, auth lock, last knob choices), live facts
// come from the pool, and every operation on an agent is here — connect,
// stop, restart, upgrade, remove, save, reorder, log in, log out, verify.
// Every door (Settings, the Agent View, the palette, notifications, startup)
// calls these methods, and nothing else starts or stops an agent's process.
// vscode-free: the questions a user answers, the login task, the sessions
// riding a connection and the views are hooks.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { methods, type InitializeResponse } from "@agentclientprotocol/sdk";
import type {
  AgentConfigView,
  AgentStatus,
  AgentUpdate,
  AgentViewEvent,
  AuthMethodView,
  CapabilityMatrix,
  CapabilityRowId,
  ConnectAgentSource,
  DeclaredCapabilities,
  KnobSeed,
  PreferencesView,
  SettingsEvent,
} from "../shared/protocol";
import { formatCommandLine, parseCommandLine } from "../shared/command-line";
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
  /** Settings-only facts: the config list (env values included) and the
   * verify bracket. */
  emitSettings(...events: SettingsEvent[]): void;
  /** The capability matrix as the views hold it — the evidence sink reads
   * it to skip what is already marked. */
  currentMatrix(agentId: string): CapabilityMatrix | undefined;
  /** What stopping this agent's connection would cut off, read from the
   * sessions riding it. */
  openWork(agentId: string): { conversations: number; turns: number };
  /** A modal question with one affirmative choice; true = it was chosen. */
  confirm(message: string, choice: string): Promise<boolean>;
  /** A warning the user sees once, never a gate. */
  warn(message: string): void;
  /** Runs a login recipe as a visible task — its exit code, or undefined
   * when the exit is unknown. */
  runLoginTask(name: string, recipe: TerminalAuthRecipe): Promise<number | undefined>;
  /** The agent is being removed — its sessions leave with it. Called once
   * its process is down, before its own facts are purged. */
  removed(agentId: string): void;
  /** The agent's auth lock just cleared. */
  authCleared(agentId: string): void;
  /** A save moved the agent's stored defaults. */
  defaultsChanged(agentId: string): void;
}

export class AgentsStore {
  private updatesNow: Readonly<Record<string, AgentUpdate>> = {};
  /** PATH divergence already warned, per agent and exact version pair. */
  private readonly divergenceWarned = new Set<string>();
  /** terminal-auth recipes (meta.ts) per agent, keyed by method id —
   * captured at every connect; command paths are machine-absolute and
   * never persisted, and the webview only ever sees the method's kind. */
  private readonly authRecipes = new Map<string, ReadonlyMap<string, TerminalAuthRecipe>>();
  /** The spec's typed `terminal` auth methods per agent, keyed by method id
   * — same capture, same host-side-only rule: wire args and env only; the
   * command is the agent's own spawn spec, composed at click time. */
  private readonly typedTerminalAuth = new Map<string, ReadonlyMap<string, TerminalAuth>>();
  /** Each declared auth method's kind per agent — what `login` checks before
   * any wire call. */
  private readonly authMethodKinds = new Map<string, ReadonlyMap<string, AuthMethodView["kind"]>>();
  /** THE in-flight bracket for every tracker round-trip the settings card
   * reflects (verify, authenticate, logout): emits
   * agentVerifyStarted/Finished around the work so the card's controls dim
   * for exactly its span — one writer for the signal, so the flows can
   * never drift apart. Refcounted: overlapping brackets (a user Verify
   * racing verify-after-connect) must not un-dim mid-RPC when the first
   * one finishes — Finished fires only when the LAST bracket closes. */
  private readonly verifySignalDepth = new Map<string, number>();

  constructor(
    private readonly deps: AgentsStoreDeps,
    private readonly hooks: AgentsStoreHooks,
    /** Output-channel seam (logger.ts). */
    private readonly log: Logger = nullLogger,
  ) {}

  // ── reads ─────────────────────────────────────────────────────────────────

  /** The agent's saved config, read from the file — undefined once removed. */
  config(agentId: string): AgentConfig | undefined {
    return this.deps.configs.get(agentId);
  }

  /** The spawnable spec its saved config stands for. */
  spec(agentId: string): LaunchSpec | undefined {
    const config = this.config(agentId);
    return config === undefined ? undefined : this.specFromConfig(config);
  }

  name(agentId: string): string | undefined {
    return this.config(agentId)?.name;
  }

  /** The update fact — registry version against each config's pin. */
  updates(): Readonly<Record<string, AgentUpdate>> {
    return this.updatesNow;
  }

  authLocked(agentId: string): boolean {
    return this.deps.authLocks.lockFor(agentId) !== null;
  }

  /** The knob seed a fresh session of this agent starts from: its configured
   * defaults, or — when the preference says so — the last combination the
   * agent confirmed on it, falling back to the defaults when it has none
   * (an agent whose knobs were never touched has no record). */
  knobSeed(agentId: string, source: PreferencesView["knobSource"]): KnobSeed | undefined {
    const defaults = this.spec(agentId)?.defaults;
    if (source !== "last-session") return defaults;
    return this.deps.composerKnobs.get(agentId) ?? defaults;
  }

  /** A user-set, agent-confirmed knob combination — the one write of the
   * last-session seed. */
  recordKnobs(agentId: string, seed: KnobSeed): void {
    void this.deps.composerKnobs.record(agentId, seed);
  }

  /** An agent's standing throwaway workspace (`probe/<agentId>`) — the
   * capability probe's and the defaults editor's sessions both open here,
   * never in a user workspace root. Created idempotently, deleted only with
   * the agent's config (`remove`): a workspace-aware agent may hold it
   * agent-side past session/new. */
  async probeRoot(agentId: string): Promise<string> {
    const dir = join(this.deps.probeRootBase, agentId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  // ── publishing to the views ───────────────────────────────────────────────

  /** Every configured agent is upserted into both channels' agent lists:
   * the Agent View knows every configured agent from the first frame, with
   * an honest status — `untested` (never initialized successfully at any
   * version) or `stopped` (has connected before; `lastSeenVersion` is the
   * durable marker) — instead of agents existing only once connected
   * in-window. */
  publishAll(): void {
    for (const agent of this.deps.configs.list()) {
      // needsAuth seeds from the persisted lock (auth-evidence.ts), never
      // a literal: a logout witnessed before this reload is still the
      // truth — the wire has nothing to re-read it from.
      const lock = this.deps.authLocks.lockFor(agent.id);
      this.hooks.emit({
        kind: "agentUpserted",
        agent: {
          id: agent.id,
          name: agent.name,
          status: agent.lastSeenVersion === null ? "untested" : "stopped",
          command: formatCommandLine(agent.command, agent.args),
          needsAuth: lock !== null,
          authReason: lock?.reason ?? undefined,
        },
      });
    }
    void this.publishConfigs();
  }

  /** The config list for the Settings forms — env values ride the Settings
   * channel to their owner: the form shows what is stored; SecretStorage
   * stays the only place they rest. */
  private async publishConfigs(): Promise<void> {
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
    this.publishUpdates();
  }

  /** The registry moved — the update fact is recomputed from it. */
  registryChanged(): void {
    this.publishUpdates();
  }

  /** Recomputes the update fact from its two inputs — the registry and the
   * configs (pin + last seen version) — and publishes it to both channels
   * when it changed. Called wherever either input moves. */
  private publishUpdates(): void {
    const updates = agentUpdates(this.deps.registry.current().agents, this.deps.configs.list());
    if (JSON.stringify(updates) === JSON.stringify(this.updatesNow)) return;
    this.updatesNow = updates;
    this.hooks.emit({ kind: "agentUpdatesChanged", updates });
  }

  // ── what the pool reports ─────────────────────────────────────────────────

  /** The process's status, as the pool saw it change. */
  noteStatus(agentId: string, status: AgentStatus, detail?: string, stderr?: readonly string[]): void {
    this.hooks.emit({ kind: "agentStatusChanged", agentId, status, detail, stderr });
    const suffix = detail !== undefined ? ` — ${detail}` : "";
    if (status === "crashed") this.log.error(`${agentId}: crashed${suffix}`);
    else this.log.info(`${agentId}: ${status}${suffix}`);
  }

  /** A fresh connection's `initialize` answer: the capability claims, the
   * version that actually answered, and the auth methods on offer. */
  noteDeclared(agentId: string, declared: DeclaredCapabilities, raw: InitializeResponse): void {
    const version = raw.agentInfo?.version ?? null;
    this.deps.tracker.onDeclared(agentId, declared, version, raw.protocolVersion);
    if (version !== null) void this.recordSeenVersion(agentId, version);
    // terminal-auth recipes (meta.ts) and the spec's terminal auth
    // methods, fresh per connect — command paths are machine-absolute
    // and never persisted; the webview only ever sees the method's
    // kind, both captures stay host-side. A recipe wins over the
    // wire's type, the same precedence the kind is classified by.
    const recipes = new Map<string, TerminalAuthRecipe>();
    const typed = new Map<string, TerminalAuth>();
    for (const m of raw.authMethods ?? []) {
      const recipe = terminalAuthRecipeOf(m._meta);
      if (recipe !== null) {
        recipes.set(m.id, recipe);
        continue;
      }
      const terminal = terminalAuthOf(m);
      if (terminal !== null) typed.set(m.id, terminal);
    }
    this.authRecipes.set(agentId, recipes);
    this.typedTerminalAuth.set(agentId, typed);
    this.authMethodKinds.set(agentId, new Map(declared.authMethods.map((m) => [m.id, m.kind])));
  }

  /** The single sink for pool.ts's proof-table hits (capabilities.ts
   * CAPABILITY_PROOFS): marks a row used the first time its path is
   * genuinely exercised on the wire, or suspect the first time it rides a
   * failed request. Guarded on current state so a chatty agent (many reads
   * per turn, a usage_update per turn) doesn't flood the patch stream with
   * idempotent events — and so suspicion never speaks over proof. */
  noteEvidence(agentId: string, row: CapabilityRowId, evidence: "used" | "suspect"): void {
    const cell = this.hooks.currentMatrix(agentId)?.[row];
    if (cell?.used) return;
    if (evidence === "used") this.deps.tracker.markUsed(agentId, row);
    else if (cell?.suspect !== true) this.deps.tracker.markSuspect(agentId, row);
  }

  /** One agent RPC's auth bearing, as the pool's wire chokepoint reports
   * it, read as evidence for the authority table. */
  noteAuthWireFact(
    agentId: string,
    method: string,
    settled: "ok" | "auth_required",
    startedAt: string,
    reason?: string | null,
  ): void {
    this.noteAuthEvidence(
      agentId,
      settled === "ok"
        ? { kind: "rpcOk", method, startedAt }
        : { kind: "authRequired", method, reason: reason ?? null },
    );
  }

  /** The one writer for agent auth state. Every caller — pool's wire
   * chokepoint, the terminal login flows — reports what it *witnessed*;
   * the authority table (auth-evidence.ts) decides what that does to the
   * lock, the lock persists machine-scoped, and only a real transition
   * emits. No other code may emit agentAuthRequired/agentAuthResolved. */
  private noteAuthEvidence(agentId: string, evidence: AuthEvidence): void {
    // Evidence for an agent that no longer exists writes nothing: a
    // terminal login left open across a Remove would otherwise re-create
    // a lock entry for a deleted id and poison a future re-add.
    if (this.config(agentId) === undefined) {
      this.log.debug(`auth evidence for unknown agent ${agentId} dropped (${evidence.kind})`);
      return;
    }
    const result = applyAuthEvidence(this.deps.authLocks.lockFor(agentId), evidence, new Date().toISOString());
    if (!result.changed) return;
    if (result.lock === null) {
      this.deps.authLocks.remove(agentId).catch((err: Error) => {
        this.log.error(`${agentId}: auth-lock remove failed — ${err.message}`);
      });
      this.hooks.emit({ kind: "agentAuthResolved", agentId });
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
        this.noteEvidence(agentId, "auth", "used");
      }
      // Words held at the turn-start door were waiting for exactly this:
      // an idle session has no coming turn end to drain them. The lock is
      // already cleared in memory (FileKV swaps synchronously), so the
      // drain reads the new truth.
      this.hooks.authCleared(agentId);
    } else {
      this.deps.authLocks.upsert({ id: agentId, lock: result.lock }).catch((err: Error) => {
        this.log.error(`${agentId}: auth-lock write failed — ${err.message}`);
      });
      this.hooks.emit({ kind: "agentAuthRequired", agentId, reason: result.lock.reason });
    }
  }

  /** `agentInfo.version` is reality ("reality is the source of
   * truth") — recorded on the config so the registry's live version
   * can be compared against what actually answered, driving "update
   * available" without ever trusting the pinned ask over the wire's fact. */
  private async recordSeenVersion(agentId: string, version: string): Promise<void> {
    const existing = this.config(agentId);
    if (existing === undefined || existing.lastSeenVersion === version) return;
    // Knob offerings need no reset here: they're connection-scoped, and a
    // version can only change on a fresh connect, which already dropped
    // them with the old connection.
    await this.deps.configs.upsert({ ...existing, lastSeenVersion: version });
    await this.publishConfigs();
  }

  // ── operations ────────────────────────────────────────────────────────────

  /** Connects a saved agent; upserts it into both channel states. The
   * single env-injection point: values are read fresh from SecretStorage
   * per connect (stores/secret-env.ts) — the spec and the config store never
   * carry them. Throws when the agent has no saved config, or when the
   * connect fails (the pool already reported the crash and its reason). */
  async connect(agentId: string): Promise<void> {
    const spec = this.spec(agentId);
    if (spec === undefined) throw new Error("no saved launch configuration — re-add it in Settings");
    // A connect bears nothing on auth — needsAuth carries the standing
    // lock (auth-evidence.ts) through the upsert instead of a literal
    // false, or every reconnect would erase a witnessed logout.
    const lock = this.deps.authLocks.lockFor(agentId);
    this.hooks.emit({
      kind: "agentUpserted",
      agent: {
        id: agentId,
        name: spec.name,
        status: "reconnecting",
        command: formatCommandLine(spec.command, spec.args),
        needsAuth: lock !== null,
        authReason: lock?.reason ?? undefined,
      },
    });
    const env = await this.deps.env.get(agentId);
    const merged = { ...spec, env: { ...spec.env, ...env } };
    await this.deps.pool.connect(merged);
    void this.warnOnPathDivergence(merged);
  }

  /** The one add-and-connect path: a registry agent or a custom command is
   * saved first, a saved agent is connected as it stands — then the connect,
   * unless one is running or under way, and the free check when asked. */
  async connectFrom(source: ConnectAgentSource, verifyAfterConnect = false): Promise<void> {
    let spec: LaunchSpec | null = null;
    let registrySource: AgentConfig["registrySource"] = null;
    let shouldPersist = true;
    if ("registryId" in source) {
      const agent = this.deps.registry.current().agents.find((a) => a.id === source.registryId);
      if (agent === undefined) return;
      const resolved = this.registryLaunch(agent);
      if (resolved === null) return; // can't run on this platform
      spec = resolved.spec;
      registrySource = resolved.registrySource;
    } else if ("configuredId" in source) {
      spec = this.spec(source.configuredId) ?? null;
      shouldPersist = false; // already persisted — this is a reconnect of an existing config
    } else {
      const parsed = parseCommandLine(source.command);
      if (parsed) {
        const id = `custom-${parsed.command.replace(/[^\w.-]+/g, "-")}`;
        spec = {
          agentId: id,
          name: parsed.command,
          command: parsed.command,
          args: parsed.args,
          env: {},
          cwd: this.deps.workspaceCwd,
        };
      }
    }
    if (spec === null) return;
    // Persist FIRST — the card exists from the click, and every download
    // the launch needs then happens on it as a connect phase. An Upgrade
    // clicked while the agent happens to be connecting must still land its
    // new pin — only the connect itself is skipped. "reconnecting" gates
    // alongside "running": a second
    // Connect during an in-flight connect would re-emit the wholesale
    // upsert (stomping the card mid-connect) just to have pool.connect
    // refuse a moment later.
    if (shouldPersist) await this.persistAgentConfig(spec, registrySource);
    const status = this.deps.pool.get(spec.agentId)?.status;
    if (status === "running" || status === "reconnecting") {
      this.log.info(`${spec.agentId}: connect skipped — already ${status}`);
      return;
    }
    // Spawn what the store says (the saved config) — the same reading a
    // restart makes, so a re-added agent keeps its stored defaults from the
    // first connect; the registry's env already went to SecretStorage.
    try {
      await this.connect(spec.agentId);
      if (verifyAfterConnect) void this.verify(spec.agentId);
    } catch {
      // pool already emitted the crashed status with detail
    }
  }

  /** Intentional stop — reads as "stopped", never "crashed". */
  stop(agentId: string): Promise<void> {
    return this.deps.pool.stop(agentId);
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
  async restart(agentId: string): Promise<void> {
    const spec = this.spec(agentId);
    if (spec === undefined) {
      await this.deps.pool.restart(agentId);
      return;
    }
    const env = await this.deps.env.get(agentId);
    await this.deps.pool.restart(agentId, { ...spec, env: { ...spec.env, ...env } });
  }

  /** Re-resolves the registry's current (possibly newer) pinned version and
   * reconnects — the same path a first Add takes, so the version-keyed
   * used-capability cache and the launch phase's download confirmation
   * both apply exactly as they would for a brand-new agent. Never silent: a
   * still-uncached binary version re-gates on the confirmation, and a stop
   * that would disconnect open conversations asks first — here, not at any one
   * button, so every surface that offers Upgrade gets the same question. */
  async upgrade(agentId: string): Promise<void> {
    const config = this.config(agentId);
    if (config === undefined || config.registrySource === null) return;
    if (this.deps.pool.get(agentId)?.status === "running") {
      if (!(await this.confirmUpgrade(config.name, this.hooks.openWork(agentId)))) return;
      await this.deps.pool.stop(agentId);
    }
    await this.connectFrom({ registryId: config.registrySource.registryId });
  }

  /** Asks only when the stop costs something: conversations attached
   * to the connection are disconnected, and a running turn is cut off. */
  private async confirmUpgrade(
    agentName: string,
    work: { conversations: number; turns: number },
  ): Promise<boolean> {
    if (work.conversations === 0) return true;
    const plural = work.conversations === 1 ? "" : "s";
    const turns = work.turns === 0 ? "" : ` — ${work.turns} still running and will be cut off`;
    return this.hooks.confirm(
      `Upgrade ${agentName}? It restarts the agent, disconnecting ${work.conversations} open conversation${plural}${turns}.`,
      "Upgrade",
    );
  }

  /** Remove is stop + forget ("add, edit, and remove agents") —
   * the process goes down, the agent leaves
   * both channel states via the `agentRemoved` event, its per-agent facts
   * (used capabilities, observed knobs) are purged so a future re-add
   * starts honest, and its session rows leave the drawer. Nothing to ask
   * the user: patchbay holds no session history — the sessions live on in
   * the agent's own store and reappear via session/list on a re-add. */
  async remove(agentId: string): Promise<void> {
    await this.deps.pool.stop(agentId);
    this.hooks.removed(agentId);
    await this.deps.configs.remove(agentId);
    await this.deps.usedCapabilities.remove(agentId);
    await this.deps.composerKnobs.remove(agentId);
    await this.deps.env.remove(agentId);
    this.authRecipes.delete(agentId);
    this.typedTerminalAuth.delete(agentId);
    this.authMethodKinds.delete(agentId);
    await this.deps.authLocks.remove(agentId);
    await rm(join(this.deps.probeRootBase, agentId), { recursive: true, force: true }).catch(() => {});
    this.hooks.emit({ kind: "agentRemoved", agentId });
    await this.publishConfigs();
  }

  /** The Settings Agents page (add, edit, and remove agents,
   * including launch configuration per agent) — persists globally. The
   * Edit form sends the launch line raw (parsing is
   * logic), so an empty args array means "parse `command` here" — the same
   * quote-aware house parser custom Add uses, never a naive split.
   * `config.env` is the form's full desired set — what is in the box is
   * what gets stored, to SecretStorage only (stores/secret-env.ts). */
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
    await this.deps.env.set(config.id, { ...config.env });
    // Identity/wire facts never round-trip through the form: the webview's
    // copies of `lastSeenVersion` and `registrySource` are patch-lag stale
    // the moment a connect or an Upgrade lands mid-edit — the store's own
    // values are the truth the form has no business carrying back.
    const prior = this.config(config.id);
    await this.deps.configs.upsert({
      id: config.id,
      name: config.name,
      command,
      args,
      autoConnect: config.autoConnect,
      // The view's folded seed is stored under `options` alone — the legacy
      // `mode` field is read (foldSeed) but never written again.
      defaults: { options: { ...config.defaults } },
      registrySource: prior?.registrySource ?? config.registrySource,
      lastSeenVersion: prior?.lastSeenVersion ?? config.lastSeenVersion,
    });
    await this.publishConfigs();
    // The store moved; an open editor re-reads the surface for the new
    // defaults from the agent (a no-op when no editor is open).
    this.hooks.defaultsChanged(config.id);
  }

  /** The Settings list order — a view's picture of it at drop time. */
  async reorder(ids: readonly string[]): Promise<void> {
    await this.deps.configs.reorder(ids);
    await this.publishConfigs();
  }

  /** Log in with one of the agent's declared methods. A method patchbay
   * cannot drive never reaches a wire call: the card shows no button for
   * it, and this is the writer holding the same line — `authenticate`
   * belongs to the agent type alone. Failure leaves needsAuth set — the
   * honest signal, no separate reply channel. */
  async login(agentId: string, methodId: string): Promise<void> {
    if (this.authMethodKinds.get(agentId)?.get(methodId) === "unsupported") {
      this.log.warn(`${agentId}: ignored a login on "${methodId}" — patchbay can't run this method's type`);
      return;
    }
    const recipe = this.authRecipes.get(agentId)?.get(methodId);
    if (recipe !== undefined) {
      // terminal-recipe method: the login runs in a visible terminal,
      // `authenticate` is never called on it (meta.ts).
      await this.loginViaTerminal(agentId, recipe);
      return;
    }
    const typed = this.typedTerminalAuth.get(agentId)?.get(methodId);
    if (typed !== undefined) {
      // the spec's terminal auth method: same executor,
      // recipe composed from the agent's own spawn spec at click time —
      // `authenticate` is never called on it either, so a login's
      // success is always terminal-ran-plus-reprobe, never the RPC's
      // word for it.
      await this.typedLoginViaTerminal(agentId, typed);
      return;
    }
    // Bracketed like verify/logout: the card's controls dim for the
    // authenticate round-trip's span too.
    await this.withVerifySignal(agentId, "authenticate", () =>
      this.deps.tracker.authenticate(agentId, methodId),
    );
  }

  /** Logout round-trip under the shared in-flight signal — the card's
   * controls dim for the RPC's span, needsAuth is raised by the tracker
   * itself (a successful logout IS the auth state; no probe) — then the
   * agent's process is disconnected. Policy, not a quirk workaround:
   * a process that has held credentials is never trusted to shed them
   * (spawn-time-only auth reads are live behavior — auggie dossier), so
   * killing it is the only clear-out that needs no agent cooperation.
   * The card lands on stopped + the logout reason, and the
   * lock persists (auth-evidence.ts) — a reconnect carries it until real
   * login evidence clears it. */
  async logout(agentId: string): Promise<void> {
    await this.withVerifySignal(agentId, "logout", () => this.deps.tracker.logout(agentId));
    await this.deps.pool.stop(agentId);
  }

  /** Brackets a Verify round-trip (manual click or "Verify after add") with
   * the settings-only in-flight signal — the card's Verify control dims and
   * reads "Verifying…" for exactly the span of the free protocol check.
   * Returns what the probe observed so the terminal-login flow can react
   * to a still-locked agent. */
  async verify(agentId: string): Promise<ProbeOutcome> {
    return await this.withVerifySignal(agentId, "verify", () => this.deps.tracker.verify(agentId));
  }

  // ── window lifecycle ──────────────────────────────────────────────────────

  /** Startup connections: the union of every config flagged auto-connect
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
  async startup(legacyDefault: string): Promise<void> {
    if (legacyDefault !== "") {
      const existing = this.config(legacyDefault);
      if (existing !== undefined && !existing.autoConnect) {
        await this.deps.configs.upsert({ ...existing, autoConnect: true });
        await this.publishConfigs();
        this.log.info(`migrated acpPatchbay.defaultAgent ("${legacyDefault}") to the per-agent auto-connect flag`);
      }
    }
    const stamped = await this.deps.lastConnected.consume();
    const flagged = this.deps.configs.list().filter((c) => c.autoConnect).map((c) => c.id);
    const ids = new Set([...flagged, ...stamped]);
    if (legacyDefault !== "") ids.add(legacyDefault); // config may not exist yet — resolved below
    await Promise.allSettled(
      [...ids].map((id) => {
        if (this.config(id) !== undefined) return this.connectFrom({ configuredId: id });
        // Only the legacy setting can name an agent with no config on this
        // machine (a stamp or flag implies one was persisted) — the registry
        // path covers it, and persists the config it was missing.
        if (id === legacyDefault) return this.connectFrom({ registryId: id });
        this.log.debug(`startup connect: ${id} has no config (removed since the stamp) — skipped`);
        return Promise.resolve();
      }),
    );
  }

  /** Reload-continuation stamp, written before any killing at shutdown —
   * the running set as it stood when the window went down is what the next
   * activate restores (if it comes soon enough to be a reload;
   * last-connected.ts). */
  stampRunning(): Promise<void> {
    return this.deps.lastConnected.write(
      this.deps.pool.list().filter((v) => v.status === "running").map((v) => v.spec.agentId),
    );
  }

  /** "Disconnect & erase all data" wiped the files: what this store holds
   * in memory goes too, every agent the views show leaves them, and the
   * config list republishes empty. */
  async erased(shownAgentIds: readonly string[]): Promise<void> {
    this.authRecipes.clear();
    this.typedTerminalAuth.clear();
    this.authMethodKinds.clear();
    for (const agentId of shownAgentIds) this.hooks.emit({ kind: "agentRemoved", agentId });
    await this.publishConfigs();
  }

  // ── internals ─────────────────────────────────────────────────────────────

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
      agentId: agent.id,
      name: agent.name,
      command: agent.command,
      args: agent.args,
      env: {},
      cwd: this.deps.workspaceCwd,
      defaults: foldSeed(agent.defaults),
      ...(source?.distributionKind === "binary" && source.binary !== undefined
        ? { binary: { ...source.binary, version: source.pinnedVersion } }
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
  ): { spec: LaunchSpec; registrySource: AgentConfig["registrySource"] } | null {
    const launch = resolveDistribution(agent);
    const cwd = this.deps.workspaceCwd;
    if ("error" in launch) return null;
    switch (launch.kind) {
      case "npx":
      case "uvx":
        return {
          spec: { agentId: agent.id, name: agent.name, command: launch.command, args: [...launch.args], env: { ...launch.env }, cwd },
          registrySource: { registryId: agent.id, distributionKind: launch.kind, pinnedVersion: agent.version },
        };
      case "binary": {
        const pinnedDigest = launch.sha256 === null ? {} : { sha256: launch.sha256 };
        return {
          spec: {
            agentId: agent.id,
            name: agent.name,
            command: resolvedBinaryPath(this.deps.binaryCacheDir, agent.id, agent.version, launch.cmd),
            args: [...launch.args],
            env: { ...launch.env },
            cwd,
            binary: { archiveUrl: launch.archiveUrl, version: agent.version, cmd: launch.cmd, ...pinnedDigest },
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

  /** Persists the launch as a global agent config — "add" and "connect" are
   * one action now (adding an agent means it's activated —
   * checked spawnable, ready to start conversations on), not two decoupled
   * steps a user could leave half-done. Preserves any hand-edited
   * defaults an existing config already carries. */
  private async persistAgentConfig(
    spec: LaunchSpec,
    registrySource: AgentConfig["registrySource"],
  ): Promise<void> {
    const existing = this.config(spec.agentId);
    // Registry-declared launch env (part of the distribution recipe) goes to
    // the same SecretStorage record user-entered env lives in — one source
    // at spawn time. Registry values win for their own keys; the user's
    // other keys survive a re-add/Upgrade.
    if (Object.keys(spec.env).length > 0) {
      const stored = await this.deps.env.get(spec.agentId);
      await this.deps.env.set(spec.agentId, { ...stored, ...spec.env });
    }
    await this.deps.configs.upsert({
      id: spec.agentId,
      name: spec.name,
      command: spec.command,
      args: [...spec.args],
      autoConnect: existing?.autoConnect ?? false,
      defaults: existing?.defaults ?? (spec.defaults !== undefined ? { options: spec.defaults } : {}),
      registrySource: registrySource ?? existing?.registrySource ?? null,
      lastSeenVersion: existing?.lastSeenVersion ?? null,
    });
    await this.publishConfigs();
  }

  /** Two installs, one memory: a PATH-installed sibling CLI shares the
   * agent's per-user state store with the copy patchbay runs — by design,
   * but a wide version gap means two writers of different vintages on one
   * store (launcher-health.ts PATH_SIBLINGS). Warning only, never a gate;
   * once per exact version pair so reconnects don't nag. */
  private async warnOnPathDivergence(spec: LaunchSpec): Promise<void> {
    try {
      const d = await checkPathDivergence(spec);
      if (d === null) return;
      const key = `${spec.agentId}:${d.pathVersion}:${d.bundledVersion}`;
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
   * heals later through a same-method success or a completed prompt. */
  private async loginViaTerminal(agentId: string, recipe: TerminalAuthRecipe): Promise<void> {
    const name = recipe.label ?? `${this.name(agentId) ?? agentId} login`;
    const exitCode = await this.hooks.runLoginTask(name, recipe);
    this.log.info(`${agentId}: login command finished (exit ${exitCode ?? "unknown"})`);
    if (exitCode !== undefined && exitCode !== 0) {
      this.noteAuthEvidence(agentId, {
        kind: "loginFailed",
        reason: `login command failed (exit ${exitCode}) — check the terminal output and try again`,
      });
      return;
    }
    // Exit 0 is the affirmative evidence — it clears the lock (the
    // authority table's call); the probe below is corroboration and the
    // offering re-read, not the clearer: on a lazy-auth agent its
    // session/new success bears nothing either way. An *unknown* exit
    // (task never started, terminated, terminal closed mid-run) is not
    // affirmative — no evidence is noted, and the lock heals later through
    // a same-method success or a completed prompt.
    if (exitCode === 0) this.noteAuthEvidence(agentId, { kind: "loginOk" });
    const outcome = await this.verify(agentId);
    // "skipped" = the probe is latch-deferred (first-session-mcp-latch) —
    // no corroboration is possible without spending the latch slot, and
    // the latched vendor is also the spawn-time-credential-read vendor:
    // restart unconditionally, same reasoning as the auth_required arm.
    if (exitCode === 0 && outcome === "skipped") {
      this.log.info(
        `${agentId}: login succeeded but the probe is latch-deferred — restarting so the process reads the fresh credentials`,
      );
      await this.restart(agentId);
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
        `${agentId}: login succeeded but the running process still reports auth_required — restarting it to pick up the fresh credentials`,
      );
      await this.restart(agentId);
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
  private async typedLoginViaTerminal(agentId: string, typed: TerminalAuth): Promise<void> {
    const spec = this.spec(agentId);
    if (spec === undefined) {
      this.log.warn(`typed terminal login: no configured spec for ${agentId}`);
      return;
    }
    const secretEnv = await this.deps.env.get(agentId);
    const env = { ...spec.env, ...secretEnv, ...typed.env };
    const command =
      process.platform === "win32"
        ? (resolveExecutableWin32(spec.command, { ...process.env, ...env }) ?? spec.command)
        : spec.command;
    await this.loginViaTerminal(agentId, {
      command,
      args: [...spec.args, ...typed.args],
      env,
    });
  }

  private async withVerifySignal<T>(agentId: string, label: string, work: () => Promise<T>): Promise<T> {
    const depth = this.verifySignalDepth.get(agentId) ?? 0;
    this.verifySignalDepth.set(agentId, depth + 1);
    if (depth === 0) this.hooks.emitSettings({ kind: "agentVerifyStarted", agentId });
    this.log.debug(`${agentId}: ${label} started`);
    try {
      return await work();
    } finally {
      const remaining = (this.verifySignalDepth.get(agentId) ?? 1) - 1;
      if (remaining <= 0) {
        this.verifySignalDepth.delete(agentId);
        this.hooks.emitSettings({ kind: "agentVerifyFinished", agentId });
      } else {
        this.verifySignalDepth.set(agentId, remaining);
      }
      this.log.debug(`${agentId}: ${label} finished`);
    }
  }
}
