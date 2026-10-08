// The MCP-servers store: catalog key/OAuth connects, custom escape hatch,
// routing, and mcpServers construction — against a real fake MCP-spec OAuth
// provider (test/support/fake-oauth-provider.ts) and an in-memory global
// server-config store (MCP servers are global, developer-env, never
// repo-committed — stores/mcp-server-configs.ts). No mocks of
// McpServersStore's own collaborators. The live half (a real agent
// calling tools through the real bridge subprocess) is
// test/mcp-bridge.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServerGates } from "../src/orchestrator/mcp-server-gates";
import { McpServersStore } from "../src/orchestrator/mcp-servers-store";
import { Queue } from "../src/orchestrator/queue";
import type { ProbeFn, ProbeTarget } from "../src/orchestrator/mcp-probe";
import { McpServerConfigStore } from "../src/orchestrator/stores/mcp-server-configs";
import { McpServerTokenStore, MemorySecrets } from "../src/orchestrator/stores/mcp-server-tokens";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import type { CatalogEntry } from "../src/orchestrator/stores/mcp-catalog";
import { SecretEnvStore } from "../src/orchestrator/stores/secret-env";
import type { McpImportReviewView, McpServerConnectView, McpServerWork, SettingsEvent } from "../src/shared/protocol";
import type { OAuthUserAgent } from "../src/orchestrator/mcp-oauth";
import { FakeOAuthProvider, fakeUserAgent } from "./support/fake-oauth-provider";
import type { PatchbayAgentId, PatchbayMcpServerId } from "../src/shared/ids";

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

function harness(catalog: CatalogEntry[], opts: { userAgent?: OAuthUserAgent } = {}) {
  const events: SettingsEvent[] = [];
  const configs = new McpServerConfigStore(new MemoryKV());
  const secrets = new MemorySecrets();
  // Every key a secret was written under — what "stores nothing" checks.
  const storedKeys: string[] = [];
  // Every value an attach handed to an agent, as the wire log hears it.
  const crossed: string[] = [];
  const store = secrets.store.bind(secrets);
  secrets.store = (key, value) => (storedKeys.push(key), store(key, value));
  const tokens = new McpServerTokenStore(secrets);
  const envStore = new SecretEnvStore(secrets, "acpPatchbay.integration");
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
    tokens,
    envStore,
    { emit: (...evs) => events.push(...evs) },
    { busy: (patchbayMcpServerId) => serverLine.held(patchbayMcpServerId), connecting: () => connectLine.holding() },
    {
      editorServerScript: "/mcp-server.js",
      bridgeScript: "/bridge.js",
      socketPath: () => "/sock",
      crossing: (value) => crossed.push(value),
    },
    WORKSPACE_CWD,
    opts.userAgent ?? fakeUserAgent(),
    undefined,
    (target, signal) => probeFn(target, signal),
  );
  const gates = new McpServerGates(manager, serverLine, connectLine);
  return {
    manager, gates, configs, tokens, envStore, events, probed, storedKeys, crossed,
    setProbeFn(fn: ProbeFn) { probeFn = fn; },
  };
}

/** The connects the store last published — running ones and held
 * failures. */
function connects(events: readonly SettingsEvent[]): readonly McpServerConnectView[] {
  const last = [...events].reverse().find((e) => e.kind === "mcpServersChanged");
  return last?.kind === "mcpServersChanged" ? last.connects : [];
}

/** The import under review as published once the store has published
 * again — null when none is. */
async function review(h: { manager: McpServersStore; events: SettingsEvent[] }): Promise<McpImportReviewView | null> {
  await h.manager.refresh();
  const last = [...h.events].reverse().find((e) => e.kind === "mcpServersChanged");
  return last?.kind === "mcpServersChanged" ? last.importReview : null;
}

/** The connects as published once the store has published again — a line
 * move republishes on its own, a beat after the operation settles. */
async function published(h: { manager: McpServersStore; events: SettingsEvent[] }): Promise<readonly McpServerConnectView[]> {
  await h.manager.refresh();
  return connects(h.events);
}

/** A session's set without the built-in editor server, which leads every
 * one — what the configured servers contributed. */
async function configuredFor(h: { manager: McpServersStore }, patchbayAgentId: PatchbayAgentId, declaresHttp = false) {
  const { servers, given } = await h.manager.mcpServersFor(patchbayAgentId, "ctx-1", declaresHttp);
  return { servers: servers.slice(1), given: given.slice(1) };
}

/** A stored server by its display name — ids are minted. */
function named(h: { configs: McpServerConfigStore }, name: string) {
  return h.configs.list().find((c) => c.name === name);
}

function failure(key: string, reason: RegExp) {
  return expect.objectContaining({ key, status: "failed", reason: expect.stringMatching(reason) });
}

