// The agents store over the real fake agent, minus vscode: saved facts are
// read from the file when asked (no copy to drift), a saved agent connects
// with its SecretStorage env, Remove purges every saved fact, auth evidence
// for an agent with no config writes nothing, and startup connects what this
// window should open with.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentConfigStore } from "../src/orchestrator/stores/agent-configs";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import type { AgentConfigView } from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { agentsHarness } from "./support/agents-harness";

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

describe("agents store", () => {
  it("reads saved facts from the file when asked — another window's save shows at once", async () => {
    const kv = new MemoryKV();
    const h = agentsHarness(dir, kv);
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

  it("startup connects the agents flagged auto-connect, and nothing else", async () => {
    const h = agentsHarness(dir);
    await h.agents.save(fakeConfig("auto", {}, { autoConnect: true }));
    await h.agents.save(fakeConfig("manual", {}));

    await h.agents.startup("");

    expect(h.pool.get("auto")?.status).toBe("running");
    expect(h.pool.get("manual")).toBeUndefined();
    await h.agents.stopAll();
  });
});
