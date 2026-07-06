// Integrations manager: registry key/OAuth connects, custom escape hatch,
// routing, and mcpServers construction — against a real fake MCP-spec OAuth
// provider (test/support/fake-oauth-provider.ts) and a real temp-dir config
// file. No mocks of IntegrationsManager's own collaborators. The live half
// (a real agent calling tools through the real bridge subprocess) is
// test/integration-bridge.test.ts.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntegrationsManager } from "../src/orchestrator/integrations";
import { ConfigFileStore } from "../src/orchestrator/stores/config-file";
import { IntegrationTokenStore, MemorySecrets } from "../src/orchestrator/stores/integration-tokens";
import type { RegistryEntry } from "../src/orchestrator/stores/registry";
import type { SettingsEvent } from "../src/shared/protocol";
import { FakeOAuthProvider, fakeUserAgent } from "./support/fake-oauth-provider";

let dir: string;
let configPath: string;
let provider: FakeOAuthProvider;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "patchbay-integrations-"));
  configPath = join(dir, ".vscode", "acp-patchbay.json");
  provider = new FakeOAuthProvider();
  await provider.listen();
});
afterEach(async () => {
  await provider.close();
  await rm(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: "svc",
    name: "Service",
    url: provider.mcpUrl,
    userUrl: false,
    docsUrl: "https://example.test/docs",
    note: "",
    auth: {
      header: { headerName: "Authorization", valuePrefix: "Bearer ", hint: "a key" },
      oauth: true,
    },
    ...overrides,
  };
}

function envOf(server: import("@agentclientprotocol/sdk").McpServer): Record<string, string> {
  if (!("command" in server)) throw new Error("expected a stdio server entry");
  return Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value]));
}

function harness(registry: RegistryEntry[]) {
  const events: SettingsEvent[] = [];
  const configFile = new ConfigFileStore(configPath);
  const tokens = new IntegrationTokenStore(new MemorySecrets());
  const manager = new IntegrationsManager(
    registry,
    configFile,
    tokens,
    { emit: (...evs) => events.push(...evs) },
    fakeUserAgent(),
  );
  return { manager, configFile, tokens, events };
}

describe("IntegrationsManager — key connect (the v1 floor)", () => {
  it("stores the pasted key and upserts the config entry with authMode header", async () => {
    const h = harness([entry()]);
    await h.manager.connectRegistryWithKey("svc", "pasted-key-1");

    expect((await h.tokens.get("svc"))?.accessToken).toBe("pasted-key-1");
    const changed = h.events.filter((e) => e.kind === "integrationsChanged").at(-1);
    expect(changed?.kind === "integrationsChanged" && changed.integrations).toEqual([
      { id: "svc", name: "Service", sourceKind: "registry", registryId: "svc", connected: true, routing: "auto" },
    ]);

    const result = await h.configFile.read();
    expect(result.ok && result.config.integrations[0]?.source).toMatchObject({
      kind: "registry",
      registryId: "svc",
      authMode: "header",
    });
    // the raw key never touches the config file on disk
    const raw = await readFile(configPath, "utf8");
    expect(raw).not.toContain("pasted-key-1");
  });

  it("a per-account entry (userUrl) requires the user's endpoint and persists it", async () => {
    const h = harness([entry({ url: "", userUrl: true })]);
    await h.manager.connectRegistryWithKey("svc", "k");
    expect(h.events.at(-1)).toMatchObject({ kind: "integrationConnectFailed", reason: /endpoint URL/ });

    await h.manager.connectRegistryWithKey("svc", "k", "https://mine.example.test/mcp");
    const result = await h.configFile.read();
    expect(result.ok && result.config.integrations[0]?.source).toMatchObject({
      url: "https://mine.example.test/mcp",
    });
  });

  it("refuses on an entry with no key mode", async () => {
    const h = harness([entry({ auth: { header: null, oauth: false } })]);
    await h.manager.connectRegistryWithKey("svc", "k");
    expect(h.events.at(-1)).toMatchObject({ kind: "integrationConnectFailed", reason: /no API-key mode/ });
    expect(await h.tokens.get("svc")).toBeNull();
  });
});

