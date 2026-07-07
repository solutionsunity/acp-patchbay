# Remote MCP integrations — auth reference

Status: **decided** (supersedes P9's original GitHub-Device-Flow call — see
Decision record at the bottom). This is the reference for how patchbay
authenticates to remote MCP servers: which mechanisms exist, which one each
curated integration uses, and the failure modes the implementation must
avoid. Facts were gathered from each vendor's own docs/repos and public
issue trackers; links inline. Anything load-bearing should be re-verified
against the linked page at implementation time — vendors move.

## Scope and roles

- Patchbay is always the **OAuth client / credential holder** in every flow
  here. The ACP agent downstream never sees a credential and never
  participates in an auth handshake: it talks to patchbay's stdio-to-HTTP
  bridge (`integration-bridge.js`), which fetches a current token from the
  orchestrator over IPC and attaches it to outbound requests. That
  architecture (P9) is unchanged by anything in this document — this
  document only decides *how the orchestrator obtains tokens*.
- Patchbay orchestrates ACP agents; it is not itself an AI agent. MCP is
  the attachment language agents understand, so **every curated
  integration is a remote MCP server** — no bespoke per-service API
  clients, ever.

## The two mechanisms (and the one we dropped)

### 1 · Static key in a header — `authType: "header"`

The user pastes a token (PAT / API key) from the vendor's own settings
page; patchbay stores it in `IntegrationTokenStore` (SecretStorage,
per-workspace) and the bridge sends it on every request.

- **Header name is per-integration data, not hardcoded**: most services
  take `Authorization: Bearer <key>`, but Stitch requires
  `X-Goog-Api-Key: <key>`. Today's P9 `bearer-token` implementation is the
  special case; the registry/custom schema needs a `headerName` field
  (default `Authorization`, value template `Bearer {token}` vs raw).
- Zero OAuth surface: no popups, no redirects, no browser, no
  remote-environment failure modes. Works identically in local VS Code,
  SSH remote, WSL, code-server, Codespaces.
- This is the **v1 floor for every integration**: each of the eight below
  has a documented static-key path. OAuth is an upgrade where open, never
  a prerequisite.

### 2 · MCP-spec OAuth 2.1 with Dynamic Client Registration — `authType: "oauth"`

The MCP Authorization spec's own flow, for servers whose DCR is genuinely
open (no pre-provisioned credentials of any kind):

1. Discover protected-resource metadata:
   `{origin}/.well-known/oauth-protected-resource{/path}` (RFC 9728), or
   the `resource_metadata` URL from a 401's `WWW-Authenticate` header.
2. Discover the authorization server's metadata from its
   `authorization_servers[0]`: `/.well-known/oauth-authorization-server`
   and OIDC-configuration variants (RFC 8414), path-aware first, origin
   fallback.
3. Dynamic Client Registration (RFC 7591) against
   `registration_endpoint`: `POST { client_name, client_uri,
   redirect_uris, grant_types: ["authorization_code","refresh_token"],
   response_types: ["code"] }` → server-issued `client_id`.
4. Authorization Code + PKCE (RFC 7636, S256).
5. Redirect handled via **`vscode.window.registerUriHandler` +
   `vscode.env.asExternalUri`** — never a raw loopback HTTP server (see
   Pitfalls §1).
6. Tokens (access + refresh) into `IntegrationTokenStore`; the existing
   refresh-on-expiry logic in `IntegrationsManager.getToken` carries over.

A registry entry for an OAuth integration needs **only a URL** — every
other parameter is discovered. This is architecture.md's "adding a curated
integration is a data change, not code" at its most literal.

### Dropped: per-service OAuth Apps (Device Flow / fixed client_id)

No pre-registered vendor apps, no Device Flow, no owner-created OAuth App
touchpoint. Reasons: it multiplies per-service maintenance (an app owned
by this project per vendor, subject to each platform's review/suspension
policies); the services that would need it (GitHub, Figma) all have a
static-key path that works today with no vendor dependency; and the
static-key path is strictly more reliable (§ Pitfalls). If a vendor later
opens DCR, that integration upgrades to mechanism 2 by changing its
registry entry — data, not code.

