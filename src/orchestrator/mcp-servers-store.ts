// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The MCP-servers store: curated (catalog)
// and custom are the same mechanism — MCP servers routed to agents. Owns
// the add lifecycle — every add checked against the server before anything
// is stored, a sign-in run when the server asks for one — routing and
// workspace decisions, and the mcpServers entries a session actually gets.
// A custom server is kept in the shape other clients write (shared/
// mcp-config.ts): a command with args and env, or a URL with headers, the
// values in SecretStorage. vscode-free (like SessionsStore/
// CapabilityTracker): the OAuth browser/redirect step is an injected
// SignInAgent, so everything is unit-testable against a fake OAuth
// provider and a fake remote MCP endpoint — the same fixture philosophy as
// the fake ACP agent.
import { IPC_ENV } from "../mcp/ipc-protocol";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { EnvVariable, McpServer, McpServerStdio } from "./acp";
import type {
  McpServerConnectView,
  McpServerListedView,
  McpServerProbeView,
  McpServerRoutingView,
  McpServerView,
  McpServerWork,
  CatalogEntryView,
  SettingsEvent,
} from "../shared/protocol";
import { unlessAborted } from "./abort";
import { asksForSignIn, probeMcpServer, type ProbeFn, type ProbeOutcome, type ProbeTarget } from "./mcp-probe";
import { formatCommandLine, parseCommandLine } from "../shared/command-line";
import { documentOf, draftProblem, expandDraft, unsetSaid, type McpDraft } from "../shared/mcp-config";
import { EDITOR_SERVER_ID, EDITOR_SERVER_NAME } from "../shared/names";
import { PRODUCT } from "../shared/product";
import { logCatch, loggableUrl, nullLogger, type Logger } from "./logger";
import { connectMcpOAuth, refreshMcpOAuth, type OAuthUserAgent } from "./mcp-oauth";
import { linkQuery, type CallbackOutcome } from "./oauth-callback";
import { McpServerTokenStore, type StoredToken } from "./stores/mcp-server-tokens";
import {
  authTypeOf,
  headersBefore090,
  McpServerConfigStore,
  type McpServerConfig,
  type McpServerSource,
} from "./stores/mcp-server-configs";
import { isConnectable, type CatalogEntry } from "./stores/mcp-catalog";
import type { SecretEnvStore } from "./stores/secret-env";
import type { PatchbayAgentId, PatchbayMcpServerId } from "../shared/ids";
import { ownReach, reaches, type Reach } from "../shared/reach";
import type { WorkspaceId } from "../shared/workspace";
import { agentErrorText } from "./readers/agent-error";

type Env = Record<string, string>;

export interface McpServersStoreHooks {
  emit(...events: SettingsEvent[]): void;
  /** The servers by name and where they are on — what an agent view's MCP
   * chip offers. */
  listed(servers: readonly McpServerListedView[]): void;
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

/** A sign-in's browser step, and its one door back in: the callback the
 * editor delivers and a link the user pastes both go through `deliver`. */
export interface SignInAgent extends OAuthUserAgent {
  deliver(query: string): CallbackOutcome;
}

/** Where the stores keep a server's secrets: a stdio server's env, a
 * remote server's headers, and the credential patchbay itself holds — a
 * curated entry's key, or a sign-in's token. */
export interface McpServerSecrets {
  env: SecretEnvStore;
  headers: SecretEnvStore;
  tokens: McpServerTokenStore;
}

/** Patchbay's own server — the editor's state and the session's roots —
 * given to every session over stdio, the one delivery every agent takes.
 * Built in: never stored, never removed, and its name is never another
 * server's. */
const EDITOR_SERVER = { id: EDITOR_SERVER_ID, name: EDITOR_SERVER_NAME } as const;

/** One of patchbay's own scripts as a server the agent spawns. On a desktop
 * editor `process.execPath` is its Electron binary, which runs a script as
 * Node only under ELECTRON_RUN_AS_NODE — and an agent that hands its servers
 * a filtered environment drops the one the extension host passed down, so
 * the editor opens the script as a file instead. The entry carries it; a
 * plain node binary (a remote host) ignores it. */
function ownScript(name: string, script: string, env: EnvVariable[]): McpServerStdio {
  return {
    name,
    command: process.execPath,
    args: [script],
    env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }, ...env],
  };
}

/** The editor server as one attach is handed it — the one launch both an
 * agent's session and patchbay's own check of the server spawn. */
function editorServer(wire: McpServerWire, contextToken: string): McpServerStdio {
  return ownScript(EDITOR_SERVER.name, wire.editorServerScript, [
    { name: IPC_ENV.socket, value: wire.socketPath() },
    { name: IPC_ENV.contextToken, value: contextToken },
  ]);
}

/** The bridge as one attach is handed it for a remote server — the launch
 * the agent spawns to reach it, with the server's headers asked per
 * request over IPC under the attach's token. */
export function bridgeServer(
  wire: Pick<McpServerWire, "bridgeScript" | "socketPath">,
  contextToken: string,
  server: { id: string; name: string; url: string },
): McpServerStdio {
  return ownScript(server.name, wire.bridgeScript, [
    { name: IPC_ENV.socket, value: wire.socketPath() },
    { name: IPC_ENV.contextToken, value: contextToken },
    { name: IPC_ENV.serverId, value: server.id },
    { name: IPC_ENV.serverUrl, value: server.url },
  ]);
}

/** The operations that take time — an add, an edit, a probe, a remove —
 * each reached only through the gates, which order them on their lines. */
export type McpServerLineOperations = Pick<
  McpServersStore,
  "connectCatalogWithKey" | "connectCatalogOAuth" | "addCustom" | "updateCustom" | "probe" | "remove"
>;

/** The connect line's keys — one line per curated entry, one per add card,
 * one per server's edit. One vocabulary, so the published connects are
 * read straight off a key. */
