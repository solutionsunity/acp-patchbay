// The agents store over the real fake agent, minus vscode: saved facts are
// read from the file when asked (no copy to drift), a saved agent connects
// with its SecretStorage env, Remove purges every saved fact, auth evidence
// for an agent with no config writes nothing, startup reads what this window
// opens with, and the gates put the connection operations through the
// queue — its holdings riding the row as busy — with Stop and Remove
// ending whatever it holds.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cancelled } from "../src/orchestrator/queue";
import { AgentConfigStore } from "../src/orchestrator/stores/agent-configs";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import type { AgentConfigView } from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { agentsHarness, type AgentsHarness } from "./support/agents-harness";
import type { PatchbayAgentId } from "../src/shared/ids";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "patchbay-agents-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function fakeConfig(id: string, script: FakeAgentScript, over: Partial<AgentConfigView> = {}): AgentConfigView {
  return {
    id: id as PatchbayAgentId,
    name: `Fake ${id}`,
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    autoConnect: false,
    defaults: {},
    registrySource: null,
    lastSeenVersion: null,
    ...over,
  };
}

/** An agent saved under a fixed id, as one stored before patchbay minted
 * ids keeps its own — so a test can name it. */
async function stored(h: AgentsHarness, config: AgentConfigView): Promise<void> {
  await h.deps.env.set(config.id, { ...config.env });
  await h.deps.configs.upsert({
    id: config.id,
    name: config.name,
    command: config.command,
    args: [...config.args],
    autoConnect: config.autoConnect,
    defaults: { options: { ...config.defaults } },
    registrySource: config.registrySource,
    lastSeenVersion: config.lastSeenVersion,
  });
  await h.agents.publishAll();
}

/** The shape of an id patchbay mints. */
const MINTED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The registry as its disk cache holds it, one npx agent per entry. */
async function seedRegistry(h: AgentsHarness, ...agents: { id: string; version: string }[]): Promise<void> {
  const raw = {
    version: "1.0.0",
    agents: agents.map((a) => ({ ...a, name: a.id, distribution: { npx: { package: `${a.id}@${a.version}` } } })),
  };
  await mkdir(join(dir, "registry"), { recursive: true });
  await writeFile(
    join(dir, "registry", "acp-registry-cache.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), etag: null, raw, icons: {} }),
  );
  await h.deps.registry.load();
}

/** A running registry agent pinned at 1.0.0 — by default with 2.0.0 on
 * offer; `listed` is what the registry lists instead. */
async function upgradable(h: AgentsHarness, listed = [{ id: "reg", version: "2.0.0" }]): Promise<void> {
  await seedRegistry(h, ...listed);
  await stored(h, 
    fakeConfig("reg", {}, { registrySource: { registryId: "reg", distributionKind: "npx", pinnedVersion: "1.0.0" } }),
  );
  await h.agents.connect("reg" as PatchbayAgentId);
}

/** The gates' asks with open work on the connection, and questions the
 * test answers — each by how it starts. */
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
    asks: {
      openWork: () => ({ conversations: 1, turns: 0 }),
      confirm: (message: string) => {
        asked.push(message);
        return new Promise<boolean>((resolve) => open.set(message, resolve));
      },
    },
  };
}

