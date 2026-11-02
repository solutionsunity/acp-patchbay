// Every window records what it spawns in one machine-wide registry, so what
// a crashed window left running is found by the next window to start. A
// record is a leftover only when the window that wrote it is gone: one
// still running owns its processes, and no other window ends them (#108).
// Real processes throughout: a stand-in idles for each agent and for each
// other window's extension host; this test's own process is this window's.
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { fakeAgent } from "./support/fake-agent";
import { IDLE, idler } from "./support/idler";
import { orchestratorHarness } from "./support/orchestrator-harness";
import { atTestEnd, tempDir } from "./support/teardown";
import { PROCESS_READS_TIMEOUT, SETTLE } from "./support/wait-for";
import { commandOf, commandsOf, killTree, trackedChild } from "../src/orchestrator/process-tree";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { type SpawnRecord, SpawnRegistryStore } from "../src/orchestrator/stores/spawn-registry";
import { STORAGE_KEYS } from "../src/orchestrator/stores/storage-keys";
import { formatCommandLine } from "../src/shared/command-line";
import type { PatchbayAgentId, PatchbaySessionId } from "../src/shared/ids";

vi.setConfig({ testTimeout: PROCESS_READS_TIMEOUT });

/** An idler, ended at the test's end, once it runs its own command line —
 * `spawn` fires after the exec, never on the parent's copy before it. */
async function running(marker: string): Promise<ChildProcess> {
  const child = idler(marker);
  atTestEnd(() => killTree(child, "SIGKILL"));
  await once(child, "spawn");
  return child;
}

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()));

/** A record as the window whose extension host is `owner` writes it. */
async function recordOf(child: ChildProcess, owner: number): Promise<SpawnRecord> {
  return (await recordsOf([[child, owner]]))[0]!;
}

/** Records for each `[process, owner]`, every command line read in one
 * call — on Windows each read is a PowerShell process. */
async function recordsOf(entries: [ChildProcess, number][]): Promise<SpawnRecord[]> {
  const lines = await commandsOf(entries.flatMap(([child, owner]) => [child.pid!, owner]));
  return entries.map(([child, owner]) => ({
    id: String(child.pid),
    pid: child.pid!,
    command: lines.get(child.pid!)!,
    kind: "agent",
    at: new Date().toISOString(),
    owner: { pid: owner, command: lines.get(owner)! },
  }));
}

describe("leftover processes at a window's start", () => {
  async function windowStarts(records: SpawnRecord[]) {
    const machineKV = new MemoryKV();
    await machineKV.update(STORAGE_KEYS.spawnRegistry, records);
    const h = orchestratorHarness(await tempDir("patchbay-spawns-"), { machineKV });
    await h.started;
    return h.orchestrator.spawnRegistry;
  }

  it("another window's running processes are its own: spared, their records kept — a gone window's are ended", async () => {
    const otherWindow = await running("patchbay-other-window");
    const goneWindow = await running("patchbay-gone-window");
    const theirs = await running("patchbay-other-windows-agent");
    const left = await running("patchbay-gone-windows-agent");
    const records = await recordsOf([[theirs, otherWindow.pid!], [left, goneWindow.pid!]]);
    killTree(goneWindow, "SIGKILL");
    await exited(goneWindow);
    const registry = await windowStarts(records);
    await exited(left); // the sweep has reached its kills
    expect(theirs.exitCode ?? theirs.signalCode).toBeNull();
    expect(registry.list().map((r) => r.pid)).toEqual([theirs.pid]);
  });

  it("a window whose host's pid now runs something else is gone", async () => {
    const somethingElse = await running("patchbay-not-a-window");
    const agent = await running("patchbay-reused-owners-agent");
    const record = { ...(await recordOf(agent, somethingElse.pid!)), owner: { pid: somethingElse.pid!, command: "code --type=extensionHost" } };
    const registry = await windowStarts([record]);
    await exited(agent);
    expect(registry.list()).toEqual([]);
    expect(somethingElse.exitCode ?? somethingElse.signalCode).toBeNull();
  });

  it("a record from before owners were recorded is no record: never swept", async () => {
    // Its window may still be running an older patchbay; whose it is can't
    // be told, so it is left alone.
    const agent = await running("patchbay-ownerless-agent");
    const goneWindow = await running("patchbay-gone-window");
    const left = await running("patchbay-gone-windows-agent");
    const [mine, theirs] = await recordsOf([[agent, process.pid], [left, goneWindow.pid!]]);
    const { owner: _, ...ownerless } = mine!;
    killTree(goneWindow, "SIGKILL");
    await exited(goneWindow);
    const registry = await windowStarts([ownerless as SpawnRecord, theirs!]);
    await exited(left); // the sweep has reached its kills
    expect(agent.exitCode ?? agent.signalCode).toBeNull();
    expect(registry.list()).toEqual([]);
  });

  it("a record from an earlier holder of this host's own pid is a leftover", async () => {
    // A window's extension host is a new process; a record naming its pid
    // was written by one that held the pid before it.
    const agent = await running("patchbay-earlier-holders-agent");
    const registry = await windowStarts([await recordOf(agent, process.pid)]);
    await exited(agent);
    expect(registry.list()).toEqual([]);
  });
});

