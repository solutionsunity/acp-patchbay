// The MCP-servers store: catalog key/OAuth connects, custom servers in the
// shape other clients write, the check every add passes before anything is
// stored, routing and workspaces, and mcpServers construction — against a
// real fake MCP-spec OAuth provider (test/support/fake-oauth-provider.ts)
// and an in-memory global server-config store (MCP servers are global,
// developer-env, never repo-committed — stores/mcp-server-configs.ts). No
// mocks of McpServersStore's own collaborators. The live half (a real
// agent calling tools through the real bridge subprocess) is
// test/mcp-bridge.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { lastEvent } from "./support/transcript";
import { SETTLE } from "./support/wait-for";
import { McpServerGates } from "../src/orchestrator/mcp-server-gates";
import { McpServersStore } from "../src/orchestrator/mcp-servers-store";
import { Queue } from "../src/orchestrator/queue";
import type { ProbeFn, ProbeTarget } from "../src/orchestrator/mcp-probe";
import { McpServerConfigStore } from "../src/orchestrator/stores/mcp-server-configs";
import { McpServerTokenStore, MemorySecrets } from "../src/orchestrator/stores/mcp-server-tokens";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import type { CatalogEntry } from "../src/orchestrator/stores/mcp-catalog";
import { SecretEnvStore } from "../src/orchestrator/stores/secret-env";
import type { McpServerConnectView, McpServerRoutingView, McpServerWork, SettingsEvent } from "../src/shared/protocol";
import type { McpDraft } from "../src/shared/mcp-config";
import type { Reach } from "../src/shared/reach";
import type { OAuthUserAgent } from "../src/orchestrator/mcp-oauth";
import { FakeOAuthProvider, fakeUserAgent } from "./support/fake-oauth-provider";
import type { PatchbayAgentId, PatchbayMcpServerId } from "../src/shared/ids";
import type { WorkspaceId } from "../src/shared/workspace";
import { SECRET_FAMILIES, STORAGE_KEYS } from "../src/orchestrator/stores/storage-keys";

let provider: FakeOAuthProvider;

beforeEach(async () => {
  provider = new FakeOAuthProvider();
  await provider.listen();
});
afterEach(async () => {
  await provider.close();
});

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "svc",
    name: "Service",
    description: "a service",
    brandIcon: { viewBox: "0 0 24 24", path: "M4 4h16v16H4z" },
    url: provider.mcpUrl,
    userUrl: false,
    docsUrl: "https://example.test/docs",
    note: "",
    auth: {
      header: { headerName: "Authorization", valuePrefix: "Bearer ", hint: "a key", keyUrl: "" },
      oauth: true,
    },
    local: null,
    ...overrides,
  };
}

function envOf(server: import("@agentclientprotocol/sdk").McpServer): Record<string, string> {
  if (!("command" in server)) throw new Error("expected a stdio server entry");
  return Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value]));
}

/** The directory the orchestrator launches agents in — the probe must run
 * custom-stdio servers in the same one. */
const WORKSPACE_CWD = "/workspace/project";
/** The workspace the window has open. */
const HERE = "file:///workspace/project" as WorkspaceId;
/** Every workspace, every agent. */
const ALL = { routing: "auto", workspaces: "auto" } as const;

const stdio = (command: string, args: string[] = [], env: Record<string, string> = {}): McpDraft => ({ type: "stdio", command, args, env });
const http = (url: string, headers: Record<string, string> = {}): McpDraft => ({ type: "http", url, headers });

function harness(
  catalog: CatalogEntry[],
  opts: { userAgent?: OAuthUserAgent; kv?: MemoryKV; secrets?: MemorySecrets; agentEnv?: Record<string, string> } = {},
) {
  const events: SettingsEvent[] = [];
  const configs = new McpServerConfigStore(opts.kv ?? new MemoryKV());
  const secrets = opts.secrets ?? new MemorySecrets();
  // Every key a secret was written under — what "stores nothing" checks.
  const storedKeys: string[] = [];
  // Every value an attach handed to an agent, as the wire log hears it.
  const crossed: string[] = [];
  const store = secrets.store.bind(secrets);
  secrets.store = (key, value) => (storedKeys.push(key), store(key, value));
  const tokens = new McpServerTokenStore(secrets);
  const envStore = new SecretEnvStore(secrets, SECRET_FAMILIES.mcpServer);
  const headerStore = new SecretEnvStore(secrets, SECRET_FAMILIES.mcpServer, () => {}, "headers");
  // Probes are faked — the real one does network/spawn (mcp-probe.ts).
  const probed: ProbeTarget[] = [];
  let probeFn: ProbeFn = async (target) => {
    probed.push(target);
    return { serverName: "fake-server", serverVersion: "1.0", tools: [{ name: "t_one", description: "d" }] };
  };
  // The lines and gates, built the way the orchestrator builds them: the
  // operations that take time go through the gates, as every door's do.
  let manager!: McpServersStore;
  const republish = () => void manager.refresh();
  const serverLine = new Queue<McpServerWork>(republish);
  const connectLine = new Queue<"connect">(republish);
  manager = new McpServersStore(
    catalog,
    configs,
    { env: envStore, headers: headerStore, tokens },
    { emit: (...evs) => events.push(...evs), listed: () => {} },
    { busy: (patchbayMcpServerId) => serverLine.held(patchbayMcpServerId), connecting: () => connectLine.holding() },
    {
      editorServerScript: "/mcp-server.js",
      bridgeScript: "/bridge.js",
      socketPath: () => "/sock",
      crossing: (value) => crossed.push(value),
    },
    WORKSPACE_CWD,
    HERE,
    async () => opts.agentEnv ?? {},
    opts.userAgent ?? fakeUserAgent(),
    undefined,
    (target, signal) => probeFn(target, signal),
  );
  const gates = new McpServerGates(manager, serverLine, connectLine);
  /** An add card's add — the card named after the server. */
  const add = (
    name: string,
    draft: McpDraft,
    reach: { routing: McpServerRoutingView; workspaces: Reach<WorkspaceId> } = ALL,
    signIn = false,
  ) => gates.addCustom(name, name, draft, reach, signIn);
  return {
    manager, gates, configs, tokens, envStore, headerStore, events, probed, storedKeys, crossed, add,
    setProbeFn(fn: ProbeFn) { probeFn = fn; },
  };
}

/** A probe the server turns away asking for a sign-in. */
const asksSignIn: ProbeFn = async () => {
  throw new StreamableHTTPError(401, "Error POSTing to endpoint: unauthorized");
};

/** The connects the store last published — running ones and held
 * outcomes. */
function connects(events: readonly SettingsEvent[]): readonly McpServerConnectView[] {
  const last = lastEvent(events, "mcpServersChanged");
  return last?.kind === "mcpServersChanged" ? last.connects : [];
}

/** The connects as published once the store has published again — a line
 * move republishes on its own, a beat after the operation settles. Done
 * adds are left out: what the card does with one is the card's. */
async function published(h: { manager: McpServersStore; events: SettingsEvent[] }): Promise<readonly McpServerConnectView[]> {
  await h.manager.refresh();
  return connects(h.events).filter((c) => c.status !== "added");
}

/** A session's set without the built-in editor server, which leads every
 * one — what the configured servers contributed. */
async function configuredFor(h: { manager: McpServersStore }, patchbayAgentId: PatchbayAgentId, declaresHttp = false) {
  const { servers, given, withheld } = await h.manager.mcpServersFor(patchbayAgentId, "ctx-1", declaresHttp);
  return { servers: servers.slice(1), given: given.slice(1), withheld };
}

/** A stored server by its display name — ids are minted. */
function named(h: { configs: McpServerConfigStore }, name: string) {
  return h.configs.list().find((c) => c.name === name);
}

/** A server's view as last published. */
async function viewOf(h: ReturnType<typeof harness>, id: PatchbayMcpServerId) {
  await h.manager.refresh();
  const last = lastEvent(h.events, "mcpServersChanged");
  return last?.kind === "mcpServersChanged" ? last.servers.find((v) => v.id === id) : undefined;
}

