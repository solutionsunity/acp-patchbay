// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The MCP-servers store: curated (catalog)
// and custom are the same mechanism — MCP servers routed to agents. Owns
// the connect lifecycle (static key in a configurable header, or MCP-spec
// OAuth 2.1), routing decisions, and the
// mcpServers entries a session actually gets. vscode-free (like
// SessionsStore/CapabilityTracker): the OAuth browser/redirect step is an
// injected OAuthUserAgent, so everything is unit-testable against a fake
// OAuth provider and a fake remote MCP endpoint — the same fixture
// philosophy as the fake ACP agent.
import { randomUUID } from "node:crypto";
import type { McpServer } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type {
  McpServerConnectView,
  McpServerProbeView,
  McpServerRoutingView,
  McpServerSourceView,
  McpServerView,
  McpServerWork,
  CatalogEntryView,
  SettingsEvent,
} from "../shared/protocol";
import { unlessAborted } from "./abort";
import { probeMcpServer, type ProbeFn, type ProbeTarget } from "./mcp-probe";
import { formatCommandLine, parseCommandLine } from "../shared/command-line";
import { loggableUrl, nullLogger, type Logger } from "./logger";
import { connectMcpOAuth, refreshMcpOAuth, type OAuthUserAgent } from "./mcp-oauth";
import { McpServerTokenStore, type StoredToken } from "./stores/mcp-server-tokens";
import { McpServerConfigStore, type McpServerConfig, type McpServerSource } from "./stores/mcp-server-configs";
import { isConnectable, type CatalogEntry } from "./stores/mcp-catalog";
import type { SecretEnvStore } from "./stores/secret-env";
import type { PatchbayAgentId, PatchbayMcpServerId } from "../shared/ids";

export interface McpServersStoreHooks {
  emit(...events: SettingsEvent[]): void;
}

/** What the gates' lines hold — read when the store publishes, never kept:
 * each server's line, and the connects under way. */
export interface McpServerLines {
  busy(patchbayMcpServerId: PatchbayMcpServerId): readonly McpServerWork[];
  /** The connect line's keys holding work (`connectKey`). */
  connecting(): readonly string[];
}

/** What a session's set is built with: the scripts patchbay spawns as
 * servers, the socket they reach it on, and the wire log's redaction of
 * every value that crosses to an agent. */
export interface McpServerWire {
  editorServerScript: string;
  bridgeScript: string;
  socketPath(): string;
  crossing(value: string): void;
}

/** Patchbay's own server — the editor's state and the session's roots —
 * given to every session over stdio, the one delivery every agent takes.
 * Built in: never stored, never removed, and its name is never another
 * server's. The id can't be a stored one's: no minted or slugged id holds
 * a colon. */
const EDITOR_SERVER = { id: "patchbay:editor" as PatchbayMcpServerId, name: "patchbay" } as const;

/** The operations that take time — a connect, an add, a probe, a remove —
 * each reached only through the gates, which order them on their lines. */
export type McpServerLineOperations = Pick<
  McpServersStore,
  "connectCatalogWithKey" | "connectCatalogOAuth" | "addCustom" | "probe" | "remove"
>;

/** The connect line's keys — one line per curated entry, one per custom
 * name — and the keys a failure is held under besides: an import (and each
 * of its entries) and a server's save. One vocabulary, so the published
 * connects are read straight off a key. */
export const connectKey = {
  catalog: (catalogId: string) => `catalog:${catalogId}`,
  custom: (name: string) => `custom:${name}`,
  import: (entryName?: string) => (entryName === undefined ? "import" : `import:${entryName}`),
  server: (patchbayMcpServerId: PatchbayMcpServerId) => `server:${patchbayMcpServerId}`,
};

function connectOf(key: string): Pick<McpServerConnectView, "kind" | "subject"> {
  const at = key.indexOf(":");
  const kind = (at === -1 ? key : key.slice(0, at)) as McpServerConnectView["kind"];
  return { kind, subject: at === -1 ? "" : key.slice(at + 1) };
}

/** A server given to a session at its attach: its id, and how it reached
 * the agent — handed through (stdio), passed through to the agent's own
 * client (http), or through patchbay's bridge, the one delivery that asks
 * patchbay for the server's credential. */
export interface AttachedServer {
  id: PatchbayMcpServerId;
  delivery: "stdio" | "http" | "bridge";
}

const CLIENT_INFO = {
  clientName: "acp-patchbay",
  clientUri: "https://github.com/solutionsunity/acp-patchbay",
};

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
function cloneRouting(routing: McpServerRoutingView): "auto" | string[] | { except: string[] } {
  if (routing === "auto") return "auto";
  return Array.isArray(routing) ? [...routing] : { except: [...(routing as { except: readonly string[] }).except] };
}

