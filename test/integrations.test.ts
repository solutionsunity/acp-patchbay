// Integrations manager: registry key/OAuth connects, custom escape hatch,
// routing, and mcpServers construction — against a real fake MCP-spec OAuth
// provider (test/support/fake-oauth-provider.ts) and an in-memory global
// integration-config store (integrations are global, developer-env, never
// repo-committed — stores/integration-configs.ts). No mocks of
// IntegrationsManager's own collaborators. The live half (a real agent
// calling tools through the real bridge subprocess) is
// test/integration-bridge.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntegrationsManager } from "../src/orchestrator/integrations";
import type { ProbeFn, ProbeTarget } from "../src/orchestrator/integration-probe";
import { IntegrationConfigStore } from "../src/orchestrator/stores/integration-configs";
import { IntegrationTokenStore, MemorySecrets } from "../src/orchestrator/stores/integration-tokens";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import type { RegistryEntry } from "../src/orchestrator/stores/registry";
import { SecretEnvStore } from "../src/orchestrator/stores/secret-env";
import type { SettingsEvent } from "../src/shared/protocol";
import { FakeOAuthProvider, fakeUserAgent } from "./support/fake-oauth-provider";

let provider: FakeOAuthProvider;

beforeEach(async () => {
  provider = new FakeOAuthProvider();
  await provider.listen();
});
afterEach(async () => {
  await provider.close();
});

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: "svc",
    name: "Service",
    icon: "server",
    brandIcon: null,
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

function harness(registry: RegistryEntry[]) {
  const events: SettingsEvent[] = [];
  const integrationStore = new IntegrationConfigStore(new MemoryKV());
  const secrets = new MemorySecrets();
  const tokens = new IntegrationTokenStore(secrets);
  const envStore = new SecretEnvStore(secrets, "acpPatchbay.integration");
  // Probes are faked — the real one does network/spawn (integration-probe.ts).
  const probed: ProbeTarget[] = [];
  let probeFn: ProbeFn = async (target) => {
    probed.push(target);
    return { serverName: "fake-server", serverVersion: "1.0", tools: [{ name: "t_one", description: "d" }] };
  };
  const manager = new IntegrationsManager(
    registry,
    integrationStore,
    tokens,
    envStore,
    { emit: (...evs) => events.push(...evs) },
    fakeUserAgent(),
    undefined,
    (target) => probeFn(target),
  );
  return {
    manager, integrationStore, tokens, envStore, events, probed,
    setProbeFn(fn: ProbeFn) { probeFn = fn; },
  };
}