describe("IntegrationsManager — OAuth connect (MCP-spec, discovery + DCR + PKCE)", () => {
  it("connects with only the entry's URL and captures refresh context alongside the token", async () => {
    const h = harness([entry()]);
    await h.manager.connectRegistryOAuth("svc");

    expect(h.events.some((e) => e.kind === "integrationConnectStarted")).toBe(true);
    const stored = await h.tokens.get("svc");
    expect(stored).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      tokenEndpoint: provider.tokenEndpoint,
      clientId: "dcr-client-1",
    });
    const result = await h.configFile.read();
    expect(result.ok && result.config.integrations[0]?.source).toMatchObject({ authMode: "oauth" });
  });

  it("gated DCR fails labeled — pitfall §2, pointing at the key path", async () => {
    provider.gateDcr = true;
    const h = harness([entry()]);
    await h.manager.connectRegistryOAuth("svc");
    const failed = h.events.at(-1);
    expect(failed).toMatchObject({ kind: "integrationConnectFailed", registryId: "svc" });
    expect(failed?.kind === "integrationConnectFailed" && failed.reason).toMatch(/API-key path/);
    expect(await h.tokens.get("svc")).toBeNull();
  });

  it("refuses on an entry without an OAuth mode", async () => {
    const h = harness([entry({ auth: { header: { headerName: "Authorization", valuePrefix: "Bearer ", hint: "" }, oauth: false } })]);
    await h.manager.connectRegistryOAuth("svc");
    expect(h.events.at(-1)).toMatchObject({ kind: "integrationConnectFailed", reason: /no OAuth mode/ });
  });
});

describe("IntegrationsManager — custom escape hatch", () => {
  it("custom-stdio needs no token and is immediately connected", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "local-tool",
      "Local Tool",
      { kind: "custom-stdio", command: "echo", args: ["hi"], env: {} },
      "auto",
    );
    const changed = h.events.filter((e) => e.kind === "integrationsChanged").at(-1);
    expect(changed?.kind === "integrationsChanged" && changed.integrations[0]).toMatchObject({
      id: "local-tool",
      sourceKind: "custom-stdio",
      connected: true,
    });
  });

  it("custom-http header auth stores the key in SecretStorage, never in config — custom header names included", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "stitch-like",
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
    expect((await h.tokens.get("stitch-like"))?.accessToken).toBe("secret-abc");
    const raw = await readFile(configPath, "utf8");
    expect(raw).not.toContain("secret-abc");
    expect(raw).toContain("X-Goog-Api-Key");
  });

  it("custom-http OAuth runs the same MCP-spec flow as registry entries", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "my-oauth",
      "My OAuth",
      { kind: "custom-http", url: provider.mcpUrl, authType: "oauth" },
      "auto",
    );
    expect((await h.tokens.get("my-oauth"))?.accessToken).toBe("access-1");
  });

  it("disconnect revokes the token but keeps the config entry for reconnecting", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "my-api",
      "My API",
      { kind: "custom-http", url: "https://example.test/mcp", authType: "header", token: "secret-abc" },
      "auto",
    );
    await h.manager.disconnect("my-api");
    expect(await h.tokens.get("my-api")).toBeNull();
    const result = await h.configFile.read();
    expect(result.ok && result.config.integrations.some((i) => i.id === "my-api")).toBe(true);
  });

  it("remove deletes both the token and the config entry", async () => {
    const h = harness([]);
    await h.manager.addCustom("local-tool", "Local Tool", { kind: "custom-stdio", command: "echo", args: [], env: {} }, "auto");
    await h.manager.remove("local-tool");
    const result = await h.configFile.read();
    expect(result.ok && result.config.integrations).toEqual([]);
  });
});

