// An import's plan: the file's items set against this machine's — matched
// by id, then by name, each new, unchanged or different, with what the
// user should know before it lands.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readConfiguration, type ConfigurationRead } from "../src/orchestrator/config-import";
import { planImport, type LocalConfiguration, type PlanChecks } from "../src/orchestrator/config-import-plan";
import type { AgentConfig } from "../src/orchestrator/stores/agent-configs";
import type { McpServerConfig } from "../src/orchestrator/stores/mcp-server-configs";
import { DEFAULT_PREFERENCES } from "../src/shared/protocol";
import type { PatchbayAgentId, PatchbayMcpServerId } from "../src/shared/ids";

async function golden(): Promise<ConfigurationRead> {
  const text = await readFile(fileURLToPath(new URL("./goldens/configuration.2026-10-13.json", import.meta.url)), "utf8");
  const outcome = readConfiguration(text);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.read;
}

const empty: LocalConfiguration = {
  agents: [],
  agentEnv: {},
  knobs: {},
  mcpServers: [],
  serverSecrets: {},
  preferences: DEFAULT_PREFERENCES,
  machineCommandRules: [],
  machineWriteScope: [],
  machineSavedRoots: [],
};

// Everything found and present, unless a test says otherwise.
const here: PlanChecks = { commandFound: () => true, pathExists: () => true };

const of = (plan: ReturnType<typeof planImport>, id: string) => {
  const item = plan.items.find((i) => i.id === id);
  if (item === undefined) throw new Error(`no item ${id}`);
  return item;
};

