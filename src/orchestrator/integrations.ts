// Integrations manager (architecture.md § Integrations): curated (registry)
// and custom are the same mechanism — MCP servers routed to agents. Owns
// the connect lifecycle (static key in a configurable header, or MCP-spec
// OAuth 2.1 per docs/reference-mcp-oauth.md), routing decisions, and the
// mcpServers entries a session actually gets. vscode-free (like
// SessionManager/CapabilityVerifier): the OAuth browser/redirect step is an
// injected OAuthUserAgent, so everything is unit-testable against a fake
// OAuth provider and a fake remote MCP endpoint — the same fixture
// philosophy as the fake ACP agent.
import type { McpServer } from "@agentclientprotocol/sdk";
import type {
  IntegrationRoutingView,
  IntegrationSourceView,
  IntegrationView,
  RegistryEntryView,
  SettingsEvent,
} from "../shared/protocol";
import { connectMcpOAuth, refreshMcpOAuth, type OAuthUserAgent } from "./mcp-oauth";
import { ConfigFileStore, type IntegrationSource } from "./stores/config-file";
import { IntegrationTokenStore, type StoredToken } from "./stores/integration-tokens";
import { isConnectable, type RegistryEntry } from "./stores/registry";

export interface IntegrationsManagerHooks {
  emit(...events: SettingsEvent[]): void;
}

const CLIENT_INFO = {
  clientName: "acp-patchbay",
  clientUri: "https://github.com/solutionsunity/acp-patchbay",
};

/** True with a minute of margin — refresh slightly before expiry rather
 * than reacting to a 401 whenever avoidable. */
function isExpired(token: StoredToken): boolean {
  if (token.expiresAt === undefined) return false;
  return Date.now() > Date.parse(token.expiresAt) - 60_000;
}

function expiresAtFrom(expiresIn: number | undefined): string | undefined {
  return expiresIn !== undefined ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
}

/** Whether "connected" requires a stored credential: registry integrations
 * always (both header and oauth modes carry one); custom-http except
 * authType "none"; custom-stdio never. */
function needsToken(source: IntegrationSource): boolean {
  if (source.kind === "registry") return true;
  if (source.kind === "custom-http") return source.authType !== "none";
  return false;
}

/** How the bridge should present the stored credential on the wire —
 * null when there's no credential to send. OAuth access tokens are always
 * `Authorization: Bearer`; header mode uses the entry's/user's own shape. */
function headerShapeOf(
  source: IntegrationSource,
  entry: RegistryEntry | undefined,
): { headerName: string; valuePrefix: string } | null {
  if (source.kind === "custom-stdio") return null;
  if (source.kind === "registry") {
    if (source.authMode === "oauth") return { headerName: "Authorization", valuePrefix: "Bearer " };
    const header = entry?.auth.header;
    return header ? { headerName: header.headerName, valuePrefix: header.valuePrefix } : null;
  }
  if (source.authType === "none") return null;
  if (source.authType === "oauth") return { headerName: "Authorization", valuePrefix: "Bearer " };
  return { headerName: source.headerName, valuePrefix: source.valuePrefix };
}

export class IntegrationsManager {
  constructor(
    private readonly registry: readonly RegistryEntry[],
    private readonly configFile: ConfigFileStore,
    private readonly tokens: IntegrationTokenStore,
    private readonly hooks: IntegrationsManagerHooks,
    /** Browser/redirect step for OAuth connects — the orchestrator wires
     * registerUriHandler + asExternalUri; tests wire a fake. Absent →
     * OAuth connects fail labeled (header connects unaffected). */
    private readonly oauthUserAgent: OAuthUserAgent | null = null,
  ) {}

  registryViews(): RegistryEntryView[] {
    return this.registry.map((r) => ({
      id: r.id,
      name: r.name,
      connectable: isConnectable(r),
      note: r.note,
      docsUrl: r.docsUrl,
      userUrl: r.userUrl,
      headerAuth: r.auth.header ? { hint: r.auth.header.hint } : null,
      oauth: r.auth.oauth,
    }));
  }

  /** Re-reads config + token presence and republishes both lists wholesale —
   * same "replace, don't patch" shape as the capability matrix. */
  async refresh(): Promise<void> {
    this.hooks.emit(
      { kind: "integrationRegistryLoaded", entries: this.registryViews() },
      { kind: "integrationsChanged", integrations: await this.currentViews() },
    );
  }

  private async currentViews(): Promise<IntegrationView[]> {
    const result = await this.configFile.read();
    if (!result.ok) return [];
    const views: IntegrationView[] = [];
    for (const integration of result.config.integrations) {
      const connected = needsToken(integration.source)
        ? (await this.tokens.get(integration.id)) !== null
        : true;
      views.push({
        id: integration.id,
        name: integration.name,
        sourceKind: integration.source.kind,
        registryId: integration.source.kind === "registry" ? integration.source.registryId : undefined,
        connected,
        routing: integration.routing,
      });
    }
    return views;
  }

