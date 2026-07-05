// P9 gate (non-live half): registry + custom integrations, routing, and
// mcpServers construction, all against a real fake OAuth provider (same
// fixture philosophy as oauth-device-flow.test.ts) and a real temp-dir
// config file — no mocks of IntegrationsManager's own collaborators. The
// live half (a real agent calling list_issues through the real bridge
// subprocess) is test/integration-bridge.test.ts; the *actually* live half
// (real GitHub, real Augment) is the P9 owner touchpoint.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigFileStore } from "../src/orchestrator/stores/config-file";
import { IntegrationTokenStore, MemorySecrets } from "../src/orchestrator/stores/integration-tokens";
import type { RegistryEntry } from "../src/orchestrator/stores/registry";
import { IntegrationsManager } from "../src/orchestrator/integrations";
import type { SettingsEvent } from "../src/shared/protocol";

let dir: string;
let configPath: string;
let server: Server;
let baseUrl: string;
let tokenResponses: Record<string, unknown>[];
let tokenCallIndex: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "patchbay-integrations-"));
  configPath = join(dir, ".vscode", "acp-patchbay.json");
  tokenResponses = [{ access_token: "gh-token-1", refresh_token: "gh-refresh-1", expires_in: 3600 }];
  tokenCallIndex = 0;
  server = createServer((req, res) => {
    void (async () => {
      for await (const _chunk of req) void _chunk;
      res.setHeader("content-type", "application/json");
      if (req.url === "/device/code") {
        res.end(
          JSON.stringify({
            user_code: "ABCD-1234",
            device_code: "dev-1",
            verification_uri: "https://example.test/activate",
            expires_in: 30,
            interval: 0,
          }),
        );
        return;
      }
      const body = tokenResponses[Math.min(tokenCallIndex, tokenResponses.length - 1)];
      tokenCallIndex++;
      res.end(JSON.stringify(body));
    })();
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

function registryEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: "github",
    name: "GitHub",
    transport: "http",
    url: `${baseUrl}/mcp`,
    auth: {
      type: "oauth-device",
      scopes: ["repo"],
      deviceCodeUrl: `${baseUrl}/device/code`,
      tokenUrl: `${baseUrl}/token`,
      clientId: "client-1",
    },
    ...overrides,
  };
}

function harness(registry: RegistryEntry[]) {
  const events: SettingsEvent[] = [];
  const configFile = new ConfigFileStore(configPath);
  const tokens = new IntegrationTokenStore(new MemorySecrets());
  const manager = new IntegrationsManager(registry, configFile, tokens, {
    emit: (...evs) => events.push(...evs),
  });
  return { manager, configFile, tokens, events };
}

describe("IntegrationsManager — registry connect (Device Flow)", () => {
  it("connect issues a device code, then stores the token and upserts config once approved", async () => {
    const h = harness([registryEntry()]);
    await h.manager.connectRegistry("github");

    const issued = h.events.find((e) => e.kind === "integrationDeviceCodeIssued");
    expect(issued).toMatchObject({ userCode: "ABCD-1234", verificationUri: "https://example.test/activate" });

    const changed = h.events.filter((e) => e.kind === "integrationsChanged").at(-1);
    expect(changed?.kind === "integrationsChanged" && changed.integrations).toEqual([
      { id: "github", name: "GitHub", sourceKind: "registry", registryId: "github", connected: true, routing: "auto" },
    ]);

    const stored = await h.tokens.get("github");
    expect(stored?.accessToken).toBe("gh-token-1");

    // the raw token never touches the config file on disk
    const raw = await readFile(configPath, "utf8");
    expect(raw).not.toContain("gh-token-1");
  });

  it("a denied device flow reports failure and stores nothing", async () => {
    tokenResponses = [{ error: "access_denied" }];
    const h = harness([registryEntry()]);
    await h.manager.connectRegistry("github");

    const failed = h.events.find((e) => e.kind === "integrationConnectFailed");
    expect(failed).toMatchObject({ registryId: "github", reason: "denied" });
    expect(await h.tokens.get("github")).toBeNull();
  });

  it("refuses to connect a registry entry that isn't owner-configured yet (empty clientId/url)", async () => {
    const h = harness([registryEntry({ url: "", auth: { ...registryEntry().auth, clientId: "" } })]);
    await h.manager.connectRegistry("github");
    expect(h.events).toEqual([{ kind: "integrationConnectFailed", registryId: "github", reason: "not connectable yet" }]);
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

  it("custom-http with a bearer token stores it in SecretStorage, never in config", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "my-api",
      "My API",
      { kind: "custom-http", url: "https://example.test/mcp", authType: "bearer-token", token: "secret-abc" },
      "auto",
    );
    expect((await h.tokens.get("my-api"))?.accessToken).toBe("secret-abc");
    const raw = await readFile(configPath, "utf8");
    expect(raw).not.toContain("secret-abc");
  });

  it("disconnect revokes the token but keeps the config entry for reconnecting", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "my-api",
      "My API",
      { kind: "custom-http", url: "https://example.test/mcp", authType: "bearer-token", token: "secret-abc" },
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

describe("IntegrationsManager — routing", () => {
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

  it("a routed-but-unconnected registry integration contributes no server (nothing to route to)", async () => {
    const h = harness([registryEntry()]);
    // upsert the config entry directly, without ever connecting — simulates
    // a shared config pasted into a workspace with no token of its own yet
    await h.configFile.upsertIntegration({ id: "github", name: "GitHub", source: { kind: "registry", registryId: "github" }, routing: "auto" });
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
  it("getToken refreshes a near-expiry token transparently, using the refresh token, never exposing it to the caller", async () => {
    const h = harness([registryEntry()]);
    await h.tokens.set("github", {
      accessToken: "stale",
      refreshToken: "gh-refresh-1",
      expiresAt: new Date(Date.now() + 1000).toISOString(), // inside the 60s margin
    });
    tokenResponses = [{ access_token: "fresh-token", expires_in: 3600 }];
    const result = await h.manager.getToken("github");
    expect(result?.accessToken).toBe("fresh-token");
    expect((await h.tokens.get("github"))?.accessToken).toBe("fresh-token");
  });

  it("getToken returns the stored token as-is when not near expiry", async () => {
    const h = harness([registryEntry()]);
    await h.tokens.set("github", { accessToken: "still-good", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const result = await h.manager.getToken("github");
    expect(result?.accessToken).toBe("still-good");
  });

  it("getToken returns null for a disconnected integration", async () => {
    const h = harness([registryEntry()]);
    expect(await h.manager.getToken("github")).toBeNull();
  });
});
