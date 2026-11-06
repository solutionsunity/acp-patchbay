// What a failed step leaves behind, on the window's own orchestrator: the
// step that failed is said, and what didn't depend on it still happens. A
// page never stays waiting on work that has ended, and one bad record costs
// that record.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AgentConfigStore, type AgentConfig } from "../src/orchestrator/stores/agent-configs";
import { parseLines } from "../src/mcp/ipc-protocol";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { McpServerConfigStore, type McpServerConfig } from "../src/orchestrator/stores/mcp-server-configs";
import { MemorySecrets } from "../src/orchestrator/stores/mcp-server-tokens";
import { SECRET_FAMILIES, STORAGE_KEYS } from "../src/orchestrator/stores/storage-keys";
import type { PatchbayAgentId, PatchbayMcpServerId } from "../src/shared/ids";
import { orchestratorHarness } from "./support/orchestrator-harness";
import { tempDir } from "./support/teardown";
import { waitFor } from "./support/wait-for";

/** A machine whose disk refuses the keys named. */
class RefusingKV extends MemoryKV {
  readonly refused = new Set<string>();
  override update(key: string, value: unknown): Thenable<void> {
    return this.refused.has(key) ? Promise.reject(new Error("disk full")) : super.update(key, value);
  }
}

/** A secret store that can't be read. */
class UnreadableSecrets extends MemorySecrets {
  override get(): Thenable<string | undefined> {
    return Promise.reject(new Error("keyring locked"));
  }
}

const AGENT: AgentConfig = {
  id: "a" as PatchbayAgentId,
  name: "A",
  command: "a",
  args: [],
  autoConnect: false,
  defaults: {},
  origin: null,
  link: null,
  previous: null,
  lastSeenVersion: null,
};

const SERVER = "oauth-server" as PatchbayMcpServerId;

const OAUTH_SERVER: McpServerConfig = {
  id: SERVER,
  name: "OAuth server",
  source: { kind: "custom-http", url: "https://mcp.example.test", oauth: true },
  routing: "auto",
  transport: "auto",
  workspaces: "auto",
};

const secretsRow = (rows: readonly { id: string; detail: string }[] | null) => rows?.find((r) => r.id === "secrets")?.detail;

describe("a window's start", () => {
  it("a leftover process that can't be struck from the record still leaves the agents to connect", async () => {
    const machineKV = new RefusingKV();
    // Its process and its window are both long gone.
    await machineKV.update(STORAGE_KEYS.spawnRegistry, [
      { id: "1", pid: 2 ** 30, command: "gone", kind: "agent", at: "2026-01-01T00:00:00.000Z", owner: { pid: 2 ** 30 + 1, command: "gone too" } },
    ]);
    machineKV.refused.add(STORAGE_KEYS.spawnRegistry);
    const connectStartupAgents = vi.fn(async () => {});
    const h = orchestratorHarness(await tempDir("patchbay-failure-"), { machineKV, ports: { connectStartupAgents } });

    await h.started;

    expect(connectStartupAgents).toHaveBeenCalledOnce();
  });

  it("startup agents that fail to connect are said, and the loading page still ends", async () => {
    const connectStartupAgents = vi.fn(async () => Promise.reject(new Error("no")));
    const h = orchestratorHarness(await tempDir("patchbay-failure-"), { ports: { connectStartupAgents } });

    await h.started;

    await waitFor(() => h.asked.some((a) => a.port === "warnCatch" && a.args[0] === "startup agents"));
    expect(h.agentView.events().some((e) => e.kind === "startupSettled")).toBe(true);
  });

  it("secrets that can't be read are said, not left as lists that never arrive", async () => {
    const machineKV = new MemoryKV();
    await new AgentConfigStore(machineKV).upsert(AGENT);
    await new McpServerConfigStore(machineKV).upsert(OAUTH_SERVER);

    const h = orchestratorHarness(await tempDir("patchbay-failure-"), { machineKV, secrets: new UnreadableSecrets() });
    await h.started;

    await waitFor(() => {
      const said = h.asked.filter((a) => a.port === "warnCatch").map((a) => a.args[0]);
      return said.includes("agents list") && said.includes("MCP server list");
    });
    expect(h.agentView.events().some((e) => e.kind === "startupSettled")).toBe(true);
  });
});

describe("a line on the window's IPC socket", () => {
  it("that can't be read costs that line: what follows still reads", () => {
    expect(parseLines('not json\n{"id":1}\n{"id"')).toEqual({ messages: [{ id: 1 }], rest: '{"id"' });
  });
});

describe("the Data page's storage inventory", () => {
  it("states secrets it can't read, and still lists every store", async () => {
    const h = orchestratorHarness(await tempDir("patchbay-failure-"), { secrets: new UnreadableSecrets() });
    await h.stores.agentConfigs.upsert(AGENT);

    await h.orchestrator.publishDataInventory();

    const rows = h.settings.state().dataInventory;
    expect(secretsRow(rows)).toContain("keyring locked");
    expect(rows?.length).toBeGreaterThan(1);
  });
});

describe("a malformed stored token", () => {
  async function withBadToken(value: string) {
    const secrets = new MemorySecrets();
    const h = orchestratorHarness(await tempDir("patchbay-failure-"), { secrets });
    await h.stores.mcpServerConfigs.upsert(OAUTH_SERVER);
    await secrets.store(`${SECRET_FAMILIES.mcpServer}.${SERVER}.token`, value);
    return h;
  }

  it.each([
    ["isn't JSON", "not json"],
    ["isn't a token", '{"nope":1}'],
  ])("%s: it reads as no token, and both pages still publish", async (_case, value) => {
    const h = await withBadToken(value);

    expect(await h.stores.mcpServerTokens.get(SERVER)).toBeNull();
    await h.orchestrator.mcpServers.refresh();
    await h.orchestrator.publishDataInventory();

    expect(h.settings.state().mcpServers.map((s) => s.id)).toContain(SERVER);
    expect(secretsRow(h.settings.state().dataInventory)).toContain("0 OAuth tokens");
  });
});

describe("an import that fails where it stands", () => {
  async function reviewed() {
    const text = await readFile(fileURLToPath(new URL("./goldens/configuration.2026-10-13.json", import.meta.url)), "utf8");
    const h = orchestratorHarness(await tempDir("patchbay-failure-"));
    await h.orchestrator.readConfigImport("config.json", text);
    const review = h.settings.state().configImport;
    if (review?.stage !== "review") throw new Error("the file wasn't read");
    return { h, importId: review.id, take: review.items.map((i) => i.id) };
  }

  it("processes that can't be stopped end it unapplied, and say so", async () => {
    const { h, importId, take } = await reviewed();
    vi.spyOn(h.orchestrator.agents, "stampRunning").mockRejectedValue(new Error("disk full"));

    await h.orchestrator.applyConfigImport(importId, take);

    const outcome = h.settings.state().configImport;
    expect(outcome).toMatchObject({ stage: "applied", landed: 0 });
    expect(outcome?.stage === "applied" && outcome.failures.join()).toContain("disk full");
    expect(h.stores.agentConfigs.list()).toEqual([]);
  });

  it("views that can't catch up after it still end on its outcome", async () => {
    const { h, importId, take } = await reviewed();
    vi.spyOn(h.orchestrator, "publishDataInventory").mockRejectedValue(new Error("keyring locked"));

    await h.orchestrator.applyConfigImport(importId, take);

    const outcome = h.settings.state().configImport;
    expect(outcome?.stage).toBe("applied");
    expect(outcome?.stage === "applied" && outcome.failures.join()).toContain("keyring locked");
  });
});