function failure(key: string, reason: RegExp, extra: Partial<McpServerConnectView> = {}) {
  return expect.objectContaining({ key, status: "failed", reason: expect.stringMatching(reason), ...extra });
}

describe("McpServerConfigStore — saved records", () => {
  it("the servers 0.88 kept are copied once to their own key — on everywhere stays on everywhere, off goes off everywhere", async () => {
    const kv = new MemoryKV();
    const stdio = { kind: "custom-stdio", command: "srv", args: [] };
    const before = [
      { id: "on", name: "On", source: stdio, routing: "auto", active: true, transport: "auto" },
      { id: "off", name: "Off", source: stdio, routing: "auto", active: false, transport: "auto" },
      { id: "unsaid", name: "Unsaid", source: stdio },
    ];
    await kv.update(STORAGE_KEYS.mcpServersBefore090, before);
    expect(new McpServerConfigStore(kv).list().map((c) => [c.id, c.workspaces])).toEqual([
      ["on", "auto"],
      ["off", []],
      ["unsaid", "auto"],
    ]);
    // A window still on 0.88 keeps its own copy, as it wrote it.
    expect(kv.get(STORAGE_KEYS.mcpServersBefore090)).toEqual(before);
    expect(JSON.stringify(kv.get(STORAGE_KEYS.mcpServers))).not.toContain("active");
    // Copied once: a list this version keeps is never filled from it again.
    await kv.update(STORAGE_KEYS.mcpServers, []);
    expect(new McpServerConfigStore(kv).list()).toEqual([]);
  });

  it("a server stored from the catalog under its old name reads as a catalog server — nothing dropped", async () => {
    const kv = new MemoryKV();
    await kv.update(STORAGE_KEYS.mcpServersBefore090, [
      { id: "old", name: "GitHub", source: { kind: "registry", registryId: "github", authMode: "oauth" } },
      { id: "own", name: "Mine", source: { kind: "custom-stdio", command: "srv", args: [] } },
    ]);
    const configs = new McpServerConfigStore(kv);
    expect(configs.list().map((c) => c.source)).toEqual([
      { kind: "catalog", catalogId: "github", authMode: "oauth" },
      { kind: "custom-stdio", command: "srv", args: [] },
    ]);
    // rewritten on disk, so the next read has nothing left to fold
    expect(JSON.stringify(kv.get(STORAGE_KEYS.mcpServers))).not.toContain("registry");
  });

  it("a name stored before names were cut to what agents keep is rewritten once, as agents already read it; one that then collides, or is the built-in's, gets a number", async () => {
    const kv = new MemoryKV();
    const stdio = { kind: "custom-stdio", command: "srv", args: [] };
    await kv.update(STORAGE_KEYS.mcpServersBefore090, [
      { id: "a", name: "GitHub 2", source: stdio },
      { id: "b", name: "My Files", source: stdio },
      { id: "c", name: "My_Files", source: stdio },
      { id: "d", name: "plain", source: stdio },
      { id: "e", name: "patchbay", source: stdio },
    ]);
    const configs = new McpServerConfigStore(kv);
    expect(configs.list().map((c) => [c.id, c.name])).toEqual([
      ["a", "GitHub_2"],
      ["b", "My_Files-2"],
      ["c", "My_Files"],
      ["d", "plain"],
      ["e", "patchbay-2"],
    ]);
    expect(new McpServerConfigStore(kv).list().map((c) => c.name)).toEqual([
      "GitHub_2",
      "My_Files-2",
      "My_Files",
      "plain",
      "patchbay-2",
    ]);
  });
});

describe("McpServersStore — key connect", () => {
  it("checks the key against the server, then stores it and the record with authMode header", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "pasted-key-1", undefined, ALL);

    // checked with the key in the entry's header, before anything was kept
    expect(h.probed).toEqual([{ kind: "http", url: provider.mcpUrl, headers: { Authorization: "Bearer pasted-key-1" } }]);
    expect((await h.tokens.get(id))?.accessToken).toBe("pasted-key-1");
    expect(await viewOf(h, id)).toEqual({
      id,
      name: "Service",
      sourceKind: "catalog",
      catalogId: "svc",
      command: undefined,
      connected: true,
      signedIn: false,
      workspaces: "auto",
      onHere: true,
      routing: "auto",
      transport: "auto",
      probe: {
        status: "ok",
        at: expect.any(String),
        serverName: "fake-server",
        serverVersion: "1.0",
        tools: [{ name: "t_one", description: "d" }],
      },
      busy: [],
      draft: undefined,
    });
    expect(h.configs.get(id)?.source).toMatchObject({ kind: "catalog", catalogId: "svc", authMode: "header" });
    // the raw key never touches the non-secret config record
    expect(JSON.stringify(h.configs.list())).not.toContain("pasted-key-1");
  });

  it("a key the server refuses stores nothing — the reason stays on the card", async () => {
    const h = harness([entry()]);
    h.setProbeFn(async () => {
      throw new Error("Error POSTing to endpoint: forbidden");
    });
    await expect(h.gates.connectWithKey("svc", "Service", "bad-key", undefined, ALL)).rejects.toThrow(/forbidden/);
    expect(h.configs.list()).toEqual([]);
    expect(h.storedKeys).toEqual([]);
    expect(await published(h)).toEqual([failure("catalog:svc", /forbidden/)]);
  });

  it("who gets it rides the connect — the workspaces, then the agents", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "k", undefined, { routing: ["agent-b" as PatchbayAgentId], workspaces: [HERE] });
    expect(h.configs.get(id)).toMatchObject({ routing: ["agent-b"], workspaces: [HERE] });
  });

  it("a per-account entry (userUrl) requires the user's endpoint and persists it", async () => {
    const h = harness([entry({ url: "", userUrl: true })]);
    await expect(h.gates.connectWithKey("svc", "Service", "k", undefined, ALL)).rejects.toThrow(/endpoint URL/);
    expect(await published(h)).toEqual([failure("catalog:svc", /endpoint URL/)]);

    const id = await h.gates.connectWithKey("svc", "Service", "k", "https://mine.example.test/mcp", ALL);
    expect(h.configs.get(id)?.source).toMatchObject({ url: "https://mine.example.test/mcp" });
    // the attempt that worked cleared the held failure, and holds what it made
    expect(await published(h)).toEqual([]);
    expect(connects(h.events)).toEqual([expect.objectContaining({ key: "catalog:svc", status: "added", server: id })]);
  });

  it("refuses on an entry with no key mode", async () => {
    const h = harness([entry({ auth: { header: null, oauth: false } })]);
    await expect(h.gates.connectWithKey("svc", "Service", "k", undefined, ALL)).rejects.toThrow(/no API-key mode/);
    expect(await published(h)).toEqual([failure("catalog:svc", /no API-key mode/)]);
    expect(h.storedKeys).toEqual([]);
  });
});

describe("McpServersStore — OAuth connect (MCP-spec, discovery + DCR + PKCE)", () => {
  it("connects with only the entry's URL, checks with the token, and captures refresh context alongside it", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectOAuth("svc", "Service", undefined, ALL);

    expect(await h.tokens.get(id)).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      tokenEndpoint: provider.tokenEndpoint,
      clientId: "dcr-client-1",
    });
    expect(h.probed).toEqual([{ kind: "http", url: provider.mcpUrl, headers: { Authorization: "Bearer access-1" } }]);
    expect(h.configs.get(id)?.source).toMatchObject({ authMode: "oauth" });
  });

  it("gated DCR fails labeled — pitfall §2, pointing at the key path", async () => {
    provider.gateDcr = true;
    const h = harness([entry()]);
    await expect(h.gates.connectOAuth("svc", "Service", undefined, ALL)).rejects.toThrow(/API-key path/);
    expect(await published(h)).toEqual([failure("catalog:svc", /API-key path/)]);
    expect(h.storedKeys).toEqual([]);
  });

  it("refuses on an entry without an OAuth mode", async () => {
    const h = harness([entry({ auth: { header: { headerName: "Authorization", valuePrefix: "Bearer ", hint: "", keyUrl: "" }, oauth: false } })]);
    await expect(h.gates.connectOAuth("svc", "Service", undefined, ALL)).rejects.toThrow(/no OAuth mode/);
    expect(await published(h)).toEqual([failure("catalog:svc", /no OAuth mode/)]);
  });
});

