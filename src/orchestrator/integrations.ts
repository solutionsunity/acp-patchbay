// Integrations manager (architecture.md § Integrations): curated (registry)
// and custom are the same mechanism — MCP servers routed to agents. Owns the
// OAuth Device Flow connect lifecycle, routing decisions, and the
// mcpServers entries a session actually gets. vscode-free (like
// SessionManager/CapabilityVerifier) so it's unit-testable against a fake
// HTTP server standing in for both the OAuth provider and the remote MCP
// endpoint — the same fixture philosophy as the fake ACP agent.
import type { McpServer } from "@agentclientprotocol/sdk";
import type {
  IntegrationRoutingView,
  IntegrationSourceView,
  IntegrationView,
  RegistryEntryView,
  SettingsEvent,
} from "../shared/protocol";
import {
  DeviceFlowDeniedError,
  DeviceFlowExpiredError,
  pollForToken,
  refreshToken,
  requestDeviceCode,
  type DeviceFlowEndpoints,
} from "./oauth-device-flow";
import { ConfigFileStore, type IntegrationSource } from "./stores/config-file";
import { IntegrationTokenStore, type StoredToken } from "./stores/integration-tokens";
import { isConnectable, type RegistryEntry } from "./stores/registry";

export interface IntegrationsManagerHooks {
  emit(...events: SettingsEvent[]): void;
}

/** True with a minute of margin — refresh slightly before expiry rather
 * than reacting to a 401 whenever avoidable. */
function isExpired(token: StoredToken): boolean {
  if (token.expiresAt === undefined) return false;
  return Date.now() > Date.parse(token.expiresAt) - 60_000;
}

function endpointsOf(entry: RegistryEntry): DeviceFlowEndpoints {
  return {
    deviceCodeUrl: entry.auth.deviceCodeUrl,
    tokenUrl: entry.auth.tokenUrl,
    clientId: entry.auth.clientId,
    scopes: entry.auth.scopes,
  };
}

/** Registry and bearer-token custom-http both need a token to be considered
 * connected; custom-stdio and authType "none" custom-http need nothing. */
function needsToken(source: IntegrationSource): boolean {
  return source.kind === "registry" || (source.kind === "custom-http" && source.authType === "bearer-token");
}

export class IntegrationsManager {
  constructor(
    private readonly registry: readonly RegistryEntry[],
    private readonly configFile: ConfigFileStore,
    private readonly tokens: IntegrationTokenStore,
    private readonly hooks: IntegrationsManagerHooks,
  ) {}

  registryViews(): RegistryEntryView[] {
    return this.registry.map((r) => ({ id: r.id, name: r.name, connectable: isConnectable(r) }));
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

  /** One click, connect (features.md § Integrations). Emits the user/device
   * code immediately so the UI can show it, then polls in the background —
   * the caller never waits on the whole flow. */
  async connectRegistry(registryId: string): Promise<void> {
    const entry = this.registry.find((r) => r.id === registryId);
    if (entry === undefined || !isConnectable(entry)) {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId, reason: "not connectable yet" });
      return;
    }
    const endpoints = endpointsOf(entry);
    let device;
    try {
      device = await requestDeviceCode(endpoints);
    } catch (err) {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId, reason: (err as Error).message });
      return;
    }
    this.hooks.emit({
      kind: "integrationDeviceCodeIssued",
      registryId,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      expiresIn: device.expiresIn,
    });
    try {
      const token = await pollForToken(endpoints, device);
      await this.tokens.set(registryId, {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt:
          token.expiresIn !== undefined
            ? new Date(Date.now() + token.expiresIn * 1000).toISOString()
            : undefined,
      });
      await this.configFile.upsertIntegration({
        id: registryId,
        name: entry.name,
        source: { kind: "registry", registryId },
        routing: "auto",
      });
      await this.refresh();
    } catch (err) {
      const reason =
        err instanceof DeviceFlowDeniedError
          ? "denied"
          : err instanceof DeviceFlowExpiredError
            ? "expired"
            : (err as Error).message;
      this.hooks.emit({ kind: "integrationConnectFailed", registryId, reason });
    }
  }

  /** The escape hatch: any MCP server, command or URL, with auth. */
  async addCustom(
    id: string,
    name: string,
    source: IntegrationSourceView,
    routing: IntegrationRoutingView,
  ): Promise<void> {
    if (source.kind === "custom-http" && source.authType === "bearer-token" && source.token) {
      await this.tokens.set(id, { accessToken: source.token });
    }
    const configSource: IntegrationSource =
      source.kind === "custom-stdio"
        ? { kind: "custom-stdio", command: source.command, args: [...source.args], env: { ...source.env } }
        : { kind: "custom-http", url: source.url, authType: source.authType };
    await this.configFile.upsertIntegration({
      id,
      name,
      source: configSource,
      routing: routing === "auto" ? "auto" : [...routing],
    });
    await this.refresh();
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
   * if it's near/past expiry and a refresh token exists — the bridge itself
   * never sees a refresh token, only ever a fresh access token (P9's IPC hook). */
  async getToken(integrationId: string): Promise<{ accessToken: string } | null> {
    const stored = await this.tokens.get(integrationId);
    if (stored === null) return null;
    if (!isExpired(stored) || stored.refreshToken === undefined) return { accessToken: stored.accessToken };
    const entry = this.registry.find((r) => r.id === integrationId);
    if (entry === undefined) return { accessToken: stored.accessToken }; // no known refresh endpoint — hand back what we have
    try {
      const refreshed = await refreshToken(endpointsOf(entry), stored.refreshToken);
      await this.tokens.set(integrationId, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt:
          refreshed.expiresIn !== undefined
            ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
            : undefined,
      });
      return { accessToken: refreshed.accessToken };
    } catch {
      return { accessToken: stored.accessToken }; // refresh failed — let the bridge's own retry surface it
    }
  }

  /** The mcpServers entries a session for `agentId` should get: every
   * integration routed to it (explicit id list, or "auto" once the agent is
   * fully brokered) and actually usable (connected where a token is needed,
   * a real endpoint where one is required). custom-stdio needs no bridge —
   * handed straight through; registry/custom-http both ride the generic
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

      if (integration.source.kind === "custom-stdio") {
        servers.push({
          name: integration.name,
          command: integration.source.command,
          args: integration.source.args,
          env: Object.entries(integration.source.env).map(([name, value]) => ({ name, value })),
        });
        continue;
      }

      const source = integration.source;
      const url = source.kind === "registry" ? this.registry.find((r) => r.id === source.registryId)?.url : source.url;
      if (url === undefined || url === "") continue; // not connectable — nothing to route to
      if (needsToken(integration.source) && (await this.tokens.get(integration.id)) === null) continue;

      servers.push({
        name: integration.name,
        command: process.execPath,
        args: [bridgeScriptPath],
        env: [
          { name: "ACP_PATCHBAY_IPC", value: ipcSocketPath },
          { name: "ACP_PATCHBAY_INTEGRATION_ID", value: integration.id },
          { name: "ACP_PATCHBAY_INTEGRATION_URL", value: url },
        ],
      });
    }
    return servers;
  }
}