describe("agents store", () => {
  it("reads saved facts from the file when asked — another window's save shows at once", async () => {
    const kv = new MemoryKV();
    const h = agentsHarness(dir, { kv });
    await stored(h, fakeConfig("a", {}));
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
    const h = agentsHarness(dir);
    await stored(h, fakeConfig("v", { version: "9.9.9" }));
    await h.agents.connect("v" as PatchbayAgentId);

    expect(h.pool.get("v" as PatchbayAgentId)?.status).toBe("running");
    expect(h.state().agents.find((a) => a.id === "v")?.status).toBe("running");
    // the script — and so the version — only reaches the process through the env
    await expect.poll(() => h.agents.config("v" as PatchbayAgentId)?.lastSeenVersion).toBe("9.9.9");

    await h.agents.stop("v" as PatchbayAgentId);
  });

  it("a crashed row carries the process's last words; a running one carries none", async () => {
    const h = agentsHarness(dir);
    // write-callback → exit: the last words are flushed before death
    const dying = ["-e", 'process.stderr.write("boom: config missing\\n", () => process.exit(1));'];
    await stored(h, fakeConfig("doomed", {}, { args: dying }));
    await expect(h.agents.connect("doomed" as PatchbayAgentId)).rejects.toThrow();
    expect(h.row("doomed" as PatchbayAgentId)?.status).toBe("crashed");
    expect(h.row("doomed" as PatchbayAgentId)?.stderr?.join("\n")).toContain("boom: config missing");

    await h.agents.save(fakeConfig("doomed", {}));
    await h.agents.connect("doomed" as PatchbayAgentId);
    expect(h.row("doomed" as PatchbayAgentId)?.status).toBe("running");
    expect(h.row("doomed" as PatchbayAgentId)?.stderr).toBeUndefined();
    await h.agents.stop("doomed" as PatchbayAgentId);
  });

  it("the row's command is what runs while a process runs, and what Connect would run otherwise", async () => {
    const h = agentsHarness(dir);
    await stored(h, fakeConfig("cmd", {}));
    await h.agents.connect("cmd" as PatchbayAgentId);
    const spawned = h.row("cmd" as PatchbayAgentId)!.command;
    await h.agents.save(fakeConfig("cmd", {}, { args: [FAKE_AGENT, "--edited"] }));
    expect(h.row("cmd" as PatchbayAgentId)!.command).toBe(spawned);
    await h.agents.stop("cmd" as PatchbayAgentId);
    expect(h.row("cmd" as PatchbayAgentId)!.command).toContain("--edited");
  });

  it("publishing sends every row before the config list waits on any env read — the first frame has every agent", async () => {
    const h = agentsHarness(dir);
    await stored(h, fakeConfig("first", {}));
    await stored(h, fakeConfig("second", {}));
    h.events.length = 0;
    const settled = h.agents.publishAll();
    // synchronously, before the env reads behind the config list resolve
    expect(h.state().agents.map((a) => a.id)).toEqual(["first", "second"]);
    expect(h.row("second" as PatchbayAgentId)?.status).toBe("untested");
    await settled;
  });

  it("refuses to connect an agent with no saved config", async () => {
    const h = agentsHarness(dir);
    await expect(h.agents.connect("ghost" as PatchbayAgentId)).rejects.toThrow("no saved launch configuration");
  });

  it("Remove stops the process, tells the sessions side, purges every saved fact, lets go of its live state and leaves the views", async () => {
    const h = agentsHarness(dir);
    await stored(h, fakeConfig("gone", {}));
    await h.agents.connect("gone" as PatchbayAgentId);
    await h.deps.authLocks.upsert({
      id: "gone" as PatchbayAgentId,
      lock: { kind: "authRequired", method: "session/new", reason: null, at: new Date().toISOString() },
    });
    h.agents.recordKnobs("gone" as PatchbayAgentId, { mode: "code" });
    const probe = await h.agents.probeRoot("gone" as PatchbayAgentId);

    await h.agents.remove("gone" as PatchbayAgentId);

    // The pool lets go only of a process that is down.
    expect(h.pool.get("gone" as PatchbayAgentId)).toBeUndefined();
    expect(h.tracker.matrix("gone" as PatchbayAgentId)).toBeUndefined();
    expect(h.removed).toEqual(["gone"]);
    expect(h.agents.config("gone" as PatchbayAgentId)).toBeUndefined();
    expect(await h.deps.env.get("gone")).toEqual({});
    expect(h.agents.authLocked("gone" as PatchbayAgentId)).toBe(false);
    expect(h.deps.composerKnobs.get("gone" as PatchbayAgentId)).toBeUndefined();
    expect(h.deps.usedCapabilities.list().some((r) => r.id === "gone")).toBe(false);
    expect(existsSync(probe)).toBe(false);
    expect(h.state().agents.some((a) => a.id === "gone")).toBe(false);
  });

  it("auth evidence for an agent with no saved config writes nothing", () => {
    const h = agentsHarness(dir);
    h.agents.noteAuthWireFact("ghost" as PatchbayAgentId, "session/new", "auth_required", new Date().toISOString(), "log in");
    expect(h.agents.authLocked("ghost" as PatchbayAgentId)).toBe(false);
    expect(h.events.some((e) => e.kind === "agentUpserted" && e.agent.id === "ghost")).toBe(false);
  });

  it("startup opens the agents flagged auto-connect, and nothing else", async () => {
    const h = agentsHarness(dir);
    await stored(h, fakeConfig("auto", {}, { autoConnect: true }));
    await stored(h, fakeConfig("manual", {}));

    expect(await h.agents.startupSources("")).toEqual([{ patchbayAgentId: "auto" }]);
  });

  it("the old default-agent setting folds into the flag once — or names a registry agent not yet saved", async () => {
    const h = agentsHarness(dir);
    await stored(h, fakeConfig("legacy", {}));

    expect(await h.agents.startupSources("legacy")).toEqual([{ patchbayAgentId: "legacy" }]);
    expect(h.agents.config("legacy" as PatchbayAgentId)?.autoConnect).toBe(true);
    expect(await h.agents.startupSources("from-registry")).toEqual([
      { patchbayAgentId: "legacy" },
      { registryId: "from-registry" },
    ]);
  });

  it("a saved config for an agent the store doesn't hold is added under an id the store mints — a view never chooses one", async () => {
    const h = agentsHarness(dir);
    await h.agents.save(fakeConfig("chosen", {}));
    expect(h.agents.config("chosen" as PatchbayAgentId)).toBeUndefined();
    const [added] = h.deps.configs.list();
    expect(added?.id).toMatch(MINTED);
    expect(added?.name).toBe("Fake chosen");
    expect(await h.deps.env.get(added!.id)).toEqual(fakeConfig("chosen", {}).env);
  });

  it("one executable added twice is two agents — ids patchbay minted, numbered names, neither overwrites the other (#51)", async () => {
    const h = agentsHarness(dir);
    const first = await h.agents.saveFrom({ command: "npx foo acp" });
    const second = await h.agents.saveFrom({ command: "npx bar acp" });
    expect(first).toMatch(MINTED);
    expect(second).toMatch(MINTED);
    expect(second).not.toBe(first);
    expect(h.agents.config(first!)).toMatchObject({ name: "npx", command: "npx", args: ["foo", "acp"] });
    expect(h.agents.config(second!)).toMatchObject({ name: "npx 2", command: "npx", args: ["bar", "acp"] });
  });

  it("one registry entry added twice is two agents, each linked to the entry by its registry id", async () => {
    const h = agentsHarness(dir);
    await seedRegistry(h, { id: "reg", version: "1.0.0" });
    const added = [await h.agents.saveFrom({ registryId: "reg" }), await h.agents.saveFrom({ registryId: "reg" })];
    expect(added[1]).not.toBe(added[0]);
    expect(added.map((id) => h.agents.config(id!)?.registrySource?.registryId)).toEqual(["reg", "reg"]);
    expect(added.map((id) => h.agents.name(id!))).toEqual(["reg", "reg 2"]);
  });

  it("a value folded once is never folded again — the flag switched off afterwards stays off", async () => {
    const h = agentsHarness(dir);
    await stored(h, fakeConfig("legacy", {}));
    await h.agents.startupSources("legacy");
    expect(h.agents.config("legacy" as PatchbayAgentId)?.autoConnect).toBe(true);
    await h.agents.save(fakeConfig("legacy", {}, { autoConnect: false })); // the user switches it off
    expect(await h.agents.startupSources("legacy")).toEqual([]);
    expect(h.agents.config("legacy" as PatchbayAgentId)?.autoConnect).toBe(false);
  });

  it("the old default-agent setting naming a registry entry adds its agent once — the next start finds it by its registry id", async () => {
    const h = agentsHarness(dir);
    await seedRegistry(h, { id: "reg", version: "1.0.0" });
    expect(await h.agents.startupSources("reg")).toEqual([{ registryId: "reg" }]);
    const added = await h.agents.saveFrom({ registryId: "reg" }); // the startup connect's save
    expect(await h.agents.startupSources("reg")).toEqual([{ patchbayAgentId: added }]);
    expect(h.agents.config(added!)?.autoConnect).toBe(true);
    expect(h.deps.configs.list()).toHaveLength(1);
  });

  it("an Upgrade the registry can't serve asks nothing and leaves the agent as it is", async () => {
    const user = asking();
    const h = agentsHarness(dir, { asks: user.asks });
    await upgradable(h, [{ id: "other", version: "2.0.0" }]); // the registry no longer lists it

    await h.agents.upgrade("reg" as PatchbayAgentId);
    expect(user.asked).toEqual([]);
    expect(h.row("reg" as PatchbayAgentId)?.status).toBe("running");
    await h.agents.stop("reg" as PatchbayAgentId);
  });

  it("an Upgrade moves the pin in place and keeps the agent's own facts — its id, name, auto-connect and defaults", async () => {
    // The launch can't run in a unit test — the pin moves all the same, and
    // the failed connect shows on the row as a crash would.
    const h = agentsHarness(dir, { resolveLaunch: () => Promise.reject(new Error("offline")) });
    await seedRegistry(h, { id: "reg", version: "2.0.0" });
    await stored(h, 
      fakeConfig("mine", {}, {
        name: "Work profile",
        autoConnect: true,
        defaults: { model: "fast" },
        registrySource: { registryId: "reg", distributionKind: "npx", pinnedVersion: "1.0.0" },
      }),
    );

    await h.agents.upgrade("mine" as PatchbayAgentId);
    expect(h.agents.config("mine" as PatchbayAgentId)).toMatchObject({
      name: "Work profile",
      autoConnect: true,
      defaults: { options: { model: "fast" } },
      registrySource: { registryId: "reg", pinnedVersion: "2.0.0" },
    });
    expect(h.deps.configs.list()).toHaveLength(1);
    expect(h.row("mine" as PatchbayAgentId)?.status).toBe("crashed");
  });
});

