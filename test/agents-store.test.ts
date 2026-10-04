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

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "patchbay-agents-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function fakeConfig(id: string, script: FakeAgentScript, over: Partial<AgentConfigView> = {}): AgentConfigView {
  return {
    id,
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
  await h.agents.save(
    fakeConfig("reg", {}, { registrySource: { registryId: "reg", distributionKind: "npx", pinnedVersion: "1.0.0" } }),
  );
  await h.agents.connect("reg");
}

/** Hooks with open work on the connection and a question the test answers. */
function asking() {
  const asked: string[] = [];
  let answer: ((yes: boolean) => void) | undefined;
  return {
    asked,
    answer: (yes: boolean) => answer?.(yes),
    hooks: {
      openWork: () => ({ conversations: 1, turns: 0 }),
      confirm: (message: string) => {
        asked.push(message);
        return new Promise<boolean>((resolve) => (answer = resolve));
      },
    },
  };
}

describe("agents store", () => {
  it("reads saved facts from the file when asked — another window's save shows at once", async () => {
    const kv = new MemoryKV();
    const h = agentsHarness(dir, { kv });
    await h.agents.save(fakeConfig("a", {}));
    expect(h.agents.name("a")).toBe("Fake a");
    // Another window, its own store over the same file, renames the agent.
    const elsewhere = new AgentConfigStore(kv);
    await elsewhere.upsert({ ...elsewhere.get("a")!, name: "Renamed", args: ["--other"] });
    expect(h.agents.name("a")).toBe("Renamed");
    expect(h.agents.spec("a")?.args).toEqual(["--other"]);
    await elsewhere.remove("a");
    expect(h.agents.spec("a")).toBeUndefined();
  });

  it("connects a saved agent with its env from SecretStorage, and records the version that answered", async () => {
    const h = agentsHarness(dir);
    await h.agents.save(fakeConfig("v", { version: "9.9.9" }));
    await h.agents.connect("v");

    expect(h.pool.get("v")?.status).toBe("running");
    expect(h.state().agents.find((a) => a.id === "v")?.status).toBe("running");
    // the script — and so the version — only reaches the process through the env
    await expect.poll(() => h.agents.config("v")?.lastSeenVersion).toBe("9.9.9");

    await h.agents.stop("v");
  });

  it("a crashed row carries the process's last words; a running one carries none", async () => {
    const h = agentsHarness(dir);
    // write-callback → exit: the last words are flushed before death
    const dying = ["-e", 'process.stderr.write("boom: config missing\\n", () => process.exit(1));'];
    await h.agents.save(fakeConfig("doomed", {}, { args: dying }));
    await expect(h.agents.connect("doomed")).rejects.toThrow();
    expect(h.row("doomed")?.status).toBe("crashed");
    expect(h.row("doomed")?.stderr?.join("\n")).toContain("boom: config missing");

    await h.agents.save(fakeConfig("doomed", {}));
    await h.agents.connect("doomed");
    expect(h.row("doomed")?.status).toBe("running");
    expect(h.row("doomed")?.stderr).toBeUndefined();
    await h.agents.stop("doomed");
  });

  it("the row's command is what runs while a process runs, and what Connect would run otherwise", async () => {
    const h = agentsHarness(dir);
    await h.agents.save(fakeConfig("cmd", {}));
    await h.agents.connect("cmd");
    const spawned = h.row("cmd")!.command;
    await h.agents.save(fakeConfig("cmd", {}, { args: [FAKE_AGENT, "--edited"] }));
    expect(h.row("cmd")!.command).toBe(spawned);
    await h.agents.stop("cmd");
    expect(h.row("cmd")!.command).toContain("--edited");
  });

  it("publishing sends every row before the config list waits on any env read — the first frame has every agent", async () => {
    const h = agentsHarness(dir);
    await h.agents.save(fakeConfig("first", {}));
    await h.agents.save(fakeConfig("second", {}));
    h.events.length = 0;
    const settled = h.agents.publishAll();
    // synchronously, before the env reads behind the config list resolve
    expect(h.state().agents.map((a) => a.id)).toEqual(["first", "second"]);
    expect(h.row("second")?.status).toBe("untested");
    await settled;
  });

  it("refuses to connect an agent with no saved config", async () => {
    const h = agentsHarness(dir);
    await expect(h.agents.connect("ghost")).rejects.toThrow("no saved launch configuration");
  });

  it("Remove stops the process, tells the sessions side, purges every saved fact and leaves the views", async () => {
    const h = agentsHarness(dir);
    await h.agents.save(fakeConfig("gone", {}));
    await h.agents.connect("gone");
    await h.deps.authLocks.upsert({
      id: "gone",
      lock: { kind: "authRequired", method: "session/new", reason: null, at: new Date().toISOString() },
    });
    h.agents.recordKnobs("gone", { mode: "code" });
    const probe = await h.agents.probeRoot("gone");

    await h.agents.remove("gone");

    expect(h.pool.get("gone")?.status).toBe("stopped");
    expect(h.removed).toEqual(["gone"]);
    expect(h.agents.config("gone")).toBeUndefined();
    expect(await h.deps.env.get("gone")).toEqual({});
    expect(h.agents.authLocked("gone")).toBe(false);
    expect(h.deps.composerKnobs.get("gone")).toBeUndefined();
    expect(h.deps.usedCapabilities.list().some((r) => r.id === "gone")).toBe(false);
    expect(existsSync(probe)).toBe(false);
    expect(h.state().agents.some((a) => a.id === "gone")).toBe(false);
  });

  it("auth evidence for an agent with no saved config writes nothing", () => {
    const h = agentsHarness(dir);
    h.agents.noteAuthWireFact("ghost", "session/new", "auth_required", new Date().toISOString(), "log in");
    expect(h.agents.authLocked("ghost")).toBe(false);
    expect(h.events.some((e) => e.kind === "agentUpserted" && e.agent.id === "ghost")).toBe(false);
  });

  it("startup opens the agents flagged auto-connect, and nothing else", async () => {
    const h = agentsHarness(dir);
    await h.agents.save(fakeConfig("auto", {}, { autoConnect: true }));
    await h.agents.save(fakeConfig("manual", {}));

    expect(await h.agents.startupSources("")).toEqual([{ configuredId: "auto" }]);
  });

  it("the old default-agent setting folds into the flag once — or names a registry agent not yet saved", async () => {
    const h = agentsHarness(dir);
    await h.agents.save(fakeConfig("legacy", {}));

    expect(await h.agents.startupSources("legacy")).toEqual([{ configuredId: "legacy" }]);
    expect(h.agents.config("legacy")?.autoConnect).toBe(true);
    expect(await h.agents.startupSources("from-registry")).toEqual([
      { configuredId: "legacy" },
      { registryId: "from-registry" },
    ]);
  });

  it("an Upgrade the registry can't serve asks nothing and leaves the agent as it is", async () => {
    const user = asking();
    const h = agentsHarness(dir, { hooks: user.hooks });
    await upgradable(h, [{ id: "other", version: "2.0.0" }]); // the registry no longer lists it

    await h.agents.upgrade("reg");
    expect(user.asked).toEqual([]);
    expect(h.row("reg")?.status).toBe("running");
    await h.agents.stop("reg");
  });

  it("an agent saved under an older id than the registry's is upgraded in place", async () => {
    // The launch can't run in a unit test — the pin moves all the same, and
    // the failed connect shows on the row as a crash would.
    const h = agentsHarness(dir, { resolveLaunch: () => Promise.reject(new Error("offline")) });
    await seedRegistry(h, { id: "reg", version: "2.0.0" });
    await h.agents.save(
      fakeConfig("legacy", {}, { registrySource: { registryId: "reg", distributionKind: "npx", pinnedVersion: "1.0.0" } }),
    );

    await h.agents.upgrade("legacy");
    expect(h.agents.config("legacy")?.registrySource?.pinnedVersion).toBe("2.0.0");
    expect(h.agents.config("reg")).toBeUndefined();
    expect(h.row("legacy")?.status).toBe("crashed");
  });
});