describe("what a window spawns", () => {
  it("each agent it connects and each terminal it runs is recorded, and let go on its exit", async () => {
    const cwd = await tempDir("patchbay-spawns-");
    const h = orchestratorHarness(cwd);
    await h.started;
    const o = h.orchestrator;
    atTestEnd(() => o.clientHost.killAll()); // a terminal ends before its folder goes
    await o.pool.connect(fakeAgent({}, "tracked", cwd));
    await o.permissionRules.set({ commandRules: [{ kind: "command", pattern: `${formatCommandLine(process.execPath, [])} *`, verdict: "allow" }], writeScope: [] });
    await o.clientHost.createTerminal(
      { sessionId: "s", command: process.execPath, args: ["-e", IDLE], env: {} },
      { requester: { patchbaySessionId: "s" as PatchbaySessionId }, cwd },
    );
    await vi.waitFor(() => expect(o.spawnRegistry.list().map((r) => r.kind).sort()).toEqual(["agent", "terminal"]), SETTLE);
    await o.pool.stop("tracked" as PatchbayAgentId);
    o.clientHost.killAll();
    await vi.waitFor(() => expect(o.spawnRegistry.list()).toEqual([]), SETTLE);
  });
});

describe("SpawnRegistryStore", () => {
  it("records a spawn under this window's host and lets it go on its exit", async () => {
    const registry = new SpawnRegistryStore(new MemoryKV());
    const agent = await running("patchbay-tracked");
    await registry.track(trackedChild(agent)!, "agent");
    expect(registry.list()).toMatchObject([
      { pid: agent.pid, kind: "agent", owner: { pid: process.pid, command: await commandOf(process.pid) } },
    ]);
    killTree(agent, "SIGKILL");
    await vi.waitFor(() => expect(registry.list()).toEqual([]), SETTLE);
  });

  it("a process gone before its command line is read leaves no record", async () => {
    const registry = new SpawnRegistryStore(new MemoryKV());
    const agent = await running("patchbay-quick");
    const tracked = trackedChild(agent)!;
    killTree(agent, "SIGKILL");
    await exited(agent);
    await registry.track(tracked, "terminal");
    expect(registry.list()).toEqual([]);
  });

  it("an exit seen while the command line is read leaves no record", async () => {
    const registry = new SpawnRegistryStore(new MemoryKV());
    const agent = await running("patchbay-exit-mid-read");
    await registry.track({ pid: agent.pid!, running: () => false, onExit: () => {} }, "agent");
    expect(registry.list()).toEqual([]);
  });

  it("what this window tracks is its own, even when a sweep runs", async () => {
    const registry = new SpawnRegistryStore(new MemoryKV());
    const agent = await running("patchbay-own-during-sweep");
    await registry.track(trackedChild(agent)!, "agent");
    await registry.reapLeftovers();
    expect(agent.exitCode ?? agent.signalCode).toBeNull();
    expect(registry.list().map((r) => r.pid)).toEqual([agent.pid]);
  });

  it("a wipe takes this window's records and leaves another window's", async () => {
    const kv = new MemoryKV();
    const otherWindow = await running("patchbay-wipe-other-window");
    const theirs = await running("patchbay-wipe-theirs");
    const ours = await running("patchbay-wipe-ours");
    await kv.update(STORAGE_KEYS.spawnRegistry, await recordsOf([[theirs, otherWindow.pid!], [ours, process.pid]]));
    await new SpawnRegistryStore(kv).wipe();
    expect(new SpawnRegistryStore(kv).list().map((r) => r.pid)).toEqual([theirs.pid]);
  });
});