describe("McpServerConfigStore — saved records", () => {
  it("a server stored from the catalog under its old name reads as a catalog server — nothing dropped", async () => {
    const kv = new MemoryKV();
    await kv.update("acpPatchbay.integrations", [
      { id: "old", name: "GitHub", source: { kind: "registry", registryId: "github", authMode: "oauth" } },
      { id: "own", name: "Mine", source: { kind: "custom-stdio", command: "srv", args: [] } },
    ]);
    const configs = new McpServerConfigStore(kv);
    expect(configs.list().map((c) => c.source)).toEqual([
      { kind: "catalog", catalogId: "github", authMode: "oauth" },
      { kind: "custom-stdio", command: "srv", args: [] },
    ]);
    // rewritten on disk, so the next read has nothing left to fold
    expect(JSON.stringify(kv.get("acpPatchbay.integrations"))).not.toContain("registry");
  });

  it("a name stored before names were cut to what agents keep is rewritten once, as agents already read it; one that then collides, or is the built-in's, gets a number", async () => {
    const kv = new MemoryKV();
    const stdio = { kind: "custom-stdio", command: "srv", args: [] };
    await kv.update("acpPatchbay.integrations", [
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

describe("McpServersStore — key connect (the v1 floor)", () => {
  it("stores the pasted key and upserts the config entry with authMode header", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "pasted-key-1");

    expect((await h.tokens.get(id))?.accessToken).toBe("pasted-key-1");
    // the connect probed the server before it settled; published once
    // more, the last view is the post-probe one
    await h.manager.refresh();
    const changed = h.events.filter((e) => e.kind === "mcpServersChanged").at(-1);
    expect(changed?.kind === "mcpServersChanged" && changed.servers).toEqual([
      {
        id,
        name: "Service",
        sourceKind: "catalog",
        catalogId: "svc",
        command: undefined,
        connected: true,
        active: true,
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
        editJson: undefined,
      },
    ]);

    expect(h.configs.get(id)?.source).toMatchObject({
      kind: "catalog",
      catalogId: "svc",
      authMode: "header",
    });
    // the raw key never touches the non-secret config record
    expect(JSON.stringify(h.configs.list())).not.toContain("pasted-key-1");
  });

  it("a per-account entry (userUrl) requires the user's endpoint and persists it", async () => {
    const h = harness([entry({ url: "", userUrl: true })]);
    await expect(h.gates.connectWithKey("svc", "Service", "k")).rejects.toThrow(/endpoint URL/);
    expect(await published(h)).toEqual([failure("catalog:svc", /endpoint URL/)]);

    const id = await h.gates.connectWithKey("svc", "Service", "k", "https://mine.example.test/mcp");
    expect(h.configs.get(id)?.source).toMatchObject({
      url: "https://mine.example.test/mcp",
    });
    // the attempt that worked cleared the held failure
    expect(await published(h)).toEqual([]);
  });

  it("refuses on an entry with no key mode", async () => {
    const h = harness([entry({ auth: { header: null, oauth: false } })]);
    await expect(h.gates.connectWithKey("svc", "Service", "k")).rejects.toThrow(/no API-key mode/);
    expect(await published(h)).toEqual([failure("catalog:svc", /no API-key mode/)]);
    expect(h.storedKeys).toEqual([]);
  });
});

describe("McpServersStore — OAuth connect (MCP-spec, discovery + DCR + PKCE)", () => {
  it("connects with only the entry's URL and captures refresh context alongside the token", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectOAuth("svc", "Service");

    const stored = await h.tokens.get(id);
    expect(stored).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      tokenEndpoint: provider.tokenEndpoint,
      clientId: "dcr-client-1",
    });
    expect(h.configs.get(id)?.source).toMatchObject({ authMode: "oauth" });
  });

  it("gated DCR fails labeled — pitfall §2, pointing at the key path", async () => {
    provider.gateDcr = true;
    const h = harness([entry()]);
    await expect(h.gates.connectOAuth("svc", "Service")).rejects.toThrow(/API-key path/);
    expect(await published(h)).toEqual([failure("catalog:svc", /API-key path/)]);
    expect(h.storedKeys).toEqual([]);
  });

  it("refuses on an entry without an OAuth mode", async () => {
    const h = harness([entry({ auth: { header: { headerName: "Authorization", valuePrefix: "Bearer ", hint: "", keyUrl: "" }, oauth: false } })]);
    await expect(h.gates.connectOAuth("svc", "Service")).rejects.toThrow(/no OAuth mode/);
    expect(await published(h)).toEqual([failure("catalog:svc", /no OAuth mode/)]);
  });
});

describe("McpServersStore — custom escape hatch", () => {
  it("custom-stdio needs no token and is immediately connected", async () => {
    const h = harness([]);
    const id = await h.gates.addCustom(
      "Local Tool",
      { kind: "custom-stdio", command: "echo", args: ["hi"], env: {} },
      "auto",
    );
    await h.manager.refresh();
    const changed = h.events.filter((e) => e.kind === "mcpServersChanged").at(-1);
    expect(changed?.kind === "mcpServersChanged" && changed.servers[0]).toMatchObject({
      id,
      sourceKind: "custom-stdio",
      connected: true,
    });
  });

  it("custom-http header auth stores the key in SecretStorage, never in config — custom header names included", async () => {
    const h = harness([]);
    const id = await h.gates.addCustom(
      "Stitch-like",
      {
        kind: "custom-http",
        url: "https://example.test/mcp",
        authType: "header",
        headerName: "X-Goog-Api-Key",
        valuePrefix: "",
        token: "secret-abc",
      },
      "auto",
    );
    expect((await h.tokens.get(id))?.accessToken).toBe("secret-abc");
    const serialized = JSON.stringify(h.configs.list());
    expect(serialized).not.toContain("secret-abc");
    expect(serialized).toContain("X-Goog-Api-Key");
  });

  it("custom-http OAuth runs the same MCP-spec flow as catalog entries", async () => {
    const h = harness([]);
    const id = await h.gates.addCustom(
      "My OAuth",
      { kind: "custom-http", url: provider.mcpUrl, authType: "oauth" },
      "auto",
    );
    expect((await h.tokens.get(id))?.accessToken).toBe("access-1");
  });

  it("disconnect is remove — the full clear; the catalog entry stays", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "static-key");
    expect(h.configs.get(id)).toBeDefined();

    await h.gates.remove(id);
    expect(await h.tokens.get(id)).toBeNull();
    expect(h.configs.list()).toEqual([]);
    // the catalog entry itself is shipped data — still there, ready to reconnect
    expect(h.manager.catalogViews().some((r) => r.id === "svc")).toBe(true);
  });

  it("inactive keeps config and credential but reaches no agent until toggled back", async () => {
    const h = harness([]);
    const id = await h.gates.addCustom(
      "Mute Me",
      { kind: "custom-http", url: "https://example.test/mcp", authType: "header", token: "secret-abc" },
      ["agent-a"],
    );
    expect((await configuredFor(h, "agent-a" as PatchbayAgentId, false)).servers).toHaveLength(1);

    await h.manager.setActive(id, false);
    expect((await configuredFor(h, "agent-a" as PatchbayAgentId, false)).servers).toEqual([]);
    expect(await h.tokens.get(id)).not.toBeNull(); // credential intact — muted, not disconnected

    await h.manager.setActive(id, true);
    expect((await configuredFor(h, "agent-a" as PatchbayAgentId, false)).servers).toHaveLength(1);
  });

  it("a failed custom OAuth add stores nothing — no stranded credential-less record", async () => {
    const h = harness([]);
    provider.denyConsent = true; // user rejects in the browser
    await expect(
      h.gates.addCustom("OAuth Fail", { kind: "custom-http", url: provider.mcpUrl, authType: "oauth" }, "auto"),
    ).rejects.toThrow();
    expect(h.configs.list()).toEqual([]);
    expect(h.storedKeys).toEqual([]);
    expect(await published(h)).toEqual([failure("custom:OAuth Fail", /./)]);
  });

  it("a blank key on a custom header add fails labeled, storing nothing", async () => {
    const h = harness([]);
    await expect(
      h.gates.addCustom("No Key", { kind: "custom-http", url: "https://example.test/mcp", authType: "header" }, "auto"),
    ).rejects.toThrow(/key is empty/);
    expect(h.configs.list()).toEqual([]);
    expect(h.storedKeys).toEqual([]);
    expect(await published(h)).toEqual([failure("custom:No Key", /key is empty/)]);
  });

  it("remove deletes both the token and the config entry", async () => {
    const h = harness([]);
    const id = await h.gates.addCustom("Local Tool", { kind: "custom-stdio", command: "echo", args: [], env: {} }, "auto");
    await h.gates.remove(id);
    expect(h.configs.list()).toEqual([]);
  });
});

