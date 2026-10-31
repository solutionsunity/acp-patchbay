// The window's orchestrator, as production builds it, on storage held in
// memory and a folder of the test's own. Only its ports — what VS Code does
// for it — are stood in for here, each recorded or answered as a test asks;
// everything the orchestrator composes is the real thing. A test observes
// it the way a webview does: attached to its views, reading what they are
// sent.
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { vi } from "vitest";
import { applyFileWrite } from "../../src/orchestrator/client-host";
import { nullLogger } from "../../src/orchestrator/logger";
import { Orchestrator, type OrchestratorPorts } from "../../src/orchestrator/orchestrator";
import { MemoryKV } from "../../src/orchestrator/stores/kv";
import { AgentConfigStore } from "../../src/orchestrator/stores/agent-configs";
import { AuthLockStore } from "../../src/orchestrator/stores/auth-locks";
import { ComposerKnobsStore } from "../../src/orchestrator/stores/composer-knobs";
import { UsedCapabilityStore } from "../../src/orchestrator/stores/used-capabilities";
import { McpServerConfigStore } from "../../src/orchestrator/stores/mcp-server-configs";
import { McpServerTokenStore, MemorySecrets } from "../../src/orchestrator/stores/mcp-server-tokens";
import { SecretEnvStore } from "../../src/orchestrator/stores/secret-env";
import { SessionFilesStore } from "../../src/orchestrator/stores/session-files";
import { SECRET_FAMILIES } from "../../src/orchestrator/stores/storage-keys";
import type { PatchbayAgentId } from "../../src/shared/ids";
import type { AgentConfigView, AgentViewEvent, AgentViewState, HostToView, SettingsEvent, SettingsState } from "../../src/shared/protocol";
import { atTestEnd, stopsAtTestEnd } from "./teardown";
import { SHELL_GRAMMAR } from "./shell-grammar";

/** One view as a webview sees it: every patch it was sent, in order. */
export interface WatchedView<S, E> {
  /** Every event the view was sent so far — pending patches flushed first. */
  events(): E[];
  /** The view's canonical state, as its next snapshot would carry it. */
  state(): S;
  /** How many whole-state snapshots the view was sent. */
  snapshots(): number;
}

export interface OrchestratorHarness {
  orchestrator: Orchestrator;
  agentView: WatchedView<AgentViewState, AgentViewEvent>;
  settings: WatchedView<SettingsState, SettingsEvent>;
  /** Settles once the orchestrator's startup has run (it says so to its
   * view: startupSettled) — where a real window is before a user acts. */
  started: Promise<void>;
  /** What the orchestrator asked of its ports, in order. */
  asked: { port: keyof OrchestratorPorts; args: unknown[] }[];
  /** The open workspace's folders — mutable, to play a folder change. */
  workspaceRoots: string[];
  /** Sessions shown in their own panels — mutable. */
  pinned: Set<string>;
  /** Where the orchestrator keeps what it stores on disk. */
  paths: { globalStorage: string; workspaceStorage: string };
  /** The machine's stored facts as its storage holds them — what was there
   * before the test, and what landed. */
  stores: {
    agentConfigs: AgentConfigStore;
    agentEnv: SecretEnvStore;
    authLocks: AuthLockStore;
    mcpServerConfigs: McpServerConfigStore;
    mcpServerTokens: McpServerTokenStore;
    sessionFiles: SessionFilesStore;
    usedCapabilities: UsedCapabilityStore;
    composerKnobs: ComposerKnobsStore;
  };
  /** Every free-check probe the orchestrator opened, in order: the
   * session/new each agent was sent in its probe root. */
  probes: { patchbayAgentId: PatchbayAgentId; sessionId: string }[];
  /** Saves an agent as the user's Settings save does — its config, its
   * env in secret storage — and so a row in the views: the orchestrator
   * acts only on agents that exist. */
  saveAgent(config: AgentConfigView): Promise<void>;
}

export interface OrchestratorHarnessOptions {
  /** This machine's storage — pass one to share it with a second harness
   * (a window reload, or another window). */
  machineKV?: MemoryKV;
  /** This workspace's storage — likewise. */
  workspaceKV?: MemoryKV;
  /** This machine's secret storage — likewise. */
  secrets?: MemorySecrets;
  /** The folder the window works in — absent, `cwd`. */
  workspace?: string;
  workspaceRoots?: readonly string[];
  /** Replaces a port's stand-in. */
  ports?: Partial<OrchestratorPorts>;
  /** The network, as the registry and every download see it — absent, the
   * test's own servers on loopback answer and anything else fails: no test
   * reaches an outside host. */
  fetch?: typeof fetch;
}

function watch<S, E>(channel: Orchestrator["agentView"] | Orchestrator["settings"]): WatchedView<S, E> {
  const sent: E[] = [];
  let snapshots = 0;
  channel.attach({
    postMessage: (message: unknown) => {
      const msg = message as HostToView<S, E>;
      if (msg.kind === "patch") sent.push(...msg.events);
      if (msg.kind === "snapshot") snapshots++;
      return Promise.resolve(true);
    },
  });
  return {
    events: () => {
      channel.flushNow();
      return [...sent];
    },
    state: () => channel.current as S,
    snapshots: () => snapshots,
  };
}

/** Each orchestrator's IPC socket has a name of its own — a test process
 * builds many, a window one. */
let orchestrators = 0;

/** `cwd` is the test's own folder: the home of the orchestrator's global
 * and workspace storage, and — unless `workspace` names another — the
 * folder it works in. */
