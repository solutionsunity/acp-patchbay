# MCP Servers — Architecture

How patchbay authenticates to and routes **remote MCP servers** — the mechanisms,
the curated catalog's policy, and the failure modes the implementation must avoid.
(Patchbay's own *local* MCP server, which exposes editor state to agents, lives in
[the architecture doc](architecture.md); this file is the remote services patchbay
connects agents to.) It is built on a vendor auth reference — endpoints, auth
types, and RFCs gathered from each vendor's own docs and issue trackers, linked
inline; anything load-bearing should be re-verified against the linked page at
implementation time, since vendors move.

## Scope and roles

- Patchbay is always the **OAuth client / credential holder** in every flow here;
  the ACP agent never takes part in an auth handshake. How the credential reaches
  the server is the delivery [the architecture doc](architecture.md) picks per
  attach: on the stdio-to-HTTP bridge (`mcp-bridge.js`) the agent never sees it —
  the bridge fetches the server's headers — a current token among them — from
  the orchestrator over IPC per request and attaches them to outbound
  requests; an agent declaring `mcp.http` gets the server passed through, with
  its headers and a fresh token in the session's own headers, ephemeral per
  session. This document decides *how the orchestrator obtains
  tokens*. (The bridge carries one more thing of patchbay's on the agent's
  behalf — the session's roots, as MCP's client-side `roots` capability; that
  mechanism is recorded with the local server in the architecture doc.)
- Patchbay orchestrates ACP agents; it is not itself an AI agent. MCP is the
  attachment language agents understand, so **every curated entry is a
  remote MCP server** — no bespoke per-service API clients, ever.

## The two mechanisms

### 1 · Static key in a header

The user pastes a token (PAT / API key) from the vendor's own settings page;
patchbay keeps it in SecretStorage and the server is sent it on every request.

- **Header name is per-server data, not hardcoded**: most services take
  `Authorization: Bearer <key>`, but Stitch requires `X-Goog-Api-Key: <key>`. A
  curated entry's catalog data names its header and prefix, and its key is
  stored alone (`McpServerTokenStore`). A custom server is kept the way other
  clients write one — `{type: "http", url, headers}` — so its key is a header
  like any other, written whole (`Authorization: Bearer <key>`), any number of
  them, the values in SecretStorage beside a stdio server's env. *(Supersedes
  the custom server's own `authType`/`headerName`/`valuePrefix`, 2026-11-01,
  #130: a field set of our own meant a pasted `headers` block was dropped.)*
- Zero OAuth surface: no popups, no redirects, no browser, no remote-environment
  failure modes. Works identically in local VS Code, SSH remote, WSL, code-server,
  Codespaces.
- This is the **floor**: a catalog entry carries the vendor's documented
  static-key path wherever one exists. OAuth is an upgrade where open, never a
  prerequisite.

### 2 · MCP-spec OAuth 2.1 with Dynamic Client Registration

The MCP Authorization spec's own flow, for servers whose DCR is genuinely open (no
pre-provisioned credentials of any kind). A curated entry offers it where its
vendor opens it; a custom server is never asked to choose it up front — a
remote server that turns patchbay's check away with a 401 is offered **Sign in**,
the spec's own discovery from there, and the server records only that it
signed in:

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
6. Tokens (access + refresh) into `McpServerTokenStore`; the existing
   refresh-on-expiry logic in `McpServersStore.getToken` carries over.

A catalog entry for an OAuth server needs **only a URL** — every other
parameter is discovered. This is [the architecture doc](architecture.md)'s "adding
a curated server is a data change, not code" at its most literal.

### Why not per-service OAuth Apps (Device Flow / fixed client_id)

No pre-registered vendor apps, no Device Flow, no owner-created OAuth App
touchpoint — a deliberate scope decision. It would multiply per-service
maintenance (an app owned by this project per vendor, subject to each platform's
review/suspension policies); the services that would need it (GitHub, Figma) all
have a static-key path that works today with no vendor dependency; and the
static-key path is strictly more reliable (§ Pitfalls). If a vendor later opens
DCR, that server upgrades to mechanism 2 by changing its catalog entry —
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
  endpoint at connect. A server with no remote at all ships `url: ""` without
  `userUrl` and is listed through its `local` server alone: the row offers the
  local prefill and nothing else, and each instance the user runs (one per
  Odoo database, say) is its own custom add under its own name.
- **`description`** says what the server is for; **`note`** carries the caveats
  a user must know before connecting; **`local`** is the vendor's official local
  server when it documents one, offered as a prefill and never auto-run.
- **The mark is a file, not a field, and every entry has one**:
  `data/icons/<id>.svg`, one monochrome path with a leading comment naming
  its source (the vendor's own asset, or simple-icons), folded into the
  catalog at build and gated there — one `<path>`, one `viewBox`, nothing
  the renderer would drop; files and entries match one to one or the build
  fails. A reviewer judges an SVG by eye; nobody can judge path data in a
  JSON diff. There is no fallback icon: an entry without art is not an
  entry yet.
- Requests arrive through the "Curated MCP server request" issue form;
  contributions as a one-entry PR (CONTRIBUTING). Paid services are welcome.
  Listing is public information, so no vendor sign-off is needed and none is
  owed: a vendor's request to be removed is judged on its reason like any
  other issue, not granted by default.
- **Facts are re-asked, not assumed.** `scripts/catalog-check.mjs` asks the
  network whether each entry still holds — docs page and endpoint answer,
  OAuth origins still publish protected-resource metadata, npx packages still
  resolve — with three verdicts (ok, drift, unclear) so a bot-blocked 403
  never reads as a dead link. Glyphs are not asked: a reviewed copy gated at
  build is not a fact that moves on its own. The weekly
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
4. **`vscode.authentication.getSession('github', …)` stays unused for MCP
   servers.** It would grant a GitHub token with zero setup, but the session
   is account/profile-scoped — the same credential silently available in every
   workspace. Re-derived with #70 (2026-11-01): a server is now on only in
   the workspaces chosen, but its credential is still its own, wherever it
   is on; a profile-wide GitHub session would be one credential behind
   every server that took it. The decision stands; #73 is where taking it
   is weighed.
5. **Discovery order matters**: `oauth-protected-resource` first (RFC 9728), then
   the authorization server's metadata — the reverse (what VS Code currently does,
   see §3) breaks against spec-correct servers.
6. **The authorization URL opens exactly as built** (#138, 2026-11-02).
   `vscode.env.openExternal` opens a `Uri` re-encoded — its query decoded
   and encoded again — so the encoded `?` of a `redirect_uri` value
   (`…/oauth-callback%3FwindowId%3D1`) reaches the server changed, and a
   server matching redirect URIs exactly rejects it (DigitalOcean,
   reproduced). Patchbay's one browser door hands VS Code the address as a
   string, which its opener takes as written (VS Code's own MCP sign-in
   opens this way); every page patchbay opens goes through that door —
   an agent's url-mode page too — and a source test holds it the only
   caller.

## Implementation — where each piece lives

1. Header auth: a curated entry's `headerName` + `valuePrefix` are catalog
   data (`stores/mcp-catalog.ts`); a custom server's headers are its own, in
   the convention's shape (`shared/mcp-config.ts`), stored in SecretStorage.
   The bridge asks for a server's headers per request
   (`getMcpServerHeaders`, `mcp/bridge-main.ts`).
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
   `McpServersStore.resolveEndpoint` refuses labeled when missing.
