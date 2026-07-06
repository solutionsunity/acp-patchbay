// Fake MCP-spec OAuth 2.1 provider — a real HTTP server implementing RFC
// 9728 protected-resource metadata, RFC 8414 authorization-server metadata,
// RFC 7591 dynamic client registration, and an authorization-code + PKCE
// token endpoint that actually verifies S256(code_verifier). Same fixture
// philosophy as the fake ACP agent: exercises the genuine wire shape, no
// mocks of fetch. `gateDcr` makes registration 403 like Figma's allowlist.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { OAuthUserAgent } from "../../src/orchestrator/mcp-oauth";

interface PendingCode {
  challenge: string;
  redirectUri: string;
  clientId: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export class FakeOAuthProvider {
  private server: Server;
  private origin = "";
  private codes = new Map<string, PendingCode>();
  private codeCounter = 0;
  private tokenCounter = 0;

  /** Observability for assertions. */
  registrations: Array<Record<string, unknown>> = [];
  tokenRequests: Array<URLSearchParams> = [];
  issuedAccessTokens: string[] = [];

  /** Registration 403s (Figma-style allowlist). */
  gateDcr = false;
  /** Authorization redirects back with error=access_denied. */
  denyConsent = false;
  /** Omit all discovery metadata (a non-compliant server). */
  noMetadata = false;
  /** expires_in on issued tokens; undefined = no expiry reported. */
  expiresIn: number | undefined = 3600;

  constructor() {
    this.server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", this.origin);
        res.setHeader("content-type", "application/json");

        if (this.noMetadata && url.pathname.startsWith("/.well-known/")) {
          res.statusCode = 404;
          res.end("{}");
          return;
        }
        // RFC 9728, path-aware: the resource lives at /mcp
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          res.end(
            JSON.stringify({
              resource: this.mcpUrl,
              authorization_servers: [`${this.origin}/auth`],
            }),
          );
          return;
        }
        // RFC 8414, path-aware: the authorization server lives at /auth
        if (url.pathname === "/.well-known/oauth-authorization-server/auth") {
          res.end(
            JSON.stringify({
              issuer: `${this.origin}/auth`,
              authorization_endpoint: `${this.origin}/auth/authorize`,
              token_endpoint: `${this.origin}/auth/token`,
              registration_endpoint: `${this.origin}/auth/register`,
            }),
          );
          return;
        }
        if (url.pathname === "/auth/register" && req.method === "POST") {
          if (this.gateDcr) {
            res.statusCode = 403;
            res.end(JSON.stringify({ error: "forbidden" }));
            return;
          }
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
          this.registrations.push(body);
          res.statusCode = 201;
          res.end(JSON.stringify({ client_id: `dcr-client-${this.registrations.length}` }));
          return;
        }
        if (url.pathname === "/auth/authorize") {
          const redirectUri = url.searchParams.get("redirect_uri") ?? "";
          const state = url.searchParams.get("state") ?? "";
          const location = new URL(redirectUri);
          if (this.denyConsent) {
            location.searchParams.set("error", "access_denied");
          } else {
            const code = `code-${++this.codeCounter}`;
            this.codes.set(code, {
              challenge: url.searchParams.get("code_challenge") ?? "",
              redirectUri,
              clientId: url.searchParams.get("client_id") ?? "",
            });
            location.searchParams.set("code", code);
          }
          location.searchParams.set("state", state);
          res.statusCode = 302;
          res.setHeader("location", location.toString());
          res.end();
          return;
        }
        if (url.pathname === "/auth/token" && req.method === "POST") {
          const params = new URLSearchParams(await readBody(req));
          this.tokenRequests.push(params);
          if (params.get("grant_type") === "refresh_token") {
            const accessToken = `refreshed-${++this.tokenCounter}`;
            this.issuedAccessTokens.push(accessToken);
            res.end(
              JSON.stringify({ access_token: accessToken, expires_in: this.expiresIn }),
            );
            return;
          }
          const pending = this.codes.get(params.get("code") ?? "");
          const verifier = params.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (
            pending === undefined ||
            challenge !== pending.challenge ||
            params.get("redirect_uri") !== pending.redirectUri ||
            params.get("client_id") !== pending.clientId
          ) {
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          const accessToken = `access-${++this.tokenCounter}`;
          this.issuedAccessTokens.push(accessToken);
          res.end(
            JSON.stringify({
              access_token: accessToken,
              refresh_token: `refresh-${this.tokenCounter}`,
              expires_in: this.expiresIn,
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      })();
    });
  }

  get mcpUrl(): string {
    return `${this.origin}/mcp`;
  }

  get tokenEndpoint(): string {
    return `${this.origin}/auth/token`;
  }

  listen(): Promise<void> {
    return new Promise((resolve) =>
      this.server.listen(0, () => {
        this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
        resolve();
      }),
    );
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** Stands in for the vscode registerUriHandler/asExternalUri agent: "opens"
 * the authorization URL by fetching it (redirect: manual — a real browser
 * would follow it to the vscode:// URI) and hands back the redirect's query
 * params, exactly what the UriHandler would receive. */
export function fakeUserAgent(): OAuthUserAgent {
  return {
    redirectUri: async () => "vscode://solutionsunity.acp-patchbay/oauth-callback",
    authorize: async (authorizationUrl) => {
      const response = await fetch(authorizationUrl, { redirect: "manual" });
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (location === null) throw new Error("authorize endpoint did not redirect");
      return new URL(location).searchParams;
    },
  };
}