  private entryFor(registryId: string): RegistryEntry | undefined {
    return this.registry.find((r) => r.id === registryId);
  }

  /** Resolves the endpoint a connect will use: the entry's fixed URL, or
   * the user-supplied one for per-account services. Null with a reason
   * when it can't — never a silent partial connect. */
  private resolveEndpoint(
    entry: RegistryEntry,
    userSuppliedUrl: string | undefined,
  ): { url: string } | { error: string } {
    if (entry.userUrl) {
      const url = userSuppliedUrl?.trim() ?? "";
      return url !== "" ? { url } : { error: "this integration needs your account's endpoint URL" };
    }
    if (entry.url !== "") return { url: entry.url };
    return { error: "no endpoint available" };
  }

  /** Static-key connect (the v1 floor — docs/reference-mcp-oauth.md §1):
   * store the pasted key, record which mechanism/endpoint this connection
   * uses. No network round-trip; the first real request proves the key. */
  async connectRegistryWithKey(registryId: string, token: string, url?: string): Promise<void> {
    const entry = this.entryFor(registryId);
    if (entry === undefined || entry.auth.header === null) {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId, reason: "no API-key mode for this integration" });
      return;
    }
    const endpoint = this.resolveEndpoint(entry, url);
    if ("error" in endpoint) {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId, reason: endpoint.error });
      return;
    }
    if (token.trim() === "") {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId, reason: "key is empty" });
      return;
    }
    await this.tokens.set(registryId, { accessToken: token.trim() });
    await this.configFile.upsertIntegration({
      id: registryId,
      name: entry.name,
      source: {
        kind: "registry",
        registryId,
        authMode: "header",
        ...(entry.userUrl ? { url: endpoint.url } : {}),
      },
      routing: "auto",
    });
    await this.refresh();
  }

  /** MCP-spec OAuth connect (docs/reference-mcp-oauth.md §2): URL-only —
   * discovery, dynamic client registration, PKCE, browser redirect via the
   * injected user agent. Failure (gated DCR, non-compliant server, denied
   * consent, timeout) is immediate and labeled — pitfall §2. */
  async connectRegistryOAuth(registryId: string, url?: string): Promise<void> {
    const entry = this.entryFor(registryId);
    if (entry === undefined || !entry.auth.oauth) {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId, reason: "no OAuth mode for this integration" });
      return;
    }
    const endpoint = this.resolveEndpoint(entry, url);
    if ("error" in endpoint) {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId, reason: endpoint.error });
      return;
    }
    if (this.oauthUserAgent === null) {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId, reason: "OAuth is unavailable in this environment" });
      return;
    }
    this.hooks.emit({ kind: "integrationConnectStarted", registryId });
    try {
      const result = await connectMcpOAuth(endpoint.url, CLIENT_INFO, this.oauthUserAgent);
      await this.tokens.set(registryId, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: expiresAtFrom(result.expiresIn),
        tokenEndpoint: result.tokenEndpoint,
        clientId: result.clientId,
      });
      await this.configFile.upsertIntegration({
        id: registryId,
        name: entry.name,
        source: {
          kind: "registry",
          registryId,
          authMode: "oauth",
          ...(entry.userUrl ? { url: endpoint.url } : {}),
        },
        routing: "auto",
      });
      await this.refresh();
    } catch (err) {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId, reason: (err as Error).message });
    }
  }

  /** The escape hatch: any MCP server, command or URL, with auth. OAuth
   * custom integrations run the same flow as registry ones. */
  async addCustom(
    id: string,
    name: string,
    source: IntegrationSourceView,
    routing: IntegrationRoutingView,
  ): Promise<void> {
    let configSource: IntegrationSource;
    if (source.kind === "custom-stdio") {
      configSource = {
        kind: "custom-stdio",
        command: source.command,
        args: [...source.args],
        env: { ...source.env },
      };
    } else {
      configSource = {
        kind: "custom-http",
        url: source.url,
        authType: source.authType,
        headerName: source.headerName ?? "Authorization",
        valuePrefix: source.valuePrefix ?? "Bearer ",
      };
      if (source.authType === "header" && source.token) {
        await this.tokens.set(id, { accessToken: source.token });
      }
    }
    await this.configFile.upsertIntegration({
      id,
      name,
      source: configSource,
      routing: routing === "auto" ? "auto" : [...routing],
    });
    await this.refresh();
    if (source.kind === "custom-http" && source.authType === "oauth") {
      await this.connectCustomOAuth(id, source.url);
    }
  }

  private async connectCustomOAuth(id: string, url: string): Promise<void> {
    if (this.oauthUserAgent === null) {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId: id, reason: "OAuth is unavailable in this environment" });
      return;
    }
    this.hooks.emit({ kind: "integrationConnectStarted", registryId: id });
    try {
      const result = await connectMcpOAuth(url, CLIENT_INFO, this.oauthUserAgent);
      await this.tokens.set(id, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: expiresAtFrom(result.expiresIn),
        tokenEndpoint: result.tokenEndpoint,
        clientId: result.clientId,
      });
      await this.refresh();
    } catch (err) {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId: id, reason: (err as Error).message });
    }
  }

  /** Revokes the credential; the config entry (name, routing) survives so
   * reconnecting doesn't mean re-adding it. */
  async disconnect(id: string): Promise<void> {
    await this.tokens.remove(id);
    await this.refresh();
  }

  async remove(id: string): Promise<void> {
    await this.tokens.remove(id);
    await this.configFile.removeIntegration(id);
    await this.refresh();
  }

  async setRouting(id: string, routing: IntegrationRoutingView): Promise<void> {
    await this.configFile.setIntegrationRouting(id, routing === "auto" ? "auto" : [...routing]);
    await this.refresh();
  }

  /** A currently-valid token for the bridge process, refreshed transparently
   * if it's near/past expiry and refresh context exists — the bridge itself
   * never sees a refresh token, only ever a fresh access token. Refresh
   * context (token endpoint + client id) was captured at connect, since
   * OAuth endpoints are discovered, not static (StoredToken carries them). */
  async getToken(integrationId: string): Promise<{ accessToken: string } | null> {
    const stored = await this.tokens.get(integrationId);
    if (stored === null) return null;
    if (!isExpired(stored)) return { accessToken: stored.accessToken };
    if (stored.refreshToken === undefined || stored.tokenEndpoint === undefined || stored.clientId === undefined) {
      return { accessToken: stored.accessToken }; // nothing to refresh with — let the server's own 401 speak
    }
    try {
      const refreshed = await refreshMcpOAuth(stored.tokenEndpoint, stored.clientId, stored.refreshToken);
      await this.tokens.set(integrationId, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: expiresAtFrom(refreshed.expiresIn),
        tokenEndpoint: stored.tokenEndpoint,
        clientId: stored.clientId,
      });
      return { accessToken: refreshed.accessToken };
    } catch {
      return { accessToken: stored.accessToken }; // refresh failed — let the bridge's own retry surface it
    }
  }

  /** The mcpServers entries a session for `agentId` should get: every
   * integration routed to it (explicit id list, or "auto" once the agent is
   * fully brokered) and actually usable (connected where a credential is
   * needed, a real endpoint where one is required). custom-stdio needs no
   * bridge — handed straight through; registry/custom-http ride the generic
   * stdio-to-HTTP bridge, "just another local MCP server" either way. */
  async mcpServersFor(
    agentId: string,
    isFullyBrokered: boolean,
    bridgeScriptPath: string,
    ipcSocketPath: string,
  ): Promise<McpServer[]> {
    const result = await this.configFile.read();
    if (!result.ok) return [];
    const servers: McpServer[] = [];
    for (const integration of result.config.integrations) {
      const routed =
        integration.routing === "auto" ? isFullyBrokered : integration.routing.includes(agentId);
      if (!routed) continue;

      const source = integration.source;
      if (source.kind === "custom-stdio") {
        servers.push({
          name: integration.name,
          command: source.command,
          args: source.args,
          env: Object.entries(source.env).map(([name, value]) => ({ name, value })),
        });
        continue;
      }

      const entry = source.kind === "registry" ? this.entryFor(source.registryId) : undefined;
      const url =
        source.kind === "registry" ? (source.url ?? entry?.url ?? "") : source.url;
      if (url === "") continue; // not connectable — nothing to route to
      if (needsToken(source) && (await this.tokens.get(integration.id)) === null) continue;

      const header = headerShapeOf(source, entry);
      servers.push({
        name: integration.name,
        command: process.execPath,
        args: [bridgeScriptPath],
        env: [
          { name: "ACP_PATCHBAY_IPC", value: ipcSocketPath },
          { name: "ACP_PATCHBAY_INTEGRATION_ID", value: integration.id },
          { name: "ACP_PATCHBAY_INTEGRATION_URL", value: url },
          ...(header !== null
            ? [
                { name: "ACP_PATCHBAY_AUTH_HEADER", value: header.headerName },
                { name: "ACP_PATCHBAY_AUTH_PREFIX", value: header.valuePrefix },
              ]
            : []),
        ],
      });
    }
    return servers;
  }
}