describe("McpServersStore — routing and mcpServers", () => {
  it("auto reaches every agent; an explicit list pins exactly; except narrows", async () => {
    const h = harness([]);
    await h.gates.addCustom("Auto Tool", { kind: "custom-stdio", command: "echo", args: [], env: {} }, "auto");
    await h.gates.addCustom("Pinned Tool", { kind: "custom-stdio", command: "echo", args: [], env: {} }, [
      "agent-b",
    ]);
    await h.gates.addCustom("Except Tool", { kind: "custom-stdio", command: "echo", args: [], env: {} }, {
      except: ["agent-a"],
    });

    const agentA = (await configuredFor(h, "agent-a" as PatchbayAgentId, false)).servers;
    expect(agentA.map((s) => s.name)).toEqual(["Auto_Tool"]);

    const agentB = (await configuredFor(h, "agent-b" as PatchbayAgentId, false)).servers;
    expect(agentB.map((s) => s.name)).toEqual(["Auto_Tool", "Pinned_Tool", "Except_Tool"]);
  });

  it("the bridge env carries the server's own header shape — Stitch-style custom headers included", async () => {
    const h = harness([
      entry({
        id: "stitch",
        name: "Stitch",
        auth: { header: { headerName: "X-Goog-Api-Key", valuePrefix: "", hint: "", keyUrl: "" }, oauth: false },
      }),
    ]);
    await h.gates.connectWithKey("stitch", "Stitch", "goog-key");

    const servers = (await configuredFor(h, "agent-a" as PatchbayAgentId, false)).servers;
    expect(servers).toHaveLength(1);
    const env = envOf(servers[0]!);
    expect(env.ACP_PATCHBAY_AUTH_HEADER).toBe("X-Goog-Api-Key");
    expect(env.ACP_PATCHBAY_AUTH_PREFIX).toBe("");
    expect(env.ACP_PATCHBAY_MCP_SERVER_URL).toBe(provider.mcpUrl);
  });

  it("an OAuth-connected server rides Authorization: Bearer regardless of the entry's key-header shape", async () => {
    const h = harness([
      entry({
        id: "svc",
        auth: { header: { headerName: "X-Custom", valuePrefix: "", hint: "", keyUrl: "" }, oauth: true },
      }),
    ]);
    await h.gates.connectOAuth("svc", "Service");

    const servers = (await configuredFor(h, "agent-a" as PatchbayAgentId, false)).servers;
    const env = envOf(servers[0]!);
    expect(env.ACP_PATCHBAY_AUTH_HEADER).toBe("Authorization");
    expect(env.ACP_PATCHBAY_AUTH_PREFIX).toBe("Bearer ");
  });

  it("a per-account entry's user-supplied URL is what reaches the bridge", async () => {
    const h = harness([entry({ id: "acct", url: "", userUrl: true })]);
    await h.gates.connectWithKey("acct", "Service", "k", "https://mine.example.test/mcp");
    const servers = (await configuredFor(h, "agent-a" as PatchbayAgentId, false)).servers;
    const env = envOf(servers[0]!);
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
      active: true,
      transport: "auto",
    });
    const servers = (await configuredFor(h, "agent-a" as PatchbayAgentId, false)).servers;
    expect(servers).toEqual([]);
  });

  it("setRouting persists a new explicit agent list", async () => {
    const h = harness([]);
    const id = await h.gates.addCustom("T1", { kind: "custom-stdio", command: "echo", args: [], env: {} }, "auto");
    await h.manager.setRouting(id, ["agent-x"]);
    expect(h.configs.get(id)?.routing).toEqual(["agent-x"]);
  });

  it("a custom-stdio command line is parsed quote-aware, never stored as one executable string", async () => {
    const h = harness([]);
    const id = await h.gates.addCustom(
      "Srv",
      { kind: "custom-stdio", command: 'npx some-server --root "/tmp/my dir"', args: [], env: {} },
      "auto",
    );
    const stored = h.configs.get(id)!;
    expect(stored.source).toMatchObject({
      kind: "custom-stdio",
      command: "npx",
      args: ["some-server", "--root", "/tmp/my dir"],
    });
    // and the agent receives it split the same way
    const servers = (await configuredFor(h, "agent-a" as PatchbayAgentId, false)).servers;
    expect(servers[0]).toMatchObject({ command: "npx", args: ["some-server", "--root", "/tmp/my dir"] });
  });

  it("custom-stdio env values land in SecretStorage, never the config record — served to the agent only at attach", async () => {
    const h = harness([]);
    const id = await h.gates.addCustom(
      "Keyed",
      { kind: "custom-stdio", command: "srv", args: [], env: { SRV_API_KEY: "sk-secret" } },
      "auto",
    );
    // config record carries no env at all
    expect("env" in (h.configs.get(id)!.source as object)).toBe(false);
    // the value round-trips through the secret store...
    expect(await h.envStore.get(id)).toEqual({ SRV_API_KEY: "sk-secret" });
    // ...and reaches the agent's spawn config at attach time
    const servers = (await configuredFor(h, "agent-a" as PatchbayAgentId, false)).servers;
    expect(envOf(servers[0]!)).toEqual({ SRV_API_KEY: "sk-secret" });
    // remove purges it with the rest
    await h.gates.remove(id);
    expect(await h.envStore.get(id)).toEqual({});
  });

  it("an unterminated quote in a custom-stdio line fails labeled, storing nothing", async () => {
    const h = harness([]);
    await expect(
      h.gates.addCustom("Bad", { kind: "custom-stdio", command: 'npx "broken', args: [], env: {} }, "auto"),
    ).rejects.toThrow(/quote/);
    expect(h.configs.list()).toEqual([]);
    expect(await published(h)).toEqual([failure("custom:Bad", /quote/)]);
  });
});