/** True with a minute of margin — refresh slightly before expiry rather
 * than reacting to a 401 whenever avoidable. */
function isExpired(token: StoredToken): boolean {
  if (token.expiresAt === undefined) return false;
  return Date.now() > Date.parse(token.expiresAt) - 60_000;
}

/** Refresh context is captured at an OAuth connect only — static keys
 * never expire on our side. */
function refreshable(
  token: StoredToken,
): token is StoredToken & { refreshToken: string; tokenEndpoint: string; clientId: string } {
  return token.refreshToken !== undefined && token.tokenEndpoint !== undefined && token.clientId !== undefined;
}

function expiresAtFrom(expiresIn: number | undefined): string | undefined {
  return expiresIn !== undefined ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
}

/** Whether a server reaches an agent's sessions: switched on, and routed to
 * it ("auto" = every agent; an id list pins exactly; "except" = every
 * agent minus the listed). Muted means configured, credential intact, not
 * routed. */
function reaches(config: McpServerConfig, patchbayAgentId: PatchbayAgentId): boolean {
  if (!config.active) return false;
  if (config.routing === "auto") return true;
  return Array.isArray(config.routing)
    ? config.routing.includes(patchbayAgentId)
    : !config.routing.except.includes(patchbayAgentId);
}

/** Whether "connected" requires a stored credential: curated servers
 * always (both header and oauth modes carry one); custom-http except
 * authType "none"; custom-stdio never. */
function needsToken(source: McpServerSource): boolean {
  if (source.kind === "catalog") return true;
  if (source.kind === "custom-http") return source.authType !== "none";
  return false;
}

/** The endpoint an http-backed server reaches: the user's own URL for
 * a per-account entry, else the catalog's fixed one; "" when neither
 * exists (not connectable). Never called for custom-stdio. */
function endpointOf(
  source: Exclude<McpServerSource, { kind: "custom-stdio" }>,
  entry: CatalogEntry | undefined,
): string {
  return source.kind === "catalog" ? (source.url ?? entry?.url ?? "") : source.url;
}

/** How the bridge should present the stored credential on the wire —
 * null when there's no credential to send. OAuth access tokens are always
 * `Authorization: Bearer`; header mode uses the entry's/user's own shape. */
function headerShapeOf(
  source: McpServerSource,
  entry: CatalogEntry | undefined,
): { headerName: string; valuePrefix: string } | null {
  if (source.kind === "custom-stdio") return null;
  if (source.kind === "catalog") {
    if (source.authMode === "oauth") return { headerName: "Authorization", valuePrefix: "Bearer " };
    const header = entry?.auth.header;
    return header ? { headerName: header.headerName, valuePrefix: header.valuePrefix } : null;
  }
  if (source.authType === "none") return null;
  if (source.authType === "oauth") return { headerName: "Authorization", valuePrefix: "Bearer " };
  return { headerName: source.headerName, valuePrefix: source.valuePrefix };
}

/** A new server's id — patchbay's own, never the catalog's or one made
 * from a name. */
function mintPatchbayMcpServerId(): PatchbayMcpServerId {
  return randomUUID() as PatchbayMcpServerId;
}

export class McpServersStore {
  constructor(
    private readonly catalog: readonly CatalogEntry[],
    private readonly configs: McpServerConfigStore,
    private readonly tokens: McpServerTokenStore,
    /** Env values for custom-stdio servers — SecretStorage-backed
     * (stores/secret-env.ts), read at attach time in mcpServersFor; the
     * config record carries no env at all. */
    private readonly envStore: SecretEnvStore,
    private readonly hooks: McpServersStoreHooks,
    private readonly lines: McpServerLines,
    private readonly wire: McpServerWire,
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
    /** The connect-time tool probe (mcp-probe.ts) — injected so
     * tests fake the handshake instead of hitting network/spawning. */
    private readonly probeFn: ProbeFn = probeMcpServer,
  ) {}

  /** Latest probe per server id — session-lived, never persisted: a
   * tool list is a point-in-time read of the server, so a fresh window
   * re-reads reality instead of trusting last week's snapshot. */
  private readonly probes = new Map<string, McpServerProbeView>();

  /** The last failure under each connect key — a connect's, an add's, an
   * import's, a server's save — held until it is dismissed or the same
   * thing is tried again. Live: a new window starts with none. */
  private readonly failures = new Map<string, string>();

  /** The refresh in flight per credential — see `refreshOnce`. */
  private readonly refreshing = new Map<string, Promise<void>>();