describe("the gates", () => {
  // #53: a chat started while its agent was still auto-connecting issued a
  // second connect, which the pool refused as "already connected".
  it("a connect asked for mid-launch joins the one under way — one spawn, no false failure (#53)", async () => {
    let release!: () => void;
    const download = new Promise<void>((resolve) => (release = resolve));
    const h = agentsHarness(dir, { resolveLaunch: async (spec) => (await download, spec) });
    await h.agents.save(fakeConfig("auto", {}, { autoConnect: true }));
    const spawns = vi.spyOn(h.pool, "connect");

    const startup = h.gates.connect("auto");
    await vi.waitFor(() => expect(h.pool.get("auto")?.status).toBe("reconnecting"));
    const chat = h.gates.connect("auto");
    expect(h.row("auto")?.busy).toEqual([{ kind: "connect" }]);
    release();

    await expect(chat).resolves.toBeUndefined();
    await startup;
    expect(spawns).toHaveBeenCalledTimes(1);
    expect(h.row("auto")).toMatchObject({ status: "running", busy: [] });
    await h.agents.stopAll();
  });

  // #68: nothing tracked an upgrade while it ran — a second one asked again
  // and restarted the agent a second time.
  it("a second Upgrade while one is held joins it — one question, one outcome (#68)", async () => {
    const user = asking();
    const h = agentsHarness(dir, { hooks: user.hooks });
    await upgradable(h);

    const first = h.gates.upgrade("reg");
    const second = h.gates.upgrade("reg");
    await vi.waitFor(() => expect(user.asked).toHaveLength(1));
    expect(user.asked[0]).toMatch(/1 open conversation/);
    expect(h.row("reg")?.busy).toEqual([{ kind: "upgrade", to: "2.0.0" }]);
    // A chat asked for meanwhile waits its turn behind the upgrade.
    const chat = h.gates.connect("reg");
    expect(h.row("reg")?.busy).toEqual([{ kind: "upgrade", to: "2.0.0" }, { kind: "connect" }]);

    user.answer(false);
    await Promise.all([first, second, chat]);
    expect(user.asked).toHaveLength(1);
    // Declined: the agent runs as it was, and the chat's connect found it up.
    expect(h.row("reg")).toMatchObject({ status: "running", busy: [], update: { from: "1.0.0", to: "2.0.0" } });
    await h.agents.stop("reg");
  });

  it("Stop never waits its turn, and an upgrade it stopped goes no further — the agent keeps its version", async () => {
    const user = asking();
    const h = agentsHarness(dir, { hooks: user.hooks });
    await upgradable(h);

    const upgrade = h.gates.upgrade("reg");
    await vi.waitFor(() => expect(user.asked).toHaveLength(1));
    const cut = expect(upgrade).rejects.toBeInstanceOf(Cancelled);
    const stop = h.gates.stop("reg");
    // The escape hatch reaches the agent whatever its queue holds.
    await vi.waitFor(() => expect(h.row("reg")?.status).toBe("stopped"));
    await cut;
    expect(h.row("reg")?.busy).toEqual([{ kind: "upgrade", to: "2.0.0" }, { kind: "stop" }]);
    // The question still open is answered yes: the upgrade, told to stop,
    // saves no new pin and starts nothing.
    user.answer(true);
    await stop;
    expect(h.agents.config("reg")?.registrySource?.pinnedVersion).toBe("1.0.0");
    expect(h.row("reg")).toMatchObject({ status: "stopped", busy: [] });
  });

  // Before Stop and Remove could reach a launch still downloading, Remove
  // finished launching an agent that no longer existed.
  it("Remove during a launch ends it: the removed agent never starts", async () => {
    let release!: () => void;
    const download = new Promise<void>((resolve) => (release = resolve));
    const h = agentsHarness(dir, { resolveLaunch: async (spec) => (await download, spec) });
    await h.agents.save(fakeConfig("doomed", {}));
    const connect = h.gates.connect("doomed");
    await vi.waitFor(() => expect(h.pool.get("doomed")?.status).toBe("reconnecting"));
    const cut = expect(connect).rejects.toBeInstanceOf(Cancelled);

    await h.gates.remove("doomed");
    await cut;
    // The download lands after all — and launches nothing.
    release();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.pool.get("doomed")?.status).toBe("stopped");
    expect(h.agents.config("doomed")).toBeUndefined();
    expect(h.row("doomed")).toBeUndefined();
    expect(h.removed).toEqual(["doomed"]);
  });

  it("Stop during a launch ends it, and the next Connect starts afresh", async () => {
    let hold: Promise<void> | null = new Promise<void>(() => {});
    const h = agentsHarness(dir, { resolveLaunch: async (spec) => (await hold, spec) });
    await h.agents.save(fakeConfig("slow", {}));
    const connect = h.gates.connect("slow");
    await vi.waitFor(() => expect(h.pool.get("slow")?.status).toBe("reconnecting"));
    const cut = expect(connect).rejects.toBeInstanceOf(Cancelled);

    await h.gates.stop("slow");
    await cut;
    expect(h.row("slow")).toMatchObject({ status: "stopped", busy: [] });
    hold = null;
    await h.gates.connect("slow");
    expect(h.row("slow")?.status).toBe("running");
    await h.agents.stopAll();
  });

  it("a terminal login holds the agent until its terminal reports an exit or is closed — the exit is evidence", async () => {
    let close: ((exitCode: number | undefined) => void) | undefined;
    const h = agentsHarness(dir, {
      hooks: { runLoginTask: () => new Promise<number | undefined>((resolve) => (close = resolve)) },
    });
    await h.agents.save(
      fakeConfig("tl", { authMethods: [{ id: "tl", name: "Terminal login", _meta: { "terminal-auth": { command: "fake-login" } } }] }),
    );
    await h.gates.connect("tl");
    const login = h.gates.login("tl", "tl");
    await vi.waitFor(() => expect(close).toBeDefined());
    await new Promise((r) => setTimeout(r, 50));
    expect(h.row("tl")?.busy).toEqual([{ kind: "login" }]);

    close?.(1);
    await login;
    expect(h.agents.authLocked("tl")).toBe(true);
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
    await h.agents.save(
      fakeConfig("tl", { authMethods: [{ id: "tl", name: "Terminal login", _meta: { "terminal-auth": { command: "fake-login" } } }] }),
    );
    await h.gates.connect("tl");
    const probes = vi.spyOn(h.tracker, "verify");
    const restarts = vi.spyOn(h.pool, "restart");
    const login = h.gates.login("tl", "tl");
    await vi.waitFor(() => expect(close).toBeDefined());
    const cut = expect(login).rejects.toBeInstanceOf(Cancelled);

    // The terminal is still open; the Stop doesn't wait for it.
    await h.gates.stop("tl");
    await cut;
    expect(h.row("tl")).toMatchObject({ status: "stopped", busy: [] });
    // The user is done with it later, and its code is the login's result.
    // The probe and the restart that follow a login need the process the
    // stop ended: neither runs.
    close?.(1);
    await vi.waitFor(() => expect(h.agents.authLocked("tl")).toBe(true));
    expect(probes).not.toHaveBeenCalled();
    expect(restarts).not.toHaveBeenCalled();
    expect(h.row("tl")?.status).toBe("stopped");
  });
});