export const connectKey = {
  catalog: (catalogId: string) => `catalog:${catalogId}`,
  custom: (card: string) => `custom:${card}`,
  server: (patchbayMcpServerId: PatchbayMcpServerId) => `server:${patchbayMcpServerId}`,
};

function connectOf(key: string): Pick<McpServerConnectView, "kind" | "subject"> {
  const at = key.indexOf(":");
  return { kind: key.slice(0, at) as McpServerConnectView["kind"], subject: key.slice(at + 1) };
}

/** A server given to a session at its attach: its id, and how it reached
 * the agent — handed through (stdio), passed through to the agent's own
 * client (http), or through patchbay's bridge, the one delivery that asks
 * patchbay for the server's headers. */
export interface AttachedServer {
  id: PatchbayMcpServerId;
  delivery: "stdio" | "http" | "bridge";
}

const CLIENT_INFO = {
  clientName: PRODUCT.name,
  clientUri: "https://github.com/solutionsunity/acp-patchbay",
};

/** A remote server's check was turned away with a 401: the add card offers
 * the sign-in the server asked for. */
class SignInAsked extends Error {}

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

/** A sign-in's result as the token store keeps it. */
function signedIn(result: Awaited<ReturnType<typeof connectMcpOAuth>>): StoredToken {
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: expiresAtFrom(result.expiresIn),
    tokenEndpoint: result.tokenEndpoint,
    clientId: result.clientId,
  };
}

/** Whether "connected" requires a stored credential: every server that
 * presents one of patchbay's, key and sign-in alike. */
function needsToken(source: McpServerSource): boolean {
  return authTypeOf(source) !== "none";
}

/** The endpoint a curated server reaches: the user's own URL for a
 * per-account entry, else the catalog's fixed one; "" when neither exists
 * (not connectable). */
function catalogEndpoint(source: Extract<McpServerSource, { kind: "catalog" }>, entry: CatalogEntry | undefined): string {
  return source.url ?? entry?.url ?? "";
}

/** A custom server in one line: its command line, or its URL. */
function customLine(source: Exclude<McpServerSource, { kind: "catalog" }>): string {
  return source.kind === "custom-stdio" ? formatCommandLine(source.command, source.args) : source.url;
}

/** The header a curated server's stored credential goes in: a sign-in's
 * token as `Authorization: Bearer`, a key in the entry's own shape. */
function catalogHeader(
  source: Extract<McpServerSource, { kind: "catalog" }>,
  entry: CatalogEntry | undefined,
): { headerName: string; valuePrefix: string } | null {
  if (source.authMode === "oauth") return { headerName: "Authorization", valuePrefix: "Bearer " };
  const header = entry?.auth.header;
  return header ? { headerName: header.headerName, valuePrefix: header.valuePrefix } : null;
}

/** A draft as it is kept: a command line typed whole in the command field
 * ("npx foo") split quote-aware — args arrive structured and are never
 * re-parsed. */
function normalized(draft: McpDraft): McpDraft {
  if (draft.type === "http") return { ...draft, url: draft.url.trim() };
  if (draft.command.trim() === "") return draft; // the check names what's missing
  const parsed = parseCommandLine(draft.command);
  if (parsed === null) throw new Error("the command has an unterminated quote");
  return { ...draft, command: parsed.command, args: [...parsed.args, ...draft.args] };
}

/** A new server's id — patchbay's own, never the catalog's or one made
 * from a name. */
function mintPatchbayMcpServerId(): PatchbayMcpServerId {
  return randomUUID() as PatchbayMcpServerId;
}

function probeView(outcome: ProbeOutcome): McpServerProbeView {
  return {
    status: "ok",
    at: new Date().toISOString(),
    serverName: outcome.serverName,
    serverVersion: outcome.serverVersion,
    tools: outcome.tools,
  };
}

export class McpServersStore {
  private readonly env: SecretEnvStore;
  private readonly headerStore: SecretEnvStore;
  private readonly tokens: McpServerTokenStore;
  /** Settles once the headers of an earlier version's custom remote
   * servers are in SecretStorage — every read of a server's headers waits
   * on it. */
  private readonly ready: Promise<void>;

  constructor(
    private readonly catalog: readonly CatalogEntry[],
    private readonly configs: McpServerConfigStore,
    /** Env and header values — SecretStorage-backed (stores/secret-env.ts),
     * read at attach time in mcpServersFor; the config record carries
     * none. */
    secrets: McpServerSecrets,
    private readonly hooks: McpServersStoreHooks,
    private readonly lines: McpServerLines,
    private readonly wire: McpServerWire,
    /** The directory agents are launched in — and so the one their
     * spawned stdio servers inherit. The probe runs custom-stdio servers
     * here so it reports the same reality the agent's own spawn will. */
    private readonly workspaceCwd: string,
    /** The workspace this window has open — null with none: a server is
     * given to a session only where it is on. */
    private readonly here: WorkspaceId | null,
    /** The agents, in their order, and each one's own configured env —
     * with this host's, what a server's `${VAR}` references are filled from
     * when it is handed to the agent, and when an add is checked. */
    private readonly agents: { ids(): readonly PatchbayAgentId[]; env(patchbayAgentId: PatchbayAgentId): Promise<Env> },
    /** Browser/redirect step for OAuth connects — the orchestrator wires
     * registerUriHandler + asExternalUri; tests wire a fake. Absent →
     * OAuth connects fail labeled (header connects unaffected). */
    private readonly oauthUserAgent: SignInAgent | null = null,
    /** Output-channel seam (logger.ts) — hosts and key *names* only, never
     * tokens, env values, or full URLs (query strings can embed secrets). */
    private readonly log: Logger = nullLogger,
    /** The connect-time tool probe (mcp-probe.ts) — injected so
     * tests fake the handshake instead of hitting network/spawning. */
    private readonly probeFn: ProbeFn = probeMcpServer,
  ) {
    this.env = secrets.env;
    this.headerStore = secrets.headers;
    this.tokens = secrets.tokens;
    const earlier = configs.copiedBefore090;
    this.ready = earlier === null ? Promise.resolve() : this.moveHeadersBefore090(earlier);
  }