describe("IntegrationsManager — key connect (the v1 floor)", () => {
  it("stores the pasted key and upserts the config entry with authMode header", async () => {
    const h = harness([entry()]);
    await h.manager.connectRegistryWithKey("svc", "pasted-key-1");

    expect((await h.tokens.get("svc"))?.accessToken).toBe("pasted-key-1");
    // connect kicks the tool probe fire-and-forget — settle it so the last
    // integrationsChanged is the deterministic post-probe view
    await new Promise((r) => setTimeout(r, 0));
    const changed = h.events.filter((e) => e.kind === "integrationsChanged").at(-1);
    expect(changed?.kind === "integrationsChanged" && changed.integrations).toEqual([
      {
        id: "svc",
        name: "Service",
        sourceKind: "registry",
        registryId: "svc",
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
        editJson: undefined,
      },
    ]);

    expect(h.integrationStore.get("svc")?.source).toMatchObject({
      kind: "registry",
      registryId: "svc",
      authMode: "header",
    });
    // the raw key never touches the non-secret config record
    expect(JSON.stringify(h.integrationStore.list())).not.toContain("pasted-key-1");
  });

  it("a per-account entry (userUrl) requires the user's endpoint and persists it", async () => {
    const h = harness([entry({ url: "", userUrl: true })]);
    await h.manager.connectRegistryWithKey("svc", "k");
    expect(h.events.at(-1)).toMatchObject({ kind: "integrationConnectFailed", reason: /endpoint URL/ });

    await h.manager.connectRegistryWithKey("svc", "k", "https://mine.example.test/mcp");
    expect(h.integrationStore.get("svc")?.source).toMatchObject({
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
    expect(h.integrationStore.get("svc")?.source).toMatchObject({ authMode: "oauth" });
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
    const h = harness([entry({ auth: { header: { headerName: "Authorization", valuePrefix: "Bearer ", hint: "", keyUrl: "" }, oauth: false } })]);
    await h.manager.connectRegistryOAuth("svc");
    expect(h.events.at(-1)).toMatchObject({ kind: "integrationConnectFailed", reason: /no OAuth mode/ });
  });
});

describe("IntegrationsManager — custom escape hatch", () => {
  it("custom-stdio needs no token and is immediately connected", async () => {
    const h = harness([]);
    await h.manager.addCustom(
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
    const serialized = JSON.stringify(h.integrationStore.list());
    expect(serialized).not.toContain("secret-abc");
    expect(serialized).toContain("X-Goog-Api-Key");
  });

  it("custom-http OAuth runs the same MCP-spec flow as registry entries", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "My OAuth",
      { kind: "custom-http", url: provider.mcpUrl, authType: "oauth" },
      "auto",
    );
    expect((await h.tokens.get("my-oauth"))?.accessToken).toBe("access-1");
  });

  it("disconnect is remove — the full clear; a curated entry just reverts to the catalog", async () => {
    const h = harness([entry()]);
    await h.manager.connectRegistryWithKey("svc", "static-key");
    expect(h.integrationStore.get("svc")).toBeDefined();

    await h.manager.remove("svc");
    expect(await h.tokens.get("svc")).toBeNull();
    expect(h.integrationStore.list()).toEqual([]);
    // the catalog entry itself is registry data — still there, ready to reconnect
    expect(h.manager.registryViews().some((r) => r.id === "svc")).toBe(true);
  });

  it("inactive keeps config and credential but reaches no agent until toggled back", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "Mute Me",
      { kind: "custom-http", url: "https://example.test/mcp", authType: "header", token: "secret-abc" },
      ["agent-a"],
    );
    expect(await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", false)).toHaveLength(1);

    await h.manager.setActive("mute-me", false);
    expect(await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", false)).toEqual([]);
    expect(await h.tokens.get("mute-me")).not.toBeNull(); // credential intact — muted, not disconnected

    await h.manager.setActive("mute-me", true);
    expect(await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", false)).toHaveLength(1);
  });

  it("a failed custom OAuth add stores nothing — no stranded credential-less record", async () => {
    const h = harness([]);
    provider.denyConsent = true; // user rejects in the browser
    await h.manager.addCustom(
      "OAuth Fail",
      { kind: "custom-http", url: provider.mcpUrl, authType: "oauth" },
      "auto",
    );
    expect(h.integrationStore.get("oauth-fail")).toBeUndefined();
    expect(await h.tokens.get("oauth-fail")).toBeNull();
    expect(
      h.events.some((e) => e.kind === "integrationConnectFailed" && e.registryId === "oauth-fail"),
    ).toBe(true);
  });

  it("a blank key on a custom header add fails labeled, storing nothing", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "No Key",
      { kind: "custom-http", url: "https://example.test/mcp", authType: "header" },
      "auto",
    );
    expect(h.integrationStore.get("no-key")).toBeUndefined();
    expect(
      h.events.some(
        (e) => e.kind === "integrationConnectFailed" && e.registryId === "no-key" && /key/.test(e.reason),
      ),
    ).toBe(true);
  });

  it("remove deletes both the token and the config entry", async () => {
    const h = harness([]);
    await h.manager.addCustom("Local Tool", { kind: "custom-stdio", command: "echo", args: [], env: {} }, "auto");
    await h.manager.remove("local-tool");
    expect(h.integrationStore.list()).toEqual([]);
  });
});