describe("IntegrationsManager — routing and mcpServers", () => {
  it("auto routing attaches only to fully-brokered agents; explicit routing attaches regardless", async () => {
    const h = harness([]);
    await h.manager.addCustom("auto-tool", "Auto Tool", { kind: "custom-stdio", command: "echo", args: [], env: {} }, "auto");
    await h.manager.addCustom("pinned-tool", "Pinned Tool", { kind: "custom-stdio", command: "echo", args: [], env: {} }, [
      "agent-b",
    ]);

    const brokeredServers = await h.manager.mcpServersFor("agent-a", true, "/bridge.js", "/sock");
    expect(brokeredServers.map((s) => s.name)).toEqual(["Auto Tool"]);

    const unbrokeredServers = await h.manager.mcpServersFor("agent-a", false, "/bridge.js", "/sock");
    expect(unbrokeredServers.map((s) => s.name)).toEqual([]);

    const pinnedAgentServers = await h.manager.mcpServersFor("agent-b", false, "/bridge.js", "/sock");
    expect(pinnedAgentServers.map((s) => s.name)).toEqual(["Pinned Tool"]);
  });

  it("the bridge env carries the integration's own header shape — Stitch-style custom headers included", async () => {
    const h = harness([
      entry({
        id: "stitch",
        name: "Stitch",
        auth: { header: { headerName: "X-Goog-Api-Key", valuePrefix: "", hint: "" }, oauth: false },
      }),
    ]);
    await h.manager.connectRegistryWithKey("stitch", "goog-key");

    const servers = await h.manager.mcpServersFor("agent-a", true, "/bridge.js", "/sock");
    expect(servers).toHaveLength(1);
    const env = envOf(servers[0]!);
    expect(env.ACP_PATCHBAY_AUTH_HEADER).toBe("X-Goog-Api-Key");
    expect(env.ACP_PATCHBAY_AUTH_PREFIX).toBe("");
    expect(env.ACP_PATCHBAY_INTEGRATION_URL).toBe(provider.mcpUrl);
  });

  it("an OAuth-connected integration rides Authorization: Bearer regardless of the entry's key-header shape", async () => {
    const h = harness([
      entry({
        id: "svc",
        auth: { header: { headerName: "X-Custom", valuePrefix: "", hint: "" }, oauth: true },
      }),
    ]);
    await h.manager.connectRegistryOAuth("svc");

    const servers = await h.manager.mcpServersFor("agent-a", true, "/bridge.js", "/sock");
    const env = envOf(servers[0]!);
    expect(env.ACP_PATCHBAY_AUTH_HEADER).toBe("Authorization");
    expect(env.ACP_PATCHBAY_AUTH_PREFIX).toBe("Bearer ");
  });

  it("a per-account entry's user-supplied URL is what reaches the bridge", async () => {
    const h = harness([entry({ id: "acct", url: "", userUrl: true })]);
    await h.manager.connectRegistryWithKey("acct", "k", "https://mine.example.test/mcp");
    const servers = await h.manager.mcpServersFor("agent-a", true, "/bridge.js", "/sock");
    const env = envOf(servers[0]!);
    expect(env.ACP_PATCHBAY_INTEGRATION_URL).toBe("https://mine.example.test/mcp");
  });

  it("a routed-but-unconnected integration contributes no server (nothing to route to)", async () => {
    const h = harness([entry()]);
    // config entry exists (e.g. pasted from a shared config), no token here
    await h.configFile.upsertIntegration({
      id: "svc",
      name: "Service",
      source: { kind: "registry", registryId: "svc", authMode: "header" },
      routing: "auto",
    });
    const servers = await h.manager.mcpServersFor("agent-a", true, "/bridge.js", "/sock");
    expect(servers).toEqual([]);
  });

  it("setRouting persists a new explicit agent list", async () => {
    const h = harness([]);
    await h.manager.addCustom("t1", "T1", { kind: "custom-stdio", command: "echo", args: [], env: {} }, "auto");
    await h.manager.setRouting("t1", ["agent-x"]);
    const result = await h.configFile.read();
    expect(result.ok && result.config.integrations[0]?.routing).toEqual(["agent-x"]);
  });
});

describe("IntegrationsManager — token refresh", () => {
  it("getToken refreshes a near-expiry OAuth token with the captured context", async () => {
    const h = harness([entry()]);
    await h.manager.connectRegistryOAuth("svc");
    // age the token into the refresh margin
    const stored = (await h.tokens.get("svc"))!;
    await h.tokens.set("svc", { ...stored, expiresAt: new Date(Date.now() + 1000).toISOString() });

    const result = await h.manager.getToken("svc");
    expect(result?.accessToken).toBe("refreshed-2");
    expect((await h.tokens.get("svc"))?.accessToken).toBe("refreshed-2");
  });

  it("getToken returns a static key as-is — nothing to refresh, no expiry on our side", async () => {
    const h = harness([entry()]);
    await h.manager.connectRegistryWithKey("svc", "static-key");
    expect((await h.manager.getToken("svc"))?.accessToken).toBe("static-key");
  });

  it("getToken returns null for a disconnected integration", async () => {
    const h = harness([entry()]);
    expect(await h.manager.getToken("svc")).toBeNull();
  });
});
