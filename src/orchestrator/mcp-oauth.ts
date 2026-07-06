// MCP-spec OAuth 2.1 client (docs/reference-mcp-oauth.md § mechanism 2):
// discover the protected resource's metadata (RFC 9728), discover its
// authorization server's metadata (RFC 8414 / OIDC), register a client
// dynamically (RFC 7591), then Authorization Code + PKCE (RFC 7636). No
// pre-provisioned credentials anywhere — a compliant server needs only its
// URL. vscode-free: the browser/redirect step is injected via OAuthUserAgent
// (the orchestrator implements it with registerUriHandler + asExternalUri —
// never a raw loopback server, pitfall §1), so the whole flow is testable
// against a fake OAuth provider, same fixture philosophy as the fake agent.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/** DCR rejected — pitfall §2: some vendors allowlist client registration
 * (Figma 403s unknown client_name with no explanation). This must surface
 * as an immediate, labeled failure, never a retry or a hang. */
export class DcrRejectedError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(
      `client registration rejected (HTTP ${status}): ${detail} — ` +
        `this server likely gates registration to approved clients; use its API-key path instead`,
    );
  }
}

export class OAuthDiscoveryError extends Error {}

export interface OAuthUserAgent {
  /** Externally-addressable redirect URI for this environment — in the
   * real implementation, `asExternalUri` of the extension's own
   * `vscode://` callback, resolved correctly under SSH/WSL/Codespaces. */
  redirectUri(): Promise<string>;
  /** Sends the user to `authorizationUrl` (browser) and resolves with the
   * callback's query parameters once the redirect lands. `state` is the
   * correlation value embedded in the URL — implementations key pending
   * callbacks by it. */
  authorize(authorizationUrl: string, state: string): Promise<URLSearchParams>;
}

export interface ClientInfo {
  clientName: string;
  clientUri?: string;
}

export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Seconds from now — undefined means no expiry reported. */
  expiresIn?: number;
  /** Refresh context — endpoints/client were discovered, so they must
   * travel with the token or refresh becomes impossible later. */
  tokenEndpoint: string;
  clientId: string;
}

// ── wire schemas (zod at the trust boundary, like every other parser here) ──

const resourceMetadataSchema = z.object({
  resource: z.string().optional(),
  authorization_servers: z.array(z.string()).optional(),
});

const authServerMetadataSchema = z.object({
  issuer: z.string().optional(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
});

export type AuthServerMetadata = z.infer<typeof authServerMetadataSchema>;

const registrationResponseSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
});

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

// ── discovery (RFC 9728 → RFC 8414; order per pitfall §5) ────────────────────