describe("McpServersStore — your own server, checked before it is stored", () => {
  it("a command is checked where it would run, then stored — env in SecretStorage, never the record", async () => {
    const h = harness([]);
    const id = await h.add("Local Tool", stdio("echo", ["hi"], { MY_KEY: "v1" }));
    expect(h.probed).toEqual([{ kind: "stdio", command: "echo", args: ["hi"], env: { MY_KEY: "v1" }, cwd: WORKSPACE_CWD }]);
    expect(h.configs.get(id)?.source).toEqual({ kind: "custom-stdio", command: "echo", args: ["hi"] });
    expect(await h.envStore.get(id)).toEqual({ MY_KEY: "v1" });
    expect(await viewOf(h, id)).toMatchObject({ sourceKind: "custom-stdio", connected: true, probe: { status: "ok" } });
  });

  it("a URL's headers — a key among them, any header name — are kept whole in SecretStorage, never in config", async () => {
    const h = harness([]);
    const id = await h.add("Stitch-like", http("https://example.test/mcp", { "X-Goog-Api-Key": "secret-abc", "X-Team": "t1" }));
    expect(h.probed).toEqual([{ kind: "http", url: "https://example.test/mcp", headers: { "X-Goog-Api-Key": "secret-abc", "X-Team": "t1" } }]);
    expect(h.configs.get(id)?.source).toEqual({ kind: "custom-http", url: "https://example.test/mcp", oauth: false });
    expect(await h.headerStore.get(id)).toEqual({ "X-Goog-Api-Key": "secret-abc", "X-Team": "t1" });
    expect(JSON.stringify(h.configs.list())).not.toContain("secret-abc");
    expect(await h.tokens.get(id)).toBeNull();
  });

  it("a failing command, a refused key or an unset variable stores nothing — the card keeps the reason", async () => {
    const h = harness([]);
    h.setProbeFn(async () => {
      throw new Error("Connection closed");
    });
    await expect(h.add("Broken", stdio("srv"))).rejects.toThrow(`Connection closed (ran in ${WORKSPACE_CWD})`);
    await expect(h.add("Unset", http("https://example.test/mcp", { Authorization: "Bearer ${PATCHBAY_TEST_UNSET}" }))).rejects.toThrow(
      /\$\{PATCHBAY_TEST_UNSET\} is not set/,
    );
    expect(h.configs.list()).toEqual([]);
    expect(h.storedKeys).toEqual([]);
    expect(await published(h)).toEqual([
      failure("custom:Broken", /Connection closed \(ran in/),
      failure("custom:Unset", /PATCHBAY_TEST_UNSET/),
    ]);
  });

  it("an empty command or URL, and VS Code's own variables, are refused before anything runs", async () => {
    const h = harness([]);
    await expect(h.add("Empty", stdio(" "))).rejects.toThrow(/a command is needed/);
    await expect(h.add("No URL", http(""))).rejects.toThrow(/a URL is needed/);
    await expect(h.add("Prompt", stdio("srv", [], { KEY: "${input:apiKey}" }))).rejects.toThrow(/asks VS Code for a value/);
    await expect(h.add("Folder", stdio("srv", ["${workspaceFolder}/x"]))).rejects.toThrow(/VS Code's own/);
    expect(h.probed).toEqual([]);
    expect(h.configs.list()).toEqual([]);
  });

  it("a server that asks for a sign-in says so; added again with the sign-in, it is checked with its token and kept signed in", async () => {
    const h = harness([]);
    h.setProbeFn(asksSignIn);
    await expect(h.add("Signs in", http(provider.mcpUrl))).rejects.toThrow(/sign in/);
    expect(await published(h)).toEqual([failure("custom:Signs in", /sign in/, { signIn: true })]);
    expect(h.storedKeys).toEqual([]);

    const seen: ProbeTarget[] = [];
    h.setProbeFn(async (target) => (seen.push(target), { serverName: "s", serverVersion: "1", tools: [] }));
    const id = await h.add("Signs in", http(provider.mcpUrl), ALL, true);
    expect(seen).toEqual([{ kind: "http", url: provider.mcpUrl, headers: { Authorization: "Bearer access-1" } }]);
    expect(h.configs.get(id)?.source).toEqual({ kind: "custom-http", url: provider.mcpUrl, oauth: true });
    expect((await h.tokens.get(id))?.accessToken).toBe("access-1");
    expect(await viewOf(h, id)).toMatchObject({ connected: true, signedIn: true });
    expect(await published(h)).toEqual([]);
  });

  it("a failed sign-in stores nothing — no stranded credential-less record", async () => {
    const h = harness([]);
    provider.denyConsent = true; // user rejects in the browser
    await expect(h.add("OAuth Fail", http(provider.mcpUrl), ALL, true)).rejects.toThrow();
    expect(h.configs.list()).toEqual([]);
    expect(h.storedKeys).toEqual([]);
    expect(await published(h)).toEqual([failure("custom:OAuth Fail", /./)]);
  });

  it("a command typed as one line is split quote-aware, never stored as one executable string", async () => {
    const h = harness([]);
    const id = await h.add("Srv", stdio('npx some-server --root "/tmp/my dir"', ["--verbose"]));
    expect(h.configs.get(id)!.source).toEqual({ kind: "custom-stdio", command: "npx", args: ["some-server", "--root", "/tmp/my dir", "--verbose"] });
    const servers = (await configuredFor(h, "agent-a" as PatchbayAgentId)).servers;
    expect(servers[0]).toMatchObject({ command: "npx", args: ["some-server", "--root", "/tmp/my dir", "--verbose"] });
  });

  it("an unterminated quote fails labeled, storing nothing", async () => {
    const h = harness([]);
    await expect(h.add("Bad", stdio('npx "broken'))).rejects.toThrow(/quote/);
    expect(h.configs.list()).toEqual([]);
    expect(await published(h)).toEqual([failure("custom:Bad", /quote/)]);
  });

  it("a finished add is held under its card until the card is closed — so the card knows its server", async () => {
    const h = harness([]);
    const id = await h.add("Done", stdio("srv"));
    await h.manager.refresh();
    expect(connects(h.events)).toEqual([{ key: "custom:Done", kind: "custom", subject: "Done", status: "added", server: id }]);
    await h.gates.cancel("custom:Done");
    expect(connects(h.events)).toEqual([]);
  });

  it("a stdio server added where it is off is never run here — stored unchecked, said so in the log", async () => {
    const h = harness([]);
    const id = await h.add("Elsewhere", stdio("srv"), { routing: "auto", workspaces: ["file:///elsewhere" as WorkspaceId] });
    await h.gates.probe(id);
    expect(h.probed).toEqual([]);
    expect(h.configs.get(id)).toBeDefined();
    // Switched on here: the user's act, and only now does it run.
    expect(await h.manager.setWorkspaces(id, [HERE])).toBe(true);
    await h.gates.probe(id);
    expect(h.probed).toEqual([expect.objectContaining({ kind: "stdio", command: "srv", cwd: WORKSPACE_CWD })]);
    // A remote server is no command of this workspace's: it is checked anywhere.
    await h.add("Remote", http("https://example.test/mcp"), { routing: "auto", workspaces: [] });
    expect(h.probed.at(-1)).toEqual(expect.objectContaining({ kind: "http", url: "https://example.test/mcp" }));
  });

  it("a name another server holds gets a number — nothing is overwritten, and no agent sees two of one name", async () => {
    const h = harness([]);
    await h.gates.addCustom("card-1", "Tool", stdio("a"), ALL, false);
    await h.gates.addCustom("card-2", "Tool", stdio("b"), ALL, false);
    expect(named(h, "Tool")?.source).toMatchObject({ command: "a" });
    expect(named(h, "Tool-2")?.source).toMatchObject({ command: "b" });
    const { servers } = await configuredFor(h, "agent-a" as PatchbayAgentId);
    expect(servers.map((sv) => sv.name)).toEqual(["Tool", "Tool-2"]);
  });

  it("a name goes to agents as they would keep it — two names an agent would merge are two names here", async () => {
    const h = harness([]);
    await h.add("my server", stdio("a"));
    await h.add("my_server", stdio("b"));
    const { servers } = await configuredFor(h, "agent-a" as PatchbayAgentId);
    expect(servers.map((sv) => sv.name)).toEqual(["my_server", "my_server-2"]);
  });

  it("a blank name is refused — nothing is stored", async () => {
    const h = harness([]);
    await expect(h.add("   ", stdio("a"))).rejects.toThrow(/name is empty/);
    expect(h.configs.list()).toEqual([]);
  });

  it("no configured server takes the built-in's name", async () => {
    const h = harness([]);
    await h.add("patchbay", stdio("a"));
    expect(h.configs.list().map((c) => c.name)).toEqual(["patchbay-2"]);
  });

  it("disconnect is remove — the full clear; the catalog entry stays", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "static-key", undefined, ALL);
    await h.gates.remove(id);
    expect(await h.tokens.get(id)).toBeNull();
    expect(h.configs.list()).toEqual([]);
    // the catalog entry itself is shipped data — still there, ready to reconnect
    expect(h.manager.catalogViews().some((r) => r.id === "svc")).toBe(true);
  });

  it("remove clears env and headers with the record", async () => {
    const h = harness([]);
    const local = await h.add("Local", stdio("srv", [], { K: "v" }));
    const remote = await h.add("Remote", http("https://example.test/mcp", { "X-Key": "k" }));
    await h.gates.remove(local);
    await h.gates.remove(remote);
    expect(h.configs.list()).toEqual([]);
    expect(await h.envStore.get(local)).toEqual({});
    expect(await h.headerStore.get(remote)).toEqual({});
  });
});

