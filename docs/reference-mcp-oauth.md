# Reference: GitHub MCP + remote-MCP OAuth — what's actually real

Two sources, both gathered while investigating plan.md's P9 owner
touchpoint ("create the GitHub OAuth app"):

1. Static inspection of the bundled `out/extension.js` in
   `augment.vscode-augment-0.890.2` **and** `-0.890.3` (installed at
   `~/.vscode-server/extensions/`) — minified, deobfuscated by reading, not
   decompiled. Both versions carry the identical partner-server list and
   OAuth code; `0.890.3` additionally carries a feature-flagged (default
   off, empty config) "GitHub integration notification" banner whose target
   URL comes from a remote config, not a client-side OAuth implementation —
   evidence Augment routes any GitHub connection through their own backend
   rather than a client-side flow like Figma/Stripe's, not evidence of a
   mechanism to copy.
2. GitHub's own public docs and the VS Code extension API docs (web search
   + fetch, current as of this session).

Treat (1) as reverse-engineered fact about one competitor's current build,
not a spec commitment from anyone. Treat (2) as authoritative but read
through an AI summarizer, not the primary text — verify anything load-bearing
against the linked pages directly before final implementation.

## Headline finding: no GitHub entry

Augment ships a curated **partner remote-MCP-server list** (object `qL` in
the bundle), each entry `{ name, displayName, url, authType }`:

| Partner | URL | authType |
|---|---|---|
| Figma | `https://mcp.figma.com/mcp` | `oauth` |
| Stripe | `https://mcp.stripe.com` | `oauth` |
| Sentry | `https://mcp.sentry.dev/mcp` | `oauth` |
| Vercel | `https://mcp.vercel.com` | `oauth` |
| Render | `https://mcp.render.com/mcp` | `header` |
| Honeycomb | `https://mcp.honeycomb.io/mcp` | `oauth` |
| Postman | `https://mcp.postman.com/mcp` | `header` |

**GitHub is not in this list, in this version.** `0.890.3` additionally
carries a feature-flagged "GitHub integration notification" (default
disabled, empty config in this build) that reads a URL out of a remote
feature-flag payload rather than driving a client-side OAuth flow —
consistent with Augment routing any GitHub connection through their own
backend/web flow rather than a Figma/Stripe-style in-extension connection.
Read together, this is real evidence GitHub's remote MCP server wasn't (as
of these two builds) integrated the same self-contained way as the other
six partners — **but it turns out GitHub does have one, confirmed by
GitHub's own docs (see below); Augment's absence just means Augment hasn't
wired it the simple way, not that it doesn't exist.**

`authType: "header"` (Render, Postman) looks like a simpler non-OAuth
mode — almost certainly "send a static API key/token as a header," i.e.
exactly patchbay's own existing `custom-http` + `bearer-token` path (P9).
Nothing further on that path needed investigating; it already matches.

## GitHub's actual official remote MCP server (docs.github.com)

Confirmed directly from GitHub's own documentation (not inferred from
Augment):

- **Endpoint**: `https://api.githubcopilot.com/mcp/` — this is
  [`github/github-mcp-server`](https://github.com/github/github-mcp-server),
  GitHub's official MCP server, also reachable remotely (not just as a
  local Docker/binary process) at that URL.
- **"Each MCP host application needs to configure a GitHub App or OAuth App
  to support remote access via OAuth"** (docs.github.com) — so for a
  from-scratch client, this *is* a real "create an app" step, same shape as
  plan.md P9 already assumed. VS Code itself gets a shortcut (next
  section). Visual Studio/JetBrains/Xcode/Eclipse currently use a PAT
  instead of OAuth (their docs say OAuth support is "coming soon" there).