describe("IntegrationsManager — routing and mcpServers", () => {
  it("auto reaches every agent; an explicit list pins exactly; except narrows", async () => {
    const h = harness([]);
    await h.manager.addCustom("Auto Tool", { kind: "custom-stdio", command: "echo", args: [], env: {} }, "auto");
    await h.manager.addCustom("Pinned Tool", { kind: "custom-stdio", command: "echo", args: [], env: {} }, [
      "agent-b",
    ]);
    await h.manager.addCustom("Except Tool", { kind: "custom-stdio", command: "echo", args: [], env: {} }, {
      except: ["agent-a"],
    });

    const agentA = await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", false);
    expect(agentA.map((s) => s.name)).toEqual(["Auto Tool"]);

    const agentB = await h.manager.mcpServersFor("agent-b", "/bridge.js", "/sock", false);
    expect(agentB.map((s) => s.name)).toEqual(["Auto Tool", "Pinned Tool", "Except Tool"]);
  });

  it("the bridge env carries the integration's own header shape — Stitch-style custom headers included", async () => {
    const h = harness([
      entry({
        id: "stitch",
        name: "Stitch",
        auth: { header: { headerName: "X-Goog-Api-Key", valuePrefix: "", hint: "", keyUrl: "" }, oauth: false },
      }),
    ]);
    await h.manager.connectRegistryWithKey("stitch", "goog-key");

    const servers = await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", false);
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
        auth: { header: { headerName: "X-Custom", valuePrefix: "", hint: "", keyUrl: "" }, oauth: true },
      }),
    ]);
    await h.manager.connectRegistryOAuth("svc");

    const servers = await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", false);
    const env = envOf(servers[0]!);
    expect(env.ACP_PATCHBAY_AUTH_HEADER).toBe("Authorization");
    expect(env.ACP_PATCHBAY_AUTH_PREFIX).toBe("Bearer ");
  });

  it("a per-account entry's user-supplied URL is what reaches the bridge", async () => {
    const h = harness([entry({ id: "acct", url: "", userUrl: true })]);
    await h.manager.connectRegistryWithKey("acct", "k", "https://mine.example.test/mcp");
    const servers = await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", false);
    const env = envOf(servers[0]!);
    expect(env.ACP_PATCHBAY_INTEGRATION_URL).toBe("https://mine.example.test/mcp");
  });

  it("a routed-but-unconnected integration contributes no server (nothing to route to)", async () => {
    const h = harness([entry()]);
    // config entry exists (e.g. pasted from a shared config), no token here
    await h.integrationStore.upsert({
      id: "svc",
      name: "Service",
      source: { kind: "registry", registryId: "svc", authMode: "header" },
      routing: "auto",
      active: true,
      transport: "auto",
    });
    const servers = await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", false);
    expect(servers).toEqual([]);
  });

  it("setRouting persists a new explicit agent list", async () => {
    const h = harness([]);
    await h.manager.addCustom("T1", { kind: "custom-stdio", command: "echo", args: [], env: {} }, "auto");
    await h.manager.setRouting("t1", ["agent-x"]);
    expect(h.integrationStore.get("t1")?.routing).toEqual(["agent-x"]);
  });

  it("a custom-stdio command line is parsed quote-aware, never stored as one executable string", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "Srv",
      { kind: "custom-stdio", command: 'npx some-server --root "/tmp/my dir"', args: [], env: {} },
      "auto",
    );
    const stored = h.integrationStore.get("srv")!;
    expect(stored.source).toMatchObject({
      kind: "custom-stdio",
      command: "npx",
      args: ["some-server", "--root", "/tmp/my dir"],
    });
    // and the agent receives it split the same way
    const servers = await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", false);
    expect(servers[0]).toMatchObject({ command: "npx", args: ["some-server", "--root", "/tmp/my dir"] });
  });

  it("custom-stdio env values land in SecretStorage, never the config record — served to the agent only at attach", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "Keyed",
      { kind: "custom-stdio", command: "srv", args: [], env: { SRV_API_KEY: "sk-secret" } },
      "auto",
    );
    // config record carries no env at all
    expect("env" in (h.integrationStore.get("keyed")!.source as object)).toBe(false);
    // the value round-trips through the secret store...
    expect(await h.envStore.get("keyed")).toEqual({ SRV_API_KEY: "sk-secret" });
    // ...and reaches the agent's spawn config at attach time
    const servers = await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", false);
    expect(envOf(servers[0]!)).toEqual({ SRV_API_KEY: "sk-secret" });
    // remove purges it with the rest
    await h.manager.remove("keyed");
    expect(await h.envStore.get("keyed")).toEqual({});
  });

  it("an unterminated quote in a custom-stdio line fails labeled, storing nothing", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "Bad",
      { kind: "custom-stdio", command: 'npx "broken', args: [], env: {} },
      "auto",
    );
    expect(h.integrationStore.get("bad")).toBeUndefined();
    expect(
      h.events.some(
        (e) => e.kind === "integrationConnectFailed" && e.registryId === "bad" && /quote/.test(e.reason),
      ),
    ).toBe(true);
  });
});