describe("an import's plan", () => {
  it("on a machine holding nothing, every item is new — each flagged with what it needs here", async () => {
    const plan = planImport(await golden(), empty, {
      commandFound: (c) => c !== "bare-acp" && c !== "tool",
      pathExists: () => false,
    });
    expect(plan.items.map((i) => [i.id, i.fate])).toEqual([
      ["agent:claude", "new"],
      ["agent:6f1c2a9e-3b7d-4e21-9a5f-0c8d2e4b7a13", "new"],
      ["agent:bare", "new"],
      ["mcpServer:keyed", "new"],
      ["mcpServer:local", "new"],
      ["mcpServer:context7", "new"],
      ["mcpServer:github", "new"],
      ["preferences", "differs"],
      ["commandRule:command:git status", "new"],
      ["commandRule:command:rm -rf *", "new"],
      ["savedRoot:/home/me/notes", "new"],
    ]);
    expect(of(plan, "agent:claude").flags).toEqual([]);
    expect(of(plan, "agent:6f1c2a9e-3b7d-4e21-9a5f-0c8d2e4b7a13").flags).toEqual(["downloaded again for this machine at its first connect"]);
    expect(of(plan, "agent:bare").flags).toEqual(["bare-acp isn't found on this machine"]);
    expect(of(plan, "mcpServer:github").flags).toEqual(["needs a fresh sign-in on this machine"]);
    expect(of(plan, "mcpServer:local").flags).toEqual(["tool isn't found on this machine"]);
    expect(of(plan, "savedRoot:/home/me/notes").flags).toEqual(["doesn't exist on this machine"]);
    expect(of(plan, "preferences").differs).toEqual(["soundOnDone", "knobSource", "idleCloseMinutes"]);
    // New ones keep their own ids.
    expect(plan.agentIds.get("claude")).toBe("claude");
  });

  it("an agent added on both machines is matched by name and lands on this machine's id; what this machine knows of it isn't compared", async () => {
    const read = await golden();
    const theirs = read.agents.find((a) => a.id === "claude")!;
    const mine: AgentConfig = { ...theirs, id: "local-claude" as PatchbayAgentId, lastSeenVersion: "0.30.0" };
    const plan = planImport(read, {
      ...empty,
      agents: [mine],
      agentEnv: { "local-claude": { ANTHROPIC_API_KEY: "sk-1" } },
      knobs: { "local-claude": { mode: "plan" } },
    }, here);
    expect(of(plan, "agent:claude")).toMatchObject({ fate: "unchanged", differs: [] });
    expect(plan.agentIds.get("claude")).toBe("local-claude");
  });

  it("an agent matched by id that differs names what differs", async () => {
    const read = await golden();
    const theirs = read.agents.find((a) => a.id === "claude")!;
    const mine: AgentConfig = { ...theirs, name: "Claude here", autoConnect: false };
    const plan = planImport(read, { ...empty, agents: [mine], agentEnv: { claude: { ANTHROPIC_API_KEY: "other" } } }, here);
    expect(of(plan, "agent:claude")).toMatchObject({
      fate: "differs",
      differs: ["name", "connect on window open", "env values", "composer choices"],
    });
  });

  it("a downloaded agent's cache path and archive are this machine's own — never a difference", async () => {
    const read = await golden();
    const theirs = read.agents.find((a) => a.link?.distributionKind === "binary")!;
    const mine: AgentConfig = {
      ...theirs,
      command: "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\solutionsunity.acp-patchbay\\bin-cache\\kimi\\0.3.1\\kimi.exe",
      link: {
        ...theirs.link!,
        distributionKind: "binary",
        distribution: { archive: "https://example.test/kimi-0.3.1-windows-x64.zip", cmd: "kimi.exe", args: ["acp"], env: {} },
      },
    };
    // The same as here, it lands nothing — so nothing to know about landing it.
    expect(of(planImport(read, { ...empty, agents: [mine] }, here), `agent:${theirs.id}`)).toMatchObject({ fate: "unchanged", flags: [] });
  });

  it("a server's routing reads by the ids its agents land on here", async () => {
    const read = await golden();
    const claude = read.agents.find((a) => a.id === "claude")!;
    const local = read.mcpServers.find((s) => s.id === "local")!;
    const plan = planImport(read, {
      ...empty,
      agents: [{ ...claude, id: "local-claude" as PatchbayAgentId }],
      mcpServers: [{ ...local, id: "here" as PatchbayMcpServerId, routing: ["local-claude"] } satisfies McpServerConfig],
      serverSecrets: { here: { env: { TOKEN: "t-1" } } },
    }, here);
    expect(of(plan, "mcpServer:local")).toMatchObject({ fate: "unchanged" });
    expect(plan.serverIds.get("local")).toBe("here");
  });

  it("a header server's key and a server's switch are compared; an OAuth sign-in never is", async () => {
    const read = await golden();
    const keyed = read.mcpServers.find((s) => s.id === "keyed")!;
    const github = read.mcpServers.find((s) => s.id === "github")!;
    const plan = planImport(read, {
      ...empty,
      mcpServers: [{ ...keyed, active: false }, github],
      serverSecrets: { keyed: { env: {}, key: "older-key" } },
    }, here);
    expect(of(plan, "mcpServer:keyed").differs).toEqual(["on or off", "API key"]);
    expect(of(plan, "mcpServer:github")).toMatchObject({ fate: "unchanged", flags: [] });
  });

  it("settings: preferences one item; a rule by its pattern; a root by its path", async () => {
    const read = await golden();
    const plan = planImport(read, {
      ...empty,
      preferences: { ...DEFAULT_PREFERENCES, soundOnDone: false, knobSource: "last-session", idleCloseMinutes: 45 },
      machineCommandRules: [{ kind: "command", pattern: "git status", verdict: "ask" }, { kind: "command", pattern: "ls", verdict: "allow" }],
      machineSavedRoots: ["/home/me/notes"],
    }, { ...here, pathExists: () => false });
    expect(of(plan, "preferences")).toMatchObject({ fate: "unchanged", differs: [] });
    expect(of(plan, "commandRule:command:git status")).toMatchObject({ fate: "differs", differs: ["ask here, allow in the file"] });
    expect(of(plan, "commandRule:command:rm -rf *").fate).toBe("new");
    expect(of(plan, "savedRoot:/home/me/notes")).toMatchObject({ fate: "unchanged", flags: [] });
    // What only this machine holds is no item: an import removes nothing.
    expect(plan.items.some((i) => i.label === "ls")).toBe(false);
  });

  it("file writes: a place by its switch or folder, set against this machine's answer — its default where it set none", async () => {
    const read: ConfigurationRead = {
      ...(await golden()),
      machineWriteScope: [
        { location: { kind: "workspace" }, on: true },
        { location: { kind: "temp" }, on: true },
        { location: { kind: "path", path: "/home/me/.hermes" }, on: true },
        { location: { kind: "path", path: "/srv/infra" }, on: true },
      ],
    };
    const plan = planImport(read, { ...empty, machineWriteScope: [{ location: { kind: "path", path: "/srv/infra" }, on: false }] }, {
      ...here,
      pathExists: (p) => p !== "/home/me/.hermes",
    });
    expect(of(plan, "writeLocation:workspace")).toMatchObject({ fate: "unchanged", differs: [] });
    expect(of(plan, "writeLocation:temp")).toMatchObject({ fate: "differs", differs: ["off here, on in the file"], label: "File writes: Temp on" });
    expect(of(plan, "writeLocation:/home/me/.hermes")).toMatchObject({ fate: "new", flags: ["doesn't exist on this machine"] });
    expect(of(plan, "writeLocation:/srv/infra")).toMatchObject({ fate: "differs", flags: [] });
  });
});