describe("McpServersStore — a server's edit, the same form", () => {
  it("a command's edit is checked, then stored over the server — name, who gets it and order kept", async () => {
    const h = harness([]);
    const id = await h.add("Editable", stdio("srv", ["--x"], { KEEP: "old", GONE: "bye" }), { routing: ["agent-a" as PatchbayAgentId], workspaces: [HERE] });
    expect((await viewOf(h, id))?.draft).toEqual({ type: "stdio", command: "srv", args: ["--x"], env: { KEEP: "old", GONE: "bye" } });

    await h.gates.updateCustom(id, stdio("srv2", ["--y"], { KEEP: "old", NEW: "n" }), false);
    expect(h.probed.at(-1)).toEqual({ kind: "stdio", command: "srv2", args: ["--y"], env: { KEEP: "old", NEW: "n" }, cwd: WORKSPACE_CWD });
    expect(h.configs.get(id)).toMatchObject({ name: "Editable", source: { command: "srv2", args: ["--y"] }, routing: ["agent-a"], workspaces: [HERE] });
    expect(await h.envStore.get(id)).toEqual({ KEEP: "old", NEW: "n" });
  });

  it("an edit that fails its check changes nothing — the reason stays on the server's card", async () => {
    const h = harness([]);
    const id = await h.add("Keyed", http("https://example.test/mcp", { "X-Key": "k1" }));
    h.setProbeFn(async () => {
      throw new Error("unauthorized key");
    });
    await expect(h.gates.updateCustom(id, http("https://example.test/mcp", { "X-Key": "k2" }), false)).rejects.toThrow(/unauthorized/);
    expect(await h.headerStore.get(id)).toEqual({ "X-Key": "k1" });
    expect(await published(h)).toEqual([failure(`server:${id}`, /unauthorized/)]);
  });

  it("a sign-in stays with a server whose URL is unchanged, and goes with one that moved", async () => {
    const h = harness([]);
    const id = await h.add("Signed", http(provider.mcpUrl), ALL, true);
    await h.gates.updateCustom(id, http(provider.mcpUrl, { "X-Team": "t" }), false);
    expect(h.probed.at(-1)).toEqual({ kind: "http", url: provider.mcpUrl, headers: { "X-Team": "t", Authorization: "Bearer access-1" } });
    expect(h.configs.get(id)?.source).toEqual({ kind: "custom-http", url: provider.mcpUrl, oauth: true });

    await h.gates.updateCustom(id, http("https://elsewhere.example.test/mcp"), false);
    expect(h.configs.get(id)?.source).toEqual({ kind: "custom-http", url: "https://elsewhere.example.test/mcp", oauth: false });
    expect(await h.tokens.get(id)).toBeNull();
  });

  it("a type changed in the edit leaves nothing of the other kind behind", async () => {
    const h = harness([]);
    const id = await h.add("Turns", stdio("srv", [], { K: "v" }));
    await h.gates.updateCustom(id, http("https://example.test/mcp", { "X-Key": "k" }), false);
    expect(await h.envStore.get(id)).toEqual({});
    expect(await h.headerStore.get(id)).toEqual({ "X-Key": "k" });
    expect(h.configs.get(id)?.source.kind).toBe("custom-http");
  });

  it("an edit racing a Remove leaves the server removed (#135)", async () => {
    const h = harness([]);
    const id = await h.add("Remote", http("https://example.test/mcp", { "X-Key": "k1" }));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    h.setProbeFn(async () => (await held, { serverName: "s", serverVersion: "1", tools: [] }));
    const save = h.gates.updateCustom(id, http("https://example.test/mcp", { "X-Key": "k2" }), false).catch((err: unknown) => err);
    await vi.waitFor(() => expect(connects(h.events).some((c) => c.status === "running")).toBe(true), SETTLE);
    await h.gates.remove(id);
    release();
    expect(await save).toMatchObject({ message: expect.stringMatching(/removed/) });
    expect(h.configs.get(id)).toBeUndefined();
    expect(await h.headerStore.get(id)).toEqual({});
  });

  it("a curated server has no edit — its shape is catalog data", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "k", undefined, ALL);
    expect((await viewOf(h, id))?.draft).toBeUndefined();
    await expect(h.gates.updateCustom(id, http(provider.mcpUrl), false)).rejects.toThrow(/no such custom server/);
  });
});