describe("IntegrationsManager — http passthrough (prompt.image mechanics)", () => {
  it("an agent declaring mcp.http gets a type:http entry with the credential in headers", async () => {
    const h = harness([entry()]);
    await h.manager.connectRegistryWithKey("svc", "key-9");

    const servers = await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", true);
    expect(servers).toEqual([
      {
        type: "http",
        name: "Service",
        url: provider.mcpUrl,
        headers: [{ name: "Authorization", value: "Bearer key-9" }],
      },
    ]);
  });

  it("transport 'bridge' pins the stdio bridge even for a declaring agent (the escape hatch)", async () => {
    const h = harness([entry()]);
    await h.manager.connectRegistryWithKey("svc", "key-9");
    await h.manager.setTransport("svc", "bridge");

    const servers = await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", true);
    expect(servers).toHaveLength(1);
    expect("command" in servers[0]!).toBe(true);
    expect(envOf(servers[0]!).ACP_PATCHBAY_INTEGRATION_ID).toBe("svc");
  });

  it("a non-declaring agent rides the bridge regardless of transport 'auto'", async () => {
    const h = harness([entry()]);
    await h.manager.connectRegistryWithKey("svc", "key-9");

    const servers = await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", false);
    expect(servers).toHaveLength(1);
    expect("command" in servers[0]!).toBe(true);
  });

  it("custom-stdio is handed through as-is either way", async () => {
    const h = harness([]);
    await h.manager.addCustom("Local Tool", { kind: "custom-stdio", command: "echo", args: [], env: {} }, "auto");

    const servers = await h.manager.mcpServersFor("agent-a", "/bridge.js", "/sock", true);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "Local Tool", command: "echo" });
  });
});

describe("IntegrationsManager — connect-time tool probe", () => {
  it("connect kicks a probe with the resolved endpoint and fresh credential", async () => {
    const h = harness([entry()]);
    await h.manager.connectRegistryWithKey("svc", "key-7");
    await new Promise((r) => setTimeout(r, 0));

    expect(h.probed).toEqual([
      {
        kind: "http",
        url: provider.mcpUrl,
        header: { name: "Authorization", value: "Bearer key-7" },
      },
    ]);
  });

  it("probing a custom-stdio server carries its command and SecretStorage env", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "Local Tool",
      { kind: "custom-stdio", command: "echo", args: ["hi"], env: { MY_KEY: "v1" } },
      "auto",
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(h.probed).toEqual([
      { kind: "stdio", command: "echo", args: ["hi"], env: { MY_KEY: "v1" } },
    ]);
  });

  it("a probe failure lands on the card as failed-with-reason, cleared by the next success", async () => {
    const h = harness([entry()]);
    let fail = true;
    h.setProbeFn(async (target) => {
      if (fail) throw new Error("boom");
      h.probed.push(target);
      return { serverName: "fake-server", serverVersion: "1.0", tools: [] };
    });
    await h.manager.connectRegistryWithKey("svc", "key-7");
    await new Promise((r) => setTimeout(r, 0));

    const failed = h.events.filter((e) => e.kind === "integrationsChanged").at(-1);
    expect(failed?.kind === "integrationsChanged" && failed.integrations[0]?.probe).toMatchObject({
      status: "failed",
      reason: "boom",
    });

    fail = false;
    await h.manager.probe("svc");
    const ok = h.events.filter((e) => e.kind === "integrationsChanged").at(-1);
    expect(ok?.kind === "integrationsChanged" && ok.integrations[0]?.probe).toMatchObject({
      status: "ok",
      tools: [],
    });
  });
});