describe("McpServersStore — http passthrough (prompt.image mechanics)", () => {
  it("an agent declaring mcp.http gets a type:http entry with the credential in headers", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "key-9");

    const { servers, given } = await configuredFor(h, "agent-a" as PatchbayAgentId, true);
    expect(servers).toEqual([
      {
        type: "http",
        name: "Service",
        url: provider.mcpUrl,
        headers: [{ name: "Authorization", value: "Bearer key-9" }],
      },
    ]);
    expect(given).toEqual([{ id, delivery: "http" }]);
  });

  it("transport 'bridge' pins the stdio bridge even for a declaring agent (the escape hatch)", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "key-9");
    await h.manager.setTransport(id, "bridge");

    const { servers, given } = await configuredFor(h, "agent-a" as PatchbayAgentId, true);
    expect(servers).toHaveLength(1);
    expect("command" in servers[0]!).toBe(true);
    expect(envOf(servers[0]!).ACP_PATCHBAY_MCP_SERVER_ID).toBe(id);
    // the one delivery that asks patchbay for the credential
    expect(given).toEqual([{ id, delivery: "bridge" }]);
  });

  it("a non-declaring agent rides the bridge regardless of transport 'auto'", async () => {
    const h = harness([entry()]);
    await h.gates.connectWithKey("svc", "Service", "key-9");

    const servers = (await configuredFor(h, "agent-a" as PatchbayAgentId, false)).servers;
    expect(servers).toHaveLength(1);
    expect("command" in servers[0]!).toBe(true);
  });

  it("custom-stdio is handed through as-is either way", async () => {
    const h = harness([]);
    const id = await h.gates.addCustom("Local Tool", { kind: "custom-stdio", command: "echo", args: [], env: {} }, "auto");

    const { servers, given } = await configuredFor(h, "agent-a" as PatchbayAgentId, true);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "Local_Tool", command: "echo" });
    expect(given).toEqual([{ id, delivery: "stdio" }]);
  });
});