describe("McpServersStore — routing, workspaces and mcpServers", () => {
  it("auto reaches every agent; an explicit list pins exactly; except narrows", async () => {
    const h = harness([]);
    await h.add("Auto Tool", stdio("echo"));
    await h.add("Pinned Tool", stdio("echo"), { routing: ["agent-b" as PatchbayAgentId], workspaces: "auto" });
    await h.add("Except Tool", stdio("echo"), { routing: { except: ["agent-a" as PatchbayAgentId] }, workspaces: "auto" });
    expect((await configuredFor(h, "agent-a" as PatchbayAgentId)).servers.map((s) => s.name)).toEqual(["Auto_Tool"]);
    expect((await configuredFor(h, "agent-b" as PatchbayAgentId)).servers.map((s) => s.name)).toEqual(["Auto_Tool", "Pinned_Tool", "Except_Tool"]);
  });

  it("a session gets a server only where it is on — in this workspace and routed to the agent, both", async () => {
    const h = harness([]);
    await h.add("Here", stdio("srv"), { routing: "auto", workspaces: [HERE] });
    await h.add("There", stdio("srv"), { routing: "auto", workspaces: ["file:///elsewhere" as WorkspaceId] });
    await h.add("Not here", stdio("srv"), { routing: "auto", workspaces: { except: [HERE] } });
    await h.add("Here, other agent", stdio("srv"), { routing: ["agent-b" as PatchbayAgentId], workspaces: [HERE] });
    expect((await configuredFor(h, "agent-a" as PatchbayAgentId)).servers.map((s) => s.name)).toEqual(["Here"]);
    await h.manager.refresh();
    const changed = lastEvent(h.events, "mcpServersChanged");
    expect(changed?.kind === "mcpServersChanged" && changed.servers.map((s) => [s.name, s.onHere])).toEqual([
      ["Here", true],
      ["There", false],
      ["Not_here", false],
      ["Here__other_agent", true],
    ]);
  });

  it("a server given to a session alone reaches it wherever it is on and whoever it is routed to — the bridge answers for it", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "k", undefined, { routing: ["agent-b" as PatchbayAgentId], workspaces: [] });
    expect((await configuredFor(h, "agent-a" as PatchbayAgentId)).servers).toEqual([]);
    const { given } = await h.manager.mcpServersFor("agent-a" as PatchbayAgentId, "ctx", false, [id]);
    expect(given.slice(1)).toEqual([{ id, delivery: "bridge" }]);
    expect(await h.manager.headersFor(id, "agent-a" as PatchbayAgentId)).toBeNull();
    expect(await h.manager.headersFor(id, "agent-a" as PatchbayAgentId, true)).toEqual({ Authorization: "Bearer k" });
  });

  it("off in this workspace keeps config and credential but reaches no agent here until switched back", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "secret-abc", undefined, ALL);
    expect((await configuredFor(h, "agent-a" as PatchbayAgentId)).servers).toHaveLength(1);
    expect(await h.manager.setWorkspaces(id, ["file:///elsewhere" as WorkspaceId])).toBe(false);
    expect((await configuredFor(h, "agent-a" as PatchbayAgentId)).servers).toEqual([]);
    expect(await h.tokens.get(id)).not.toBeNull(); // credential intact — off here, not disconnected
    expect(await h.manager.setWorkspaces(id, { except: ["file:///elsewhere" as WorkspaceId] })).toBe(true);
    expect((await configuredFor(h, "agent-a" as PatchbayAgentId)).servers).toHaveLength(1);
  });

  it("the bridge is handed the server's id and URL only — its headers are asked for per request", async () => {
    const h = harness([
      entry({ id: "stitch", name: "Stitch", auth: { header: { headerName: "X-Goog-Api-Key", valuePrefix: "", hint: "", keyUrl: "" }, oauth: false } }),
    ]);
    const id = await h.gates.connectWithKey("stitch", "Stitch", "goog-key", undefined, ALL);
    const servers = (await configuredFor(h, "agent-a" as PatchbayAgentId)).servers;
    const env = envOf(servers[0]!);
    expect(env.ACP_PATCHBAY_MCP_SERVER_URL).toBe(provider.mcpUrl);
    expect(env.ACP_PATCHBAY_MCP_SERVER_ID).toBe(id);
    expect(Object.values(env)).not.toContain("goog-key");
    // the bridge's request carries the entry's own header shape
    expect(await h.manager.headersFor(id, "agent-a" as PatchbayAgentId)).toEqual({ "X-Goog-Api-Key": "goog-key" });
  });

  it("an OAuth-connected curated server sends Authorization: Bearer regardless of the entry's key-header shape", async () => {
    const h = harness([entry({ auth: { header: { headerName: "X-Custom", valuePrefix: "", hint: "", keyUrl: "" }, oauth: true } })]);
    const id = await h.gates.connectOAuth("svc", "Service", undefined, ALL);
    expect(await h.manager.headersFor(id, "agent-a" as PatchbayAgentId)).toEqual({ Authorization: "Bearer access-1" });
  });

  it("a per-account entry's user-supplied URL is what reaches the bridge", async () => {
    const h = harness([entry({ id: "acct", url: "", userUrl: true })]);
    await h.gates.connectWithKey("acct", "Service", "k", "https://mine.example.test/mcp", ALL);
    const env = envOf((await configuredFor(h, "agent-a" as PatchbayAgentId)).servers[0]!);
    expect(env.ACP_PATCHBAY_MCP_SERVER_URL).toBe("https://mine.example.test/mcp");
  });

  it("a routed-but-unconnected server contributes no entry (nothing to route to)", async () => {
    const h = harness([entry()]);
    // config entry exists (e.g. pasted from a shared config), no token here
    await h.configs.upsert({
      id: "svc" as PatchbayMcpServerId,
      name: "Service",
      source: { kind: "catalog", catalogId: "svc", authMode: "header" },
      routing: "auto",
      workspaces: "auto",
      transport: "auto",
    });
    expect((await configuredFor(h, "agent-a" as PatchbayAgentId)).servers).toEqual([]);
  });

  it("setRouting persists a new explicit agent list", async () => {
    const h = harness([]);
    const id = await h.add("T1", stdio("echo"));
    await h.manager.setRouting(id, ["agent-x" as PatchbayAgentId]);
    expect(h.configs.get(id)?.routing).toEqual(["agent-x"]);
  });

  it("env values reach the agent's spawn config only at attach", async () => {
    const h = harness([]);
    const id = await h.add("Keyed", stdio("srv", [], { SRV_API_KEY: "sk-secret" }));
    expect("env" in (h.configs.get(id)!.source as object)).toBe(false);
    const servers = (await configuredFor(h, "agent-a" as PatchbayAgentId)).servers;
    expect(envOf(servers[0]!)).toEqual({ SRV_API_KEY: "sk-secret" });
  });

  it("an agent's removal leaves every reach list that named it", async () => {
    const h = harness([]);
    const pinned = await h.add("Pinned", stdio("a"), { routing: ["agent-a" as PatchbayAgentId, "agent-b" as PatchbayAgentId], workspaces: "auto" });
    const except = await h.add("Except", stdio("b"), { routing: { except: ["agent-a" as PatchbayAgentId] }, workspaces: "auto" });
    const auto = await h.add("Auto", stdio("c"));
    await h.manager.forgetAgent("agent-a" as PatchbayAgentId);
    expect(h.configs.get(pinned)?.routing).toEqual(["agent-b"]);
    expect(h.configs.get(except)?.routing).toEqual({ except: [] });
    expect(h.configs.get(auto)?.routing).toBe("auto");
  });
});

describe("McpServersStore — ${VAR} references, filled where the server is handed over", () => {
  const KEY = "PATCHBAY_TEST_MCP_KEY";
  beforeEach(() => {
    process.env[KEY] = "from-host";
  });
  afterEach(() => {
    delete process.env[KEY];
  });

  it("stored as typed, filled at hand-off from the host's env and the agent's own — never stored filled in", async () => {
    // checked on this host; handed over with the agent's own env on top
    const h = harness([], { agentEnv: { [KEY]: "from-agent" } });
    const local = await h.add("Local", stdio("srv", ["--key=${" + KEY + "}"], { TOKEN: "${env:" + KEY + "}", MODE: "${PATCHBAY_TEST_MODE:-quiet}" }));
    expect(h.probed[0]).toMatchObject({ args: ["--key=from-host"], env: { TOKEN: "from-host", MODE: "quiet" } });
    const remote = await h.add("Remote", http("https://example.test/${" + KEY + "}/mcp", { Authorization: "Bearer ${" + KEY + "}" }));
    expect(h.configs.get(local)?.source).toMatchObject({ args: ["--key=${" + KEY + "}"] });
    expect(await h.envStore.get(local)).toEqual({ TOKEN: "${env:" + KEY + "}", MODE: "${PATCHBAY_TEST_MODE:-quiet}" });
    expect(await h.headerStore.get(remote)).toEqual({ Authorization: "Bearer ${" + KEY + "}" });

    const { servers, withheld } = await configuredFor(h, "agent-a" as PatchbayAgentId, true);
    expect(withheld).toEqual([]);
    expect(servers[0]).toMatchObject({ args: ["--key=from-agent"] });
    expect(envOf(servers[0]!)).toEqual({ TOKEN: "from-agent", MODE: "quiet" });
    expect(servers[1]).toEqual({
      type: "http",
      name: "Remote",
      url: "https://example.test/from-agent/mcp",
      headers: [{ name: "Authorization", value: "Bearer from-agent" }],
    });
    // the copy keeps the references
    expect(await h.manager.exportJson(remote)).toContain("${" + KEY + "}");
  });

  it("a variable unset with no default withholds that server alone, and says which variable", async () => {
    const h = harness([], { agentEnv: { ONLY_AGENT_A: "x" } });
    await expect(h.add("Needs it", stdio("srv", [], { TOKEN: "${ONLY_AGENT_A}" }))).rejects.toThrow(/ONLY_AGENT_A/);
    await h.add("Plain", stdio("srv"));
    // checked on this host, where the variable isn't — the agent's env has it
    expect(h.configs.list()).toHaveLength(1);
    await h.configs.upsert({
      id: "needs" as PatchbayMcpServerId,
      name: "Needs_it",
      source: { kind: "custom-stdio", command: "srv", args: ["${PATCHBAY_TEST_NOWHERE}"] },
      routing: "auto",
      workspaces: "auto",
      transport: "auto",
    });
    const { servers, withheld } = await configuredFor(h, "agent-a" as PatchbayAgentId);
    expect(servers.map((s) => s.name)).toEqual(["Plain"]);
    expect(withheld).toEqual(['MCP server "Needs_it" wasn\'t given to the agent: ${PATCHBAY_TEST_NOWHERE} is not set, and has no default.']);
  });
});