describe("IntegrationsManager — JSON import and edit (the well-known mcpServers shape)", () => {
  it("imports stdio and url entries, ids slugged from names, env straight to SecretStorage; bad entries labeled, rest unaffected", async () => {
    const h = harness([]);
    await h.manager.importJson(
      JSON.stringify({
        mcpServers: {
          "My Files": { command: "npx", args: ["-y", "files-server"], env: { FILES_KEY: "sk-1" } },
          remote: { url: "https://example.test/mcp" },
          broken: { neither: true },
        },
      }),
    );
    expect(h.integrationStore.get("my-files")?.source).toMatchObject({
      kind: "custom-stdio",
      command: "npx",
      args: ["-y", "files-server"],
    });
    expect(await h.envStore.get("my-files")).toEqual({ FILES_KEY: "sk-1" });
    expect(h.integrationStore.get("remote")?.source).toMatchObject({
      kind: "custom-http",
      url: "https://example.test/mcp",
      authType: "none",
    });
    expect(h.integrationStore.get("broken")).toBeUndefined();
    expect(
      h.events.some(
        (e) => e.kind === "integrationConnectFailed" && e.registryId === "import:broken",
      ),
    ).toBe(true);
  });

  it("name collisions uniquify the generated id instead of overwriting", async () => {
    const h = harness([]);
    await h.manager.addCustom("Tool", { kind: "custom-stdio", command: "a", args: [], env: {} }, "auto");
    await h.manager.addCustom("Tool", { kind: "custom-stdio", command: "b", args: [], env: {} }, "auto");
    expect(h.integrationStore.get("tool")?.source).toMatchObject({ command: "a" });
    expect(h.integrationStore.get("tool-2")?.source).toMatchObject({ command: "b" });
  });

  it("updateFromJson: env is write-only — blank keeps, filled overwrites, removed deletes", async () => {
    const h = harness([]);
    await h.manager.addCustom(
      "Editable",
      { kind: "custom-stdio", command: "srv", args: ["--x"], env: { KEEP: "old", GONE: "bye", SWAP: "1" } },
      "auto",
    );
    await h.manager.updateFromJson(
      "editable",
      JSON.stringify({ command: "srv2", args: ["--y"], env: { KEEP: "", SWAP: "2", NEW: "n" } }),
    );
    expect(h.integrationStore.get("editable")?.source).toMatchObject({ command: "srv2", args: ["--y"] });
    expect(await h.envStore.get("editable")).toEqual({ KEEP: "old", SWAP: "2", NEW: "n" });
  });
});

describe("IntegrationsManager — cancelling a browser flow", () => {
  it("cancel clears the pending state without inventing a failure; nothing is stored", async () => {
    const events: SettingsEvent[] = [];
    const integrationStore = new IntegrationConfigStore(new MemoryKV());
    const secrets = new MemorySecrets();
    const tokens = new IntegrationTokenStore(secrets);
    const manager = new IntegrationsManager(
      [entry()],
      integrationStore,
      tokens,
      new SecretEnvStore(secrets, "acpPatchbay.integration"),
      { emit: (...evs) => events.push(...evs) },
      {
        redirectUri: async () => "vscode://solutionsunity.acp-patchbay/oauth-callback",
        authorize: () => new Promise(() => {}), // the browser tab that never answers
      },
    );

    const inFlight = manager.connectRegistryOAuth("svc");
    // wait until the flow is actually pending, then abandon it
    for (let i = 0; i < 200 && !events.some((e) => e.kind === "integrationConnectStarted"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    manager.cancelConnect("svc");
    await inFlight;

    expect(events.some((e) => e.kind === "integrationConnectResolved" && e.registryId === "svc")).toBe(true);
    expect(events.some((e) => e.kind === "integrationConnectFailed")).toBe(false);
    expect(await tokens.get("svc")).toBeNull();
    expect(integrationStore.list()).toEqual([]);
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