`oauth-device-flow.ts` and the registry's `oauth-device` auth shape
(`deviceCodeUrl`/`tokenUrl`/`clientId`) are to be removed in the
implementation pass; RFC 8628 support returns only if some future vendor
offers Device Flow as its *open* mechanism, which none of the eight do.

## The curated eight

| Integration | Endpoint | v1 auth (`header`) | OAuth upgrade (`oauth`) |
|---|---|---|---|
| **GitHub** | `https://api.githubcopilot.com/mcp/` | PAT as `Authorization: Bearer` | ✗ — no DCR; one-click OAuth exists only for IDE-registered apps ([github/github-mcp-server](https://github.com/github/github-mcp-server)) |
| **Figma** | `https://mcp.figma.com/mcp` | ✗ remote (no key mode) — but the **Desktop** Dev Mode server is a local *HTTP* endpoint (`http://127.0.0.1:3845/mcp`, no auth; enabled in the desktop app) carried by the registry's `local` field | ✗ for now — remote access is gated on Figma's MCP client **catalog**: "only clients listed... can connect", new clients join a waitlist ([official docs](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/), re-verified after owner review). VS Code being listed covers *VS Code's own OAuth client* only — patchbay is its own MCP client and doesn't inherit the listing by running inside VS Code. Flips to ✓ if patchbay gets catalog-listed; the waitlist form is an owner touchpoint |
| **Stitch** (Google Labs) | `https://stitch.googleapis.com/mcp` | API key as `X-Goog-Api-Key` (custom header name — the case that forces `headerName` into the schema) | ✗ — key-only ([stitch.withgoogle.com/docs/mcp](https://stitch.withgoogle.com/docs/mcp/setup/)) |
| **Stripe** | `https://mcp.stripe.com` | Restricted API key as bearer | ✓ open DCR ([docs.stripe.com/mcp](https://docs.stripe.com/mcp)) |
| **Sentry** | `https://mcp.sentry.dev/mcp` | PAT (their own recommended fallback for remote-IDE setups) | ✓ open DCR ([docs.sentry.io/ai/mcp](https://docs.sentry.io/ai/mcp/)) |
| **Postman** | `https://mcp.postman.com/mcp` (US), `https://mcp.eu.postman.com` (EU) | API key as bearer (EU is key-only) | ✓ US server ([Postman docs](https://learning.postman.com/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server)) |
| **Supabase** | Per-project URL (Supabase OAuth 2.1 Server product) | Project API key | ✓ when the project enables DCR ([supabase docs](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication)) |
| **Augment Context Engine** | Per-account URL from `app.augmentcode.com/mcp/configuration` | API key (documented "non-interactive" mode) | ✓ documented OAuth mode ([docs.augmentcode.com](https://docs.augmentcode.com/context-services/mcp/overview)) — DCR openness unverified, check at implementation |

Notes:

- Per-account/per-project URLs (Supabase, Augment) mean the registry entry
  ships with `url: ""` and the user pastes their own endpoint at connect
  time — the entry contributes name, auth shape, and a docs link.
- Augment's remote indexing additionally requires their GitHub App on the
  repo — Augment's own onboarding, outside patchbay.
- Figma remote is the one entry with no self-serve path today; it ships as
  visible with the remote honestly gated, and the desktop Dev Mode server
  (local HTTP, no auth) offered as its "run it locally" path — the catalog
  row's Connect leads there.

## Pitfalls the implementation must respect (evidence-backed)

1. **Never bind a raw `http://127.0.0.1:{port}` server as the OAuth
   redirect target.** Under SSH remote, WSL, code-server, and Codespaces
   the browser is not on the machine that bound the port; the callback
   dies before reaching the extension. Real-world: Sentry documents this
   exact failure and recommends PAT to route around it
   ([write-up](https://www.darwinbiler.com/sentry-mcp-stdio-fix/)); a
   hardcoded-localhost redirect bug is reported against Roo-Code
   ([Roo-Code#10531](https://github.com/RooCodeInc/Roo-Code/issues/10531)).
   Correct mechanism: `vscode.window.registerUriHandler` (a
   `vscode://solutionsunity.acp-patchbay/...` callback) with the redirect
   URI built by `vscode.env.asExternalUri` — VS Code resolves it correctly
   in every environment by construction
   ([remote-extensions guide](https://code.visualstudio.com/api/advanced-topics/remote-extensions)).
2. **Treat DCR rejection as an immediate, labeled failure.** Figma 403s
   unknown `client_name`s with no hint that an allowlist exists; a known
   client library hangs forever on it
   ([mcporter#115](https://github.com/steipete/mcporter/issues/115)).
   Patchbay must surface "this server rejected client registration —
   likely gated; use its API-key path" and stop. No retry, no hang.
3. **Do not delegate to VS Code's native MCP-client OAuth**
   (`contributes.mcpServerDefinitionProviders`). It has open bugs as of
   this research — wrong discovery order (skips
   `oauth-protected-resource`), no audience config, mis-keyed credential
   cache — reported against the GitHub endpoint specifically
   ([vscode#273655](https://github.com/microsoft/vscode/issues/273655)).
   It also registers servers for *VS Code's own* MCP client, not for
   patchbay's agent-facing bridge, so it's the wrong layer regardless.
4. **`vscode.authentication.getSession('github', …)` stays unused for
   integrations.** It would grant a GitHub token with zero setup, but the
   session is account/profile-scoped — the same credential silently
   available in every workspace — which violates features.md's
   workspace-scoping rule (born of a real incident: a production-access
   MCP server following a user between repos). PAT-per-workspace keeps
   the blast radius the design promises.
5. **Discovery order matters**: `oauth-protected-resource` first (RFC
   9728), then the authorization server's metadata — the reverse (what VS
   Code currently does, see §3) breaks against spec-correct servers.

## Implementation (done — where each piece lives)

1. Header auth generalized: `headerName` + `valuePrefix` in both the
   registry schema (`stores/registry.ts`) and the custom-http config shape
   (`stores/config-file.ts`); the bridge reads them from
   `ACP_PATCHBAY_AUTH_HEADER`/`_PREFIX` (`integrations/bridge-main.ts`).
2. `src/orchestrator/mcp-oauth.ts`: discovery (RFC 9728 → 8414) → DCR (RFC
   7591) → Authorization Code + PKCE; redirect via an injected
   `OAuthUserAgent` — the orchestrator implements it with
   `registerUriHandler` (extension.ts) + `asExternalUri`, pending callbacks
   keyed by `state` in `oauth-callback.ts`. Gated DCR throws
   `DcrRejectedError`, labeled, immediately. Tested against a fake
   spec-compliant provider that genuinely verifies S256 PKCE
   (`test/support/fake-oauth-provider.ts`, `test/mcp-oauth.test.ts`).
3. `oauth-device-flow.ts` and the `oauth-device` registry shape removed.
4. `data/registry.json` ships the eight entries (Figma
   visible-but-not-connectable; Supabase/Augment with user-supplied URLs).
5. Per-account endpoints: registry source persists the pasted `url`;
   `IntegrationsManager.resolveEndpoint` refuses labeled when missing.

## Decision record

- **Superseded**: P9's phase-start call "GitHub Device Flow with an
  owner-created OAuth App" (plan.md P9, built as
  `oauth-device-flow.ts`). Rationale at the time was sound (no client
  secret in an extension, works in remote/WSL); superseded because (a)
  GitHub's remote MCP server accepts a plain PAT, making the app
  unnecessary, (b) Device Flow generalizes to none of the other seven
  integrations, and (c) the MCP-spec OAuth flow + static-header pair
  covers all eight with less machinery and no owner touchpoint.
- **Active**: mechanisms 1 + 2 above; the curated-eight table; pitfalls
  1–5 as binding implementation constraints.