describe("McpServersStore — http passthrough (prompt.image mechanics)", () => {
  it("an agent declaring mcp.http gets a type:http entry with the credential in headers", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "key-9", undefined, ALL);
    const { servers, given } = await configuredFor(h, "agent-a" as PatchbayAgentId, true);
    expect(servers).toEqual([{ type: "http", name: "Service", url: provider.mcpUrl, headers: [{ name: "Authorization", value: "Bearer key-9" }] }]);
    expect(given).toEqual([{ id, delivery: "http" }]);
  });

  it("a custom server's every header rides, a sign-in's token beside them", async () => {
    const h = harness([]);
    const id = await h.add("Mine", http(provider.mcpUrl, { "X-Team": "t1" }), ALL, true);
    const { servers } = await configuredFor(h, "agent-a" as PatchbayAgentId, true);
    expect(servers).toEqual([
      {
        type: "http",
        name: "Mine",
        url: provider.mcpUrl,
        headers: [
          { name: "X-Team", value: "t1" },
          { name: "Authorization", value: "Bearer access-1" },
        ],
      },
    ]);
    expect(await h.manager.headersFor(id, "agent-a" as PatchbayAgentId)).toEqual({ "X-Team": "t1", Authorization: "Bearer access-1" });
  });

  it("transport 'bridge' pins the stdio bridge even for a declaring agent (the escape hatch)", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "key-9", undefined, ALL);
    await h.manager.setTransport(id, "bridge");
    const { servers, given } = await configuredFor(h, "agent-a" as PatchbayAgentId, true);
    expect(servers).toHaveLength(1);
    expect("command" in servers[0]!).toBe(true);
    expect(envOf(servers[0]!).ACP_PATCHBAY_MCP_SERVER_ID).toBe(id);
    // the one delivery that asks patchbay for the headers
    expect(given).toEqual([{ id, delivery: "bridge" }]);
  });

  it("a non-declaring agent rides the bridge regardless of transport 'auto'", async () => {
    const h = harness([entry()]);
    await h.gates.connectWithKey("svc", "Service", "key-9", undefined, ALL);
    const servers = (await configuredFor(h, "agent-a" as PatchbayAgentId)).servers;
    expect(servers).toHaveLength(1);
    expect("command" in servers[0]!).toBe(true);
  });

  it("custom-stdio is handed through as-is either way", async () => {
    const h = harness([]);
    const id = await h.add("Local Tool", stdio("echo"));
    const { servers, given } = await configuredFor(h, "agent-a" as PatchbayAgentId, true);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "Local_Tool", command: "echo" });
    expect(given).toEqual([{ id, delivery: "stdio" }]);
  });
});

describe("McpServersStore — one composition of a session's set", () => {
  it("opens with the built-in editor server, carries the attach's token, and registers every crossing value for redaction", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "key-9", undefined, ALL);
    const { servers, given } = await h.manager.mcpServersFor("agent-a" as PatchbayAgentId, "ctx-7", true);
    expect(servers[0]).toEqual({
      name: "patchbay",
      command: process.execPath,
      args: ["/mcp-server.js"],
      env: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: "ACP_PATCHBAY_IPC", value: "/sock" },
        { name: "ACP_PATCHBAY_CONTEXT_TOKEN", value: "ctx-7" },
      ],
    });
    expect(given).toEqual([
      { id: "patchbay:editor", delivery: "stdio" },
      { id, delivery: "http" },
    ]);
    expect(h.crossed).toEqual(expect.arrayContaining(["/sock", "ctx-7", "Bearer key-9"]));
  });

  it("every server patchbay runs itself carries ELECTRON_RUN_AS_NODE — an agent that filters its environment would launch the editor", async () => {
    const h = harness([entry()]);
    await h.gates.connectWithKey("svc", "Service", "key-9", undefined, ALL);
    const { servers } = await h.manager.mcpServersFor("agent-a" as PatchbayAgentId, "ctx-7", false);
    const own = servers.filter((s) => "command" in s && s.command === process.execPath);
    expect(own.map((s) => s.name)).toEqual(["patchbay", "Service"]);
    for (const server of own) expect(envOf(server).ELECTRON_RUN_AS_NODE).toBe("1");
  });
});

describe("McpServersStore — the tool probe", () => {
  it("re-reads a curated server with its stored key, a fresh token where it signed in", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "key-7", undefined, ALL);
    await h.gates.probe(id);
    expect(h.probed).toEqual([
      { kind: "http", url: provider.mcpUrl, headers: { Authorization: "Bearer key-7" } },
      { kind: "http", url: provider.mcpUrl, headers: { Authorization: "Bearer key-7" } },
    ]);
  });

  it("a probe failure lands on the card as failed-with-reason, cleared by the next success", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "key-7", undefined, ALL);
    h.setProbeFn(async () => {
      throw new Error("boom");
    });
    await h.gates.probe(id);
    expect((await viewOf(h, id))?.probe).toMatchObject({ status: "failed", reason: "boom" });
    h.setProbeFn(async () => ({ serverName: "fake-server", serverVersion: "1.0", tools: [] }));
    await h.gates.probe(id);
    expect((await viewOf(h, id))?.probe).toMatchObject({ status: "ok", tools: [] });
  });

  it("a stdio probe failure names the directory it ran in", async () => {
    const h = harness([]);
    const id = await h.add("Local Tool", stdio("srv"));
    h.setProbeFn(async () => {
      throw new Error("Connection closed");
    });
    await h.gates.probe(id);
    expect((await viewOf(h, id))?.probe).toMatchObject({ status: "failed", reason: `Connection closed (ran in ${WORKSPACE_CWD})` });
  });
});

describe("McpServersStore — Copy and the erase", () => {
  it("exportJson writes the shape other clients take — every field of the type, the values the owner typed", async () => {
    const h = harness([entry()]);
    const filesId = await h.add("My Files", stdio("npx", ["-y", "files-server"], { FILES_KEY: "sk-1" }));
    const remoteId = await h.add("Remote", http("https://example.test/mcp", { "X-Key": "k" }));
    const bareId = await h.add("Bare", stdio("srv"));
    const curatedId = await h.gates.connectWithKey("svc", "Service", "pasted-key-1", undefined, ALL);

    expect(JSON.parse((await h.manager.exportJson(filesId))!)).toEqual({
      mcpServers: { My_Files: { type: "stdio", command: "npx", args: ["-y", "files-server"], env: { FILES_KEY: "sk-1" } } },
    });
    expect(JSON.parse((await h.manager.exportJson(remoteId))!)).toEqual({
      mcpServers: { Remote: { type: "http", url: "https://example.test/mcp", headers: { "X-Key": "k" } } },
    });
    // unfilled is empty, never left out
    expect(JSON.parse((await h.manager.exportJson(bareId))!)).toEqual({ mcpServers: { Bare: { type: "stdio", command: "srv", args: [], env: {} } } });
    // a curated entry copies as its endpoint, with the header its key goes in
    expect(JSON.parse((await h.manager.exportJson(curatedId))!)).toEqual({
      mcpServers: { Service: { type: "http", url: provider.mcpUrl, headers: { Authorization: "Bearer pasted-key-1" } } },
    });
    for (const id of [filesId, remoteId, curatedId]) {
      expect((await h.manager.exportJson(id))!).not.toMatch(/"routing"|"source"|"transport"/);
    }
  });

  it("an OAuth-minted token never rides the edit form or Copy — only what the owner typed does (issue #12)", async () => {
    const h = harness([entry()]);
    const curated = await h.gates.connectOAuth("svc", "Service", undefined, ALL);
    expect(JSON.parse((await h.manager.exportJson(curated))!).mcpServers.Service).toEqual({ type: "http", url: provider.mcpUrl, headers: {} });
    const custom = await h.add("Signed", http(provider.mcpUrl, { "X-Team": "t" }), ALL, true);
    const copied = (await h.manager.exportJson(custom))!;
    expect(JSON.parse(copied).mcpServers.Signed).toEqual({ type: "http", url: provider.mcpUrl, headers: { "X-Team": "t" } });
    expect(copied).not.toContain("access-1");
    expect(JSON.stringify((await viewOf(h, custom))?.draft)).not.toContain("access-1");
  });

  it("a curated connect stores the name the user gave it, as agents keep it — and connects more than once (#58)", async () => {
    const h = harness([entry()]);
    const first = await h.gates.connectWithKey("svc", "Service work", "key-work", undefined, ALL);
    const second = await h.gates.connectWithKey("svc", "Service work", "key-home", undefined, ALL);
    expect([h.configs.get(first)?.name, h.configs.get(second)?.name]).toEqual(["Service_work", "Service_work-2"]);
    expect([(await h.tokens.get(first))?.accessToken, (await h.tokens.get(second))?.accessToken]).toEqual(["key-work", "key-home"]);
  });

  it("the erase takes every server's secrets while their records still name them, then the records (#135)", async () => {
    const h = harness([entry()]);
    const id = await h.add("Files", stdio("files-server", [], { FILES_KEY: "sk-1" }));
    const remote = await h.add("Remote", http("https://example.test/mcp", { "X-Key": "k" }));
    const keyed = await h.gates.connectWithKey("svc", "Service", "k1", undefined, ALL);
    await h.manager.eraseAll();
    expect(h.configs.list()).toEqual([]);
    expect(await h.envStore.get(id)).toEqual({});
    expect(await h.headerStore.get(remote)).toEqual({});
    expect(await h.tokens.get(keyed)).toBeNull();
  });
});