- Scopes/exact handshake aren't published in the page GitHub's docs summary
  covered — worth reading
  [the setup page](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server)
  and [`github/github-mcp-server`](https://github.com/github/github-mcp-server)
  directly before implementing, not just this summary.

## VS Code has a built-in GitHub auth provider — a shortcut worth taking

This is the most consequential find, from VS Code's own extension API docs
and general API knowledge, independent of Augment or the MCP spec:

- **`vscode.authentication.getSession('github', scopes, options)`** is a
  long-standing, first-party VS Code extension API. It returns an
  `AuthenticationSession` (with a real GitHub access token) using **VS
  Code's own pre-registered GitHub OAuth App** — the same one VS Code's
  built-in GitHub Pull Requests / Settings Sync / source control features
  already use. No `client_id`, no OAuth App creation, no Device Flow client
  code, no owner touchpoint at all: the user just sees VS Code's native
  "Sign in with GitHub" consent UI (or reuses their existing signed-in VS
  Code account) and grants the requested scopes.
- Separately, `contributes.mcpServerDefinitionProviders` +
  `vscode.lm.registerMcpServerDefinitionProvider()` is VS Code's *own* MCP
  client registration API (what backs `MCP: List Servers` and Copilot
  Chat's tool use) — VS Code handles OAuth for these natively (DCR first,
  client-credentials fallback), per its "Full MCP Specification Support"
  blog post. **This is not directly useful for patchbay's bridge**, though:
  it registers a server for *VS Code's own* MCP client to talk to, not a
  connection patchbay can hand off to an arbitrary spawned ACP agent
  process — the actual relay to the agent still needs patchbay's own
  stdio-to-HTTP bridge (P9, already built) regardless of which mechanism
  gets the token.

### The real tradeoff this surfaces

Using `vscode.authentication.getSession('github', …)` instead of a custom
OAuth client is simpler, safer (patchbay never touches a client secret or
implements a redirect listener), and needs no owner-created app. But VS
Code's authentication sessions are **account/profile-scoped, not
workspace-scoped** — once granted, the same GitHub session is available in
every workspace the user opens, for every extension that requests
overlapping scopes. That's a direct tension with architecture.md's own
stated rule (features.md § Integrations): *"Integrations are workspace-
scoped by default... a credential connected in one repo is never silently
available in another"* — a rule that exists because of a real incident.
Routing/attachment (which agents get GitHub) stays workspace-scoped either
way (that's config-file state, not the credential); what changes is the
credential's own blast radius, which today's `IntegrationTokenStore`
(SecretStorage, genuinely per-workspace) deliberately contains and
`vscode.authentication` would not.

## The `authType: "oauth"` mechanism — MCP's own spec, not GitHub's Device Flow

This is the part worth changing patchbay's plan for. Augment's OAuth path
is the official **MCP Authorization spec** (OAuth 2.1 for remote MCP
servers — RFC 9728 Protected Resource Metadata, RFC 8414 Authorization
Server Metadata, RFC 7591 Dynamic Client Registration), implemented via
what reads as the official `@modelcontextprotocol/sdk` client auth helpers
(the function/variable shapes match that package's `auth.ts` almost
verbatim — `registerClient`, `client_name`/`client_uri`/`logo_uri`,
`grant_types:["authorization_code","refresh_token"]`,
`response_types:["code"]`). **No pre-provisioned OAuth App or hardcoded
`client_id` anywhere in this path.**

Flow, as implemented:

1. **Discover the protected-resource metadata.** Request
   `{serverOrigin}/.well-known/oauth-protected-resource{/path}` (or read a
   `resource_metadata` URL off a `401`'s `WWW-Authenticate` header, per
   RFC 9728 §5.1). Response includes `resource` and `authorization_servers: []`.
2. **Discover the authorization server's own metadata**, at the first
   `authorization_servers` entry: try, in order,
   `/.well-known/oauth-authorization-server{/path}`,
   `/.well-known/openid-configuration{/path}`, `{path}/.well-known/openid-configuration`,
   falling back to the bare origin's well-known paths. Response includes
   `authorization_endpoint`, `token_endpoint`, and optionally
   `registration_endpoint`.
3. **Dynamic Client Registration (RFC 7591)** — if `registration_endpoint`
   is present: `POST` `{ client_name, client_uri, logo_uri, redirect_uris,
   grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }`
   → response carries a freshly-issued `client_id` (and secret, if the
   server issues one). No app registered anywhere in advance. If the
   server doesn't support DCR, the error is surfaced as-is ("Incompatible
   auth server: does not support dynamic client registration") — no silent
   fallback.
4. **Standard OAuth 2.1 Authorization Code + PKCE** (`code_verifier`/
   `code_challenge`, 43–128 chars per RFC 7636) — not Device Flow.
5. **Redirect URI is a local loopback callback**, RFC 8252-style: the
   extension host spins up a temporary `http://127.0.0.1:{port}/callback`
   HTTP server (`createCallbackServer`), opens the browser to the
   authorization endpoint, and captures the redirect on that local server
   before exchanging the code for tokens. Constants confirm loopback hosts
   accepted: `127.0.0.1`, `localhost`, `[::1]`.

## What this means for patchbay's P9

Plan.md recorded a deliberate call at P9's start: *"OAuth grant: decide at
phase start — default call is GitHub Device Flow (no client secret in an
extension, works in remote/WSL)."* That's what got built
(`src/orchestrator/oauth-device-flow.ts`) — and GitHub's own docs confirm a
from-scratch OAuth App is a real requirement for a generic client, so the
underlying premise (an app has to exist somewhere) wasn't wrong. Three
things this investigation changes about the specifics, surfaced rather than
silently acted on:

1. **The endpoint is no longer a guess.** `https://api.githubcopilot.com/mcp/`
   is GitHub's own documented URL — `data/registry.json`'s `url` can be
   filled in now regardless of which auth path gets chosen.
2. **For GitHub specifically, `vscode.authentication.getSession('github',
   scopes)` replaces the whole Device Flow client** — no `clientId`, no
   owner-created OAuth App, no `oauth-device-flow.ts` code path exercised
   for this integration at all. The cost: the token is VS Code
   account-scoped, not workspace-scoped, in tension with the "integrations
   are workspace-scoped, credentials never follow you" rule (see above) —
   a real product-behavior question, not a technical one, and the reason
   this is being raised rather than just switched.
3. **For any *other* remote MCP server (custom integrations, or a future
   curated one), the generic OAuth 2.1 + Protected Resource Metadata +
   Dynamic Client Registration + PKCE + loopback-callback flow (steps 1–5
   above) is still the right shape** — GitHub's own built-in shortcut
   doesn't exist for Figma/Stripe/Sentry/etc., so `oauth-device-flow.ts`
   either gets replaced by (or gains a sibling) generic `mcp-oauth.ts` for
   that case regardless of what's decided for GitHub.

**Decision needed from the owner** (not made silently): for the GitHub
registry entry specifically, take the `vscode.authentication` shortcut
(simpler, zero setup, but account-scoped credential) or keep a self-
contained OAuth client scoped per-workspace via `IntegrationTokenStore`
(matches the stated workspace-scoping rule exactly, more code, and — per
GitHub's own docs — still needs a real OAuth App created either way if it
doesn't use VS Code's built-in one). Either choice, the custom-integration
escape hatch benefits from the generic OAuth 2.1 flow being built at some
point; that part isn't really in question.