export function orchestratorHarness(cwd: string, opts: OrchestratorHarnessOptions = {}): OrchestratorHarness {
  const real = globalThis.fetch;
  const loopbackOnly: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ? real(input, init)
      : Promise.reject(new Error(`no network in tests: ${url.host}`));
  };
  vi.stubGlobal("fetch", opts.fetch ?? loopbackOnly);
  atTestEnd(() => vi.unstubAllGlobals());
  const asked: OrchestratorHarness["asked"] = [];
  const paths = { globalStorage: join(cwd, ".patchbay-global"), workspaceStorage: join(cwd, ".patchbay-workspace") };
  const workspace = opts.workspace ?? cwd;
  const workspaceRoots = [...(opts.workspaceRoots ?? [workspace])];
  const pinned = new Set<string>();
  const note = <K extends keyof OrchestratorPorts>(port: K, ...args: unknown[]) => asked.push({ port, args });
  const ports: OrchestratorPorts = {
    handleAction: (action) => note("handleAction", action),
    workspaceRoots: () => workspaceRoots,
    // an editor with nothing open: no selection, no file, no diagnostics
    editor: { getSelection: () => null, getCurrentFile: () => null, getDiagnostics: () => [], getOpenEditors: () => [] },
    redirectUri: async () => "http://127.0.0.1/oauth-callback",
    openLink: async (href) => (note("openLink", href), true),
    confirm: async (message, choice) => (note("confirm", message, choice), true),
    warn: (message) => note("warn", message),
    runLoginTask: async (name, recipe) => (note("runLoginTask", name, recipe), 0),
    announceUpdates: async () => {},
    wireSink: () => ({ appendLine: () => {} }),
    onWireLogStateChanged: () => {},
    pinnedSessions: () => [...pinned],
    // No editor holds a file here: what VS Code would fall back to, disk.
    readTextFileLive: (path) => readFile(path, "utf8"),
    writeTextFileLive: (path, content) => applyFileWrite(path, content),
    closeAskDiffs: async () => {},
    connectStartupAgents: async () => {},
    focusComposer: async () => void note("focusComposer"),
    notifyAsk: (patchbaySessionId, title, ask) => note("notifyAsk", patchbaySessionId, title, ask),
    syncDetachContext: () => {},
    warnCatch: (context, what) => (err) => note("warnCatch", context, what, err),
    ...opts.ports,
  };
  const machineKV = opts.machineKV ?? new MemoryKV();
  const secrets = opts.secrets ?? new MemorySecrets();
  // What this machine holds, as its files and secret storage hold it — for a
  // test to set up what was already there, and to read what landed. The
  // orchestrator's owners hold their own copies of these stores; both read
  // the same storage.
  const stores = {
    agentConfigs: new AgentConfigStore(machineKV),
    agentEnv: new SecretEnvStore(secrets, SECRET_FAMILIES.agent),
    authLocks: new AuthLockStore(machineKV),
    mcpServerConfigs: new McpServerConfigStore(machineKV),
    mcpServerTokens: new McpServerTokenStore(secrets),
    sessionFiles: new SessionFilesStore(join(paths.globalStorage, "session-files")),
    usedCapabilities: new UsedCapabilityStore(machineKV),
    composerKnobs: new ComposerKnobsStore(machineKV),
  };
  const orchestrator = new Orchestrator(
    {
      machineKV,
      workspaceKV: opts.workspaceKV ?? new MemoryKV(),
      secrets,
      globalStoragePath: paths.globalStorage,
      storagePath: paths.workspaceStorage,
      workspaceCwd: workspace,
      ipcName: `patchbay-test-${process.pid}-${++orchestrators}`,
      scripts: {
        editorServer: join(process.cwd(), "out", "mcp-server.js"),
        bridge: join(process.cwd(), "out", "mcp-bridge.js"),
      },
      shellGrammar: SHELL_GRAMMAR,
    },
    ports,
    nullLogger,
  );
  // Its startup runs on from the constructor; the view is told when it ends.
  // What the harness reads off the orchestrator it wraps by hand, never by
  // a spy: a test's own spy on the same method then wraps this one.
  const started = new Promise<void>((resolve) => {
    const emit = orchestrator.agentView.emit.bind(orchestrator.agentView);
    orchestrator.agentView.emit = (...events) => {
      emit(...events);
      if (events.some((e) => e.kind === "startupSettled")) resolve();
    };
  });
  atTestEnd(() => orchestrator.dispose());
  stopsAtTestEnd(orchestrator.pool);
  // A probe is the session/new an agent is sent in its probe root — read
  // off the pool as it answers, nothing added to the orchestrator for it.
  const probes: OrchestratorHarness["probes"] = [];
  const probeRoot = join(paths.globalStorage, "probe") + sep;
  const newSession = orchestrator.pool.newSession.bind(orchestrator.pool);
  orchestrator.pool.newSession = async (patchbayAgentId, sessionCwd, ...rest) => {
    const opened = await newSession(patchbayAgentId, sessionCwd, ...rest);
    if (sessionCwd.startsWith(probeRoot)) probes.push({ patchbayAgentId, sessionId: opened.sessionId });
    return opened;
  };
  const saveAgent = async (config: AgentConfigView) => {
    await stores.agentEnv.set(config.id, { ...config.env });
    await stores.agentConfigs.upsert({
      id: config.id,
      name: config.name,
      command: config.command,
      args: [...config.args],
      autoConnect: config.autoConnect,
      defaults: { options: { ...config.defaults } },
      origin: config.origin,
      link: config.link,
      previous: null,
      lastSeenVersion: config.lastSeenVersion,
    });
    orchestrator.agents.publish(config.id);
  };
  return {
    orchestrator,
    agentView: watch<AgentViewState, AgentViewEvent>(orchestrator.agentView),
    settings: watch<SettingsState, SettingsEvent>(orchestrator.settings),
    started,
    asked,
    workspaceRoots,
    pinned,
    paths,
    stores,
    probes,
    saveAgent,
  };
}