describe("McpServersStore — an earlier version's servers", () => {
  it("a custom remote server's key moves into the header its record named, once, as its own headers", async () => {
    const kv = new MemoryKV();
    const secrets = new MemorySecrets();
    const tokens = new McpServerTokenStore(secrets);
    await kv.update(STORAGE_KEYS.mcpServersBefore090, [
      { id: "x", name: "X", source: { kind: "custom-http", url: "https://x.test/mcp", authType: "header", headerName: "X-Api-Key", valuePrefix: "" }, routing: "auto", active: true, transport: "auto" },
      { id: "b", name: "B", source: { kind: "custom-http", url: "https://b.test/mcp", authType: "header", headerName: "Authorization", valuePrefix: "Bearer " }, routing: "auto", active: true, transport: "auto" },
      { id: "o", name: "O", source: { kind: "custom-http", url: "https://o.test/mcp", authType: "oauth" }, routing: "auto", active: false, transport: "auto" },
      { id: "n", name: "N", source: { kind: "custom-http", url: "https://n.test/mcp", authType: "none" }, routing: "auto", active: true, transport: "auto" },
    ]);
    await tokens.set("x" as PatchbayMcpServerId, { accessToken: "kx" });
    await tokens.set("b" as PatchbayMcpServerId, { accessToken: "kb" });
    await tokens.set("o" as PatchbayMcpServerId, { accessToken: "signed", refreshToken: "r", tokenEndpoint: "t", clientId: "c" });
    const h = harness([], { kv, secrets });
    expect(h.configs.list().map((c) => [c.id, c.source, c.workspaces])).toEqual([
      ["x", { kind: "custom-http", url: "https://x.test/mcp", oauth: false }, "auto"],
      ["b", { kind: "custom-http", url: "https://b.test/mcp", oauth: false }, "auto"],
      ["o", { kind: "custom-http", url: "https://o.test/mcp", oauth: true }, []],
      ["n", { kind: "custom-http", url: "https://n.test/mcp", oauth: false }, "auto"],
    ]);
    // every read of a server's headers waits for the move
    expect(await h.manager.headers("x" as PatchbayMcpServerId)).toEqual({ "X-Api-Key": "kx" });
    expect(await h.manager.headers("b" as PatchbayMcpServerId)).toEqual({ Authorization: "Bearer kb" });
    expect(await h.manager.headers("o" as PatchbayMcpServerId)).toEqual({});
    expect(await h.manager.headers("n" as PatchbayMcpServerId)).toEqual({});
    // the key stays where a window still on that version reads it
    expect((await tokens.get("x" as PatchbayMcpServerId))?.accessToken).toBe("kx");
    expect(await h.manager.headersFor("o" as PatchbayMcpServerId, "agent-a" as PatchbayAgentId)).toBeNull(); // off everywhere
    // once: a header the owner removes later is never brought back
    await h.headerStore.set("x", {});
    const again = harness([], { kv, secrets });
    expect(await again.manager.headers("x" as PatchbayMcpServerId)).toEqual({});
  });
});

describe("McpServersStore — the lines: an add, a probe, a remove", () => {
  /** The browser tab that never answers. */
  const silentTab: OAuthUserAgent = {
    redirectUri: async () => "vscode://solutionsunity.acp-patchbay/oauth-callback",
    authorize: () => new Promise(() => {}),
  };

  it("a connect out shows running; told to stop, it stores nothing and leaves no failure", async () => {
    const h = harness([entry()], { userAgent: silentTab });
    const flow = h.gates.connectOAuth("svc", "Service", undefined, ALL).catch((err: unknown) => err);
    expect(await published(h)).toEqual([expect.objectContaining({ key: "catalog:svc", kind: "catalog", subject: "svc", status: "running" })]);
    await h.gates.cancel("catalog:svc");
    expect(await flow).toMatchObject({ by: "cancel" });
    expect(await published(h)).toEqual([]);
    expect(h.storedKeys).toEqual([]);
    expect(h.configs.list()).toEqual([]);
  });

  it("no clock gives a browser flow up — the wait ends with the connect, at the tab itself", async () => {
    let waitSignal: AbortSignal | undefined;
    const h = harness([entry()], {
      userAgent: {
        ...silentTab,
        authorize: (_url, _state, signal) => {
          waitSignal = signal;
          return new Promise(() => {});
        },
      },
    });
    const flow = h.gates.connectOAuth("svc", "Service", undefined, ALL).catch((err: unknown) => err);
    await vi.waitFor(() => expect(waitSignal).toBeDefined(), SETTLE);
    expect(waitSignal?.aborted).toBe(false);
    await h.gates.cancel("catalog:svc");
    expect(await flow).toMatchObject({ by: "cancel" });
    expect(waitSignal?.aborted).toBe(true);
  });

  it("a second Connect while a card's browser flow is out is that flow — one tab, one outcome", async () => {
    let tabs = 0;
    const h = harness([entry()], { userAgent: { ...silentTab, authorize: () => (tabs++, new Promise(() => {})) } });
    const first = h.gates.connectOAuth("svc", "Service", undefined, ALL).catch((err: unknown) => err);
    const second = h.gates.connectOAuth("svc", "Service", undefined, ALL).catch((err: unknown) => err);
    await vi.waitFor(() => expect(tabs).toBeGreaterThan(0), SETTLE);
    await h.gates.cancel("catalog:svc");
    expect(await first).toMatchObject({ by: "cancel" });
    expect(await second).toMatchObject({ by: "cancel" });
    expect(tabs).toBe(1);
  });

  it("an add's check that hangs is told to stop by Cancel — nothing is stored", async () => {
    const h = harness([]);
    let told = false;
    h.setProbeFn((_target, signal) => {
      signal?.addEventListener("abort", () => (told = true), { once: true });
      return new Promise(() => {});
    });
    const adding = h.add("Slow", stdio("srv")).catch((err: unknown) => err);
    await vi.waitFor(async () => expect(await published(h)).toEqual([expect.objectContaining({ key: "custom:Slow", status: "running" })]), SETTLE);
    await h.gates.cancel("custom:Slow");
    expect(await adding).toMatchObject({ by: "cancel" });
    expect(told).toBe(true);
    expect(h.configs.list()).toEqual([]);
    expect(await published(h)).toEqual([]);
  });

  it("a failure is held until dismissed", async () => {
    const h = harness([entry({ auth: { header: null, oauth: false } })]);
    await h.gates.connectWithKey("svc", "Service", "k", undefined, ALL).catch(() => {});
    expect(await published(h)).toEqual([failure("catalog:svc", /no API-key mode/)]);
    await h.gates.cancel("catalog:svc");
    expect(await published(h)).toEqual([]);
  });

  it("a probe on the line is the server's busy state; a second probe joins it", async () => {
    const h = harness([]);
    const slow = await h.add("Slow", stdio("srv"));
    let release!: () => void;
    let probes = 0;
    h.setProbeFn(() => {
      probes++;
      return new Promise((resolve) => {
        release = () => resolve({ serverName: "slow", serverVersion: "1", tools: [] });
      });
    });
    const one = h.gates.probe(slow);
    const two = h.gates.probe(slow);
    await vi.waitFor(() => expect(probes).toBeGreaterThan(0), SETTLE);
    expect((await viewOf(h, slow))?.busy).toEqual(["probe"]);
    release();
    await Promise.all([one, two]);
    expect(probes).toBe(1);
  });

  it("Remove cuts in: a probe still running is told to stop, keeps no outcome, and the server is gone", async () => {
    const h = harness([]);
    const hung = await h.add("Hung", stdio("srv"));
    let started = false;
    let told = false;
    h.setProbeFn((_target, signal) => {
      started = true;
      signal?.addEventListener("abort", () => (told = true), { once: true });
      return new Promise(() => {});
    });
    const probing = h.gates.probe(hung).catch((err: unknown) => err);
    await vi.waitFor(() => expect(started).toBe(true), SETTLE);
    await h.gates.remove(hung);
    expect(told).toBe(true);
    expect(await probing).toMatchObject({ by: "remove" });
    expect(h.configs.get(hung)).toBeUndefined();
    expect(await viewOf(h, hung)).toBeUndefined();
  });
});

