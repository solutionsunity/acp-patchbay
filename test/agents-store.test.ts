// The agents store over the real fake agent, minus vscode: saved facts are
// read from the file when asked (no copy to drift), a saved agent connects
// with its SecretStorage env, Remove purges every saved fact, auth evidence
// for an agent with no config writes nothing, startup reads what this window
// opens with, and the gates put the connection operations through the
// queue — its holdings riding the row as busy — with Stop and Remove
// ending whatever it holds.
import { existsSync } from "node:fs";
import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_AGENT, fakeAgentPackage, fakeConfig } from "./support/fake-agent";
import { npmRegistry, type LocalNpmRegistry } from "./support/npm-registry";
import { orchestratorHarness, type OrchestratorHarnessOptions } from "./support/orchestrator-harness";
import { fileTempDir, tempDir } from "./support/teardown";
import { SETTLE } from "./support/wait-for";
import { platformOf, registryTarget } from "../src/orchestrator/platform";
import { Cancelled } from "../src/orchestrator/queue";
import { runtimeInstallSpec } from "../src/orchestrator/runtime-resolver";
import { formatCommandLine } from "../src/shared/command-line";
import { AgentConfigStore } from "../src/orchestrator/stores/agent-configs";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import type { AgentConfigView } from "../src/shared/protocol";
import type { PatchbayAgentId, PatchbaySessionId } from "../src/shared/ids";


let dir: string;
beforeEach(async () => {
  dir = await tempDir("patchbay-agents-");
});
afterEach(async () => {
  vi.unstubAllGlobals();
});

/** The window's orchestrator, its agents side under the names these tests
 * read; `ports` answers what VS Code would (its questions, its terminal). */
function harness(opts: { kv?: MemoryKV; ports?: OrchestratorHarnessOptions["ports"] } = {}) {
  const h = orchestratorHarness(dir, { machineKV: opts.kv, ports: opts.ports });
  const o = h.orchestrator;
  const state = h.agentView.state;
  return {
    orchestrator: o,
    pool: o.pool,
    agents: o.agents,
    gates: o.gates,
    tracker: o.capabilityTracker,
    deps: {
      configs: o.agentConfigs,
      env: o.agentEnv,
      registry: o.acpRegistry,
      usedCapabilities: o.usedCapabilities,
      composerKnobs: o.composerKnobs,
      authLocks: o.authLocks,
    },
    events: h.agentView.events,
    state,
    row: (patchbayAgentId: PatchbayAgentId) => state().agents.find((a) => a.id === patchbayAgentId),
    paths: h.paths,
    saveAgent: h.saveAgent,
    warnings: () => h.asked.filter((a) => a.port === "warn").map((a) => a.args[0]),
  };
}
type Harness = ReturnType<typeof harness>;

/** One conversation open on the agent, as a user opens one: a chat started
 * and spoken in. */
async function openConversation(h: Harness, patchbayAgentId: PatchbayAgentId): Promise<void> {
  await h.orchestrator.startChat(patchbayAgentId);
  await h.orchestrator.sessionGates.prompt(h.state().activePatchbaySessionId! as PatchbaySessionId, { text: "hello" });
}

/** An agent env with npm offline — what a registry launch meets on a
 * machine with no network: npx fails at once, as it would there. */
const OFFLINE = { npm_config_offline: "true" };

/** A registry agent's origin and link, as the Settings view carries them. */
const linked = (origin: string, pinnedVersion: string) => ({ origin, link: { distributionKind: "npx" as const, pinnedVersion } });

/** The shape of an id patchbay mints. */
const MINTED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A registry entry: one npx agent, its recipe setting `env` when given. */
type Listed = { id: string; version: string; env?: Record<string, string> };

/** A registry file, one npx agent per entry. */
const registryFile = (agents: Listed[]) => ({
  version: "1.0.0",
  agents: agents.map(({ env, ...a }) => ({ ...a, name: a.id, distribution: { npx: { package: `${a.id}@${a.version}`, ...(env === undefined ? {} : { env }) } } })),
});

/** What the CDN serves from now on. */
function serveRegistry(...agents: Listed[]): void {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify(registryFile(agents)), { headers: { "content-type": "application/json" } }),
  );
}