describe("the gates", () => {
  // #53: a chat started while its agent was still auto-connecting issued a
  // second connect, which the pool refused as "already connected".
  it("a connect asked for mid-launch joins the one under way — one spawn, no false failure (#53)", async () => {
    let release!: () => void;
    const download = new Promise<void>((resolve) => (release = resolve));
    const h = agentsHarness(dir, { resolveLaunch: async (spec) => (await download, spec) });
    await stored(h, fakeConfig("auto", {}, { autoConnect: true }));
    const spawns = vi.spyOn(h.pool, "connect");

    const startup = h.gates.connect("auto" as PatchbayAgentId);
    await vi.waitFor(() => expect(h.pool.get("auto" as PatchbayAgentId)?.status).toBe("reconnecting"));
    const chat = h.gates.connect("auto" as PatchbayAgentId);
    expect(h.row("auto" as PatchbayAgentId)?.busy).toEqual([{ kind: "connect" }]);
    release();

    await expect(chat).resolves.toBeUndefined();
    await startup;
    expect(spawns).toHaveBeenCalledTimes(1);
    expect(h.row("auto" as PatchbayAgentId)).toMatchObject({ status: "running", busy: [] });
    await h.agents.stopAll();
  });

  // #68: nothing tracked an upgrade while it ran — a second one asked again
  // and restarted the agent a second time.
  it("a second Upgrade while one is held joins it — one question, one outcome (#68)", async () => {
    const user = asking();
    const h = agentsHarness(dir, { asks: user.asks });
    await upgradable(h);

    const first = h.gates.upgrade("reg" as PatchbayAgentId);
    const second = h.gates.upgrade("reg" as PatchbayAgentId);
    await vi.waitFor(() => expect(user.asked).toHaveLength(1));
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
    await h.agents.stop("reg" as PatchbayAgentId);
  });

  it("Stop never waits its turn, and an upgrade it stopped goes no further — the agent keeps its version", async () => {
    const user = asking();
    const h = agentsHarness(dir, { asks: user.asks });
    await upgradable(h);

    const upgrade = h.gates.upgrade("reg" as PatchbayAgentId);
    await vi.waitFor(() => expect(user.asked).toHaveLength(1));
    const cut = expect(upgrade).rejects.toBeInstanceOf(Cancelled);
    const stop = h.gates.stop("reg" as PatchbayAgentId);
    // A conversation is open, so the Stop puts the one question too.
    await vi.waitFor(() => expect(user.asked).toHaveLength(2));
    expect(user.asked[1]).toBe("Stop Fake reg? It disconnects 1 open conversation.");
    user.answer("Stop", true);
    // The escape hatch reaches the agent whatever its queue holds.
    await vi.waitFor(() => expect(h.row("reg" as PatchbayAgentId)?.status).toBe("stopped"));
    await cut;
    expect(h.row("reg" as PatchbayAgentId)?.busy).toEqual([{ kind: "upgrade", to: "2.0.0" }, { kind: "stop" }]);
    // The upgrade's own question, still open, is answered yes: told to
    // stop, it saves no new pin and starts nothing.
    user.answer("Upgrade", true);
    await stop;
    expect(h.agents.config("reg" as PatchbayAgentId)?.registrySource?.pinnedVersion).toBe("1.0.0");
    expect(h.row("reg" as PatchbayAgentId)).toMatchObject({ status: "stopped", busy: [] });
  });

  // Before Stop and Remove could reach a launch still downloading, Remove
  // finished launching an agent that no longer existed.
  it("Remove during a launch ends it: the removed agent never starts", async () => {
    let release!: () => void;
    const download = new Promise<void>((resolve) => (release = resolve));
    const h = agentsHarness(dir, { resolveLaunch: async (spec) => (await download, spec) });
    await stored(h, fakeConfig("doomed", {}));
    const connect = h.gates.connect("doomed" as PatchbayAgentId);
    await vi.waitFor(() => expect(h.pool.get("doomed" as PatchbayAgentId)?.status).toBe("reconnecting"));
    const cut = expect(connect).rejects.toBeInstanceOf(Cancelled);

    await h.gates.remove("doomed" as PatchbayAgentId);
    await cut;
    // The download lands after all — and launches nothing.
    release();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.pool.get("doomed" as PatchbayAgentId)).toBeUndefined();
    expect(h.agents.config("doomed" as PatchbayAgentId)).toBeUndefined();
    expect(h.row("doomed" as PatchbayAgentId)).toBeUndefined();
    expect(h.removed).toEqual(["doomed"]);
  });

  it("Stop during a launch ends it, and the next Connect starts afresh", async () => {
    let hold: Promise<void> | null = new Promise<void>(() => {});
    const h = agentsHarness(dir, { resolveLaunch: async (spec) => (await hold, spec) });
    await stored(h, fakeConfig("slow", {}));
    const connect = h.gates.connect("slow" as PatchbayAgentId);
    await vi.waitFor(() => expect(h.pool.get("slow" as PatchbayAgentId)?.status).toBe("reconnecting"));
    const cut = expect(connect).rejects.toBeInstanceOf(Cancelled);

    await h.gates.stop("slow" as PatchbayAgentId);
    await cut;
    expect(h.row("slow" as PatchbayAgentId)).toMatchObject({ status: "stopped", busy: [] });
    hold = null;
    await h.gates.connect("slow" as PatchbayAgentId);
    expect(h.row("slow" as PatchbayAgentId)?.status).toBe("running");
    await h.agents.stopAll();
  });

  it("a terminal login holds the agent until its terminal reports an exit or is closed — the exit is evidence", async () => {
    let close: ((exitCode: number | undefined) => void) | undefined;
    const h = agentsHarness(dir, {
      hooks: { runLoginTask: () => new Promise<number | undefined>((resolve) => (close = resolve)) },
    });
    await stored(h, 
      fakeConfig("tl", { authMethods: [{ id: "tl", name: "Terminal login", _meta: { "terminal-auth": { command: "fake-login" } } }] }),
    );
    await h.gates.connect("tl" as PatchbayAgentId);
    const login = h.gates.login("tl" as PatchbayAgentId, "tl");
    await vi.waitFor(() => expect(close).toBeDefined());
    await new Promise((r) => setTimeout(r, 50));
    expect(h.row("tl" as PatchbayAgentId)?.busy).toEqual([{ kind: "login" }]);

    close?.(1);
    await login;
    expect(h.agents.authLocked("tl" as PatchbayAgentId)).toBe(true);
    await h.agents.stopAll();
  });

  // The login's terminal is the user's: a Stop stops waiting on it, never
  // closes it — the user may still finish the login there, or use it. The
  // return code is the login's only word, so it still counts when it comes.
  it("Stop stops waiting on a terminal login and leaves the terminal be — its return code still counts", async () => {
    let close: ((exitCode: number | undefined) => void) | undefined;
    const h = agentsHarness(dir, {
      // The login's terminal: open until the user is done with it.
      hooks: { runLoginTask: () => new Promise<number | undefined>((resolve) => (close = resolve)) },
    });
    await stored(h, 
      fakeConfig("tl", { authMethods: [{ id: "tl", name: "Terminal login", _meta: { "terminal-auth": { command: "fake-login" } } }] }),
    );
    await h.gates.connect("tl" as PatchbayAgentId);
    const probes = vi.spyOn(h.tracker, "verify");
    const restarts = vi.spyOn(h.pool, "restart");
    const login = h.gates.login("tl" as PatchbayAgentId, "tl");
    await vi.waitFor(() => expect(close).toBeDefined());
    const cut = expect(login).rejects.toBeInstanceOf(Cancelled);

    // The terminal is still open; the Stop doesn't wait for it.
    await h.gates.stop("tl" as PatchbayAgentId);
    await cut;
    expect(h.row("tl" as PatchbayAgentId)).toMatchObject({ status: "stopped", busy: [] });
    // The user is done with it later, and its code is the login's result.
    // The probe and the restart that follow a login need the process the
    // stop ended: neither runs.
    close?.(1);
    await vi.waitFor(() => expect(h.agents.authLocked("tl" as PatchbayAgentId)).toBe(true));
    expect(probes).not.toHaveBeenCalled();
    expect(restarts).not.toHaveBeenCalled();
    expect(h.row("tl" as PatchbayAgentId)?.status).toBe("stopped");
  });
});