  /** One attempt under a connect key: it clears the last one's failure,
   * and holds its own until dismissed. One the gates told to stop is no
   * failure — nothing was stored, and there is nothing to say. */
  private async attempt<T>(key: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    this.failures.delete(key);
    try {
      return await run();
    } catch (err) {
      if (signal?.aborted === true) {
        this.log.info(`${key}: stopped — nothing stored`);
      } else {
        this.failures.set(key, (err as Error).message);
        this.log.error(`${key}: failed — ${(err as Error).message}`);
      }
      throw err;
    }
  }

  /** Clears a failure's note. */
  async dismiss(key: string): Promise<void> {
    this.failures.delete(key);
    await this.refresh();
  }

  /** A browser flow: the user agent handed to it waits on the browser for
   * as long as the user takes, and ends with the attempt's signal — told to
   * stop (Cancel, the window's end), the wait for the tab is given up, and
   * the flow with it, so a tab finished later changes nothing. Its result
   * is never stored then. */
  private async browserFlow<T>(
    userAgent: OAuthUserAgent,
    flow: (bound: OAuthUserAgent) => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const running = flow({ ...userAgent, authorize: (url, state) => userAgent.authorize(url, state, signal) });
    running.catch(() => {}); // given up, it may still reject — never unhandled
    return unlessAborted(running, signal);
  }