async function fetchJson(url: string, fetchFn: typeof fetch): Promise<unknown | null> {
  try {
    const response = await fetchFn(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** Path-aware well-known URLs, most specific first, per each RFC's
 * path-component rule, with bare-origin fallbacks. */
function wellKnownUrls(base: URL, suffix: string): string[] {
  const path = base.pathname.replace(/\/$/, "");
  const urls: string[] = [];
  if (path !== "" && path !== "/") {
    urls.push(new URL(`/.well-known/${suffix}${path}`, base.origin).toString());
  }
  urls.push(new URL(`/.well-known/${suffix}`, base.origin).toString());
  return urls;
}

/** RFC 9728: who is this resource's authorization server? Falls back to
 * the resource's own origin when no metadata is published — the MCP spec's
 * documented legacy behavior for servers that are their own AS. */
export async function discoverAuthorizationServer(
  mcpServerUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<URL> {
  const base = new URL(mcpServerUrl);
  for (const url of wellKnownUrls(base, "oauth-protected-resource")) {
    const body = await fetchJson(url, fetchFn);
    if (body === null) continue;
    const parsed = resourceMetadataSchema.safeParse(body);
    if (!parsed.success) continue;
    const first = parsed.data.authorization_servers?.[0];
    if (first !== undefined) return new URL(first);
  }
  return new URL(base.origin);
}

/** RFC 8414 (+ OIDC discovery variants): the authorization server's own
 * endpoints. Tries OAuth metadata first, then openid-configuration, each
 * path-aware before bare-origin. */
export async function discoverAuthServerMetadata(
  authServer: URL,
  fetchFn: typeof fetch = fetch,
): Promise<AuthServerMetadata> {
  const candidates = [
    ...wellKnownUrls(authServer, "oauth-authorization-server"),
    ...wellKnownUrls(authServer, "openid-configuration"),
  ];
  for (const url of candidates) {
    const body = await fetchJson(url, fetchFn);
    if (body === null) continue;
    const parsed = authServerMetadataSchema.safeParse(body);
    if (parsed.success) return parsed.data;
  }
  throw new OAuthDiscoveryError(
    `no OAuth authorization-server metadata found at ${authServer.origin} — this server may not support MCP-spec OAuth`,
  );
}

// ── Dynamic Client Registration (RFC 7591) ───────────────────────────────────

export async function registerClient(
  registrationEndpoint: string,
  clientInfo: ClientInfo,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ clientId: string; clientSecret?: string }> {
  const response = await fetchFn(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: clientInfo.clientName,
      client_uri: clientInfo.clientUri,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client — PKCE carries the proof
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new DcrRejectedError(response.status, detail.slice(0, 200) || response.statusText);
  }
  const parsed = registrationResponseSchema.parse(await response.json());
  return { clientId: parsed.client_id, clientSecret: parsed.client_secret };
}

// ── PKCE (RFC 7636, S256) ────────────────────────────────────────────────────

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url"); // 64 chars, within 43–128
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── token endpoint ───────────────────────────────────────────────────────────

async function postForm(
  url: string,
  params: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<unknown> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.error === "string") {
    throw new Error(`token endpoint error: ${body.error}${body.error_description ? ` (${String(body.error_description)})` : ""}`);
  }
  return body;
}

// ── the full flow ────────────────────────────────────────────────────────────

/** Connects to a remote MCP server with nothing but its URL: discovery →
 * DCR → Authorization Code + PKCE via the injected user agent. Throws
 * `DcrRejectedError` (gated registration) and `OAuthDiscoveryError`
 * (non-compliant server) as labeled, immediate failures. */
export async function connectMcpOAuth(
  mcpServerUrl: string,
  clientInfo: ClientInfo,
  userAgent: OAuthUserAgent,
  fetchFn: typeof fetch = fetch,
): Promise<McpOAuthTokens> {
  const authServer = await discoverAuthorizationServer(mcpServerUrl, fetchFn);
  const metadata = await discoverAuthServerMetadata(authServer, fetchFn);
  if (metadata.registration_endpoint === undefined) {
    throw new OAuthDiscoveryError(
      "authorization server does not offer dynamic client registration — use this integration's API-key path instead",
    );
  }
  const redirectUri = await userAgent.redirectUri();
  const { clientId } = await registerClient(
    metadata.registration_endpoint,
    clientInfo,
    redirectUri,
    fetchFn,
  );

  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("base64url");
  const authorizationUrl = new URL(metadata.authorization_endpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("resource", mcpServerUrl); // RFC 8707 audience binding

  const callback = await userAgent.authorize(authorizationUrl.toString(), state);
  if (callback.get("state") !== state) throw new Error("OAuth callback state mismatch");
  const callbackError = callback.get("error");
  if (callbackError !== null) {
    throw new Error(
      `authorization failed: ${callbackError}${callback.get("error_description") ? ` (${callback.get("error_description")})` : ""}`,
    );
  }
  const code = callback.get("code");
  if (code === null) throw new Error("OAuth callback carried no authorization code");

  const body = tokenResponseSchema.parse(
    await postForm(
      metadata.token_endpoint,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: mcpServerUrl,
      },
      fetchFn,
    ),
  );
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    tokenEndpoint: metadata.token_endpoint,
    clientId,
  };
}

/** Refresh with the context captured at connect (StoredToken carries it). */
export async function refreshMcpOAuth(
  tokenEndpoint: string,
  clientId: string,
  refreshTokenValue: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const body = tokenResponseSchema.parse(
    await postForm(
      tokenEndpoint,
      { grant_type: "refresh_token", refresh_token: refreshTokenValue, client_id: clientId },
      fetchFn,
    ),
  );
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? refreshTokenValue,
    expiresIn: body.expires_in,
  };
}