describe("McpServersStore — a bridge's headers", () => {
  it("refreshes a near-expiry OAuth token with the captured context", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectOAuth("svc", "Service", undefined, ALL);
    const stored = (await h.tokens.get(id))!;
    await h.tokens.set(id, { ...stored, expiresAt: new Date(Date.now() + 1000).toISOString() });
    expect(await h.manager.headersFor(id, "agent-a" as PatchbayAgentId)).toEqual({ Authorization: "Bearer refreshed-2" });
    expect((await h.tokens.get(id))?.accessToken).toBe("refreshed-2");
  });

  it("asked at once by several, a near-expiry credential spends its refresh token once", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectOAuth("svc", "Service", undefined, ALL);
    const stored = (await h.tokens.get(id))!;
    await h.tokens.set(id, { ...stored, expiresAt: new Date(Date.now() + 1000).toISOString() });
    const answers = await Promise.all([
      h.manager.headersFor(id, "agent-a" as PatchbayAgentId),
      h.manager.headersFor(id, "agent-b" as PatchbayAgentId),
      h.manager.headersFor(id, "agent-a" as PatchbayAgentId),
    ]);
    expect(answers.map((a) => a?.Authorization)).toEqual(["Bearer refreshed-2", "Bearer refreshed-2", "Bearer refreshed-2"]);
    expect(provider.tokenRequests.filter((r) => r.get("grant_type") === "refresh_token")).toHaveLength(1);
  });

  it("a refresh that lands after the server was removed stores nothing", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectOAuth("svc", "Service", undefined, ALL);
    const stored = (await h.tokens.get(id))!;
    await h.tokens.set(id, { ...stored, expiresAt: new Date(Date.now() + 1000).toISOString() });
    const asked = h.manager.headersFor(id, "agent-a" as PatchbayAgentId);
    await h.gates.remove(id);
    await asked;
    expect(await h.tokens.get(id)).toBeNull();
  });

  it("returns null for a server it doesn't hold", async () => {
    const h = harness([entry()]);
    expect(await h.manager.headersFor("svc" as PatchbayMcpServerId, "agent-a" as PatchbayAgentId)).toBeNull();
  });

  it("answers only while the server reaches the agent — switching it off, re-routing or removing it reaches a running bridge (#72)", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "static-key", undefined, ALL);
    const bearer = { Authorization: "Bearer static-key" };
    expect(await h.manager.headersFor(id, "agent-a" as PatchbayAgentId)).toEqual(bearer);
    await h.manager.setRouting(id, ["agent-b" as PatchbayAgentId]);
    expect(await h.manager.headersFor(id, "agent-a" as PatchbayAgentId)).toBeNull();
    expect(await h.manager.headersFor(id, "agent-b" as PatchbayAgentId)).toEqual(bearer);
    await h.manager.setWorkspaces(id, []);
    expect(await h.manager.headersFor(id, "agent-b" as PatchbayAgentId)).toBeNull();
    await h.manager.setWorkspaces(id, "auto");
    await h.gates.remove(id);
    expect(await h.manager.headersFor(id, "agent-b" as PatchbayAgentId)).toBeNull();
  });
});

// Patchbay's own server: read-only in Settings, but what it serves is read
// the way a user server's is — a handshake with the spawn agents are handed.
describe("McpServersStore — the built-in editor server", () => {
  const builtinOf = (h: ReturnType<typeof harness>) => {
    const last = lastEvent(h.events, "mcpServersChanged");
    return last?.kind === "mcpServersChanged" ? last.builtin : [];
  };

  it("is published read-only and unchecked until its page asks", async () => {
    const h = harness([]);
    await h.manager.refresh();
    expect(builtinOf(h)).toEqual([{ id: "patchbay:editor", name: "patchbay", probe: undefined, busy: [] }]);
    expect(h.probed).toEqual([]);
  });

  it("is checked through the launch every agent is handed, under a token no attach minted", async () => {
    const h = harness([]);
    await h.gates.checkBuiltin();
    const { servers } = await h.manager.mcpServersFor("agent-a" as PatchbayAgentId, "ctx-7", false);
    const attached = servers[0]!;
    const probe = h.probed[0]!;
    expect(probe).toMatchObject({ kind: "stdio", command: (attached as { command: string }).command, args: ["/mcp-server.js"], cwd: WORKSPACE_CWD });
    const env = probe.kind === "stdio" ? probe.env : {};
    expect(env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1", ACP_PATCHBAY_IPC: "/sock" });
    expect(env.ACP_PATCHBAY_CONTEXT_TOKEN).toMatch(/^[0-9a-f-]{36}$/);
    // a check is no attach: nothing it carries is a value an agent was handed
    expect(h.crossed).not.toContain(env.ACP_PATCHBAY_CONTEXT_TOKEN);
    await h.manager.refresh();
    expect(builtinOf(h)[0]?.probe).toMatchObject({ status: "ok", serverName: "fake-server", tools: [{ name: "t_one" }] });
  });

  it("opening its page again reads nothing new — a reading stays until refreshed", async () => {
    const h = harness([]);
    await h.gates.checkBuiltin();
    await h.gates.checkBuiltin();
    expect(h.probed).toHaveLength(1);
    await h.gates.probe("patchbay:editor" as PatchbayMcpServerId);
    expect(h.probed).toHaveLength(2);
  });

  it("a failed check is a reading too: it shows the reason, and the page doesn't retry it on its own", async () => {
    const h = harness([]);
    h.setProbeFn(async () => {
      throw new Error("spawn ENOENT");
    });
    await h.gates.checkBuiltin();
    await h.gates.checkBuiltin();
    await h.manager.refresh();
    expect(builtinOf(h)[0]?.probe).toMatchObject({ status: "failed", reason: `spawn ENOENT (ran in ${WORKSPACE_CWD})` });
  });

  it("is never removed — a remove naming it changes nothing", async () => {
    const h = harness([]);
    await h.gates.checkBuiltin();
    await h.gates.remove("patchbay:editor" as PatchbayMcpServerId);
    await h.manager.refresh();
    expect(builtinOf(h)[0]?.probe).toMatchObject({ status: "ok" });
    const { given } = await h.manager.mcpServersFor("agent-a" as PatchbayAgentId, "ctx-7", false);
    expect(given[0]).toEqual({ id: "patchbay:editor", delivery: "stdio" });
  });
});