  /** Once, after the store copied an earlier version's records: each custom
   * remote server that sent a key gets the header it sent it in, whole, as
   * its own. The key stays where it was — a window still on that version
   * reads it there. */
  private async moveHeadersBefore090(records: readonly unknown[]): Promise<void> {
    try {
      const keys = new Map<string, string | undefined>();
      for (const r of records) {
        const id = (r as { id?: unknown } | null)?.id;
        if (typeof id === "string") keys.set(id, (await this.tokens.get(id as PatchbayMcpServerId))?.accessToken);
      }
      for (const [id, headers] of headersBefore090(records, (id) => keys.get(id))) await this.headerStore.set(id, headers);
    } catch (err) {
      this.log.error(`moving the headers of earlier servers failed — ${agentErrorText(err)}`);
    }
  }

  private async headersOf(patchbayMcpServerId: PatchbayMcpServerId): Promise<Env> {
    await this.ready;
    return this.headerStore.get(patchbayMcpServerId);
  }

  /** Whether the server is on in this window's workspace. */
  private onHere(config: McpServerConfig): boolean {
    return reaches(config.workspaces, this.here);
  }

  /** Whether a server reaches an agent's sessions in this window: on in its
   * workspace, and routed to the agent. Off means configured, credential
   * intact, given to no session here. */
  private givenTo(config: McpServerConfig, patchbayAgentId: PatchbayAgentId): boolean {
    return this.onHere(config) && reaches(config.routing, patchbayAgentId);
  }

  /** Latest probe per server id — session-lived, never persisted: a
   * tool list is a point-in-time read of the server, so a fresh window
   * re-reads reality instead of trusting last week's snapshot. */
  private readonly probes = new Map<string, McpServerProbeView>();

  /** The last failure under each connect key — an add's or an edit's, a
   * curated connect's — held until it is dismissed or the same thing is
   * tried again; `signIn` when the server asked for one. Live: a new window
   * starts with none. */
  private readonly failures = new Map<string, { reason: string; signIn: boolean }>();

  /** The server each finished add or edit stored, under its key — held
   * until its card is closed, so the card knows which server it became. */
  private readonly added = new Map<string, PatchbayMcpServerId>();

  /** The sign-in each connect waits on the browser for, under its key: the
   * state its callback must carry, and why the link last pasted for it was
   * refused. Held while the wait lasts. */
  private readonly awaiting = new Map<string, { state: string; refused?: string }>();

  /** The refresh in flight per credential — see `refreshOnce`. */
  private readonly refreshing = new Map<string, Promise<void>>();

  /** One attempt under a connect key: it clears the last one's outcome,
   * and holds its own until dismissed. One the gates told to stop is no
   * failure — nothing was stored, and there is nothing to say. */
  private async attempt(key: string, signal: AbortSignal | undefined, run: () => Promise<PatchbayMcpServerId>): Promise<PatchbayMcpServerId> {
    this.failures.delete(key);
    this.added.delete(key);
    try {
      const patchbayMcpServerId = await run();
      this.added.set(key, patchbayMcpServerId);
      return patchbayMcpServerId;
    } catch (err) {
      if (signal?.aborted === true) {
        this.log.info(`${key}: stopped — nothing stored`);
      } else {
        this.failures.set(key, { reason: agentErrorText(err), signIn: err instanceof SignInAsked });
        this.log.error(`${key}: failed — ${agentErrorText(err)}`);
      }
      throw err;
    } finally {
      // Told to stop, its sign-in's wait may never settle: no link is taken
      // for an attempt that ended.
      this.awaiting.delete(key);
    }
  }

  /** Clears an add's outcome — its failure's note, or the server it made. */
  async dismiss(key: string): Promise<void> {
    this.failures.delete(key);
    this.added.delete(key);
    await this.refresh();
  }

  /** A browser flow under a connect key: the user agent handed to it waits
   * on the browser for as long as the user takes — published as waiting
   * meanwhile, so its card takes a pasted link — and ends with the
   * attempt's signal — told to stop (Cancel, the window's end), the wait
   * for the tab is given up, and the flow with it, so a tab finished later
   * changes nothing. Its result is never stored then. */
  private async browserFlow<T>(
    key: string,
    userAgent: OAuthUserAgent,
    flow: (bound: OAuthUserAgent) => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const running = flow({
      redirectUri: () => userAgent.redirectUri(),
      authorize: async (url, state) => {
        const waiting = { state };
        this.awaiting.set(key, waiting);
        this.republish();
        try {
          return await userAgent.authorize(url, state, signal);
        } finally {
          // A wait given up may settle after the next attempt under the key
          // began waiting: it clears only its own.
          if (this.awaiting.get(key) === waiting) this.awaiting.delete(key);
          this.republish();
        }
      },
    });
    running.catch(() => {}); // given up, it may still reject — never unhandled
    return unlessAborted(running, signal);
  }

  /** MCP's sign-in against a remote server: discovery, dynamic client
   * registration, PKCE, the browser — the token it ends with. */
  private async signIn(key: string, url: string, signal: AbortSignal | undefined): Promise<StoredToken> {
    if (this.oauthUserAgent === null) throw new Error("OAuth is unavailable in this environment");
    this.log.info(`browser OAuth starting (endpoint ${loggableUrl(url)})`);
    return signedIn(await this.browserFlow(key, this.oauthUserAgent, (ua) => connectMcpOAuth(url, CLIENT_INFO, ua), signal));
  }