/** The registry's copy on disk, loaded into the store. */
async function cacheRegistry(h: Harness, ...agents: Listed[]): Promise<void> {
  await mkdir(join(h.paths.globalStorage, "registry"), { recursive: true });
  await writeFile(
    join(h.paths.globalStorage, "registry", "acp-registry-cache.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), etag: null, raw: registryFile(agents), icons: {} }),
  );
  await h.deps.registry.load();
}

/** The registry as both its copy and the CDN hold it. */
async function seedRegistry(h: Harness, ...agents: Listed[]): Promise<void> {
  serveRegistry(...agents);
  await cacheRegistry(h, ...agents);
}

/** A running registry agent pinned at 1.0.0 — by default with 2.0.0 on
 * offer; `listed` is what the registry lists instead. */
async function upgradable(h: Harness, listed = [{ id: "reg", version: "2.0.0" }]): Promise<void> {
  await seedRegistry(h, ...listed);
  await h.saveAgent(
    fakeConfig("reg", {}, { env: { ...OFFLINE, FAKE_AGENT_SCRIPT: "{}" }, ...linked("reg", "1.0.0") }),
  );
  await h.gates.connect("reg" as PatchbayAgentId);
}

/** The questions VS Code would put, answered by the test — each by how it
 * starts. */
function asking() {
  const asked: string[] = [];
  const open = new Map<string, (yes: boolean) => void>();
  return {
    asked,
    answer: (start: string, yes: boolean) => {
      const message = [...open.keys()].find((m) => m.startsWith(start));
      if (message === undefined) throw new Error(`no open question starting "${start}"`);
      open.get(message)!(yes);
      open.delete(message);
    },
    confirm: (message: string) => {
      asked.push(message);
      return new Promise<boolean>((resolve) => open.set(message, resolve));
    },
  };
}

describe("agents store", () => {
  it("reads saved facts from the file when asked — another window's save shows at once", async () => {
    const kv = new MemoryKV();
    const h = harness({ kv });
    await h.saveAgent(fakeConfig("a", {}));
    expect(h.agents.name("a" as PatchbayAgentId)).toBe("Fake a");
    // Another window, its own store over the same file, renames the agent.
    const elsewhere = new AgentConfigStore(kv);
    await elsewhere.upsert({ ...elsewhere.get("a" as PatchbayAgentId)!, name: "Renamed", args: ["--other"] });
    expect(h.agents.name("a" as PatchbayAgentId)).toBe("Renamed");
    expect(h.agents.spec("a" as PatchbayAgentId)?.args).toEqual(["--other"]);
    await elsewhere.remove("a" as PatchbayAgentId);
    expect(h.agents.spec("a" as PatchbayAgentId)).toBeUndefined();
  });

  it("connects a saved agent with its env from SecretStorage, and records the version that answered", async () => {
    const h = harness();
    await h.saveAgent(fakeConfig("v", { version: "9.9.9" }));
    await h.gates.connect("v" as PatchbayAgentId);

    expect(h.pool.get("v" as PatchbayAgentId)?.status).toBe("running");
    expect(h.state().agents.find((a) => a.id === "v")?.status).toBe("running");
    // the script — and so the version — only reaches the process through the env
    await expect.poll(() => h.agents.config("v" as PatchbayAgentId)?.lastSeenVersion).toBe("9.9.9");

    await h.gates.stop("v" as PatchbayAgentId);
  });

  it("a crashed row carries the process's last words; a running one carries none", async () => {
    const h = harness();
    // write-callback → exit: the last words are flushed before death
    const dying = ["-e", 'process.stderr.write("boom: config missing\\n", () => process.exit(1));'];
    await h.saveAgent(fakeConfig("doomed", {}, { args: dying }));
    await expect(h.gates.connect("doomed" as PatchbayAgentId)).rejects.toThrow();
    expect(h.row("doomed" as PatchbayAgentId)?.status).toBe("crashed");
    expect(h.row("doomed" as PatchbayAgentId)?.stderr?.join("\n")).toContain("boom: config missing");

    await h.agents.save(fakeConfig("doomed", {}), formatCommandLine(process.execPath, [FAKE_AGENT]));
    await h.gates.connect("doomed" as PatchbayAgentId);
    expect(h.row("doomed" as PatchbayAgentId)?.status).toBe("running");
    expect(h.row("doomed" as PatchbayAgentId)?.stderr).toBeUndefined();
    await h.gates.stop("doomed" as PatchbayAgentId);
  });

  it("an edit that takes another agent's name is refused — the record stays as it was", async () => {
    const h = harness();
    await h.saveAgent(fakeConfig("one", {}));
    await h.saveAgent(fakeConfig("two", {}));
    await h.agents.save(fakeConfig("two", {}, { name: "Fake one", autoConnect: true }));
    expect(h.agents.config("two" as PatchbayAgentId)).toMatchObject({ name: "Fake two", autoConnect: false });
  });

  it("the row's command is what runs while a process runs, and what Connect would run otherwise", async () => {
    const h = harness();
    await h.saveAgent(fakeConfig("cmd", {}));
    await h.gates.connect("cmd" as PatchbayAgentId);
    const spawned = h.row("cmd" as PatchbayAgentId)!.command;
    await h.agents.save(fakeConfig("cmd", {}), formatCommandLine(process.execPath, [FAKE_AGENT, "--edited"]));
    expect(h.row("cmd" as PatchbayAgentId)!.command).toBe(spawned);
    await h.gates.stop("cmd" as PatchbayAgentId);
    expect(h.row("cmd" as PatchbayAgentId)!.command).toContain("--edited");
  });

  it("publishing sends every row before the config list waits on any env read — the first frame has every agent", async () => {
    const h = harness();
    await h.saveAgent(fakeConfig("first", {}));
    await h.saveAgent(fakeConfig("second", {}));
    const before = h.events().length;
    const settled = h.agents.publishAll();
    // synchronously, before the env reads behind the config list resolve
    const sent = h.events().slice(before).flatMap((e) => (e.kind === "agentUpserted" ? [e.agent] : []));
    expect(sent.map((a) => a.id)).toEqual(["first", "second"]);
    expect(sent.find((a) => a.id === "second")?.status).toBe("untested");
    await settled;
  });

  it("refuses to connect an agent with no saved config", async () => {
    const h = harness();
    await expect(h.gates.connect("ghost" as PatchbayAgentId)).rejects.toThrow("no saved launch configuration");
  });

  it("Remove stops the process, tells the sessions side, purges every saved fact, lets go of its live state and leaves the views", async () => {
    const h = harness();
    await h.saveAgent(fakeConfig("gone", {}));
    await h.gates.connect("gone" as PatchbayAgentId);
    await openConversation(h, "gone" as PatchbayAgentId);
    await h.deps.authLocks.upsert({
      id: "gone" as PatchbayAgentId,
      lock: { kind: "authRequired", method: "session/new", reason: null, at: new Date().toISOString() },
    });
    h.agents.recordKnobs("gone" as PatchbayAgentId, { mode: "code" });
    const probe = await h.agents.probeRoot("gone" as PatchbayAgentId);

    await h.gates.remove("gone" as PatchbayAgentId);

    // The pool lets go only of a process that is down.
    expect(h.pool.get("gone" as PatchbayAgentId)).toBeUndefined();
    expect(h.tracker.matrix("gone" as PatchbayAgentId)).toBeUndefined();
    // the sessions side was told: the agent's conversation left with it
    expect(h.state().sessions.some((s) => s.patchbayAgentId === "gone")).toBe(false);
    expect(h.agents.config("gone" as PatchbayAgentId)).toBeUndefined();
    expect(await h.deps.env.get("gone")).toEqual({});
    expect(h.agents.authLocked("gone" as PatchbayAgentId)).toBe(false);
    expect(h.deps.composerKnobs.get("gone" as PatchbayAgentId)).toBeUndefined();
    expect(h.deps.usedCapabilities.list().some((r) => r.id === "gone")).toBe(false);
    expect(existsSync(probe)).toBe(false);
    expect(h.state().agents.some((a) => a.id === "gone")).toBe(false);
  });

  it("once the stores move under the views, an agent they no longer hold leaves them and one they hold reads as stored", async () => {
    const h = harness();
    await h.saveAgent(fakeConfig("kept", {}));
    await h.saveAgent(fakeConfig("gone", {}));
    await h.deps.configs.remove("gone" as PatchbayAgentId);
    await h.deps.configs.upsert({ ...h.agents.config("kept" as PatchbayAgentId)!, name: "Renamed" });

    const before = h.events().length;
    await h.agents.republish(h.state().agents.map((a) => a.id));

    expect(h.state().agents.map((a) => [a.id, a.name])).toEqual([["kept", "Renamed"]]);
    // Only the gone one is removed: a removal takes the agent's open
    // questions and knob rows with it, so a kept agent is never removed and
    // re-added.
    const removed = h.events().slice(before).flatMap((e) => (e.kind === "agentRemoved" ? [e.patchbayAgentId] : []));
    expect(removed).toEqual(["gone"]);
  });

  it("auth evidence for an agent with no saved config writes nothing", () => {
    const h = harness();
    h.agents.noteAuthWireFact("ghost" as PatchbayAgentId, "session/new", "auth_required", new Date().toISOString(), "log in");
    expect(h.agents.authLocked("ghost" as PatchbayAgentId)).toBe(false);
    expect(h.events().some((e) => e.kind === "agentUpserted" && e.agent.id === "ghost")).toBe(false);
  });

  it("startup opens the agents flagged auto-connect, and nothing else", async () => {
    const h = harness();
    await h.saveAgent(fakeConfig("auto", {}, { autoConnect: true }));
    await h.saveAgent(fakeConfig("manual", {}));

    expect(await h.agents.startupSources("")).toEqual([{ patchbayAgentId: "auto" }]);
  });

  it("the old default-agent setting folds into the flag once — or names a registry agent not yet saved", async () => {
    const h = harness();
    await h.saveAgent(fakeConfig("legacy", {}));

    expect(await h.agents.startupSources("legacy")).toEqual([{ patchbayAgentId: "legacy" }]);
    expect(h.agents.config("legacy" as PatchbayAgentId)?.autoConnect).toBe(true);
    expect(await h.agents.startupSources("from-registry")).toEqual([
      { patchbayAgentId: "legacy" },
      { registryId: "from-registry" },
    ]);
  });

  it("a saved config for an agent the store doesn't hold is added under an id the store mints — a view never chooses one", async () => {
    const h = harness();
    await h.agents.save(fakeConfig("chosen", {}));
    expect(h.agents.config("chosen" as PatchbayAgentId)).toBeUndefined();
    const [added] = h.deps.configs.list();
    expect(added?.id).toMatch(MINTED);
    expect(added?.name).toBe("Fake chosen");
    expect(await h.deps.env.get(added!.id)).toEqual(fakeConfig("chosen", {}).env);
  });

  it("one executable added twice is two agents — ids patchbay minted, numbered names, neither overwrites the other (#51)", async () => {
    const h = harness();
    const first = await h.agents.saveFrom({ command: "npx foo acp" });
    const second = await h.agents.saveFrom({ command: "npx bar acp" });
    expect(first).toMatch(MINTED);
    expect(second).toMatch(MINTED);
    expect(second).not.toBe(first);
    expect(h.agents.config(first!)).toMatchObject({ name: "npx", command: "npx", args: ["foo", "acp"] });
    expect(h.agents.config(second!)).toMatchObject({ name: "npx 2", command: "npx", args: ["bar", "acp"] });
  });

  it("one registry entry added twice is two agents, each linked to the entry by its registry id", async () => {
    const h = harness();
    await seedRegistry(h, { id: "reg", version: "1.0.0" });
    const added = [await h.agents.saveFrom({ registryId: "reg" }), await h.agents.saveFrom({ registryId: "reg" })];
    expect(added[1]).not.toBe(added[0]);
    expect(added.map((id) => h.agents.config(id!)?.origin)).toEqual(["reg", "reg"]);
    expect(added.map((id) => h.agents.name(id!))).toEqual(["reg", "reg 2"]);
  });

  it("a value folded once is never folded again — the flag switched off afterwards stays off", async () => {
    const h = harness();
    await h.saveAgent(fakeConfig("legacy", {}));
    await h.agents.startupSources("legacy");
    expect(h.agents.config("legacy" as PatchbayAgentId)?.autoConnect).toBe(true);
    await h.agents.save(fakeConfig("legacy", {}, { autoConnect: false })); // the user switches it off
    expect(await h.agents.startupSources("legacy")).toEqual([]);
    expect(h.agents.config("legacy" as PatchbayAgentId)?.autoConnect).toBe(false);
  });

  it("the old default-agent setting naming a registry entry adds its agent once — the next start finds it by its registry id", async () => {
    const h = harness();
    await seedRegistry(h, { id: "reg", version: "1.0.0" });
    expect(await h.agents.startupSources("reg")).toEqual([{ registryId: "reg" }]);
    const added = await h.agents.saveFrom({ registryId: "reg" }); // the startup connect's save
    expect(await h.agents.startupSources("reg")).toEqual([{ patchbayAgentId: added }]);
    expect(h.agents.config(added!)?.autoConnect).toBe(true);
    expect(h.deps.configs.list()).toHaveLength(1);
  });

  // The copy a list or an update chip was shown from may be days old in a
  // window left open: Add and Upgrade act on the registry's word now.
  it("Add and Upgrade act on a fresh read of the registry, not on the copy they were shown from", async () => {
    const h = harness();
    await cacheRegistry(h, { id: "reg", version: "2.0.0" }); // the copy
    serveRegistry({ id: "reg", version: "3.0.0" }); // the registry moved on since
    const added = await h.agents.saveFrom({ registryId: "reg" });
    expect(h.agents.config(added!)?.link?.pinnedVersion).toBe("3.0.0");

    // the store now holds 3.0.0 — what an update chip would show
    await h.saveAgent(
      fakeConfig("old", {}, { env: OFFLINE, ...linked("reg", "1.0.0") }),
    );
    serveRegistry({ id: "reg", version: "4.0.0" });
    await h.gates.upgrade("old" as PatchbayAgentId);
    // offline, 4.0.0 can't start — the version it tried is the fresh read's
    expect(h.warnings()).toContainEqual(expect.stringContaining("the upgrade to 4.0.0 didn't start"));
  }, 120_000);

  it("Add and a re-resolve (Upgrade, import) keep the registry's recipe for the pinned version whole — npx package, args and env, or this platform's binary target", async () => {
    const h = harness();
    const serve = (version: string, distribution: object) =>
      vi.stubGlobal("fetch", async () =>
        new Response(JSON.stringify({ version: "1.0.0", agents: [{ id: "reg", name: "reg", version, distribution }] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    serve("1.0.0", { npx: { package: "reg@1.0.0", args: ["--acp"], env: { REG_FLAG: "1" } } });
    await h.deps.registry.load();
    const added = await h.agents.saveFrom({ registryId: "reg" });
    expect(h.agents.config(added!)).toMatchObject({
      origin: "reg",
      link: { distributionKind: "npx", pinnedVersion: "1.0.0", distribution: { package: "reg@1.0.0", args: ["--acp"], env: { REG_FLAG: "1" } } },
    });

    const target = { archive: "https://example.test/reg-2.0.0.tar.gz", cmd: "./reg", args: ["acp"], env: { REG_HOME: "x" }, sha256: "ab".repeat(32) };
    serve("2.0.0", { binary: { [registryTarget(platformOf()!)]: target } });
    // a way back the record holds stays: re-resolving moves no version
    const previous = { distributionKind: "npx" as const, pinnedVersion: "0.9.0" };
    await h.deps.configs.upsert({ ...h.agents.config(added!)!, previous });
    await h.agents.resolveHere(added!);
    expect(h.agents.config(added!)?.previous).toEqual(previous);
    expect(h.agents.config(added!)).toMatchObject({ origin: "reg", link: { distributionKind: "binary", pinnedVersion: "2.0.0", distribution: target } });
  });

  it("a changed line unlinks a registry agent, its origin kept; a save without one keeps the stored command — a spaced path with no args included", async () => {
    const h = harness();
    await seedRegistry(h, { id: "reg", version: "2.0.0" });
    const registry = linked("reg", "1.0.0");
    const spaced = join(dir, "Program Files", "agent");
    await h.saveAgent(fakeConfig("mine", {}, { command: spaced, args: [], ...registry }));

    // a knob or toggle save carries the stored command back — never an edit
    await h.agents.save(fakeConfig("mine", {}, { command: spaced, args: [], name: "Work profile", autoConnect: true }));
    expect(h.agents.config("mine" as PatchbayAgentId)).toMatchObject({ command: spaced, args: [], ...registry });
    expect(h.row("mine" as PatchbayAgentId)?.update).toEqual({ from: "1.0.0", to: "2.0.0" });
    // the line typed as it was keeps the link
    await h.agents.save(fakeConfig("mine", {}, { command: spaced, args: [] }), formatCommandLine(spaced, []));
    expect(h.agents.config("mine" as PatchbayAgentId)).toMatchObject(registry);

    await h.agents.save(fakeConfig("mine", {}, { command: spaced, args: [] }), `"${spaced}" --own`);
    expect(h.agents.config("mine" as PatchbayAgentId)).toMatchObject({ command: spaced, args: ["--own"], origin: "reg", link: null });
    expect(h.row("mine" as PatchbayAgentId)?.update).toBeUndefined();
  });

  // #129: the update was suppressed while the agent reported the registry's
  // latest — a comparison across two naming schemes (a pin's `0.36.0`, a
  // report's `0.36.0 (commit 7c61e5bb)`), guarding a drift never observed.
  it("the update is the pin against the registry's latest only — what the agent reports is never compared (#129)", async () => {
    const h = harness();
    await seedRegistry(h, { id: "reg", version: "2.0.0" });
    await h.saveAgent(fakeConfig("reports", {}, { ...linked("reg", "1.0.0"), lastSeenVersion: "2.0.0" }));
    expect(h.row("reports" as PatchbayAgentId)).toMatchObject({
      update: { from: "1.0.0", to: "2.0.0" },
      version: { pinned: "1.0.0", reported: "2.0.0" },
    });
  });

  it("a registry agent stored before its recipe gets it from the registry's copy, and one edited back then is unlinked, its origin kept", async () => {
    const h = harness();
    const target = { archive: "https://example.test/bin-1.0.0.tar.gz", cmd: "./bin", args: ["acp"], env: {} };
    vi.stubGlobal("fetch", async () => new Response("offline", { status: 503 }));
    await mkdir(join(h.paths.globalStorage, "registry"), { recursive: true });
    await writeFile(
      join(h.paths.globalStorage, "registry", "acp-registry-cache.json"),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        etag: null,
        icons: {},
        raw: {
          version: "1.0.0",
          agents: [
            { id: "pkg", name: "pkg", version: "1.0.0", distribution: { npx: { package: "pkg@1.0.0", args: ["--acp"] } } },
            { id: "bin", name: "bin", version: "1.0.0", distribution: { binary: { [registryTarget(platformOf()!)]: target } } },
            { id: "moved", name: "moved", version: "3.0.0", distribution: { npx: { package: "moved@3.0.0" } } },
          ],
        },
      }),
    );
    await h.deps.registry.load();
    const npx = linked;
    const binary = { origin: "bin", link: { distributionKind: "binary" as const, pinnedVersion: "1.0.0", distribution: { archive: target.archive, cmd: "./bin" } } };
    const cached = (root: string) => join(root, "bin", "1.0.0", "bin");
    await h.saveAgent(fakeConfig("pkg-kept", {}, { command: "npx", args: ["-y", "pkg@1.0.0", "--acp"], ...npx("pkg", "1.0.0") }));
    await h.saveAgent(fakeConfig("pkg-edited", {}, { command: "pkg", args: ["--acp"], ...npx("pkg", "1.0.0") }));
    await h.saveAgent(fakeConfig("moved-edited", {}, { command: "moved", args: [], ...npx("moved", "1.0.0") }));
    // a cache root from before the extension's storage moved
    await h.saveAgent(fakeConfig("bin-kept", {}, { command: cached("/old/root/bin-cache"), args: ["acp"], ...binary }));
    await h.saveAgent(fakeConfig("bin-edited", {}, { command: "C:\\Users\\me\\tools\\bin.exe", args: ["acp"], ...binary }));

    await h.agents.relinkAll();
    const source = (id: string) => {
      const config = h.agents.config(id as PatchbayAgentId);
      return { origin: config?.origin, link: config?.link };
    };
    expect(source("pkg-kept")).toEqual({ origin: "pkg", link: { ...npx("pkg", "1.0.0").link, distribution: { package: "pkg@1.0.0", args: ["--acp"], env: {} } } });
    expect(source("pkg-edited")).toEqual({ origin: "pkg", link: null });
    // the registry lists another version now: nothing to know it by — its next Upgrade writes the recipe
    expect(source("moved-edited")).toEqual(npx("moved", "1.0.0"));
    expect(source("bin-kept")).toEqual({ origin: "bin", link: { ...binary.link, distribution: target } });
    expect(source("bin-edited")).toEqual({ origin: "bin", link: null });
    expect(h.agents.config("bin-edited" as PatchbayAgentId)?.command).toBe("C:\\Users\\me\\tools\\bin.exe");
  });

  it("an imported agent edited on its own machine is unlinked, never re-resolved over", async () => {
    const h = harness();
    serveRegistry({ id: "reg", version: "2.0.0" });
    const link = { distributionKind: "binary" as const, pinnedVersion: "1.0.0", distribution: { archive: "https://example.test/reg.tar.gz", cmd: "reg" } };
    await h.saveAgent(fakeConfig("edited", {}, { command: "/home/me/tools/reg", origin: "reg", link }));
    expect(await h.agents.resolveHere("edited" as PatchbayAgentId)).toBe(true);
    expect(h.agents.config("edited" as PatchbayAgentId)).toMatchObject({ command: "/home/me/tools/reg", origin: "reg", link: null });
  });

  it("the env is the user's: Add seeds it from the recipe, an Upgrade never writes it and says what the registry changed", async () => {
    const h = harness();
    const serve = (version: string, env: Record<string, string>) =>
      vi.stubGlobal("fetch", async () =>
        new Response(
          JSON.stringify({ version: "1.0.0", agents: [{ id: "reg", name: "reg", version, distribution: { npx: { package: `reg@${version}`, env } } }] }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    serve("1.0.0", { MODEL: "a", AUTO_UPDATE: "0", GONE: "1" });
    await h.deps.registry.load();
    const added = (await h.agents.saveFrom({ registryId: "reg" }))!;
    expect(await h.deps.env.get(added)).toEqual({ MODEL: "a", AUTO_UPDATE: "0", GONE: "1" });

    const mine = { MODEL: "mine", AUTO_UPDATE: "0", GONE: "1", API_KEY: "secret" };
    await h.deps.env.set(added, mine);
    serve("2.0.0", { MODEL: "b", AUTO_UPDATE: "0", NEW: "x" });
    await h.agents.resolveHere(added);
    expect(await h.deps.env.get(added)).toEqual(mine);
    expect(h.agents.config(added)?.link?.distribution).toMatchObject({ env: { MODEL: "b", AUTO_UPDATE: "0", NEW: "x" } });
    expect(h.warnings()).toEqual([
      "reg 2.0.0: the ACP registry's env for this version differs — now sets MODEL=b (was a); now sets NEW=x; no longer sets GONE. Your env is unchanged; edit it in Settings › Agents to take any of this.",
    ]);
  });

  it("an agent stored before its recipe hears the new env against its own — its values never shown", async () => {
    const h = harness();
    await h.saveAgent(
      fakeConfig("old", {}, { name: "Old", env: { TOKEN: "secret" }, ...linked("reg", "1.0.0") }),
    );
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ version: "1.0.0", agents: [{ id: "reg", name: "reg", version: "2.0.0", distribution: { npx: { package: "reg@2.0.0", env: { TOKEN: "public", MODE: "acp" } } } }] }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await h.deps.registry.load();
    await h.agents.resolveHere("old" as PatchbayAgentId);
    expect(await h.deps.env.get("old" as PatchbayAgentId)).toEqual({ TOKEN: "secret" });
    expect(h.warnings()).toEqual([
      "Old 2.0.0: the ACP registry's env for this version differs — now sets TOKEN=public (yours differs); now sets MODE=acp. Your env is unchanged; edit it in Settings › Agents to take any of this.",
    ]);
  });

  it("an imported agent is resolved for this machine from a fresh registry read — or, unlisted, stays as the file had it", async () => {
    const h = harness();
    serveRegistry({ id: "reg", version: "2.0.0" });
    await h.saveAgent(fakeConfig("reg", {}, linked("reg", "1.0.0")));
    await h.saveAgent(fakeConfig("gone", {}, linked("unlisted", "1.0.0")));

    expect(await h.agents.resolveHere("reg" as PatchbayAgentId)).toBe(true);
    expect(h.agents.config("reg" as PatchbayAgentId)).toMatchObject({
      command: "npx",
      origin: "reg",
      link: { pinnedVersion: "2.0.0" },
    });
    expect(await h.agents.resolveHere("gone" as PatchbayAgentId)).toBe(false);
    expect(h.agents.config("gone" as PatchbayAgentId)?.link?.pinnedVersion).toBe("1.0.0");
    // Resolving never connects: the import's restart does.
    expect(h.pool.get("reg" as PatchbayAgentId)).toBeUndefined();
  });

  it("an Upgrade the registry can't serve asks nothing and leaves the agent as it is", async () => {
    const user = asking();
    const h = harness({ ports: { confirm: user.confirm } });
    await upgradable(h, [{ id: "other", version: "2.0.0" }]); // the registry no longer lists it
    await openConversation(h, "reg" as PatchbayAgentId);

    await h.gates.upgrade("reg" as PatchbayAgentId);
    expect(user.asked).toEqual([]);
    expect(h.row("reg" as PatchbayAgentId)?.status).toBe("running");
  });

  // #125: the new pin was saved before the new version started, so one that
  // couldn't install left the agent pinned to a version that won't run.
  it("an Upgrade whose new version doesn't start leaves the agent on its version — stopped before, it stays down and says why (#125)", async () => {
    // Offline, the new version's launch fails.
    const h = harness();
    await seedRegistry(h, { id: "reg", version: "2.0.0" });
    const config = fakeConfig("mine", {}, {
      env: OFFLINE,
      ...linked("reg", "1.0.0"),
    });
    await h.saveAgent(config);

    await h.gates.upgrade("mine" as PatchbayAgentId);
    expect(h.agents.config("mine" as PatchbayAgentId)).toMatchObject({
      command: config.command,
      args: config.args,
      origin: "reg",
      link: { pinnedVersion: "1.0.0" },
      previous: null,
    });
    expect(h.row("mine" as PatchbayAgentId)).toMatchObject({ status: "crashed", update: { from: "1.0.0", to: "2.0.0" } });
    expect(h.warnings()).toEqual([expect.stringMatching(/^Fake mine: the upgrade to 2\.0\.0 didn't start — .+\. It stays on 1\.0\.0\.$/)]);
  }, 120_000);

  it("an Upgrade whose new version doesn't start brings the version it had back up when it was running (#125)", async () => {
    const h = harness();
    await upgradable(h);
    await h.gates.upgrade("reg" as PatchbayAgentId);
    expect(h.agents.config("reg" as PatchbayAgentId)?.link?.pinnedVersion).toBe("1.0.0");
    expect(h.row("reg" as PatchbayAgentId)?.status).toBe("running");
    expect(h.warnings()).toEqual([expect.stringContaining("the upgrade to 2.0.0 didn't start")]);
    await h.gates.stopAll();
  }, 120_000);
});

describe("the gates", () => {
  // A launch that downloads: the fake agent as a package from a registry
  // served here, its tarball held where a test plays a slow download.
  let packages: LocalNpmRegistry;
  beforeAll(async () => {
    packages = await npmRegistry(await fileTempDir("patchbay-agents-npm-"), { "patchbay-fake-agent": fakeAgentPackage() });
  }, 120_000);
  /** Settles once npm has asked for the package's tarball — the launch is
   * downloading now (the request the hold keeps waiting). */
  const downloading = async (before: number) =>
    vi.waitFor(() => expect(packages.tarballFetches("patchbay-fake-agent")).toBe(before + 1), { ...SETTLE, timeout: 60_000 });
  /** An agent launched from that registry — with an npm cache of the test's
   * own, so every launch downloads. */
  const downloaded = (id: string, over: Partial<AgentConfigView> = {}) =>
    fakeConfig(id, {}, {
      command: "npx",
      args: ["-y", "patchbay-fake-agent@1.0.0"],
      env: { ...packages.env, npm_config_cache: join(dir, "npm-cache"), FAKE_AGENT_SCRIPT: "{}" },
      ...over,
    });

  // #53: a chat started while its agent was still auto-connecting issued a
  // second connect, which the pool refused as "already connected".
  it("a connect asked for mid-launch joins the one under way — one spawn, no false failure (#53)", async () => {
    const h = harness();
    await h.saveAgent(downloaded("auto", { autoConnect: true }));
    const release = packages.hold("patchbay-fake-agent");
    const fetched = packages.tarballFetches("patchbay-fake-agent");
    const spawns = vi.spyOn(h.pool, "connect");

    const startup = h.gates.connect("auto" as PatchbayAgentId);
    await downloading(fetched);
    expect(h.pool.get("auto" as PatchbayAgentId)?.status).toBe("reconnecting");
    const chat = h.gates.connect("auto" as PatchbayAgentId);
    expect(h.row("auto" as PatchbayAgentId)?.busy).toEqual([{ kind: "connect" }]);
    release();

    await expect(chat).resolves.toBeUndefined();
    await startup;
    expect(spawns).toHaveBeenCalledTimes(1);
    expect(h.row("auto" as PatchbayAgentId)).toMatchObject({ status: "running", busy: [] });
    await h.gates.stopAll();
  }, 120_000);

  // #68: nothing tracked an upgrade while it ran — a second one asked again
  // and restarted the agent a second time.
  it("a second Upgrade while one is held joins it — one question, one outcome (#68)", async () => {
    const user = asking();
    const h = harness({ ports: { confirm: user.confirm } });
    await upgradable(h);
    await openConversation(h, "reg" as PatchbayAgentId);

    const first = h.gates.upgrade("reg" as PatchbayAgentId);
    const second = h.gates.upgrade("reg" as PatchbayAgentId);
    await vi.waitFor(() => expect(user.asked).toHaveLength(1), SETTLE);
    expect(user.asked[0]).toMatch(/1 open conversation/);
    expect(h.row("reg" as PatchbayAgentId)?.busy).toEqual([{ kind: "upgrade", to: "2.0.0" }]);
    // A chat asked for meanwhile waits its turn behind the upgrade.
    const chat = h.gates.connect("reg" as PatchbayAgentId);
    expect(h.row("reg" as PatchbayAgentId)?.busy).toEqual([{ kind: "upgrade", to: "2.0.0" }, { kind: "connect" }]);

    user.answer("Upgrade", false);
    await Promise.all([first, second, chat]);
    expect(user.asked).toHaveLength(1);
    // Declined: the agent runs as it was, and the chat's connect found it up.
    expect(h.row("reg" as PatchbayAgentId)).toMatchObject({ status: "running", busy: [], update: { from: "1.0.0", to: "2.0.0" } });
  });

  it("a held Reset or Back names the version it moves to on the row — declined, the agent runs as it was (#129)", async () => {
    const user = asking();
    const h = harness({ ports: { confirm: user.confirm } });
    await seedRegistry(h, { id: "reg", version: "2.0.0" });
    await h.saveAgent(fakeConfig("ed", {}, { origin: "reg", link: null }));
    await h.saveAgent(fakeConfig("up", {}, linked("reg", "2.0.0")));
    const previous = { distributionKind: "npx" as const, pinnedVersion: "1.0.0", distribution: { package: "reg@1.0.0", args: [], env: {} } };
    await h.deps.configs.upsert({ ...h.agents.config("up" as PatchbayAgentId)!, previous });
    for (const id of ["ed", "up"] as PatchbayAgentId[]) {
      await h.gates.connect(id);
      await openConversation(h, id);
    }

    const reset = h.gates.reset("ed" as PatchbayAgentId);
    const back = h.gates.goBack("up" as PatchbayAgentId);
    await vi.waitFor(() => expect(user.asked).toHaveLength(2), SETTLE);
    expect(h.row("ed" as PatchbayAgentId)?.busy).toEqual([{ kind: "reset", to: "2.0.0" }]);
    expect(h.row("up" as PatchbayAgentId)?.busy).toEqual([{ kind: "goBack", to: "1.0.0" }]);
    user.answer("Reset", false);
    user.answer("Take", false);
    await Promise.all([reset, back]);
    expect(h.row("ed" as PatchbayAgentId)).toMatchObject({ status: "running", busy: [] });
    expect(h.agents.config("up" as PatchbayAgentId)).toMatchObject({ link: { pinnedVersion: "2.0.0" }, previous });
    await h.gates.stopAll();
  });

  it("Stop never waits its turn, and an upgrade it stopped goes no further — the agent keeps its version", async () => {
    const user = asking();
    const h = harness({ ports: { confirm: user.confirm } });
    await upgradable(h);
    await openConversation(h, "reg" as PatchbayAgentId);

    const upgrade = h.gates.upgrade("reg" as PatchbayAgentId);
    await vi.waitFor(() => expect(user.asked).toHaveLength(1), SETTLE);
    const cut = expect(upgrade).rejects.toBeInstanceOf(Cancelled);
    const stop = h.gates.stop("reg" as PatchbayAgentId);
    // A conversation is open, so the Stop puts the one question too.
    await vi.waitFor(() => expect(user.asked).toHaveLength(2), SETTLE);
    expect(user.asked[1]).toBe("Stop Fake reg? It disconnects 1 open conversation.");
    user.answer("Stop", true);
    // The escape hatch reaches the agent whatever its queue holds.
    await vi.waitFor(() => expect(h.row("reg" as PatchbayAgentId)?.status).toBe("stopped"), SETTLE);
    await cut;
    expect(h.row("reg" as PatchbayAgentId)?.busy).toEqual([{ kind: "upgrade", to: "2.0.0" }, { kind: "stop" }]);
    // The upgrade's own question, still open, is answered yes: told to
    // stop, it saves no new pin and starts nothing.
    user.answer("Upgrade", true);
    await stop;
    expect(h.agents.config("reg" as PatchbayAgentId)?.link?.pinnedVersion).toBe("1.0.0");
    expect(h.row("reg" as PatchbayAgentId)).toMatchObject({ status: "stopped", busy: [] });
  });

  // Before Stop and Remove could reach a launch still downloading, Remove
  // finished launching an agent that no longer existed.
  it("Remove during a launch ends it: the removed agent never starts", async () => {
    const h = harness();
    await h.saveAgent(downloaded("doomed"));
    const release = packages.hold("patchbay-fake-agent");
    const fetched = packages.tarballFetches("patchbay-fake-agent");
    const connect = h.gates.connect("doomed" as PatchbayAgentId);
    await downloading(fetched);
    expect(h.pool.get("doomed" as PatchbayAgentId)?.status).toBe("reconnecting");
    const cut = expect(connect).rejects.toBeInstanceOf(Cancelled);

    await h.gates.remove("doomed" as PatchbayAgentId);
    await cut;
    // The download lands after all — and launches nothing: the cut connect
    // ended its download (npm with it), and nothing holds what it fetched.
    release();
    await new Promise((r) => setImmediate(r));
    expect(h.pool.get("doomed" as PatchbayAgentId)).toBeUndefined();
    expect(h.agents.config("doomed" as PatchbayAgentId)).toBeUndefined();
    expect(h.row("doomed" as PatchbayAgentId)).toBeUndefined();
    expect(h.events().some((e) => e.kind === "agentRemoved" && e.patchbayAgentId === "doomed")).toBe(true);
  }, 120_000);

  it("Stop during a launch ends it, and the next Connect starts afresh", async () => {
    const h = harness();
    await h.saveAgent(downloaded("slow"));
    packages.hold("patchbay-fake-agent"); // the first download never lands
    const fetched = packages.tarballFetches("patchbay-fake-agent");
    const connect = h.gates.connect("slow" as PatchbayAgentId);
    await downloading(fetched);
    expect(h.pool.get("slow" as PatchbayAgentId)?.status).toBe("reconnecting");
    const cut = expect(connect).rejects.toBeInstanceOf(Cancelled);

    await h.gates.stop("slow" as PatchbayAgentId);
    await cut;
    expect(h.row("slow" as PatchbayAgentId)).toMatchObject({ status: "stopped", busy: [] });
    await h.gates.connect("slow" as PatchbayAgentId);
    expect(h.row("slow" as PatchbayAgentId)?.status).toBe("running");
    await h.gates.stopAll();
  }, 120_000);

  /** A registry agent pinned at 0.9.0 whose registry now lists the fake
   * agent's package at 1.0.0 — an Upgrade that downloads and starts. */
  const upgradableTo100 = async (h: Harness, id: string, over: Partial<AgentConfigView> = {}) => {
    await seedRegistry(h, { id: "patchbay-fake-agent", version: "1.0.0" });
    const config = fakeConfig(id, {}, {
      env: downloaded(id).env,
      ...linked("patchbay-fake-agent", "0.9.0"),
      ...over,
    });
    await h.saveAgent(config);
    return config;
  };

  it("an Upgrade saves the new version once it has started, keeping the agent's own facts — its id, name, auto-connect and defaults (#125)", async () => {
    const h = harness();
    await upgradableTo100(h, "up", { name: "Work profile", autoConnect: true, defaults: { model: "fast" } });
    await h.gates.upgrade("up" as PatchbayAgentId);
    expect(h.agents.config("up" as PatchbayAgentId)).toMatchObject({
      name: "Work profile",
      autoConnect: true,
      defaults: { options: { model: "fast" } },
      command: "npx",
      origin: "patchbay-fake-agent",
      link: { pinnedVersion: "1.0.0" },
    });
    expect(h.deps.configs.list()).toHaveLength(1);
    expect(h.row("up" as PatchbayAgentId)).toMatchObject({ status: "running", busy: [] });
    expect(h.warnings()).toEqual([]);
    await h.gates.stopAll();
  }, 120_000);

  // An agent's error is read by its one reader: the reason an agent gives
  // rides its `data`, and the bare message ("Internal error") says nothing.
  it("a move that doesn't start says the agent's own reason — its error read whole (#129)", async () => {
    const h = harness();
    const reason = "process exited with code 1";
    await upgradableTo100(h, "rejects", {
      env: { ...downloaded("rejects").env, FAKE_AGENT_SCRIPT: JSON.stringify({ rejectInitialize: { code: -32603, message: "Internal error", data: reason } }) },
    });
    await h.gates.upgrade("rejects" as PatchbayAgentId);
    expect(h.warnings()).toEqual([expect.stringContaining(`didn't start — Internal error — ${reason}. It stays on 0.9.0.`)]);
    expect(h.agents.config("rejects" as PatchbayAgentId)?.link?.pinnedVersion).toBe("0.9.0");
  }, 120_000);

  // A Save doesn't wait its turn behind an Upgrade: one landing while the new
  // version downloads is the newer word.
  it("a launch edited while an Upgrade starts the new version keeps the edit — the upgrade saves nothing over it (#125)", async () => {
    const h = harness();
    const config = await upgradableTo100(h, "raced");
    const release = packages.hold("patchbay-fake-agent");
    const fetched = packages.tarballFetches("patchbay-fake-agent");
    const upgrade = h.gates.upgrade("raced" as PatchbayAgentId);
    await downloading(fetched);

    await h.agents.save(config, formatCommandLine(config.command, [...config.args, "--edited"]));
    release();
    await upgrade;
    expect(h.agents.config("raced" as PatchbayAgentId)).toMatchObject({
      command: config.command,
      args: [...config.args, "--edited"],
      link: null,
    });
    await h.gates.stopAll();
  }, 120_000);

  // #129: an upgrade couldn't be undone — the link it replaced was gone.
  // The old link here is the 0.9.0 pin with its recipe kept; the one package
  // the test registry serves stands in for both versions' packages.
  const kept = { package: "patchbay-fake-agent@1.0.0", args: [], env: {} };
  const keptLink = { distributionKind: "npx" as const, pinnedVersion: "0.9.0", distribution: kept };

  it("an Upgrade keeps the link it replaced; Back to previous runs it exactly, clears it, and the update is on offer again (#129)", async () => {
    const h = harness();
    await upgradableTo100(h, "undo", { link: keptLink });
    await h.gates.upgrade("undo" as PatchbayAgentId);
    expect(h.agents.config("undo" as PatchbayAgentId)).toMatchObject({ link: { pinnedVersion: "1.0.0" }, previous: keptLink });
    expect(h.state().agents.find((a) => a.id === "undo")?.version).toEqual({ pinned: "1.0.0", reported: expect.any(String) });

    await h.gates.goBack("undo" as PatchbayAgentId);
    expect(h.agents.config("undo" as PatchbayAgentId)).toMatchObject({
      command: "npx",
      args: ["-y", kept.package],
      origin: "patchbay-fake-agent",
      link: keptLink,
      previous: null,
    });
    expect(h.row("undo" as PatchbayAgentId)).toMatchObject({ status: "running", busy: [], update: { from: "0.9.0", to: "1.0.0" } });
    expect(h.warnings()).toEqual([]);
    await h.gates.stopAll();
  }, 120_000);

  it("an edited command clears the way back with the link — an edited agent goes back to the registry only by Reset (#129)", async () => {
    const h = harness();
    const config = await upgradableTo100(h, "edit", { link: keptLink });
    await h.deps.configs.upsert({ ...h.agents.config("edit" as PatchbayAgentId)!, previous: keptLink });
    await h.agents.save(config, formatCommandLine(config.command, [...config.args, "--own"]));
    expect(h.agents.config("edit" as PatchbayAgentId)).toMatchObject({ origin: "patchbay-fake-agent", link: null, previous: null });
    // nothing to go back to: the operation does nothing, says nothing
    await h.gates.goBack("edit" as PatchbayAgentId);
    expect(h.agents.config("edit" as PatchbayAgentId)?.args).toEqual([...config.args, "--own"]);
    expect(h.warnings()).toEqual([]);
  });

  it("Reset links an edited agent to the registry's current entry — its env stays the user's, what the recipe sets differently is said (#129)", async () => {
    const h = harness();
    await seedRegistry(h, { id: "patchbay-fake-agent", version: "1.0.0", env: { FAKE_AGENT_SCRIPT: "registry's", MODE: "acp" } });
    // edited: its origin kept, its own command running
    const config = fakeConfig("edited", {}, { env: downloaded("edited").env, origin: "patchbay-fake-agent", link: null });
    await h.saveAgent(config);
    await h.gates.reset("edited" as PatchbayAgentId);
    expect(h.agents.config("edited" as PatchbayAgentId)).toMatchObject({
      command: "npx",
      args: ["-y", "patchbay-fake-agent@1.0.0"],
      origin: "patchbay-fake-agent",
      link: { pinnedVersion: "1.0.0" },
      previous: null,
    });
    expect(h.row("edited" as PatchbayAgentId)).toMatchObject({ status: "running", busy: [] });
    expect(await h.deps.env.get("edited" as PatchbayAgentId)).toEqual(config.env);
    expect(h.warnings()).toEqual([
      "Fake edited 1.0.0: the ACP registry's env for this version differs — now sets FAKE_AGENT_SCRIPT=registry's (yours differs); now sets MODE=acp. Your env is unchanged; edit it in Settings › Agents to take any of this.",
    ]);
    await h.gates.stopAll();
  }, 120_000);

  // Reset and Back run through Upgrade's own path, its #125 rule with it.
  it("a Back whose version doesn't start leaves the agent where it was, its way back kept, and says why (#129)", async () => {
    const h = harness();
    await seedRegistry(h, { id: "reg", version: "2.0.0" });
    await h.saveAgent(fakeConfig("back", {}, { env: OFFLINE, ...linked("reg", "2.0.0") }));
    const previous = { distributionKind: "npx" as const, pinnedVersion: "1.0.0", distribution: { package: "reg@1.0.0", args: [], env: {} } };
    const before = { ...h.agents.config("back" as PatchbayAgentId)!, previous };
    await h.deps.configs.upsert(before);
    await h.gates.goBack("back" as PatchbayAgentId);
    expect(h.agents.config("back" as PatchbayAgentId)).toEqual(before);
    expect(h.warnings()).toEqual([expect.stringMatching(/^Fake back: going back to 1\.0\.0 didn't start — .+\. It stays on 2\.0\.0\.$/)]);
  }, 120_000);

  it("a Reset the registry can't serve leaves the agent as it is and says so (#129)", async () => {
    const h = harness();
    await seedRegistry(h, { id: "other", version: "1.0.0" });
    await h.saveAgent(fakeConfig("orphan", {}, { origin: "gone", link: null }));
    await h.gates.reset("orphan" as PatchbayAgentId);
    expect(h.agents.config("orphan" as PatchbayAgentId)).toMatchObject({ origin: "gone", link: null, command: process.execPath });
    expect(h.warnings()).toEqual(["Fake orphan: the ACP registry lists nothing this machine can run for it — it stays as it is."]);
  });

  // #126: on a machine with no Node of its own, the connect ran the agent on
  // the managed runtime while its Log in ran the configured launch — whose
  // `npx` names nothing there.
  it("a terminal login runs in the env the agent was launched in — the managed runtime's PATH with it (#126)", async () => {
    const handed: { command: string; args: string[]; env?: Record<string, string> }[] = [];
    const h = harness({ ports: { runLoginTask: async (_name, recipe) => (handed.push(recipe), 0) } });
    // The managed Node, already in the cache: this node and its npm in the
    // slot the launch phase installs to, laid out as the archive lays them
    // (`bin/` beside POSIX node, `.cmd` shims beside Windows node.exe), so
    // nothing is downloaded.
    const node = runtimeInstallSpec("node")!;
    const managedBin = dirname(join(h.paths.globalStorage, "bin-cache", node.distribution, node.version, node.cmd));
    await mkdir(managedBin, { recursive: true });
    const win = process.platform === "win32";
    const npmBin = join(dirname(process.execPath), win ? "" : "../lib", "node_modules/npm/bin");
    if (win) {
      await copyFile(process.execPath, join(managedBin, "node.exe"));
      for (const tool of ["npx", "npm"]) {
        await writeFile(join(managedBin, `${tool}.cmd`), `@"%~dp0node.exe" "${join(npmBin, `${tool}-cli.js`)}" %*\r\n`);
      }
    } else {
      await symlink(process.execPath, join(managedBin, "node"));
      for (const tool of ["npx", "npm"]) await symlink(join(npmBin, `${tool}-cli.js`), join(managedBin, tool));
    }
    // A system PATH with no Node on it — a shell still, as any machine has
    // (npm runs a package's scripts through `sh`; Windows reaches cmd.exe by
    // ComSpec).
    const bare = await fileTempDir("patchbay-no-node-");
    if (!win) await symlink("/bin/sh", join(bare, "sh"));
    const config = downloaded("nonode", {
      env: {
        ...downloaded("nonode").env,
        PATH: bare,
        FAKE_AGENT_SCRIPT: JSON.stringify({ authMethods: [{ id: "login", name: "Login", type: "terminal", args: ["--login"] }] }),
      },
    });
    await h.saveAgent(config);
    await h.gates.connect("nonode" as PatchbayAgentId);
    await h.gates.login("nonode" as PatchbayAgentId, "login");
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ command: win ? join(managedBin, "npx.cmd") : "npx", args: [...config.args, "--login"] });
    expect(handed[0]!.env?.PATH?.split(delimiter)).toEqual([managedBin, bare]);
    await h.gates.stopAll();
  }, 120_000);

  it("a terminal login holds the agent until its terminal reports an exit or is closed — the exit is evidence", async () => {
    let close: ((exitCode: number | undefined) => void) | undefined;
    const h = harness({
      ports: { runLoginTask: () => new Promise<number | undefined>((resolve) => (close = resolve)) },
    });
    await h.saveAgent(
      fakeConfig("tl", { authMethods: [{ id: "tl", name: "Terminal login", _meta: { "terminal-auth": { command: "fake-login" } } }] }),
    );
    await h.gates.connect("tl" as PatchbayAgentId);
    const login = h.gates.login("tl" as PatchbayAgentId, "tl");
    await vi.waitFor(() => expect(close).toBeDefined(), SETTLE);
    await vi.waitFor(() => expect(h.row("tl" as PatchbayAgentId)?.busy).toEqual([{ kind: "login" }]), SETTLE);

    close?.(1);
    await login;
    expect(h.agents.authLocked("tl" as PatchbayAgentId)).toBe(true);
    await h.gates.stopAll();
  });

  // What the login task is handed (#93). A typed terminal method is the
  // agent's own launch plus the method's args, whatever recipe rides along;
  // a recipe runs as the agent wrote it, over the agent's launch env — the
  // user's keys reach the login that writes the credentials they pair with.
  it("a typed terminal login runs the agent's own launch plus its args, never the recipe beside it", async () => {
    const handed: { command: string; args: string[]; env?: Record<string, string> }[] = [];
    const h = harness({ ports: { runLoginTask: async (_name, recipe) => (handed.push(recipe), 0) } });
    const config = fakeConfig("oc2", {
      authMethods: [
        { id: "login", name: "Login", type: "terminal", args: ["--login"], _meta: { "terminal-auth": { command: "opencode", args: ["auth", "login"] } } },
      ],
    });
    await h.saveAgent(config);
    await h.gates.connect("oc2" as PatchbayAgentId);
    await h.gates.login("oc2" as PatchbayAgentId, "login");
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ command: config.command, args: [...config.args, "--login"] });
    await h.gates.stopAll();
  });

  it("a recipe login runs as written, over the agent's launch env — the recipe's own env wins a clash", async () => {
    const handed: { command: string; args: string[]; env?: Record<string, string> }[] = [];
    const h = harness({ ports: { runLoginTask: async (_name, recipe) => (handed.push(recipe), 0) } });
    const config = fakeConfig(
      "oc1",
      { authMethods: [{ id: "login", name: "Login", _meta: { "terminal-auth": { command: "opencode", args: ["auth", "login"], env: { SHARED: "recipe" } } } }] },
    );
    await h.saveAgent({ ...config, env: { ...config.env, USER_KEY: "k-1", SHARED: "user" } });
    await h.gates.connect("oc1" as PatchbayAgentId);
    await h.gates.login("oc1" as PatchbayAgentId, "login");
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ command: "opencode", args: ["auth", "login"] });
    expect(handed[0]!.env).toMatchObject({ USER_KEY: "k-1", SHARED: "recipe" });
    await h.gates.stopAll();
  });

  // The login's terminal is the user's: a Stop stops waiting on it, never
  // closes it — the user may still finish the login there, or use it. The
  // return code is the login's only word, so it still counts when it comes.
  it("Stop stops waiting on a terminal login and leaves the terminal be — its return code still counts", async () => {
    let close: ((exitCode: number | undefined) => void) | undefined;
    const h = harness({
      // The login's terminal: open until the user is done with it.
      ports: { runLoginTask: () => new Promise<number | undefined>((resolve) => (close = resolve)) },
    });
    await h.saveAgent(
      fakeConfig("tl", { authMethods: [{ id: "tl", name: "Terminal login", _meta: { "terminal-auth": { command: "fake-login" } } }] }),
    );
    await h.gates.connect("tl" as PatchbayAgentId);
    const probes = vi.spyOn(h.tracker, "recheck");
    const restarts = vi.spyOn(h.pool, "restart");
    const login = h.gates.login("tl" as PatchbayAgentId, "tl");
    await vi.waitFor(() => expect(close).toBeDefined(), SETTLE);
    const cut = expect(login).rejects.toBeInstanceOf(Cancelled);

    // The terminal is still open; the Stop doesn't wait for it.
    await h.gates.stop("tl" as PatchbayAgentId);
    await cut;
    expect(h.row("tl" as PatchbayAgentId)).toMatchObject({ status: "stopped", busy: [] });
    // The user is done with it later, and its code is the login's result.
    // The probe and the restart that follow a login need the process the
    // stop ended: neither runs.
    close?.(1);
    await vi.waitFor(() => expect(h.agents.authLocked("tl" as PatchbayAgentId)).toBe(true), SETTLE);
    expect(probes).not.toHaveBeenCalled();
    expect(restarts).not.toHaveBeenCalled();
    expect(h.row("tl" as PatchbayAgentId)?.status).toBe("stopped");
  });
});
