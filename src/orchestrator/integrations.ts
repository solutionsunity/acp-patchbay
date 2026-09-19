// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Integrations manager: curated (registry)
// and custom are the same mechanism — MCP servers routed to agents. Owns
// the connect lifecycle (static key in a configurable header, or MCP-spec
// OAuth 2.1), routing decisions, and the
// mcpServers entries a session actually gets. vscode-free (like
// SessionManager/CapabilityTracker): the OAuth browser/redirect step is an
// injected OAuthUserAgent, so everything is unit-testable against a fake
// OAuth provider and a fake remote MCP endpoint — the same fixture
// philosophy as the fake ACP agent.
import type { McpServer } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type {
  IntegrationProbeView,
  IntegrationRoutingView,
  IntegrationSourceView,
  IntegrationView,
  RegistryEntryView,
  SettingsEvent,
} from "../shared/protocol";
import { probeMcpServer, type ProbeFn, type ProbeTarget } from "./integration-probe";
import { parseCommandLine } from "./command-line";
import { loggableUrl, nullLogger, type Logger } from "./logger";
import { connectMcpOAuth, refreshMcpOAuth, type OAuthUserAgent } from "./mcp-oauth";
import { IntegrationTokenStore, type StoredToken } from "./stores/integration-tokens";
import { IntegrationConfigStore, type IntegrationConfig, type IntegrationSource } from "./stores/integration-configs";
import { isConnectable, type RegistryEntry } from "./stores/registry";
import type { SecretEnvStore } from "./stores/secret-env";

export interface IntegrationsManagerHooks {
  emit(...events: SettingsEvent[]): void;
}

const CLIENT_INFO = {
  clientName: "acp-patchbay",
  clientUri: "https://github.com/solutionsunity/acp-patchbay",
};

/** User-abandoned browser flow — not a failure, just no outcome. */
class ConnectCancelled extends Error {}

const BROWSER_FLOW_TIMEOUT_MS = 10 * 60_000;

/** Ids are generated, never user-typed — they're the storage/SecretStorage
 * key, an internal concern. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

/** One entry of the well-known `mcpServers` JSON (Claude Desktop / Cursor /
 * VS Code shape) — the interchange format users already have on disk.
 * Unknown fields are ignored rather than rejected (the format grows). */
const mcpServersEntrySchema = z.union([
  z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    url: z.string().min(1),
    authType: z.enum(["none", "header", "oauth"]).default("none"),
    headerName: z.string().optional(),
    valuePrefix: z.string().optional(),
    /** A header key — user-typed, so it rides editJson and Copy like env
     * does. Never an OAuth token. */
    token: z.string().optional(),
  }),
]);

/** Own the routing arrays on store writes — the view's readonly arrays stay
 * the webview's (protocol.ts: three reaches — auto / id list / except). */
function cloneRouting(routing: IntegrationRoutingView): "auto" | string[] | { except: string[] } {
  if (routing === "auto") return "auto";
  return Array.isArray(routing) ? [...routing] : { except: [...(routing as { except: readonly string[] }).except] };
}

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

/** The endpoint an http-backed integration reaches: the user's own URL for
 * a per-account entry, else the registry's fixed one; "" when neither
 * exists (not connectable). Never called for custom-stdio. */