describe("McpServersStore — one composition of a session's set", () => {
  it("opens with the built-in editor server, carries the attach's token, and registers every crossing value for redaction", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "key-9");
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
    await h.gates.connectWithKey("svc", "Service", "key-9");
    const { servers } = await h.manager.mcpServersFor("agent-a" as PatchbayAgentId, "ctx-7", false);
    const own = servers.filter((s) => "command" in s && s.command === process.execPath);
    expect(own.map((s) => s.name)).toEqual(["patchbay", "Service"]);
    for (const server of own) expect(envOf(server).ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("no configured server takes the built-in's name", async () => {
    const h = harness([]);
    await h.gates.addCustom("patchbay", { kind: "custom-stdio", command: "a", args: [], env: {} }, "auto");
    expect(h.configs.list().map((c) => c.name)).toEqual(["patchbay-2"]);
  });
});

describe("McpServersStore — connect-time tool probe", () => {
  it("connect kicks a probe with the resolved endpoint and fresh credential", async () => {
    const h = harness([entry()]);
    await h.gates.connectWithKey("svc", "Service", "key-7");

    expect(h.probed).toEqual([
      {
        kind: "http",
        url: provider.mcpUrl,
        header: { name: "Authorization", value: "Bearer key-7" },
      },
    ]);
  });

  it("probing a custom-stdio server carries its command, SecretStorage env, and the workspace cwd the agent's spawn will inherit", async () => {
    const h = harness([]);
    await h.gates.addCustom(
      "Local Tool",
      { kind: "custom-stdio", command: "echo", args: ["hi"], env: { MY_KEY: "v1" } },
      "auto",
    );

    expect(h.probed).toEqual([
      { kind: "stdio", command: "echo", args: ["hi"], env: { MY_KEY: "v1" }, cwd: WORKSPACE_CWD },
    ]);
  });

  it("a custom-stdio probe failure names the directory it ran in", async () => {
    const h = harness([]);
    h.setProbeFn(async () => {
      throw new Error("Connection closed");
    });
    await h.gates.addCustom("Local Tool", { kind: "custom-stdio", command: "srv", args: [], env: {} }, "auto");
    await h.manager.refresh();

    const failed = h.events.filter((e) => e.kind === "mcpServersChanged").at(-1);
    expect(failed?.kind === "mcpServersChanged" && failed.servers[0]?.probe).toMatchObject({
      status: "failed",
      reason: `Connection closed (ran in ${WORKSPACE_CWD})`,
    });
  });

  it("a probe failure lands on the card as failed-with-reason, cleared by the next success", async () => {
    const h = harness([entry()]);
    let fail = true;
    h.setProbeFn(async (target) => {
      if (fail) throw new Error("boom");
      h.probed.push(target);
      return { serverName: "fake-server", serverVersion: "1.0", tools: [] };
    });
    const id = await h.gates.connectWithKey("svc", "Service", "key-7");
    await h.manager.refresh();

    const failed = h.events.filter((e) => e.kind === "mcpServersChanged").at(-1);
    expect(failed?.kind === "mcpServersChanged" && failed.servers[0]?.probe).toMatchObject({
      status: "failed",
      reason: "boom",
    });

    fail = false;
    await h.gates.probe(id);
    await h.manager.refresh();
    const ok = h.events.filter((e) => e.kind === "mcpServersChanged").at(-1);
    expect(ok?.kind === "mcpServersChanged" && ok.servers[0]?.probe).toMatchObject({
      status: "ok",
      tools: [],
    });
  });
});

describe("McpServersStore — JSON import and edit (the well-known mcpServers shape)", () => {
  it("an import reads its entries into a review and adds nothing; Add all adds each under the name chosen there", async () => {
    const h = harness([]);
    await h.gates.importJson(
      JSON.stringify({
        mcpServers: {
          "My Files": { command: "npx", args: ["-y", "files-server"], env: { FILES_KEY: "sk-1" } },
          remote: { url: "https://example.test/mcp" },
          broken: { neither: true },
        },
      }),
    );
    expect(h.configs.list()).toEqual([]);
    const pending = await review(h);
    expect(pending?.entries).toEqual([
      { name: "My Files", summary: "npx -y files-server" },
      { name: "remote", summary: "https://example.test/mcp" },
    ]);
    expect(await published(h)).toEqual([failure("import:broken", /neither a command entry nor a url entry/)]);

    await h.gates.addImported(pending!.id, ["files", "remote"]);
    expect(named(h, "files")?.source).toMatchObject({
      kind: "custom-stdio",
      command: "npx",
      args: ["-y", "files-server"],
    });
    expect(await h.envStore.get(named(h, "files")!.id)).toEqual({ FILES_KEY: "sk-1" });
    expect(named(h, "remote")?.source).toMatchObject({
      kind: "custom-http",
      url: "https://example.test/mcp",
      authType: "none",
    });
    expect(named(h, "broken")).toBeUndefined();
    expect(await review(h)).toBeNull();
  });

  it("a review answered after a newer import replaced it, or after it was cancelled, adds nothing", async () => {
    const h = harness([]);
    const doc = (name: string) => JSON.stringify({ mcpServers: { [name]: { command: "srv", args: [] } } });
    await h.gates.importJson(doc("first"));
    const stale = (await review(h))!.id;
    await h.gates.importJson(doc("second"));
    await h.gates.addImported(stale, ["first"]);
    expect(h.configs.list()).toEqual([]);
    expect((await review(h))?.entries.map((e) => e.name)).toEqual(["second"]);

    await h.manager.cancelImport((await review(h))!.id);
    expect(await review(h)).toBeNull();
    expect(h.configs.list()).toEqual([]);
  });

  it("a name another server holds gets a number — nothing is overwritten, and no agent sees two of one name", async () => {
    const h = harness([]);
    await h.gates.addCustom("Tool", { kind: "custom-stdio", command: "a", args: [], env: {} }, "auto");
    await h.gates.addCustom("Tool", { kind: "custom-stdio", command: "b", args: [], env: {} }, "auto");
    expect(named(h, "Tool")?.source).toMatchObject({ command: "a" });
    expect(named(h, "Tool-2")?.source).toMatchObject({ command: "b" });
    const { servers } = await configuredFor(h, "agent-a" as PatchbayAgentId, false);
    expect(servers.map((sv) => sv.name)).toEqual(["Tool", "Tool-2"]);
  });

  it("a name goes to agents as they would keep it — two names an agent would merge are two names here", async () => {
    const h = harness([]);
    await h.gates.addCustom("my server", { kind: "custom-stdio", command: "a", args: [], env: {} }, "auto");
    await h.gates.addCustom("my_server", { kind: "custom-stdio", command: "b", args: [], env: {} }, "auto");
    const { servers } = await configuredFor(h, "agent-a" as PatchbayAgentId, false);
    expect(servers.map((sv) => sv.name)).toEqual(["my_server", "my_server-2"]);
  });

  it("a blank name is refused — nothing is stored", async () => {
    const h = harness([]);
    await expect(
      h.gates.addCustom("   ", { kind: "custom-stdio", command: "a", args: [], env: {} }, "auto"),
    ).rejects.toThrow(/name is empty/);
    expect(h.configs.list()).toEqual([]);
  });

  it("a curated entry connects more than once — two accounts, two servers, each its own (#58)", async () => {
    const h = harness([entry()]);
    const first = await h.gates.connectWithKey("svc", "Service", "key-work");
    const second = await h.gates.connectWithKey("svc", "Service", "key-home");
    expect(first).not.toBe(second);
    expect([h.configs.get(first)?.name, h.configs.get(second)?.name]).toEqual(["Service", "Service-2"]);
    expect([(await h.tokens.get(first))?.accessToken, (await h.tokens.get(second))?.accessToken]).toEqual([
      "key-work",
      "key-home",
    ]);
    await h.gates.remove(first);
    expect(h.configs.list().map((c) => c.id)).toEqual([second]);
  });

  it("a curated connect stores the name the user gave it, as agents keep it", async () => {
    const h = harness([entry()]);
    const key = await h.gates.connectWithKey("svc", "Service work", "key-work");
    const oauth = await h.gates.connectOAuth("svc", "service-home");
    expect([h.configs.get(key)?.name, h.configs.get(oauth)?.name]).toEqual(["Service_work", "service-home"]);
  });

  it("exportJson emits the mcpServers document Import reads back — stdio, custom-http, and curated alike (issue #11)", async () => {
    const h = harness([entry()]);
    const filesId = await h.gates.addCustom(
      "My Files",
      { kind: "custom-stdio", command: "npx", args: ["-y", "files-server"], env: { FILES_KEY: "sk-1" } },
      "auto",
    );
    const remoteId = await h.gates.addCustom(
      "Remote",
      { kind: "custom-http", url: "https://example.test/mcp", authType: "header", headerName: "X-Key", valuePrefix: "", token: "k" },
      "auto",
    );
    const curatedId = await h.gates.connectWithKey("svc", "Service", "pasted-key-1");

    const files = JSON.parse((await h.manager.exportJson(filesId))!);
    expect(files).toEqual({
      mcpServers: { My_Files: { command: "npx", args: ["-y", "files-server"], env: { FILES_KEY: "sk-1" } } },
    });
    expect(JSON.parse((await h.manager.exportJson(remoteId))!)).toEqual({
      mcpServers: { Remote: { url: "https://example.test/mcp", authType: "header", headerName: "X-Key", valuePrefix: "", token: "k" } },
    });
    expect(JSON.parse((await h.manager.exportJson(curatedId))!)).toEqual({
      mcpServers: {
        Service: { url: provider.mcpUrl, authType: "header", headerName: "Authorization", valuePrefix: "Bearer ", token: "pasted-key-1" },
      },
    });
    // never the store record
    for (const id of [filesId, remoteId, curatedId]) {
      expect((await h.manager.exportJson(id))!).not.toMatch(/"routing"|"source"|"transport"/);
    }

    // round-trip: what Copy emits, Import accepts — same name, same launch line, same env
    const fresh = harness([]);
    await fresh.gates.importJson(JSON.stringify(files));
    const pending = (await review(fresh))!;
    await fresh.gates.addImported(pending.id, pending.entries.map((e) => e.name));
    expect(named(fresh, "My_Files")?.source).toMatchObject({
      kind: "custom-stdio",
      command: "npx",
      args: ["-y", "files-server"],
    });
    expect(await fresh.envStore.get(named(fresh, "My_Files")!.id)).toEqual({ FILES_KEY: "sk-1" });
    expect(await published(fresh)).toEqual([]);
  });

  it("an OAuth-minted token never rides editJson or Copy — only what the owner typed does (issue #12)", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectOAuth("svc", "Service");
    const json = (await h.manager.exportJson(id))!;
    expect(JSON.parse(json).mcpServers.Service).toEqual({ url: provider.mcpUrl, authType: "oauth" });
    expect(json).not.toContain((await h.tokens.get(id))!.accessToken);
  });

  it("editJson shows the stored env and header key; updateFromJson stores the box as written (issue #12)", async () => {
    const h = harness([]);
    const editable = await h.gates.addCustom(
      "Editable",
      { kind: "custom-stdio", command: "srv", args: ["--x"], env: { KEEP: "old", GONE: "bye", SWAP: "1" } },
      "auto",
    );
    const keyed = await h.gates.addCustom(
      "Keyed",
      { kind: "custom-http", url: "https://example.test/mcp", authType: "header", headerName: "X-Key", valuePrefix: "", token: "k1" },
      "auto",
    );
    await h.manager.refresh();
    const views = h.events.filter((e) => e.kind === "mcpServersChanged").at(-1);
    const editJsonOf = (id: string) =>
      JSON.parse(
        (views?.kind === "mcpServersChanged" && views.servers.find((i) => i.id === id)?.editJson) || "null",
      );
    expect(editJsonOf(editable).env).toEqual({ KEEP: "old", GONE: "bye", SWAP: "1" });
    expect(editJsonOf(keyed).token).toBe("k1");

    await h.manager.updateFromJson(
      editable,
      JSON.stringify({ command: "srv2", args: ["--y"], env: { KEEP: "old", SWAP: "2", NEW: "n" } }),
    );
    expect(h.configs.get(editable)?.source).toMatchObject({ command: "srv2", args: ["--y"] });
    expect(await h.envStore.get(editable)).toEqual({ KEEP: "old", SWAP: "2", NEW: "n" });

    // a header key removed from the box is removed from the store — the card reads disconnected
    await h.manager.updateFromJson(
      keyed,
      JSON.stringify({ url: "https://example.test/mcp", authType: "header", headerName: "X-Key", valuePrefix: "" }),
    );
    expect(await h.tokens.get(keyed)).toBeNull();
    await h.manager.updateFromJson(
      keyed,
      JSON.stringify({ url: "https://example.test/mcp", authType: "header", headerName: "X-Key", valuePrefix: "", token: "k2" }),
    );
    expect((await h.tokens.get(keyed))?.accessToken).toBe("k2");
  });

  it("an agent's removal leaves every reach list that named it", async () => {
    const h = harness([]);
    const pinned = await h.gates.addCustom("Pinned", { kind: "custom-stdio", command: "a", args: [], env: {} }, ["agent-a", "agent-b"]);
    const except = await h.gates.addCustom("Except", { kind: "custom-stdio", command: "b", args: [], env: {} }, { except: ["agent-a"] });
    const auto = await h.gates.addCustom("Auto", { kind: "custom-stdio", command: "c", args: [], env: {} }, "auto");
    await h.manager.forgetAgent("agent-a" as PatchbayAgentId);
    expect(h.configs.get(pinned)?.routing).toEqual(["agent-b"]);
    expect(h.configs.get(except)?.routing).toEqual({ except: [] });
    expect(h.configs.get(auto)?.routing).toBe("auto");
  });
});

