// MCP-spec OAuth 2.1 client (docs/reference-mcp-oauth.md §2) against a fake
// provider that genuinely implements RFC 9728/8414/7591 discovery, DCR, and
// PKCE verification on the wire — no fetch mocks. Pitfalls §2 (gated DCR
// fails labeled and immediately) and §5 (discovery order) are asserted, not
// assumed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectMcpOAuth,
  DcrRejectedError,
  discoverAuthorizationServer,
  generatePkce,
  OAuthDiscoveryError,
  refreshMcpOAuth,
} from "../src/orchestrator/mcp-oauth";
import { FakeOAuthProvider, fakeUserAgent } from "./support/fake-oauth-provider";

const CLIENT_INFO = { clientName: "acp-patchbay", clientUri: "https://example.test/patchbay" };

let provider: FakeOAuthProvider;
beforeEach(async () => {
  provider = new FakeOAuthProvider();
  await provider.listen();
});
afterEach(async () => {
  await provider.close();
});

describe("connectMcpOAuth", () => {
  it("connects with nothing but the server URL: discovery → DCR → PKCE code exchange", async () => {
    const tokens = await connectMcpOAuth(provider.mcpUrl, CLIENT_INFO, fakeUserAgent());

    expect(tokens.accessToken).toBe("access-1");
    expect(tokens.refreshToken).toBe("refresh-1");
    expect(tokens.expiresIn).toBe(3600);
    // refresh context captured — endpoints were discovered, nothing static to re-derive them from
    expect(tokens.tokenEndpoint).toBe(provider.tokenEndpoint);
    expect(tokens.clientId).toBe("dcr-client-1");

    // DCR carried the public-client registration shape
    expect(provider.registrations).toHaveLength(1);
    expect(provider.registrations[0]).toMatchObject({
      client_name: "acp-patchbay",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: ["vscode://solutionsunity.acp-patchbay/oauth-callback"],
    });

    // the token endpoint verified S256(code_verifier) — reaching here proves
    // PKCE round-tripped, since the fake rejects a mismatched challenge
    const exchange = provider.tokenRequests[0]!;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code_verifier")).toBeTruthy();
  });

  it("gated DCR (Figma-style allowlist) fails immediately with a labeled error — never a hang", async () => {
    provider.gateDcr = true;
    await expect(connectMcpOAuth(provider.mcpUrl, CLIENT_INFO, fakeUserAgent())).rejects.toThrow(
      DcrRejectedError,
    );
    await expect(connectMcpOAuth(provider.mcpUrl, CLIENT_INFO, fakeUserAgent())).rejects.toThrow(
      /API-key path/,
    );
  });

  it("a server with no OAuth metadata fails as non-compliant, not as a crash", async () => {
    provider.noMetadata = true;
    await expect(connectMcpOAuth(provider.mcpUrl, CLIENT_INFO, fakeUserAgent())).rejects.toThrow(
      OAuthDiscoveryError,
    );
  });

  it("denied consent surfaces the provider's error", async () => {
    provider.denyConsent = true;
    await expect(connectMcpOAuth(provider.mcpUrl, CLIENT_INFO, fakeUserAgent())).rejects.toThrow(
      /access_denied/,
    );
  });

  it("rejects a callback whose state doesn't match — CSRF guard", async () => {
    const tampering = {
      ...fakeUserAgent(),
      authorize: async () => new URLSearchParams({ code: "stolen", state: "wrong" }),
    };
    await expect(connectMcpOAuth(provider.mcpUrl, CLIENT_INFO, tampering)).rejects.toThrow(
      /state mismatch/,
    );
  });
});

describe("discovery", () => {
  it("finds the authorization server via path-aware protected-resource metadata (RFC 9728)", async () => {
    const authServer = await discoverAuthorizationServer(provider.mcpUrl);
    expect(authServer.toString()).toContain("/auth");
  });

  it("falls back to the resource's own origin when no metadata is published", async () => {
    provider.noMetadata = true;
    const authServer = await discoverAuthorizationServer(provider.mcpUrl);
    expect(authServer.pathname).toBe("/");
  });
});

describe("refreshMcpOAuth", () => {
  it("exchanges a refresh token using the captured endpoint + client id", async () => {
    const tokens = await connectMcpOAuth(provider.mcpUrl, CLIENT_INFO, fakeUserAgent());
    const refreshed = await refreshMcpOAuth(tokens.tokenEndpoint, tokens.clientId, tokens.refreshToken!);
    expect(refreshed.accessToken).toBe("refreshed-2");
    // keeps the old refresh token when the provider doesn't rotate it
    expect(refreshed.refreshToken).toBe(tokens.refreshToken);
  });
});

describe("generatePkce", () => {
  it("produces a spec-length verifier and its S256 challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(challenge).not.toBe(verifier);
    expect(generatePkce().verifier).not.toBe(verifier); // fresh entropy each time
  });
});