function endpointOf(
  source: Exclude<IntegrationSource, { kind: "custom-stdio" }>,
  entry: RegistryEntry | undefined,
): string {
  return source.kind === "registry" ? (source.url ?? entry?.url ?? "") : source.url;
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
    private readonly integrationStore: IntegrationConfigStore,
    private readonly tokens: IntegrationTokenStore,
    /** Env values for custom-stdio servers — SecretStorage-backed
     * (stores/secret-env.ts), read at attach time in mcpServersFor; the
     * config record carries no env at all. */
    private readonly envStore: SecretEnvStore,
    private readonly hooks: IntegrationsManagerHooks,
    /** The directory agents are launched in — and so the one their
     * spawned stdio servers inherit. The probe runs custom-stdio servers
     * here so it reports the same reality the agent's own spawn will. */
    private readonly workspaceCwd: string,
    /** Browser/redirect step for OAuth connects — the orchestrator wires
     * registerUriHandler + asExternalUri; tests wire a fake. Absent →
     * OAuth connects fail labeled (header connects unaffected). */
    private readonly oauthUserAgent: OAuthUserAgent | null = null,
    /** Output-channel seam (logger.ts) — hosts and key *names* only, never
     * tokens, env values, or full URLs (query strings can embed secrets). */
    private readonly log: Logger = nullLogger,
    /** The connect-time tool probe (integration-probe.ts) — injected so
     * tests fake the handshake instead of hitting network/spawning. */
    private readonly probeFn: ProbeFn = probeMcpServer,
  ) {}

  /** Latest probe per integration id — session-lived, never persisted: a
   * tool list is a point-in-time read of the server, so a fresh window
   * re-reads reality instead of trusting last week's snapshot. */
  private readonly probes = new Map<string, IntegrationProbeView>();

  /** In-flight browser flows by integration id — each holds its own
   * cancel trigger, so an abandoned browser tab isn't a forever-pending
   * "Connecting…" (the tab may simply never answer). */
  private readonly pendingConnects = new Map<string, () => void>();

  /** Cancels an in-flight browser flow; with nothing in flight it clears a
   * lingering failed note instead — the same "no outcome, back to idle". */
  cancelConnect(id: string): void {
    const cancel = this.pendingConnects.get(id);
    if (cancel !== undefined) cancel();
    else this.hooks.emit({ kind: "integrationConnectResolved", registryId: id });
  }

  /** Races the browser flow against user cancel and a hard timeout. The
   * losing flow is left to die quietly — its eventual result is dropped,
   * never stored. */
  private async raceBrowserFlow<T>(id: string, flow: Promise<T>): Promise<T> {
    flow.catch(() => {}); // the race may abandon it — never an unhandled rejection
    let timer: ReturnType<typeof setTimeout>;
    const interrupted = new Promise<never>((_, reject) => {
      this.pendingConnects.set(id, () => reject(new ConnectCancelled()));
      timer = setTimeout(
        () => reject(new Error("timed out waiting for browser authorization")),
        BROWSER_FLOW_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([flow, interrupted]);
    } finally {
      clearTimeout(timer!);
      this.pendingConnects.delete(id);
    }
  }

  /** One outcome path for a browser flow that didn't finish: cancel clears
   * the pending state without inventing a failure; anything else is a
   * labeled failure. */
  private emitFlowOutcome(id: string, err: unknown): void {
    if (err instanceof ConnectCancelled) {
      this.log.info(`${id}: browser OAuth cancelled — nothing stored`);
      this.hooks.emit({ kind: "integrationConnectResolved", registryId: id });
    } else {
      this.log.error(`${id}: connect failed — ${(err as Error).message}`);
      this.hooks.emit({ kind: "integrationConnectFailed", registryId: id, reason: (err as Error).message });
    }
  }

  registryViews(): RegistryEntryView[] {
    return this.registry.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      icon: r.icon,
      brandIcon: r.brandIcon,
      connectable: isConnectable(r),
      note: r.note,
      docsUrl: r.docsUrl,
      userUrl: r.userUrl,
      headerAuth: r.auth.header
        ? { hint: r.auth.header.hint, keyUrl: r.auth.header.keyUrl }
        : null,
      oauth: r.auth.oauth,
      local:
        r.local === null
          ? null
          : "command" in r.local
            ? {
                kind: "stdio" as const,
                command: r.local.command,
                args: r.local.args,
                envKeys: r.local.envKeys,
                note: r.local.note,
              }
            : { kind: "http" as const, url: r.local.url, note: r.local.note },
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
    const views: IntegrationView[] = [];
    for (const integration of this.integrationStore.list()) {
      const connected = needsToken(integration.source)
        ? (await this.tokens.get(integration.id)) !== null
        : true;
      const source = integration.source;
      views.push({
        id: integration.id,
        name: integration.name,
        sourceKind: source.kind,
        registryId: source.kind === "registry" ? source.registryId : undefined,
        command:
          source.kind === "custom-stdio"
            ? [source.command, ...source.args].join(" ")
            : source.kind === "custom-http"
              ? source.url
              : undefined,
        connected,
        active: integration.active,
        routing: integration.routing,
        transport: integration.transport,
        probe: this.probes.get(integration.id),
        editJson: await this.editJsonFor(integration.id, source),
      });
    }
    return views;
  }

  /** The editable mcpServers entry for a custom server, values included.
   * Undefined for curated entries — their shape is registry data. */
  private async editJsonFor(id: string, source: IntegrationSource): Promise<string | undefined> {
    if (source.kind === "registry") return undefined;
    const entry = await this.entryJsonFor(id, source);
    return entry === undefined ? undefined : JSON.stringify(entry, null, 2);
  }

  /** Copy config: the integration as a `{"mcpServers": {name: entry}}`
   * document — the well-known shape importJson reads and other clients
   * take. Keyed by display name so a re-import slugs back to the same id.
   * A curated entry copies as its resolved endpoint plus auth shape (what
   * a re-import would create as a custom-http server). Undefined when there
   * is no endpoint to name. */
  async exportJson(id: string): Promise<string | undefined> {
    const integration = this.integrationStore.get(id);
    if (integration === undefined) return undefined;
    const entry = await this.entryJsonFor(id, integration.source);
    if (entry === undefined) return undefined;
    return JSON.stringify({ mcpServers: { [integration.name]: entry } }, null, 2);
  }

  /** One `mcpServers` entry, the shape mcpServersEntrySchema reads back,
   * carrying what the owner typed: env values, and the key of a header-auth
   * server. An OAuth token is flow-minted and never rides. */
  private async entryJsonFor(
    id: string,
    source: IntegrationSource,
  ): Promise<Record<string, unknown> | undefined> {
    if (source.kind === "custom-stdio") {
      return { command: source.command, args: source.args, env: await this.envStore.get(id) };
    }
    const entry = source.kind === "registry" ? this.entryFor(source.registryId) : undefined;
    const url = endpointOf(source, entry);
    if (url === "") return undefined;
    const authType = source.kind === "registry" ? source.authMode : source.authType;
    if (authType !== "header") return { url, authType };
    const token = (await this.tokens.get(id))?.accessToken;
    return { url, authType, ...headerShapeOf(source, entry), ...(token !== undefined ? { token } : {}) };
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

  /** Static-key connect (the v1 floor):
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
    this.log.info(`${registryId}: connected with key (endpoint ${loggableUrl(endpoint.url)})`);
    await this.integrationStore.upsert({
      id: registryId,
      name: entry.name,
      source: {
        kind: "registry",
        registryId,
        authMode: "header",
        ...(entry.userUrl ? { url: endpoint.url } : {}),
      },
      routing: "auto",
      active: true,
      transport: "auto",
    });
    await this.refresh();
    void this.probe(registryId);
  }

  /** MCP-spec OAuth connect: URL-only —
   * discovery, dynamic client registration, PKCE, browser redirect via the
   * injected user agent. Failure (gated DCR, non-compliant server, denied
   * consent, timeout) is immediate and labeled. */
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
    this.log.info(`${registryId}: browser OAuth starting (endpoint ${loggableUrl(endpoint.url)})`);
    try {
      const result = await this.raceBrowserFlow(
        registryId,
        connectMcpOAuth(endpoint.url, CLIENT_INFO, this.oauthUserAgent),
      );
      await this.tokens.set(registryId, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: expiresAtFrom(result.expiresIn),
        tokenEndpoint: result.tokenEndpoint,
        clientId: result.clientId,
      });
      await this.integrationStore.upsert({
        id: registryId,
        name: entry.name,
        source: {
          kind: "registry",
          registryId,
          authMode: "oauth",
          ...(entry.userUrl ? { url: endpoint.url } : {}),
        },
        routing: "auto",
        active: true,
        transport: "auto",
      });
      this.log.info(`${registryId}: connected via OAuth`);
      await this.refresh();
    } catch (err) {
      this.emitFlowOutcome(registryId, err);
    }
  }

  /** A free id derived from the display name — slug, uniquified against
   * what's stored. The id is patchbay's storage key, never user-typed. */
  private uniqueId(name: string): string {
    const base = slugify(name);
    if (this.integrationStore.get(base) === undefined) return base;
    let n = 2;
    while (this.integrationStore.get(`${base}-${n}`) !== undefined) n++;
    return `${base}-${n}`;
  }

  /** The escape hatch: any MCP server, command or URL, with auth. Nothing
   * is stored until it can actually work: a custom OAuth connect runs the
   * browser flow *first* and stores only on success — cancelling consent
   * means nothing was added, never a stranded credential-less record.
   * Returns the generated id (slug of `name`, uniquified). */
  async addCustom(
    name: string,
    source: IntegrationSourceView,
    routing: IntegrationRoutingView,
  ): Promise<string> {
    const id = this.uniqueId(name);
    let configSource: IntegrationSource;
    if (source.kind === "custom-stdio") {
      // `args` arrive structured (form lines / imported JSON) and are never
      // re-parsed; the `command` field alone may still be a typed line
      // ("npx foo"), so it gets the quote-aware house parser (parsing is
      // logic, and it lives here).
      const parsed = parseCommandLine(source.command);
      if (parsed === null) {
        this.hooks.emit({
          kind: "integrationConnectFailed",
          registryId: id,
          reason: "command line has an unterminated quote",
        });
        return id;
      }
      configSource = {
        kind: "custom-stdio",
        command: parsed.command,
        args: [...parsed.args, ...source.args],
      };
      // Values ride the action once and land in SecretStorage — the config
      // record above deliberately carries no env.
      await this.envStore.set(id, { ...source.env });
    } else {
      configSource = {
        kind: "custom-http",
        url: source.url,
        authType: source.authType,
        headerName: source.headerName ?? "Authorization",
        valuePrefix: source.valuePrefix ?? "Bearer ",
      };
      if (source.authType === "header") {
        if (!source.token) {
          this.hooks.emit({ kind: "integrationConnectFailed", registryId: id, reason: "key is empty" });
          return id;
        }
        await this.tokens.set(id, { accessToken: source.token });
      }
      if (source.authType === "oauth") {
        const connected = await this.runCustomOAuth(id, source.url);
        if (!connected) return id; // failed/cancelled labeled — nothing stored
      }
    }
    await this.integrationStore.upsert({
      id,
      name,
      source: configSource,
      routing: cloneRouting(routing),
      active: true,
      transport: "auto",
    });
    this.log.info(`${id}: custom ${configSource.kind} added`);
    await this.refresh();
    void this.probe(id);
    return id;
  }

  /** Browser OAuth for a custom URL — token stored on success only. */
  private async runCustomOAuth(id: string, url: string): Promise<boolean> {
    if (this.oauthUserAgent === null) {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId: id, reason: "OAuth is unavailable in this environment" });
      return false;
    }
    this.hooks.emit({ kind: "integrationConnectStarted", registryId: id });
    try {
      const result = await this.raceBrowserFlow(id, connectMcpOAuth(url, CLIENT_INFO, this.oauthUserAgent));
      await this.tokens.set(id, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: expiresAtFrom(result.expiresIn),
        tokenEndpoint: result.tokenEndpoint,
        clientId: result.clientId,
      });
      return true;
    } catch (err) {
      this.emitFlowOutcome(id, err);
      return false;
    }
  }

  /** Imports the well-known `{"mcpServers": {...}}` JSON (a bare name→spec
   * map is accepted too). Each entry becomes a custom server named by its
   * key; per-entry failures are labeled and don't stop the rest. Only what
   * validates is stored — a trust boundary, same as every store read. */
  async importJson(json: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId: "import", reason: "not valid JSON" });
      return;
    }
    const root = (parsed as { mcpServers?: unknown }).mcpServers ?? parsed;
    if (typeof root !== "object" || root === null || Array.isArray(root)) {
      this.hooks.emit({
        kind: "integrationConnectFailed",
        registryId: "import",
        reason: 'expected {"mcpServers": {name: {...}}} or a name→server map',
      });
      return;
    }
    for (const [name, raw] of Object.entries(root)) {
      const spec = mcpServersEntrySchema.safeParse(raw);
      if (!spec.success) {
        this.hooks.emit({
          kind: "integrationConnectFailed",
          registryId: `import:${slugify(name)}`,
          reason: `"${name}": neither a command entry nor a url entry`,
        });
        continue;
      }
      const source: IntegrationSourceView =
        "command" in spec.data
          ? { kind: "custom-stdio", command: spec.data.command, args: spec.data.args, env: spec.data.env }
          : {
              kind: "custom-http",
              url: spec.data.url,
              authType: spec.data.authType,
              headerName: spec.data.headerName,
              valuePrefix: spec.data.valuePrefix,
              token: spec.data.token,
            };
      await this.addCustom(name, source, "auto");
    }
  }

  /** Applies an edited mcpServers entry to one custom server — the box is
   * the truth: env is stored as written, and for header auth so is
   * `token` (removing it removes the key, which reads as disconnected
   * until one is entered again). */
  async updateFromJson(id: string, json: string): Promise<void> {
    const existing = this.integrationStore.get(id);
    if (existing === undefined || existing.source.kind === "registry") return;
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      this.hooks.emit({ kind: "integrationConnectFailed", registryId: id, reason: "not valid JSON" });
      return;
    }
    const spec = mcpServersEntrySchema.safeParse(raw);
    if (!spec.success) {
      this.hooks.emit({
        kind: "integrationConnectFailed",
        registryId: id,
        reason: "neither a command entry nor a url entry",
      });
      return;
    }
    if ("command" in spec.data) {
      await this.envStore.set(id, spec.data.env);
      await this.integrationStore.upsert({
        ...existing,
        source: { kind: "custom-stdio", command: spec.data.command, args: spec.data.args },
      });
    } else {
      if (spec.data.authType === "header") {
        if (spec.data.token) await this.tokens.set(id, { accessToken: spec.data.token });
        else await this.tokens.remove(id);
      }
      await this.integrationStore.upsert({
        ...existing,
        source: {
          kind: "custom-http",
          url: spec.data.url,
          authType: spec.data.authType,
          headerName: spec.data.headerName ?? "Authorization",
          valuePrefix: spec.data.valuePrefix ?? "Bearer ",
        },
      });
    }
    await this.refresh();
  }

  /** Disconnect *is* remove — the full clear (credential + env + config).
   * A curated entry then reappears in the catalog ready for a fresh
   * connect; a custom one is simply gone. The non-destructive option is
   * `setActive(false)`, which keeps everything and only unroutes. */
  async remove(id: string): Promise<void> {
    this.probes.delete(id);
    await this.tokens.remove(id);
    await this.envStore.remove(id);
    await this.integrationStore.remove(id);
    this.log.info(`${id}: removed — credential, env, and config cleared`);
    await this.refresh();
  }

  async setActive(id: string, active: boolean): Promise<void> {
    const existing = this.integrationStore.get(id);
    if (existing === undefined) return;
    await this.integrationStore.upsert({ ...existing, active });
    await this.refresh();
    if (active) void this.probe(id);
  }

  /** Settings drag-drop — persist the dropped order and republish. Order
   * is presentational only (routing never depends on it): no probe, no
   * reconnect. */
  async reorder(ids: readonly string[]): Promise<void> {
    await this.integrationStore.reorder(ids);
    await this.refresh();
  }

  async setTransport(id: string, transport: "auto" | "bridge"): Promise<void> {
    const existing = this.integrationStore.get(id);
    if (existing === undefined) return;
    await this.integrationStore.upsert({ ...existing, transport });
    await this.refresh();
  }

  /** Runs the connect-time tool probe and caches the outcome on the card
   * (protocol.ts IntegrationProbeView — provider-side truth, timestamped).
   * Explicit-trigger only (connect, power-on, refresh button): probing a
   * custom-stdio server executes its command, and even http shouldn't fire
   * on background sweeps — reality is read when the user acts on it. */
  async probe(id: string): Promise<void> {
    const integration = this.integrationStore.get(id);
    if (integration === undefined) return;
    this.probes.set(id, { status: "probing", at: new Date().toISOString() });
    await this.refresh();
    let target: ProbeTarget | null = null;
    try {
      target = await this.probeTargetFor(integration);
      if (target === null) {
        // Nothing reachable to probe (no endpoint / missing credential) —
        // the card's connected flag already tells that story.
        this.probes.delete(id);
      } else {
        const outcome = await this.probeFn(target);
        this.probes.set(id, {
          status: "ok",
          at: new Date().toISOString(),
          serverName: outcome.serverName,
          serverVersion: outcome.serverVersion,
          tools: outcome.tools,
        });
        this.log.info(`${id}: probe ok — ${outcome.tools.length} tool(s)`);
      }
    } catch (err) {
      // A stdio failure names where the command ran: a server that reads
      // project-local config fails differently per directory, and the
      // reason should let the user see which one was tried.
      const reason =
        target?.kind === "stdio"
          ? `${(err as Error).message} (ran in ${target.cwd})`
          : (err as Error).message;
      this.probes.set(id, { status: "failed", at: new Date().toISOString(), reason });
      this.log.info(`${id}: probe failed — ${reason}`);
    }
    await this.refresh();
  }

  /** The probe's connection recipe for one integration — same resolution as
   * mcpServersFor (registry entry URL, header shape, fresh token), pointed
   * at patchbay's own MCP client instead of an agent's. */
  private async probeTargetFor(integration: IntegrationConfig): Promise<ProbeTarget | null> {
    const source = integration.source;
    if (source.kind === "custom-stdio") {
      return {
        kind: "stdio",
        command: source.command,
        args: source.args,
        env: await this.envStore.get(integration.id),
        cwd: this.workspaceCwd,
      };
    }
    const entry = source.kind === "registry" ? this.entryFor(source.registryId) : undefined;
    const url = source.kind === "registry" ? (source.url ?? entry?.url ?? "") : source.url;
    if (url === "") return null;
    const shape = headerShapeOf(source, entry);
    if (shape === null) return { kind: "http", url, header: null };
    const token = (await this.getToken(integration.id))?.accessToken ?? null;
    if (token === null) return null; // needs a credential, none stored
    return { kind: "http", url, header: { name: shape.headerName, value: `${shape.valuePrefix}${token}` } };
  }

  async setRouting(id: string, routing: IntegrationRoutingView): Promise<void> {
    const existing = this.integrationStore.get(id);
    if (existing === undefined) return;
    await this.integrationStore.upsert({
      ...existing,
      routing: cloneRouting(routing),
    });
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
   * integration routed to it ("auto" = every agent; explicit id list;
   * "except" = every agent minus the listed — protocol.ts records the
   * fidelity-gate supersession) and actually usable (connected where a
   * credential is needed, a real endpoint where one is required).
   * custom-stdio needs no bridge — handed straight through.
   * registry/custom-http go one of two ways (prompt.image mechanics —
   * capability-conditional delivery): `declaresHttp` and transport "auto" ⇒
   * a real `type: "http"` entry, the agent's own MCP client connects (token
   * read here, at attach — it rides agent-visible config, ephemeral per
   * session, exactly like a CLI-added server; the recorded trade superseding
   * the earlier bridge-only rule). Otherwise the stdio-to-HTTP
   * bridge, the guaranteed floor. */
  async mcpServersFor(
    agentId: string,
    bridgeScriptPath: string,
    ipcSocketPath: string,
    declaresHttp: boolean,
  ): Promise<McpServer[]> {
    const servers: McpServer[] = [];
    for (const integration of this.integrationStore.list()) {
      if (!integration.active) continue; // muted — configured, credential intact, not routed
      const routed =
        integration.routing === "auto"
          ? true
          : Array.isArray(integration.routing)
            ? integration.routing.includes(agentId)
            : !integration.routing.except.includes(agentId);
      if (!routed) continue;

      const source = integration.source;
      if (source.kind === "custom-stdio") {
        // Env values read from SecretStorage at the moment of attach — this
        // is also where they necessarily cross to the agent: the agent
        // spawns stdio servers itself (ACP model), so the spawn env must
        // ride the session's mcpServers config. SecretStorage governs
        // where patchbay keeps them at rest, not that inherent handoff.
        // No cwd travels: the entry has no such field, so the server runs
        // wherever the agent does — the same workspaceCwd the probe uses.
        const env = await this.envStore.get(integration.id);
        servers.push({
          name: integration.name,
          command: source.command,
          args: source.args,
          env: Object.entries(env).map(([name, value]) => ({ name, value })),
        });
        continue;
      }

      const entry = source.kind === "registry" ? this.entryFor(source.registryId) : undefined;
      const url = endpointOf(source, entry);
      if (url === "") continue; // not connectable — nothing to route to
      if (needsToken(source) && (await this.tokens.get(integration.id)) === null) continue;

      const header = headerShapeOf(source, entry);
      if (declaresHttp && integration.transport === "auto") {
        // getToken refreshes transparently, so the agent starts the session
        // with the freshest credential we can mint — but passthrough is a
        // snapshot: a token expiring mid-session is the agent's 401 to
        // surface, not ours to fix (the bridge path re-reads per request).
        const token = header !== null ? (await this.getToken(integration.id))?.accessToken : null;
        servers.push({
          type: "http",
          name: integration.name,
          url,
          headers:
            header !== null && token != null
              ? [{ name: header.headerName, value: `${header.valuePrefix}${token}` }]
              : [],
        });
        continue;
      }
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
    this.log.debug(
      `mcpServersFor ${agentId}: serving ${servers.length} server(s)` +
        (servers.length > 0 ? ` — ${servers.map((sv) => sv.name).join(", ")}` : ""),
    );
    return servers;
  }
}