  /** A sign-in link the user pasted into the card of the connect under
   * `key` — the callback, handed to another window. Through the door a
   * delivered callback takes, once its state is the one this connect's
   * sign-in waits on; any other is refused, the reason on the card. With
   * no sign-in waiting there, nothing happens: its card no longer asks. */
  async pasteSignInLink(key: string, link: string): Promise<void> {
    const waiting = this.awaiting.get(key);
    if (waiting === undefined || this.oauthUserAgent === null) return;
    const query = linkQuery(link);
    const state = query === null ? null : new URLSearchParams(query).get("state");
    if (query === null || state === null) waiting.refused = "this isn't a sign-in link";
    else if (state !== waiting.state) waiting.refused = "this link belongs to a different sign-in";
    else {
      delete waiting.refused;
      this.oauthUserAgent.deliver(query);
    }
    await this.refresh();
  }

  /** Patchbay's own handshake with a server about to be stored — the check
   * every add and edit passes before anything is kept. A remote server
   * asking for a sign-in is said as that. */
  private async check(target: ProbeTarget, signal: AbortSignal | undefined): Promise<ProbeOutcome> {
    try {
      return await unlessAborted(this.probeFn(target, signal, this.log), signal);
    } catch (err) {
      if (signal?.aborted !== true && asksForSignIn(err)) throw new SignInAsked("the server asks you to sign in");
      if (signal?.aborted !== true && target.kind === "stdio") throw new Error(`${agentErrorText(err)} (ran in ${target.cwd})`);
      throw err;
    }
  }

  /** The environment a server's `${VAR}` references are filled from when it
   * is handed to an agent: this host's, the agent's own env over it. */
  private async handOffEnv(patchbayAgentId: PatchbayAgentId): Promise<Readonly<Record<string, string | undefined>>> {
    return { ...process.env, ...(await this.agents.env(patchbayAgentId)) };
  }

  /** The environment patchbay's own check of a server fills it from: a
   * hand-off's to one of the agents it is routed to — the first whose
   * environment fills every variable; with none routed, or none filling
   * them, this host's alone, which names what stays unset. */
  private async checkEnv(draft: McpDraft, routing: McpServerRoutingView): Promise<Readonly<Record<string, string | undefined>>> {
    for (const patchbayAgentId of this.agents.ids().filter((id) => reaches(routing, id))) {
      const env = await this.handOffEnv(patchbayAgentId);
      if ("draft" in expandDraft(draft, env)) return env;
    }
    return process.env;
  }