  catalogViews(): CatalogEntryView[] {
    return this.catalog.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
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

  /** Re-reads config + token presence and republishes the lists wholesale
   * — same "replace, don't patch" shape as the capability matrix. */
  async refresh(): Promise<void> {
    this.hooks.emit(
      { kind: "mcpCatalogLoaded", entries: this.catalogViews() },
      { kind: "mcpServersChanged", servers: await this.currentViews(), connects: this.connectViews() },
    );
  }

  /** The connects under way, read off the connect line, and the failures
   * held — one under a key that runs again shows running. */
  private connectViews(): McpServerConnectView[] {
    const running = this.lines.connecting();
    return [
      ...running.map((key) => ({ key, ...connectOf(key), status: "running" as const })),
      ...[...this.failures]
        .filter(([key]) => !running.includes(key))
        .map(([key, reason]) => ({ key, ...connectOf(key), status: "failed" as const, reason })),
    ];
  }

  private async currentViews(): Promise<McpServerView[]> {
    const views: McpServerView[] = [];
    for (const config of this.configs.list()) {
      const connected = needsToken(config.source)
        ? (await this.tokens.get(config.id)) !== null
        : true;
      const source = config.source;
      views.push({
        id: config.id,
        name: config.name,
        sourceKind: source.kind,
        catalogId: source.kind === "catalog" ? source.catalogId : undefined,
        command:
          source.kind === "custom-stdio"
            ? formatCommandLine(source.command, source.args)
            : source.kind === "custom-http"
              ? source.url
              : undefined,
        connected,
        active: config.active,
        routing: config.routing,
        transport: config.transport,
        probe: this.probes.get(config.id),
        busy: this.lines.busy(config.id),
        editJson: await this.editJsonFor(config.id, source),
      });
    }
    return views;
  }

  /** The editable mcpServers entry for a custom server, values included.
   * Undefined for curated entries — their shape is catalog data. */
  private async editJsonFor(patchbayMcpServerId: PatchbayMcpServerId, source: McpServerSource): Promise<string | undefined> {
    if (source.kind === "catalog") return undefined;
    const entry = await this.entryJsonFor(patchbayMcpServerId, source);
    return entry === undefined ? undefined : JSON.stringify(entry, null, 2);
  }

  /** Copy config: the server as a `{"mcpServers": {name: entry}}`
   * document — the well-known shape an import reads and other clients
   * take. Keyed by display name — the name a re-import gives the server.
   * A curated entry copies as its resolved endpoint plus auth shape (what
   * a re-import would create as a custom-http server). Undefined when there
   * is no endpoint to name. */
  async exportJson(patchbayMcpServerId: PatchbayMcpServerId): Promise<string | undefined> {
    const config = this.configs.get(patchbayMcpServerId);
    if (config === undefined) return undefined;
    const entry = await this.entryJsonFor(patchbayMcpServerId, config.source);
    if (entry === undefined) return undefined;
    return JSON.stringify({ mcpServers: { [config.name]: entry } }, null, 2);
  }

  /** One `mcpServers` entry, the shape mcpServersEntrySchema reads back,
   * carrying what the owner typed: env values, and the key of a header-auth
   * server. An OAuth token is flow-minted and never rides. */
  private async entryJsonFor(
    patchbayMcpServerId: PatchbayMcpServerId,
    source: McpServerSource,
  ): Promise<Record<string, unknown> | undefined> {
    if (source.kind === "custom-stdio") {
      return { command: source.command, args: source.args, env: await this.envStore.get(patchbayMcpServerId) };
    }
    const entry = source.kind === "catalog" ? this.entryFor(source.catalogId) : undefined;
    const url = endpointOf(source, entry);
    if (url === "") return undefined;
    const authType = source.kind === "catalog" ? source.authMode : source.authType;
    if (authType !== "header") return { url, authType };
    const token = (await this.tokens.get(patchbayMcpServerId))?.accessToken;
    return { url, authType, ...headerShapeOf(source, entry), ...(token !== undefined ? { token } : {}) };
  }

  private entryFor(catalogId: string): CatalogEntry | undefined {
    return this.catalog.find((r) => r.id === catalogId);
  }

  /** Resolves the endpoint a connect will use: the entry's fixed URL, or
   * the user-supplied one for per-account services. Null with a reason
   * when it can't — never a silent partial connect. */
  private resolveEndpoint(
    entry: CatalogEntry,
    userSuppliedUrl: string | undefined,
  ): { url: string } | { error: string } {
    if (entry.userUrl) {
      const url = userSuppliedUrl?.trim() ?? "";
      return url !== "" ? { url } : { error: "this server needs your account's endpoint URL" };
    }
    if (entry.url !== "") return { url: entry.url };
    return { error: "no endpoint available" };
  }

  /** Static-key connect (the v1 floor): store the pasted key, record
   * which mechanism/endpoint this connection uses. No network round-trip;
   * the first real request proves the key. Returns the server's id. */
  connectCatalogWithKey(catalogId: string, token: string, url?: string, signal?: AbortSignal): Promise<PatchbayMcpServerId> {
    return this.attempt(connectKey.catalog(catalogId), signal, async () => {
      const entry = this.entryFor(catalogId);
      if (entry === undefined || entry.auth.header === null) throw new Error("no API-key mode for this server");
      const endpoint = this.resolveEndpoint(entry, url);
      if ("error" in endpoint) throw new Error(endpoint.error);
      if (token.trim() === "") throw new Error("key is empty");
      const patchbayMcpServerId = mintPatchbayMcpServerId();
      await this.tokens.set(patchbayMcpServerId, { accessToken: token.trim() });
      const name = await this.configs.add({
        id: patchbayMcpServerId,
        name: entry.name,
        source: {
          kind: "catalog",
          catalogId,
          authMode: "header",
          ...(entry.userUrl ? { url: endpoint.url } : {}),
        },
        routing: "auto",
        active: true,
        transport: "auto",
      }, [EDITOR_SERVER.name]);
      this.log.info(`${patchbayMcpServerId}: ${name} connected with key (endpoint ${loggableUrl(endpoint.url)})`);
      return patchbayMcpServerId;
    });
  }

  /** MCP-spec OAuth connect: URL-only — discovery, dynamic client
   * registration, PKCE, browser redirect via the injected user agent.
   * Failure (gated DCR, non-compliant server, denied consent) is immediate
   * and labeled; an abandoned tab waits until the connect is cancelled.
   * Returns the server's id. */
  connectCatalogOAuth(catalogId: string, url?: string, signal?: AbortSignal): Promise<PatchbayMcpServerId> {
    return this.attempt(connectKey.catalog(catalogId), signal, async () => {
      const entry = this.entryFor(catalogId);
      if (entry === undefined || !entry.auth.oauth) throw new Error("no OAuth mode for this server");
      const endpoint = this.resolveEndpoint(entry, url);
      if ("error" in endpoint) throw new Error(endpoint.error);
      if (this.oauthUserAgent === null) throw new Error("OAuth is unavailable in this environment");
      this.log.info(`${catalogId}: browser OAuth starting (endpoint ${loggableUrl(endpoint.url)})`);
      const result = await this.browserFlow(this.oauthUserAgent, (ua) => connectMcpOAuth(endpoint.url, CLIENT_INFO, ua), signal);
      const patchbayMcpServerId = mintPatchbayMcpServerId();
      await this.tokens.set(patchbayMcpServerId, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: expiresAtFrom(result.expiresIn),
        tokenEndpoint: result.tokenEndpoint,
        clientId: result.clientId,
      });
      const name = await this.configs.add({
        id: patchbayMcpServerId,
        name: entry.name,
        source: {
          kind: "catalog",
          catalogId,
          authMode: "oauth",
          ...(entry.userUrl ? { url: endpoint.url } : {}),
        },
        routing: "auto",
        active: true,
        transport: "auto",
      }, [EDITOR_SERVER.name]);
      this.log.info(`${patchbayMcpServerId}: ${name} connected via OAuth`);
      return patchbayMcpServerId;
    });
  }

