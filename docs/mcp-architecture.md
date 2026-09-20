# MCP Integrations — Architecture

How patchbay authenticates to and routes **remote MCP servers** — the mechanisms,
the curated catalog's policy, and the failure modes the implementation must avoid.
(Patchbay's own *local* MCP server, which exposes editor state to agents, lives in
[the architecture doc](architecture.md); this file is the remote services patchbay
connects agents to.) It is built on a vendor auth reference — endpoints, auth
types, and RFCs gathered from each vendor's own docs and issue trackers, linked
inline; anything load-bearing should be re-verified against the linked page at
implementation time, since vendors move.

## Scope and roles

- Patchbay is always the **OAuth client / credential holder** in every flow here.
  The ACP agent downstream never sees a credential and never participates in an
  auth handshake: it talks to patchbay's stdio-to-HTTP bridge
  (`integration-bridge.js`), which fetches a current token from the orchestrator
  over IPC and attaches it to outbound requests. That bridge architecture is
  fixed; this document decides *how the orchestrator obtains tokens*.
- Patchbay orchestrates ACP agents; it is not itself an AI agent. MCP is the
  attachment language agents understand, so **every curated integration is a
  remote MCP server** — no bespoke per-service API clients, ever.

## The two mechanisms

### 1 · Static key in a header — `authType: "header"`

The user pastes a token (PAT / API key) from the vendor's own settings page;
patchbay stores it in `IntegrationTokenStore` (SecretStorage, per-workspace) and
the bridge sends it on every request.

- **Header name is per-integration data, not hardcoded**: most services take
  `Authorization: Bearer <key>`, but Stitch requires `X-Goog-Api-Key: <key>`. The
  bearer-token case is the default; the catalog/custom schema carries a
  `headerName` field (default `Authorization`, value template `Bearer {token}` vs
  raw).
- Zero OAuth surface: no popups, no redirects, no browser, no remote-environment
  failure modes. Works identically in local VS Code, SSH remote, WSL, code-server,
  Codespaces.
- This is the **floor**: a catalog entry carries the vendor's documented
  static-key path wherever one exists. OAuth is an upgrade where open, never a
  prerequisite.

### 2 · MCP-spec OAuth 2.1 with Dynamic Client Registration — `authType: "oauth"`

The MCP Authorization spec's own flow, for servers whose DCR is genuinely open (no
pre-provisioned credentials of any kind):

1. Discover protected-resource metadata:
   `{origin}/.well-known/oauth-protected-resource{/path}` (RFC 9728), or the
   `resource_metadata` URL from a 401's `WWW-Authenticate` header.
2. Discover the authorization server's metadata from its `authorization_servers[0]`:
   `/.well-known/oauth-authorization-server` and OIDC-configuration variants
   (RFC 8414), path-aware first, origin fallback.
3. Dynamic Client Registration (RFC 7591) against `registration_endpoint`:
   `POST { client_name, client_uri, redirect_uris, grant_types:
   ["authorization_code","refresh_token"], response_types: ["code"] }` →
   server-issued `client_id`.
4. Authorization Code + PKCE (RFC 7636, S256).
5. Redirect handled via **`vscode.window.registerUriHandler` +
   `vscode.env.asExternalUri`** — never a raw loopback HTTP server (see Pitfalls §1).
6. Tokens (access + refresh) into `IntegrationTokenStore`; the existing
   refresh-on-expiry logic in `IntegrationsManager.getToken` carries over.

A catalog entry for an OAuth integration needs **only a URL** — every other
parameter is discovered. This is [the architecture doc](architecture.md)'s "adding
a curated integration is a data change, not code" at its most literal.

### Why not per-service OAuth Apps (Device Flow / fixed client_id)

No pre-registered vendor apps, no Device Flow, no owner-created OAuth App
touchpoint — a deliberate scope decision. It would multiply per-service
maintenance (an app owned by this project per vendor, subject to each platform's
review/suspension policies); the services that would need it (GitHub, Figma) all
have a static-key path that works today with no vendor dependency; and the
static-key path is strictly more reliable (§ Pitfalls). If a vendor later opens
DCR, that integration upgrades to mechanism 2 by changing its catalog entry —
data, not code. Device Flow (RFC 8628) support returns only if some future vendor
offers it as its *open* mechanism, which no curated vendor does.

## The curated set

The catalog is `data/mcp-catalog.json`, loaded through the schema in
`stores/mcp-catalog.ts`; the data file is the record and this document does not
restate it. Policy for what an entry is:

- **The vendor's official server**, described from the vendor's public
  documentation (`docsUrl` is the page every other field comes from). Patchbay
  lists what the vendor publishes; it does not certify the server — MCP is a
  standard — and a fact that turns out wrong is an issue.