  /** A custom draft's check: its variables filled as its hand-off fills
   * them, then the handshake — a stdio server's only where it would be on,
   * never running its command in a workspace it is off in: there, unchecked
   * (null). */
  private async checkDraft(
    draft: McpDraft,
    reach: { routing: McpServerRoutingView; workspaces: Reach<WorkspaceId> },
    bearer: string | null,
    signal: AbortSignal | undefined,
  ): Promise<ProbeOutcome | null> {
    const problem = draftProblem(draft);
    if (problem !== null) throw new Error(problem);
    const filled = expandDraft(draft, await this.checkEnv(draft, reach.routing));
    if ("unset" in filled) throw new Error(unsetSaid(filled.unset));
    const d = filled.draft;
    if (d.type === "stdio") {
      if (!reaches(reach.workspaces, this.here)) return null;
      return this.check({ kind: "stdio", command: d.command, args: d.args, env: d.env, cwd: this.workspaceCwd }, signal);
    }
    const headers = bearer === null ? d.headers : { ...d.headers, Authorization: `Bearer ${bearer}` };
    return this.check({ kind: "http", url: d.url, headers }, signal);
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

  /** `refresh` when nothing waits on it. */
  republish(): void {
    void this.refresh().catch(logCatch(this.log, "MCP server list"));
  }

  /** Re-reads config + token presence and republishes the lists wholesale
   * — same "replace, don't patch" shape as the capability matrix. */
  async refresh(): Promise<void> {
    this.hooks.listed(this.configs.list().map((c) => ({ id: c.id, name: c.name, workspaces: c.workspaces })));
    this.hooks.emit(
      { kind: "mcpCatalogLoaded", entries: this.catalogViews() },
      {
        kind: "mcpServersChanged",
        servers: await this.currentViews(),
        builtin: [
          {
            id: EDITOR_SERVER.id,
            name: EDITOR_SERVER.name,
            probe: this.probes.get(EDITOR_SERVER.id),
            busy: this.lines.busy(EDITOR_SERVER.id),
          },
        ],
        connects: this.connectViews(),
      },
    );
  }

  /** The connects under way, read off the connect line, and the outcomes
   * held — one under a key that runs again shows running. */
  private connectViews(): McpServerConnectView[] {
    const running = this.lines.connecting();
    const held = (key: string) => !running.includes(key);
    return [
      ...running.map((key) => {
        const waiting = this.awaiting.get(key);
        return {
          key,
          ...connectOf(key),
          status: "running" as const,
          ...(waiting === undefined ? {} : { awaitingSignIn: true as const }),
          ...(waiting?.refused === undefined ? {} : { linkRefused: waiting.refused }),
        };
      }),
      ...[...this.failures]
        .filter(([key]) => held(key))
        .map(([key, { reason, signIn }]) => ({
          key,
          ...connectOf(key),
          status: "failed" as const,
          reason,
          ...(signIn ? { signIn: true as const } : {}),
        })),
      ...[...this.added]
        .filter(([key]) => held(key))
        .map(([key, server]) => ({ key, ...connectOf(key), status: "added" as const, server })),
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
        command: source.kind === "catalog" ? undefined : customLine(source),
        connected,
        signedIn: authTypeOf(source) === "oauth",
        workspaces: config.workspaces,
        onHere: this.onHere(config),
        routing: config.routing,
        transport: config.transport,
        probe: this.probes.get(config.id),
        busy: this.lines.busy(config.id),
        draft: await this.draftOf(config),
      });
    }
    return views;
  }

  /** A custom server as its edit form shows it, values included — what
   * its owner typed. Undefined for curated entries: their shape is catalog
   * data. */
  private async draftOf(config: McpServerConfig): Promise<McpDraft | undefined> {
    const source = config.source;
    if (source.kind === "custom-stdio") {
      return { type: "stdio", command: source.command, args: source.args, env: await this.env.get(config.id) };
    }
    if (source.kind === "custom-http") return { type: "http", url: source.url, headers: await this.headersOf(config.id) };
    return undefined;
  }

  /** The server's name, read now — undefined once removed. */
  name(patchbayMcpServerId: PatchbayMcpServerId): string | undefined {
    return this.configs.get(patchbayMcpServerId)?.name;
  }

  /** Copy config: the server as a `{"mcpServers": {name: entry}}` document
   * — the shape other clients take, and the add card reads back. Keyed by
   * display name. A custom server copies as it is kept, `${VAR}` references
   * as typed; a curated entry as its resolved endpoint with the header its
   * key goes in — a sign-in is this machine's own, and the copy carries an
   * empty header list. Undefined when there is no endpoint to name. */
  async exportJson(patchbayMcpServerId: PatchbayMcpServerId): Promise<string | undefined> {
    const config = this.configs.get(patchbayMcpServerId);
    if (config === undefined) return undefined;
    const source = config.source;
    let draft = await this.draftOf(config);
    if (source.kind === "catalog") {
      const entry = this.entryFor(source.catalogId);
      const url = catalogEndpoint(source, entry);
      if (url === "") return undefined;
      const header = source.authMode === "header" ? catalogHeader(source, entry) : null;
      const key = await this.headerKey(patchbayMcpServerId);
      draft = { type: "http", url, headers: header !== null && key !== undefined ? { [header.headerName]: `${header.valuePrefix}${key}` } : {} };
    }
    return draft === undefined ? undefined : documentOf([{ name: config.name, draft }]);
  }

  /** The key a curated header-auth server sends — what its owner typed, so
   * it leaves with the server's export. Undefined for any other server: an
   * OAuth token is flow-minted and never leaves, and a custom server's
   * headers are its own (`headers`). */
  async headerKey(patchbayMcpServerId: PatchbayMcpServerId): Promise<string | undefined> {
    const source = this.configs.get(patchbayMcpServerId)?.source;
    if (source?.kind !== "catalog" || source.authMode !== "header") return undefined;
    return (await this.tokens.get(patchbayMcpServerId))?.accessToken;
  }

  /** A custom remote server's headers, as its owner typed them. */
  async headers(patchbayMcpServerId: PatchbayMcpServerId): Promise<Env> {
    return this.configs.get(patchbayMcpServerId)?.source.kind === "custom-http" ? this.headersOf(patchbayMcpServerId) : {};
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

  /** Stores a curated server that passed its check — its credential, its
   * record, its first reading. */
  private async storeCatalog(
    entry: CatalogEntry,
    name: string,
    authMode: "header" | "oauth",
    url: string,
    token: StoredToken,
    reach: { routing: McpServerRoutingView; workspaces: Reach<WorkspaceId> },
    outcome: ProbeOutcome,
  ): Promise<PatchbayMcpServerId> {
    const patchbayMcpServerId = mintPatchbayMcpServerId();
    await this.tokens.set(patchbayMcpServerId, token);
    const given = await this.configs.add({
      id: patchbayMcpServerId,
      name,
      source: { kind: "catalog", catalogId: entry.id, authMode, ...(entry.userUrl ? { url } : {}) },
      routing: ownReach(reach.routing),
      workspaces: ownReach(reach.workspaces),
      transport: "auto",
    });
    this.probes.set(patchbayMcpServerId, probeView(outcome));
    this.log.info(`${patchbayMcpServerId}: ${given} connected with ${authMode} (endpoint ${loggableUrl(url)})`);
    return patchbayMcpServerId;
  }

  /** A curated entry's key connect: the key checked against the server
   * first, stored only once it answers. Stored under the name the user
   * gave it. Returns the server's id. */
  connectCatalogWithKey(
    catalogId: string,
    name: string,
    token: string,
    url: string | undefined,
    reach: { routing: McpServerRoutingView; workspaces: Reach<WorkspaceId> },
    signal?: AbortSignal,
  ): Promise<PatchbayMcpServerId> {
    return this.attempt(connectKey.catalog(catalogId), signal, async () => {
      McpServerConfigStore.admitName(name);
      const entry = this.entryFor(catalogId);
      const header = entry?.auth.header;
      if (entry === undefined || header == null) throw new Error("no API-key mode for this server");
      const endpoint = this.resolveEndpoint(entry, url);
      if ("error" in endpoint) throw new Error(endpoint.error);
      const key = token.trim();
      if (key === "") throw new Error("key is empty");
      const outcome = await this.check(
        { kind: "http", url: endpoint.url, headers: { [header.headerName]: `${header.valuePrefix}${key}` } },
        signal,
      );
      return this.storeCatalog(entry, name, "header", endpoint.url, { accessToken: key }, reach, outcome);
    });
  }

  /** MCP-spec OAuth connect: URL-only — discovery, dynamic client
   * registration, PKCE, browser redirect via the injected user agent —
   * then the check, with the token it ended with. Failure (gated DCR,
   * non-compliant server, denied consent) is immediate and labeled; an
   * abandoned tab waits until the connect is cancelled. Stored under the
   * name the user gave it. Returns the server's id. */
  connectCatalogOAuth(
    catalogId: string,
    name: string,
    url: string | undefined,
    reach: { routing: McpServerRoutingView; workspaces: Reach<WorkspaceId> },
    signal?: AbortSignal,
  ): Promise<PatchbayMcpServerId> {
    return this.attempt(connectKey.catalog(catalogId), signal, async () => {
      McpServerConfigStore.admitName(name);
      const entry = this.entryFor(catalogId);
      if (entry === undefined || !entry.auth.oauth) throw new Error("no OAuth mode for this server");
      const endpoint = this.resolveEndpoint(entry, url);
      if ("error" in endpoint) throw new Error(endpoint.error);
      const token = await this.signIn(connectKey.catalog(catalogId), endpoint.url, signal);
      const outcome = await this.check(
        { kind: "http", url: endpoint.url, headers: { Authorization: `Bearer ${token.accessToken}` } },
        signal,
      );
      return this.storeCatalog(entry, name, "oauth", endpoint.url, token, reach, outcome);
    });
  }

  /** Any MCP server, as the add card's draft — checked against the server
   * before anything is stored, and stored only once it answers: a bad key,
   * a failing command or an unset variable leaves nothing behind. A remote
   * server that asks for a sign-in fails saying so; added again with
   * `signIn`, the browser flow runs first and the check goes with its
   * token. `card` keys the attempt — the add card it came from. The id is
   * minted; the name is cut to what agents keep, and a taken one gets a
   * number. Returns the id. */
  addCustom(
    card: string,
    name: string,
    draft: McpDraft,
    reach: { routing: McpServerRoutingView; workspaces: Reach<WorkspaceId> },
    signIn: boolean,
    signal?: AbortSignal,
  ): Promise<PatchbayMcpServerId> {
    return this.attempt(connectKey.custom(card), signal, async () => {
      McpServerConfigStore.admitName(name);
      const d = normalized(draft);
      const token = signIn && d.type === "http" ? await this.signIn(connectKey.custom(card), d.url, signal) : null;
      const outcome = await this.checkDraft(d, reach, token?.accessToken ?? null, signal);
      const patchbayMcpServerId = mintPatchbayMcpServerId();
      await this.keepSecrets(patchbayMcpServerId, d, token);
      const given = await this.configs.add({
        id: patchbayMcpServerId,
        name,
        source: this.sourceOf(d, token !== null),
        routing: ownReach(reach.routing),
        workspaces: ownReach(reach.workspaces),
        transport: "auto",
      });
      if (outcome !== null) this.probes.set(patchbayMcpServerId, probeView(outcome));
      this.log.info(`${patchbayMcpServerId}: custom ${d.type} ${given} added${outcome === null ? " — off here, so not checked" : ""}`);
      return patchbayMcpServerId;
    });
  }

  /** A custom server edited in the add card's form: checked as an add is,
   * then stored over the server — its name, who gets it and its order
   * kept. A sign-in stays with a server whose URL is unchanged; `signIn`
   * runs a fresh one. */
  updateCustom(
    patchbayMcpServerId: PatchbayMcpServerId,
    draft: McpDraft,
    signIn: boolean,
    signal?: AbortSignal,
  ): Promise<PatchbayMcpServerId> {
    return this.attempt(connectKey.server(patchbayMcpServerId), signal, async () => {
      const existing = this.configs.get(patchbayMcpServerId);
      if (existing === undefined || existing.source.kind === "catalog") throw new Error("no such custom server");
      const was = existing.source;
      const d = normalized(draft);
      const kept =
        !signIn && d.type === "http" && was.kind === "custom-http" && was.oauth && was.url === d.url
          ? await this.freshToken(patchbayMcpServerId)
          : null;
      const token = signIn && d.type === "http" ? await this.signIn(connectKey.server(patchbayMcpServerId), d.url, signal) : null;
      const bearer = token?.accessToken ?? kept?.accessToken ?? null;
      const outcome = await this.checkDraft(d, existing, bearer, signal);
      // Removed while it was checked: it stays removed.
      const now = this.configs.get(patchbayMcpServerId);
      if (now === undefined) throw new Error("the server was removed");
      await this.keepSecrets(patchbayMcpServerId, d, token, kept !== null);
      await this.configs.upsert({ ...now, source: this.sourceOf(d, bearer !== null) });
      if (outcome !== null) this.probes.set(patchbayMcpServerId, probeView(outcome));
      else this.probes.delete(patchbayMcpServerId);
      this.log.info(`${patchbayMcpServerId}: custom ${d.type} ${now.name} saved`);
      return patchbayMcpServerId;
    });
  }

  private sourceOf(draft: McpDraft, oauth: boolean): McpServerSource {
    return draft.type === "stdio"
      ? { kind: "custom-stdio", command: draft.command, args: [...draft.args] }
      : { kind: "custom-http", url: draft.url, oauth };
  }

  /** A custom server's secrets as its draft has them: env for a command,
   * headers for a URL, and a sign-in's token — a fresh one, or the one it
   * keeps. Nothing of the other kind stays. */
  private async keepSecrets(
    patchbayMcpServerId: PatchbayMcpServerId,
    draft: McpDraft,
    token: StoredToken | null,
    keepsSignIn = false,
  ): Promise<void> {
    await this.env.set(patchbayMcpServerId, draft.type === "stdio" ? { ...draft.env } : {});
    await this.headerStore.set(patchbayMcpServerId, draft.type === "http" ? { ...draft.headers } : {});
    if (token !== null) await this.tokens.set(patchbayMcpServerId, token);
    else if (!keepsSignIn) await this.tokens.remove(patchbayMcpServerId);
  }

  /** An imported server landed on this machine, whole, on `record.id` — its
   * env, headers and key as the file carries them. A sign-in is this
   * machine's own: it stays with a server whose connection is unchanged,
   * and goes with one that moved. Returns the name it holds here: a taken
   * one gets a number. */
  async landImported(
    record: McpServerConfig,
    secret: { env?: Readonly<Env>; headers?: Readonly<Env>; key?: string } | undefined,
  ): Promise<string> {
    const mine = this.configs.get(record.id);
    let name = record.name;
    if (mine === undefined) name = await this.configs.add(record);
    else await this.configs.upsert(record);
    await this.env.set(record.id, { ...secret?.env });
    await this.headerStore.set(record.id, { ...secret?.headers });
    const auth = authTypeOf(record.source);
    const keepsSignIn = auth === "oauth" && mine !== undefined && isDeepStrictEqual(mine.source, record.source);
    if (auth === "header" && secret?.key !== undefined) await this.tokens.set(record.id, { accessToken: secret.key });
    else if (!keepsSignIn) await this.tokens.remove(record.id);
    return name;
  }

  /** Every server's facts gone — the erase. Secrets first, while the
   * records still key them; then the records whole. */
  async eraseAll(): Promise<void> {
    for (const { id } of this.configs.list()) {
      await this.env.remove(id);
      await this.headerStore.remove(id);
      await this.tokens.remove(id);
    }
    await this.configs.wipe();
  }

  /** Disconnect *is* remove — the full clear (credential + env + headers +
   * config): the server is gone, curated or custom; its catalog entry stays
   * there to connect again. The non-destructive option is switching it off
   * where it is on (`setWorkspaces`), which keeps everything. */
  async remove(patchbayMcpServerId: PatchbayMcpServerId): Promise<void> {
    if (patchbayMcpServerId === EDITOR_SERVER.id) return; // built in: never removed
    this.probes.delete(patchbayMcpServerId);
    this.failures.delete(connectKey.server(patchbayMcpServerId));
    this.added.delete(connectKey.server(patchbayMcpServerId));
    await this.tokens.remove(patchbayMcpServerId);
    await this.env.remove(patchbayMcpServerId);
    await this.headerStore.remove(patchbayMcpServerId);
    await this.configs.remove(patchbayMcpServerId);
    this.log.info(`${patchbayMcpServerId}: removed — credential, env, headers and config cleared`);
  }

  /** An agent removed: no server's reach names it any more. */
  async forgetAgent(patchbayAgentId: PatchbayAgentId): Promise<void> {
    await this.configs.forgetAgent(patchbayAgentId);
    await this.refresh();
  }

  /** Where the server is on. Returns whether it was switched on in this
   * window's workspace by it — off before, on now. */
  async setWorkspaces(patchbayMcpServerId: PatchbayMcpServerId, workspaces: Reach<WorkspaceId>): Promise<boolean> {
    const existing = this.configs.get(patchbayMcpServerId);
    if (existing === undefined) return false;
    const next = { ...existing, workspaces: ownReach(workspaces) };
    await this.configs.upsert(next);
    await this.refresh();
    return !this.onHere(existing) && this.onHere(next);
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

  /** The built-in servers with no reading yet this window. */
  uncheckedBuiltin(): PatchbayMcpServerId[] {
    return this.probes.has(EDITOR_SERVER.id) ? [] : [EDITOR_SERVER.id];
  }

  /** Runs the tool probe and caches the outcome on the card
   * (protocol.ts McpServerProbeView — provider-side truth, timestamped).
   * Explicit-trigger only (switched on here, refresh button, the page of
   * the built-in servers opened): probing a custom-stdio server executes
   * its command — and only where the server is on — and even http
   * shouldn't fire on background sweeps — reality is read when the user
   * acts on it. The
   * built-in editor server is probed the same way, through the launch every
   * agent is handed — under a token no attach minted, which the handshake
   * never presents: initialize and tools/list are the server's own. */
  async probe(patchbayMcpServerId: PatchbayMcpServerId, signal?: AbortSignal): Promise<void> {
    const config = this.configs.get(patchbayMcpServerId);
    if (config === undefined && patchbayMcpServerId !== EDITOR_SERVER.id) return;
    // A server's command runs only where the server is on: off in this
    // workspace, it is never started in this workspace's folder.
    if (config?.source.kind === "custom-stdio" && !this.onHere(config)) {
      this.probes.delete(patchbayMcpServerId);
      return;
    }
    try {
      const target = config !== undefined ? await this.probeTargetFor(config) : this.editorProbeTarget();
      if (target === null) {
        // Nothing reachable to probe (no endpoint / missing credential) —
        // the card's connected flag already tells that story.
        this.probes.delete(patchbayMcpServerId);
      } else {
        const outcome = await this.check(target, signal);
        this.probes.set(patchbayMcpServerId, probeView(outcome));
        this.log.info(`${patchbayMcpServerId}: probe ok — ${outcome.tools.length} tool(s)`);
      }
    } catch (err) {
      // Told to stop, the probe has no outcome to keep.
      if (signal?.aborted === true) throw err;
      const reason = agentErrorText(err);
      this.probes.set(patchbayMcpServerId, { status: "failed", at: new Date().toISOString(), reason });
      this.log.info(`${patchbayMcpServerId}: probe failed — ${reason}`);
    }
  }

  /** The probe's connection recipe for one server — same resolution as
   * mcpServersFor (the server's draft filled as its add's check fills it,
   * a curated entry's URL and header, a fresh token), pointed at
   * patchbay's own MCP client instead of an agent's. */
  private editorProbeTarget(): ProbeTarget {
    const launch = editorServer(this.wire, randomUUID());
    return {
      kind: "stdio",
      command: launch.command,
      args: launch.args,
      env: Object.fromEntries(launch.env.map(({ name, value }) => [name, value])),
      cwd: this.workspaceCwd,
    };
  }

  private async probeTargetFor(config: McpServerConfig): Promise<ProbeTarget | null> {
    const draft = await this.draftOf(config);
    const live = await this.liveDraft(config, draft === undefined ? process.env : await this.checkEnv(draft, config.routing));
    if (live === null) return null;
    if ("unset" in live) throw new Error(unsetSaid(live.unset));
    const d = live.draft;
    return d.type === "stdio"
      ? { kind: "stdio", command: d.command, args: d.args, env: d.env, cwd: this.workspaceCwd }
      : { kind: "http", url: d.url, headers: d.headers };
  }

  /** A server as it is handed over now: its draft — a curated one's, its
   * endpoint with the header its credential goes in — filled from `env`,
   * a sign-in's fresh token beside its headers. Null when there is nothing
   * to reach (no endpoint, a credential it needs not stored); the unset
   * variables when it can't be filled. */
  private async liveDraft(
    config: McpServerConfig,
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<{ draft: McpDraft } | { unset: string[] } | null> {
    const source = config.source;
    if (source.kind === "catalog") {
      const entry = this.entryFor(source.catalogId);
      const url = catalogEndpoint(source, entry);
      const header = catalogHeader(source, entry);
      if (url === "" || header === null) return null;
      const token = (await this.freshToken(config.id))?.accessToken;
      if (token === undefined) return null; // needs a credential, none stored
      return { draft: { type: "http", url, headers: { [header.headerName]: `${header.valuePrefix}${token}` } } };
    }
    const draft = await this.draftOf(config);
    if (draft === undefined) return null;
    const filled = expandDraft(draft, env);
    if ("unset" in filled || filled.draft.type === "stdio" || source.kind !== "custom-http" || !source.oauth) return filled;
    const token = (await this.freshToken(config.id))?.accessToken;
    if (token === undefined) return null;
    return { draft: { ...filled.draft, headers: { ...filled.draft.headers, Authorization: `Bearer ${token}` } } };
  }

  async setRouting(patchbayMcpServerId: PatchbayMcpServerId, routing: McpServerRoutingView): Promise<void> {
    const existing = this.configs.get(patchbayMcpServerId);
    if (existing === undefined) return;
    await this.configs.upsert({
      ...existing,
      routing: ownReach(routing),
    });
    await this.refresh();
  }

  /** The headers the bridge serving a remote server to `patchbayAgentId`
   * sends — only while the server is still connected, and on in this
   * workspace and routed to that agent, or `own` — given to the bridge's
   * session alone: switching it off, re-routing or removing it reaches a
   * running bridge at its next request. Filled from the environment the
   * agent runs with. */
  async headersFor(patchbayMcpServerId: PatchbayMcpServerId, patchbayAgentId: PatchbayAgentId, own = false): Promise<Env | null> {
    const config = this.configs.get(patchbayMcpServerId);
    if (config === undefined || !(own || this.givenTo(config, patchbayAgentId))) return null;
    const live = await this.liveDraft(config, await this.handOffEnv(patchbayAgentId));
    return live !== null && "draft" in live && live.draft.type === "http" ? { ...live.draft.headers } : null;
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
      this.log.error(`${patchbayMcpServerId}: credential refresh failed — ${agentErrorText(err)}`);
    }
  }

  /** The mcpServers entries a session for `patchbayAgentId` should get — the
   * editor server first, then every configured server that reaches it
   * (protocol.ts records the fidelity-gate supersession) and is actually
   * usable (connected where a credential is needed, a real endpoint where
   * one is required) — and, beside them, which servers were given and how:
   * the session's attach records it. Each server's `${VAR}` references are
   * filled here, from the environment the agent runs with — this host's
   * and the agent's own env; one with a variable unset and no default is
   * not given, and `withheld` says which and why. Every value that crosses
   * to the agent is registered with the wire log's redaction, here, where
   * it crosses.
   * custom-stdio needs no bridge — handed straight through.
   * catalog/custom-http go one of two ways (prompt.image mechanics —
   * capability-conditional delivery): `declaresHttp` and transport "auto" ⇒
   * a real `type: "http"` entry, the agent's own MCP client connects
   * (headers read here, at attach — they ride agent-visible config,
   * ephemeral per session, exactly like a CLI-added server; the recorded
   * trade superseding the earlier bridge-only rule). Otherwise the
   * stdio-to-HTTP bridge, the guaranteed floor, which asks for the headers
   * per request. */
  async mcpServersFor(
    patchbayAgentId: PatchbayAgentId,
    contextToken: string,
    declaresHttp: boolean,
    /** Servers given to this session alone — the MCP chip's, given wherever
     * they are on and whoever they are routed to. */
    own: readonly PatchbayMcpServerId[] = [],
  ): Promise<{ servers: McpServer[]; given: AttachedServer[]; withheld: string[] }> {
    // McpServerStdio is the untagged union member — no discriminant needed
    // since it's the only variant every agent is guaranteed to accept.
    const servers: McpServer[] = [editorServer(this.wire, contextToken)];
    const given: AttachedServer[] = [{ id: EDITOR_SERVER.id, delivery: "stdio" }];
    const withheld: string[] = [];
    const env = await this.handOffEnv(patchbayAgentId);
    for (const config of this.configs.list()) {
      if (!this.givenTo(config, patchbayAgentId) && !own.includes(config.id)) continue;
      // Env and header values read from SecretStorage at the moment of
      // attach — this is also where they necessarily cross to the agent:
      // the agent spawns stdio servers itself (ACP model), so the spawn env
      // must ride the session's mcpServers config. SecretStorage governs
      // where patchbay keeps them at rest, not that inherent handoff.
      const live = await this.liveDraft(config, env);
      if (live === null) continue; // not connectable — nothing to route to
      if ("unset" in live) {
        withheld.push(`MCP server "${config.name}" wasn't given to the agent: ${unsetSaid(live.unset)}.`);
        continue;
      }
      const d = live.draft;
      if (d.type === "stdio") {
        // No cwd travels: the entry has no such field, so the server runs
        // wherever the agent does — the same workspaceCwd the probe uses.
        servers.push({
          name: config.name,
          command: d.command,
          args: [...d.args],
          env: Object.entries(d.env).map(([name, value]) => ({ name, value })),
        });
        given.push({ id: config.id, delivery: "stdio" });
      } else if (declaresHttp && config.transport === "auto") {
        // Passthrough is a snapshot: a token expiring mid-session is the
        // agent's 401 to surface, not ours to fix (the bridge path re-reads
        // per request).
        servers.push({
          type: "http",
          name: config.name,
          url: d.url,
          headers: Object.entries(d.headers).map(([name, value]) => ({ name, value })),
        });
        given.push({ id: config.id, delivery: "http" });
      } else {
        servers.push(bridgeServer(this.wire, contextToken, { id: config.id, name: config.name, url: d.url }));
        given.push({ id: config.id, delivery: "bridge" });
      }
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
    return { servers, given, withheld };
  }
}