  /** The escape hatch: any MCP server, command or URL, with auth. Nothing
   * is stored until it can actually work: a custom OAuth connect runs the
   * browser flow *first* and stores only on success — cancelling consent
   * means nothing was added, never a stranded credential-less record. The
   * id is minted; a name already taken gets a number. Returns the id. */
  addCustom(
    name: string,
    source: McpServerSourceView,
    routing: McpServerRoutingView,
    signal?: AbortSignal,
  ): Promise<PatchbayMcpServerId> {
    return this.attempt(connectKey.custom(name), signal, async () => {
      const patchbayMcpServerId = mintPatchbayMcpServerId();
      let configSource: McpServerSource;
      if (source.kind === "custom-stdio") {
        // `args` arrive structured (form lines / imported JSON) and are never
        // re-parsed; the `command` field alone may still be a typed line
        // ("npx foo"), so it gets the quote-aware house parser (parsing is
        // logic, and it lives here).
        const parsed = parseCommandLine(source.command);
        if (parsed === null) throw new Error("command line has an unterminated quote");
        configSource = {
          kind: "custom-stdio",
          command: parsed.command,
          args: [...parsed.args, ...source.args],
        };
        // Values ride the action once and land in SecretStorage — the config
        // record above deliberately carries no env.
        await this.envStore.set(patchbayMcpServerId, { ...source.env });
      } else {
        configSource = {
          kind: "custom-http",
          url: source.url,
          authType: source.authType,
          headerName: source.headerName ?? "Authorization",
          valuePrefix: source.valuePrefix ?? "Bearer ",
        };
        if (source.authType === "header") {
          if (!source.token) throw new Error("key is empty");
          await this.tokens.set(patchbayMcpServerId, { accessToken: source.token });
        }
        if (source.authType === "oauth") {
          if (this.oauthUserAgent === null) throw new Error("OAuth is unavailable in this environment");
          const result = await this.browserFlow(this.oauthUserAgent, (ua) => connectMcpOAuth(source.url, CLIENT_INFO, ua), signal);
          await this.tokens.set(patchbayMcpServerId, {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            expiresAt: expiresAtFrom(result.expiresIn),
            tokenEndpoint: result.tokenEndpoint,
            clientId: result.clientId,
          });
        }
      }
      const given = await this.configs.add({
        id: patchbayMcpServerId,
        name,
        source: configSource,
        routing: cloneRouting(routing),
        active: true,
        transport: "auto",
      }, [EDITOR_SERVER.name]);
      this.log.info(`${patchbayMcpServerId}: custom ${configSource.kind} ${given} added`);
      return patchbayMcpServerId;
    });
  }

  /** Reads the well-known `{"mcpServers": {...}}` JSON (a bare name→spec
   * map is accepted too) into the entries an import adds — each a custom
   * server named by its key. Only what validates comes back — a trust
   * boundary, same as every store read; the rest is held as the import's
   * failures, per entry, without stopping the others. */
  async importEntries(json: string): Promise<{ name: string; source: McpServerSourceView }[]> {
    for (const key of [...this.failures.keys()]) {
      if (connectOf(key).kind === "import") this.failures.delete(key);
    }
    const entries: { name: string; source: McpServerSourceView }[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      this.failures.set(connectKey.import(), "not valid JSON");
    }
    const root = (parsed as { mcpServers?: unknown } | undefined)?.mcpServers ?? parsed;
    if (parsed !== undefined && (typeof root !== "object" || root === null || Array.isArray(root))) {
      this.failures.set(connectKey.import(), 'expected {"mcpServers": {name: {...}}} or a name→server map');
    } else if (parsed !== undefined) {
      for (const [name, raw] of Object.entries(root as Record<string, unknown>)) {
        const spec = mcpServersEntrySchema.safeParse(raw);
        if (!spec.success) {
          this.failures.set(connectKey.import(name), `"${name}": neither a command entry nor a url entry`);
          continue;
        }
        entries.push({
          name,
          source:
            "command" in spec.data
              ? { kind: "custom-stdio", command: spec.data.command, args: spec.data.args, env: spec.data.env }
              : {
                  kind: "custom-http",
                  url: spec.data.url,
                  authType: spec.data.authType,
                  headerName: spec.data.headerName,
                  valuePrefix: spec.data.valuePrefix,
                  token: spec.data.token,
                },
        });
      }
    }
    await this.refresh();
    return entries;
  }