- **Mechanisms as documented**: `auth.header` where the vendor documents a
  pasted key, `auth.oauth` where it documents MCP-spec OAuth — set false when a
  failure was reproduced (Figma's allowlisted DCR, Pitfall §2). Per-account
  services ship `url: ""` with `userUrl: true` and the user pastes their own
  endpoint at connect.
- **`description`** says what the server is for; **`note`** carries the caveats
  a user must know before connecting; **`local`** is the vendor's official local
  server when it documents one, offered as a prefill and never auto-run.
- Requests arrive through the "Curated MCP server request" issue form;
  contributions as a one-entry PR (CONTRIBUTING). Paid services are welcome.
  Listing is public information, so no vendor sign-off is needed and none is
  owed: a vendor's request to be removed is judged on its reason like any
  other issue, not granted by default.
- **Facts are re-asked, not assumed.** `scripts/catalog-check.mjs` asks the
  network whether each entry still holds — docs page and endpoint answer,
  OAuth origins still publish protected-resource metadata, npx packages still
  resolve, brand glyphs still equal simple-icons — with three verdicts (ok,
  drift, unclear) so a bot-blocked 403 never reads as a dead link. The weekly
  workflow keeps one open "MCP Catalog drift" issue: opened when drift appears,
  updated only when the findings change, closed on the first clean run.

## Pitfalls the implementation must respect (evidence-backed)

1. **Never bind a raw `http://127.0.0.1:{port}` server as the OAuth redirect
   target.** Under SSH remote, WSL, code-server, and Codespaces the browser is not
   on the machine that bound the port; the callback dies before reaching the
   extension. Real-world: Sentry documents this exact failure and recommends PAT
   to route around it ([write-up](https://www.darwinbiler.com/sentry-mcp-stdio-fix/));
   a hardcoded-localhost redirect bug is reported against Roo-Code
   ([Roo-Code#10531](https://github.com/RooCodeInc/Roo-Code/issues/10531)). Correct
   mechanism: `vscode.window.registerUriHandler` (a
   `vscode://solutionsunity.acp-patchbay/...` callback) with the redirect URI built
   by `vscode.env.asExternalUri` — VS Code resolves it correctly in every
   environment by construction
   ([remote-extensions guide](https://code.visualstudio.com/api/advanced-topics/remote-extensions)).
2. **Treat DCR rejection as an immediate, labeled failure.** Figma 403s unknown
   `client_name`s with no hint that an allowlist exists; a known client library
   hangs forever on it ([mcporter#115](https://github.com/steipete/mcporter/issues/115)).
   Patchbay must surface "this server rejected client registration — likely gated;
   use its API-key path" and stop. No retry, no hang.
3. **Do not delegate to VS Code's native MCP-client OAuth**
   (`contributes.mcpServerDefinitionProviders`). It has open bugs as of this
   research — wrong discovery order (skips `oauth-protected-resource`), no audience
   config, mis-keyed credential cache — reported against the GitHub endpoint
   specifically ([vscode#273655](https://github.com/microsoft/vscode/issues/273655)).
   It also registers servers for *VS Code's own* MCP client, not for patchbay's
   agent-facing bridge, so it's the wrong layer regardless.
4. **`vscode.authentication.getSession('github', …)` stays unused for
   integrations.** It would grant a GitHub token with zero setup, but the session
   is account/profile-scoped — the same credential silently available in every
   workspace — which violates [the features doc](features.md)'s workspace-scoping
   rule (born of a real incident: a production-access MCP server following a user
   between repos). PAT-per-workspace keeps the blast radius the design promises.
5. **Discovery order matters**: `oauth-protected-resource` first (RFC 9728), then
   the authorization server's metadata — the reverse (what VS Code currently does,
   see §3) breaks against spec-correct servers.

## Implementation — where each piece lives

1. Header auth generalized: `headerName` + `valuePrefix` in both the catalog
   schema (`stores/mcp-catalog.ts`) and the custom-http config shape
   (`stores/integration-configs.ts`); the bridge reads them from
   `ACP_PATCHBAY_AUTH_HEADER`/`_PREFIX` (`integrations/bridge-main.ts`).
2. `src/orchestrator/mcp-oauth.ts`: discovery (RFC 9728 → 8414) → DCR (RFC 7591) →
   Authorization Code + PKCE; redirect via an injected `OAuthUserAgent` — the
   orchestrator implements it with `registerUriHandler` (extension.ts) +
   `asExternalUri`, pending callbacks keyed by `state` in `oauth-callback.ts`.
   Gated DCR throws `DcrRejectedError`, labeled, immediately. Tested against a fake
   spec-compliant provider that genuinely verifies S256 PKCE
   (`test/support/fake-oauth-provider.ts`, `test/mcp-oauth.test.ts`).
3. `data/mcp-catalog.json` ships the entries; `stores/mcp-catalog.ts` loads them
   through the schema (the loader is the one seam a fetched source would use).
4. Per-account endpoints: the registry-kind source persists the pasted `url`;
   `IntegrationsManager.resolveEndpoint` refuses labeled when missing.