describe("McpServersStore — the lines: a connect, a probe, a remove", () => {
  /** The browser tab that never answers. */
  const silentTab: OAuthUserAgent = {
    redirectUri: async () => "vscode://solutionsunity.acp-patchbay/oauth-callback",
    authorize: () => new Promise(() => {}),
  };

  it("a connect out shows running; told to stop, it stores nothing and leaves no failure", async () => {
    const h = harness([entry()], { userAgent: silentTab });
    const flow = h.gates.connectOAuth("svc", "Service").catch((err: unknown) => err);
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
    const flow = h.gates.connectOAuth("svc", "Service").catch((err: unknown) => err);
    for (let i = 0; i < 200 && waitSignal === undefined; i++) await new Promise((r) => setTimeout(r, 10));
    expect(waitSignal?.aborted).toBe(false);
    await h.gates.cancel("catalog:svc");
    expect(await flow).toMatchObject({ by: "cancel" });
    expect(waitSignal?.aborted).toBe(true);
  });

  it("a second Connect while a card's browser flow is out is that flow — one tab, one outcome", async () => {
    let tabs = 0;
    const h = harness([entry()], { userAgent: { ...silentTab, authorize: () => (tabs++, new Promise(() => {})) } });
    const first = h.gates.connectOAuth("svc", "Service").catch((err: unknown) => err);
    const second = h.gates.connectOAuth("svc", "Service").catch((err: unknown) => err);
    for (let i = 0; i < 200 && tabs === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await h.gates.cancel("catalog:svc");
    expect(await first).toMatchObject({ by: "cancel" });
    expect(await second).toMatchObject({ by: "cancel" });
    expect(tabs).toBe(1);
  });

  it("a failure is held until dismissed", async () => {
    const h = harness([entry({ auth: { header: null, oauth: false } })]);
    await h.gates.connectWithKey("svc", "Service", "k").catch(() => {});
    expect(await published(h)).toEqual([failure("catalog:svc", /no API-key mode/)]);
    await h.gates.cancel("catalog:svc");
    expect(await published(h)).toEqual([]);
  });

  it("a probe on the line is the server's busy state; a second probe joins it", async () => {
    const h = harness([]);
    const slow = await h.gates.addCustom("Slow", { kind: "custom-stdio", command: "srv", args: [], env: {} }, "auto");
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
    for (let i = 0; i < 200 && probes === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await h.manager.refresh();
    const busy = h.events.filter((e) => e.kind === "mcpServersChanged").at(-1);
    expect(busy?.kind === "mcpServersChanged" && busy.servers[0]?.busy).toEqual(["probe"]);
    release();
    await Promise.all([one, two]);
    expect(probes).toBe(1);
  });

  it("Remove cuts in: a probe still running is told to stop, keeps no outcome, and the server is gone", async () => {
    const h = harness([]);
    const hung = await h.gates.addCustom("Hung", { kind: "custom-stdio", command: "srv", args: [], env: {} }, "auto");
    let told = false;
    h.setProbeFn((_target, signal) => {
      signal?.addEventListener("abort", () => (told = true), { once: true });
      return new Promise(() => {});
    });
    const probing = h.gates.probe(hung).catch((err: unknown) => err);
    await new Promise((r) => setTimeout(r, 20));
    await h.gates.remove(hung);
    expect(told).toBe(true);
    expect(await probing).toMatchObject({ by: "remove" });
    expect(h.configs.get(hung)).toBeUndefined();
    await h.manager.refresh();
    const after = h.events.filter((e) => e.kind === "mcpServersChanged").at(-1);
    expect(after?.kind === "mcpServersChanged" && after.servers).toEqual([]);
  });
});

describe("McpServersStore — a bridge's credential", () => {
  it("refreshes a near-expiry OAuth token with the captured context", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectOAuth("svc", "Service");
    // age the token into the refresh margin
    const stored = (await h.tokens.get(id))!;
    await h.tokens.set(id, { ...stored, expiresAt: new Date(Date.now() + 1000).toISOString() });

    const result = await h.manager.credentialFor(id, "agent-a" as PatchbayAgentId);
    expect(result?.accessToken).toBe("refreshed-2");
    expect((await h.tokens.get(id))?.accessToken).toBe("refreshed-2");
  });

  it("asked at once by several, a near-expiry credential spends its refresh token once", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectOAuth("svc", "Service");
    const stored = (await h.tokens.get(id))!;
    await h.tokens.set(id, { ...stored, expiresAt: new Date(Date.now() + 1000).toISOString() });

    const answers = await Promise.all([
      h.manager.credentialFor(id, "agent-a" as PatchbayAgentId),
      h.manager.credentialFor(id, "agent-b" as PatchbayAgentId),
      h.manager.credentialFor(id, "agent-a" as PatchbayAgentId),
    ]);
    expect(answers.map((a) => a?.accessToken)).toEqual(["refreshed-2", "refreshed-2", "refreshed-2"]);
    expect(provider.tokenRequests.filter((r) => r.get("grant_type") === "refresh_token")).toHaveLength(1);
  });

  it("a refresh that lands after the server was removed stores nothing", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectOAuth("svc", "Service");
    const stored = (await h.tokens.get(id))!;
    await h.tokens.set(id, { ...stored, expiresAt: new Date(Date.now() + 1000).toISOString() });
    const asked = h.manager.credentialFor(id, "agent-a" as PatchbayAgentId);
    await h.gates.remove(id);
    await asked;
    expect(await h.tokens.get(id)).toBeNull();
  });

  it("returns a static key as-is — nothing to refresh, no expiry on our side", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "static-key");
    expect((await h.manager.credentialFor(id, "agent-a" as PatchbayAgentId))?.accessToken).toBe("static-key");
  });

  it("returns null for a disconnected server", async () => {
    const h = harness([entry()]);
    expect(await h.manager.credentialFor("svc" as PatchbayMcpServerId, "agent-a" as PatchbayAgentId)).toBeNull();
  });

  it("answers only while the server reaches the agent — muting, re-routing or removing it reaches a running bridge (#72)", async () => {
    const h = harness([entry()]);
    const id = await h.gates.connectWithKey("svc", "Service", "static-key");
    expect((await h.manager.credentialFor(id, "agent-a" as PatchbayAgentId))?.accessToken).toBe("static-key");

    await h.manager.setRouting(id, ["agent-b"]);
    expect(await h.manager.credentialFor(id, "agent-a" as PatchbayAgentId)).toBeNull();
    expect((await h.manager.credentialFor(id, "agent-b" as PatchbayAgentId))?.accessToken).toBe("static-key");

    await h.manager.setActive(id, false);
    expect(await h.manager.credentialFor(id, "agent-b" as PatchbayAgentId)).toBeNull();

    await h.manager.setActive(id, true);
    await h.gates.remove(id);
    expect(await h.manager.credentialFor(id, "agent-b" as PatchbayAgentId)).toBeNull();
    expect(await h.manager.credentialFor("no-such-server" as PatchbayMcpServerId, "agent-b" as PatchbayAgentId)).toBeNull();
  });
});