  /** Applies an edited mcpServers entry to one custom server — the box is
   * the truth: env is stored as written, and for header auth so is
   * `token` (removing it removes the key, which reads as disconnected
   * until one is entered again). */
  async updateFromJson(patchbayMcpServerId: PatchbayMcpServerId, json: string): Promise<void> {
    const existing = this.configs.get(patchbayMcpServerId);
    if (existing === undefined || existing.source.kind === "catalog") return;
    const key = connectKey.server(patchbayMcpServerId);
    this.failures.delete(key);
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      this.failures.set(key, "not valid JSON");
      await this.refresh();
      return;
    }
    const spec = mcpServersEntrySchema.safeParse(raw);
    if (!spec.success) {
      this.failures.set(key, "neither a command entry nor a url entry");
      await this.refresh();
      return;
    }
    if ("command" in spec.data) {
      await this.envStore.set(patchbayMcpServerId, spec.data.env);
      await this.configs.upsert({
        ...existing,
        source: { kind: "custom-stdio", command: spec.data.command, args: spec.data.args },
      });
    } else {
      if (spec.data.authType === "header") {
        if (spec.data.token) await this.tokens.set(patchbayMcpServerId, { accessToken: spec.data.token });
        else await this.tokens.remove(patchbayMcpServerId);
      }
      await this.configs.upsert({
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

  /** Disconnect *is* remove — the full clear (credential + env + config):
   * the server is gone, curated or custom; its catalog entry stays there to
   * connect again. The non-destructive option is `setActive(false)`, which
   * keeps everything and only unroutes. */
  async remove(patchbayMcpServerId: PatchbayMcpServerId): Promise<void> {
    this.probes.delete(patchbayMcpServerId);
    this.failures.delete(connectKey.server(patchbayMcpServerId));
    await this.tokens.remove(patchbayMcpServerId);
    await this.envStore.remove(patchbayMcpServerId);
    await this.configs.remove(patchbayMcpServerId);
    this.log.info(`${patchbayMcpServerId}: removed — credential, env, and config cleared`);
  }

  /** An agent removed: no server's reach names it any more. */
  async forgetAgent(patchbayAgentId: PatchbayAgentId): Promise<void> {
    await this.configs.forgetAgent(patchbayAgentId);
    await this.refresh();
  }

  async setActive(patchbayMcpServerId: PatchbayMcpServerId, active: boolean): Promise<void> {
    const existing = this.configs.get(patchbayMcpServerId);
    if (existing === undefined) return;
    await this.configs.upsert({ ...existing, active });
    await this.refresh();
  }

  /** Settings drag-drop — persist the dropped order and republish. Order
   * is presentational only (routing never depends on it): no probe, no
   * reconnect. */
  async reorder(patchbayMcpServerIds: readonly PatchbayMcpServerId[]): Promise<void> {
    await this.configs.reorder(patchbayMcpServerIds);
    await this.refresh();
  }

  async setTransport(patchbayMcpServerId: PatchbayMcpServerId, transport: "auto" | "bridge"): Promise<void> {
    const existing = this.configs.get(patchbayMcpServerId);
    if (existing === undefined) return;
    await this.configs.upsert({ ...existing, transport });
    await this.refresh();
  }

  /** Runs the connect-time tool probe and caches the outcome on the card
   * (protocol.ts McpServerProbeView — provider-side truth, timestamped).
   * Explicit-trigger only (connect, power-on, refresh button): probing a
   * custom-stdio server executes its command, and even http shouldn't fire
   * on background sweeps — reality is read when the user acts on it. */
  async probe(patchbayMcpServerId: PatchbayMcpServerId, signal?: AbortSignal): Promise<void> {
    const config = this.configs.get(patchbayMcpServerId);
    if (config === undefined) return;
    let target: ProbeTarget | null = null;
    try {
      target = await this.probeTargetFor(config);
      if (target === null) {
        // Nothing reachable to probe (no endpoint / missing credential) —
        // the card's connected flag already tells that story.
        this.probes.delete(patchbayMcpServerId);
      } else {
        const outcome = await unlessAborted(this.probeFn(target, signal, this.log), signal);
        this.probes.set(patchbayMcpServerId, {
          status: "ok",
          at: new Date().toISOString(),
          serverName: outcome.serverName,
          serverVersion: outcome.serverVersion,
          tools: outcome.tools,
        });
        this.log.info(`${patchbayMcpServerId}: probe ok — ${outcome.tools.length} tool(s)`);
      }
    } catch (err) {
      // Told to stop, the probe has no outcome to keep.
      if (signal?.aborted === true) throw err;
      // A stdio failure names where the command ran: a server that reads
      // project-local config fails differently per directory, and the
      // reason should let the user see which one was tried.
      const reason =
        target?.kind === "stdio"
          ? `${(err as Error).message} (ran in ${target.cwd})`
          : (err as Error).message;
      this.probes.set(patchbayMcpServerId, { status: "failed", at: new Date().toISOString(), reason });
      this.log.info(`${patchbayMcpServerId}: probe failed — ${reason}`);
    }
  }

  /** The probe's connection recipe for one server — same resolution as
   * mcpServersFor (catalog entry URL, header shape, fresh token), pointed
   * at patchbay's own MCP client instead of an agent's. */
  private async probeTargetFor(config: McpServerConfig): Promise<ProbeTarget | null> {
    const source = config.source;
    if (source.kind === "custom-stdio") {
      return {
        kind: "stdio",
        command: source.command,
        args: source.args,
        env: await this.envStore.get(config.id),
        cwd: this.workspaceCwd,
      };
    }
    const entry = source.kind === "catalog" ? this.entryFor(source.catalogId) : undefined;
    const url = source.kind === "catalog" ? (source.url ?? entry?.url ?? "") : source.url;
    if (url === "") return null;
    const shape = headerShapeOf(source, entry);
    if (shape === null) return { kind: "http", url, header: null };
    const token = (await this.freshToken(config.id))?.accessToken ?? null;
    if (token === null) return null; // needs a credential, none stored
    return { kind: "http", url, header: { name: shape.headerName, value: `${shape.valuePrefix}${token}` } };
  }

  async setRouting(patchbayMcpServerId: PatchbayMcpServerId, routing: McpServerRoutingView): Promise<void> {
    const existing = this.configs.get(patchbayMcpServerId);
    if (existing === undefined) return;
    await this.configs.upsert({
      ...existing,
      routing: cloneRouting(routing),
    });
    await this.refresh();
  }

  /** A server's credential for the bridge serving it to `patchbayAgentId` — only
   * while the server is still connected, switched on and routed to that
   * agent: muting, re-routing or removing it reaches a running bridge at
   * its next request. */
  async credentialFor(patchbayMcpServerId: PatchbayMcpServerId, patchbayAgentId: PatchbayAgentId): Promise<{ accessToken: string } | null> {
    const config = this.configs.get(patchbayMcpServerId);
    if (config === undefined || !reaches(config, patchbayAgentId)) return null;
    return this.freshToken(patchbayMcpServerId);
  }

  /** The stored token, refreshed first when near expiry and refreshable —
   * a bridge never sees a refresh token, only ever a fresh access token. A
   * refresh that fails leaves the stale one: the server's own 401 speaks. */
  private async freshToken(patchbayMcpServerId: PatchbayMcpServerId): Promise<{ accessToken: string } | null> {
    const stored = await this.tokens.get(patchbayMcpServerId);
    if (stored === null) return null;
    if (isExpired(stored) && refreshable(stored)) await this.refreshOnce(patchbayMcpServerId);
    const current = await this.tokens.get(patchbayMcpServerId);
    return current === null ? null : { accessToken: current.accessToken };
  }

  /** One refresh per credential at a time, shared by whoever asks
   * meanwhile — a bridge's request, an attach, a probe. A refresh token
   * spent twice can cost the grant: every connect here is a public client,
   * which OAuth 2.1 has the server rotate or bind refresh tokens for, and a
   * rotating server takes a replay for theft. */
  private refreshOnce(patchbayMcpServerId: PatchbayMcpServerId): Promise<void> {
    const running = this.refreshing.get(patchbayMcpServerId);
    if (running !== undefined) return running;
    const run = this.refreshCredential(patchbayMcpServerId).finally(() => this.refreshing.delete(patchbayMcpServerId));
    this.refreshing.set(patchbayMcpServerId, run);
    return run;
  }

  /** Refreshes the stored credential if it still needs it. The refresh
   * context (token endpoint + client id) was captured at connect, since
   * OAuth endpoints are discovered, not static. */
  private async refreshCredential(patchbayMcpServerId: PatchbayMcpServerId): Promise<void> {
    const stored = await this.tokens.get(patchbayMcpServerId);
    if (stored === null || !isExpired(stored) || !refreshable(stored)) return;
    try {
      const refreshed = await refreshMcpOAuth(stored.tokenEndpoint, stored.clientId, stored.refreshToken);
      // Removed or connected anew while the request was out: the answer is
      // for a credential that no longer stands.
      if ((await this.tokens.get(patchbayMcpServerId))?.refreshToken !== stored.refreshToken) return;
      await this.tokens.set(patchbayMcpServerId, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: expiresAtFrom(refreshed.expiresIn),
        tokenEndpoint: stored.tokenEndpoint,
        clientId: stored.clientId,
      });
    } catch (err) {
      this.log.error(`${patchbayMcpServerId}: credential refresh failed — ${(err as Error).message}`);
    }
  }

  /** The mcpServers entries a session for `patchbayAgentId` should get — the
   * editor server first, then every configured server that reaches it
   * (protocol.ts records the fidelity-gate supersession) and is actually
   * usable (connected where a credential is needed, a real endpoint where
   * one is required) — and, beside them, which servers were given and how:
   * the session's attach records it. Every value that crosses to the agent
   * is registered with the wire log's redaction, here, where it crosses.
   * custom-stdio needs no bridge — handed straight through.
   * catalog/custom-http go one of two ways (prompt.image mechanics —
   * capability-conditional delivery): `declaresHttp` and transport "auto" ⇒
   * a real `type: "http"` entry, the agent's own MCP client connects (token
   * read here, at attach — it rides agent-visible config, ephemeral per
   * session, exactly like a CLI-added server; the recorded trade superseding
   * the earlier bridge-only rule). Otherwise the stdio-to-HTTP
   * bridge, the guaranteed floor. */
  async mcpServersFor(
    patchbayAgentId: PatchbayAgentId,
    contextToken: string,
    declaresHttp: boolean,
  ): Promise<{ servers: McpServer[]; given: AttachedServer[] }> {
    // McpServerStdio is the untagged union member — no discriminant needed
    // since it's the only variant every agent is guaranteed to accept.
    const servers: McpServer[] = [
      {
        name: EDITOR_SERVER.name,
        command: process.execPath,
        args: [this.wire.editorServerScript],
        env: [
          { name: "ACP_PATCHBAY_IPC", value: this.wire.socketPath() },
          { name: "ACP_PATCHBAY_CONTEXT_TOKEN", value: contextToken },
        ],
      },
    ];
    const given: AttachedServer[] = [{ id: EDITOR_SERVER.id, delivery: "stdio" }];
    for (const config of this.configs.list()) {
      if (!reaches(config, patchbayAgentId)) continue;

      const source = config.source;
      if (source.kind === "custom-stdio") {
        // Env values read from SecretStorage at the moment of attach — this
        // is also where they necessarily cross to the agent: the agent
        // spawns stdio servers itself (ACP model), so the spawn env must
        // ride the session's mcpServers config. SecretStorage governs
        // where patchbay keeps them at rest, not that inherent handoff.
        // No cwd travels: the entry has no such field, so the server runs
        // wherever the agent does — the same workspaceCwd the probe uses.
        const env = await this.envStore.get(config.id);
        servers.push({
          name: config.name,
          command: source.command,
          args: source.args,
          env: Object.entries(env).map(([name, value]) => ({ name, value })),
        });
        given.push({ id: config.id, delivery: "stdio" });
        continue;
      }

      const entry = source.kind === "catalog" ? this.entryFor(source.catalogId) : undefined;
      const url = endpointOf(source, entry);
      if (url === "") continue; // not connectable — nothing to route to
      if (needsToken(source) && (await this.tokens.get(config.id)) === null) continue;

      const header = headerShapeOf(source, entry);
      if (declaresHttp && config.transport === "auto") {
        // freshToken refreshes first, so the agent starts the session
        // with the freshest credential we can mint — but passthrough is a
        // snapshot: a token expiring mid-session is the agent's 401 to
        // surface, not ours to fix (the bridge path re-reads per request).
        const token = header !== null ? (await this.freshToken(config.id))?.accessToken : null;
        servers.push({
          type: "http",
          name: config.name,
          url,
          headers:
            header !== null && token != null
              ? [{ name: header.headerName, value: `${header.valuePrefix}${token}` }]
              : [],
        });
        given.push({ id: config.id, delivery: "http" });
        continue;
      }
      servers.push({
        name: config.name,
        command: process.execPath,
        args: [this.wire.bridgeScript],
        env: [
          { name: "ACP_PATCHBAY_IPC", value: this.wire.socketPath() },
          { name: "ACP_PATCHBAY_CONTEXT_TOKEN", value: contextToken },
          { name: "ACP_PATCHBAY_MCP_SERVER_ID", value: config.id },
          { name: "ACP_PATCHBAY_MCP_SERVER_URL", value: url },
          ...(header !== null
            ? [
                { name: "ACP_PATCHBAY_AUTH_HEADER", value: header.headerName },
                { name: "ACP_PATCHBAY_AUTH_PREFIX", value: header.valuePrefix },
              ]
            : []),
        ],
      });
      given.push({ id: config.id, delivery: "bridge" });
    }
    // Env and header values are secrets by classification. Over-redaction
    // (plumbing values like socket paths get masked too) is the safe
    // direction.
    for (const server of servers) {
      for (const { value } of "env" in server ? (server.env ?? []) : []) this.wire.crossing(value);
      for (const { value } of "headers" in server ? (server.headers ?? []) : []) this.wire.crossing(value);
    }
    this.log.debug(
      `mcpServersFor ${patchbayAgentId}: serving ${servers.length} server(s)` +
        (servers.length > 0 ? ` — ${servers.map((sv) => sv.name).join(", ")}` : ""),
    );
    return { servers, given };
  }
}
