# Reference: authenticating remote MCP servers (GitHub, Figma, Stitch, Stripe, Sentry, Postman, Supabase)

Research for plan.md's P9 owner touchpoint ("create the GitHub OAuth app")
and the wider integrations list under consideration: GitHub, Figma, Stitch,
Stripe, Sentry, Postman, Supabase. Gathered from each vendor's own public
docs/repos (web search + fetch, current as of this session) and from public
VS Code extension-API docs and issue tracker reports. Read through an AI
summarizer, not the primary text in every case — verify anything
load-bearing against the linked pages directly before final implementation.

## Per-integration reality, as of this research

| Integration | Remote MCP endpoint | Auth reality | Notes |
|---|---|---|---|
| **GitHub** | `https://api.githubcopilot.com/mcp/` ([github/github-mcp-server](https://github.com/github/github-mcp-server)) | **No Dynamic Client Registration.** A generic client needs its own pre-registered GitHub OAuth App/GitHub App, **or** a Personal Access Token (`Authorization: Bearer <PAT>`) works with zero OAuth at all. | The one-click OAuth GitHub's own docs mention only works because the *IDE itself* (VS Code, JetBrains) already has a GitHub-registered app baked in — not something a generic client gets for free. |
| **Figma** | `https://mcp.figma.com/mcp` | Advertises DCR, but **the registration endpoint allowlists `client_name`** and returns `403` for anything not on Figma's approved list (VS Code, Cursor, Claude Code, …), confirmed on [Figma's own forum](https://forum.figma.com/ask-the-community-7/understanding-oauth-requirements-for-mcp-clients-connecting-to-figma-mcp-server-52216) and a [reported client-library bug](https://github.com/steipete/mcporter/issues/115) where an unhandled rejection makes the auth flow hang forever instead of failing cleanly. | A real, gated allowlist wearing DCR's clothes — functionally the same "ask the vendor to approve you" step as an App route, just phrased as a client-registration rejection instead of a missing API key field. Figma's Desktop MCP server (local, Dev Mode) sidesteps this entirely by not needing remote OAuth. |
| **Stitch** (Google Labs) | `https://stitch.googleapis.com/mcp` | Static API key in a **custom header**, `X-Goog-Api-Key` — not `Authorization: Bearer`. | Confirms patchbay's `custom-http` auth model needs a configurable header *name*, not just a hardcoded `Authorization: Bearer` — today's `authType: "bearer-token"` (P9) is one specific case of a more general "static header" shape. |
| **Stripe** | `https://mcp.stripe.com` | Real, open OAuth 2.1 + DCR — no allowlist reported. Restricted API key also accepted as a simpler alternative. | Matches the generic MCP OAuth flow cleanly. |
| **Sentry** | `https://mcp.sentry.dev/mcp` | Real, open OAuth 2.1 + DCR ("you typically do not need to create an OAuth app"). | Also documents a PAT fallback (`--access-token`) specifically because the OAuth redirect **fails in remote VS Code** (SSH/code-server) — see the reliability section below. |
| **Postman** | `https://mcp.postman.com/mcp` (US) / `https://mcp.eu.postman.com` | OAuth on the US server; **the EU server only supports a Postman API key as `Authorization: Bearer <key>`.** | Already exactly patchbay's existing `custom-http` + `bearer-token` path — nothing new needed for this one. |
| **Supabase** | Project-specific, via Supabase's own OAuth 2.1 Server product | Real OAuth 2.1, DCR optional (dashboard toggle) or manual client pre-registration. | Supabase is itself an OAuth-server *product* others build on — same shape as Stripe/Sentry from a connecting client's perspective. |

**Headline: DCR is not a uniform escape hatch.** Three of seven genuinely
support it in the open (Stripe, Sentry, Supabase). One advertises it but
gates it behind an approval allowlist that behaves like a silent rejection
to anyone not on the list (Figma). Two don't do OAuth at all — a static key
in a header is the real mechanism (Stitch, Postman-EU). One requires a
pre-registered app with no DCR alternative, but also accepts a plain PAT
with zero OAuth machinery (GitHub).

## "MCP route" vs "App route" — what's actually being traded

**MCP route** = the MCP Authorization spec's own OAuth 2.1 flow: discover
`.well-known/oauth-protected-resource` → discover the authorization
server's `.well-known/oauth-authorization-server` (or OIDC equivalent) →
Dynamic Client Registration if `registration_endpoint` exists → standard
Authorization Code + PKCE.

- **Gain**: zero pre-provisioned credentials for any server that supports
  open DCR (Stripe, Sentry, Supabase confirmed) — a registry entry needs
  only a URL, matching architecture.md's "adding a curated integration is a
  data change, not code" as literally as possible. One implementation
  covers every present and future compliant server.
- **Lose**: doesn't help at all for GitHub (no DCR) or Figma (DCR present
  but allowlist-gated) — those need a fallback regardless. Requires a
  redirect-callback mechanism, which is the actual source of the
  reliability complaints (next section) if built the way most
  reference implementations build it.

**App route** = a manually pre-registered OAuth App/GitHub App per service,
with its own `client_id` (Device Flow, as P9 originally built for GitHub,
or Authorization Code with a fixed app identity).

- **Gain**: works for services without DCR (GitHub) or with a gated one
  (Figma, if patchbay ever gets onto their allowlist — an external,
  non-technical dependency). Device Flow specifically has **no redirect
  URI at all**, so it's immune to the whole callback-reliability problem
  class below.
- **Lose**: real ongoing maintenance per service (an app registered and
  owned by this project, subject to each platform's review/rate-limit/
  suspension policies) — the thing plan.md's P9 already flagged as an
  owner touchpoint, multiplied by however many services end up needing it.

**Do we need both?** Yes, on the evidence above — no single mechanism
covers all seven services honestly. A third shape, **static key in a
header**, is also load-bearing (Stitch, Postman-EU) and already fully
built (`custom-http`, P9) modulo the header-name generalization noted
above.

One thing the "we orchestrate ACP agents, not build one" framing does
settle: patchbay itself is the OAuth *client* in every one of these flows
(it holds the token, the bridge attaches it to outbound requests) — the ACP
agent downstream never sees a credential or participates in the auth
handshake at all. That's already how P9 is built (`IntegrationTokenStore` +
the stdio-to-HTTP bridge) and none of this research changes it; it only
changes *how patchbay itself gets the token* for a given service.

## Known-problematic patterns to avoid, with evidence

1. **A raw `http://127.0.0.1:{port}/callback` HTTP server as the OAuth
   redirect URI breaks under SSH remote, code-server, WSL, and Codespaces**,
   because the browser doing the redirect may not be on the same machine as
   the process that bound that port. Confirmed real-world: Sentry's own
   docs describe exactly this failure for their MCP server in remote VS
   Code and recommend a PAT specifically to route around it
   ([darwinbiler.com](https://www.darwinbiler.com/sentry-mcp-stdio-fix/));
   a similar hardcoded-localhost redirect bug is reported against another
   extension ([RooCodeInc/Roo-Code#10531](https://github.com/RooCodeInc/Roo-Code/issues/10531)).
   **The fix VS Code itself provides**: `vscode.window.registerUriHandler`
   (a `vscode://<publisher>.<extension>/...` callback) plus
   `vscode.env.asExternalUri()` to build the redirect URI — VS Code
   resolves this correctly in every environment (local, SSH remote, WSL,
   Codespaces, tunnels) by construction, unlike a hand-rolled loopback
   server. This is the one change worth making regardless of which
   integration ships first.
2. **DCR that's allowlisted, not open, and rejected silently** — Figma
   returns a plain `403` to an unrecognized `client_name` with nothing
   telling the caller "you need approval." A known MCP client library hangs
   indefinitely instead of surfacing this
   ([steipete/mcporter#115](https://github.com/steipete/mcporter/issues/115)).
   Any generic OAuth-2.1 client patchbay builds must treat a DCR rejection
   as a clean, immediate, labeled failure — never a silent retry or hang.
3. **VS Code's own built-in MCP OAuth support has open, unresolved bugs**
   as of this research — wrong discovery order (tries
   `/.well-known/oauth-authorization-server` before the spec-correct
   `/.well-known/oauth-protected-resource`, with no fallback), missing
   audience configuration, and credential caching keyed wrong
   ([microsoft/vscode#273655](https://github.com/microsoft/vscode/issues/273655)),
   reported specifically against the GitHub MCP endpoint. Leaning on VS
   Code's native `contributes.mcpServerDefinitionProviders` OAuth handling
   today would inherit these bugs — another reason patchbay's own bridge +
   token store (already built, P9) stays the right layer to own this,
   rather than delegating to VS Code's in-progress MCP client machinery.
4. **`vscode.authentication.getSession('github', scopes)`** (VS Code's
   built-in GitHub auth provider) sidesteps 1–3 entirely for GitHub
   specifically — no app, no redirect, no DCR — but trades away workspace
   scoping (previously flagged): the session is account/profile-wide, not
   per-workspace, in tension with features.md's stated "a credential
   connected in one repo is never silently available in another" rule.

## What this suggests for v1 (not decided — laid out for the call)

- **Static-header auth (already built) is the most reliable path and
  covers real cases today**: Postman (EU), Stitch, and GitHub-via-PAT all
  reduce to "paste a token, send it as a header" — zero OAuth surface,
  zero popups, zero remote-environment failure modes, works identically
  everywhere. Only gap: the header *name* needs to be configurable
  (`Authorization: Bearer` today; Stitch needs `X-Goog-Api-Key`).
- **A generic OAuth 2.1 + open-DCR + PKCE flow, redirecting through
  `registerUriHandler`/`asExternalUri` (never a raw loopback server),
  covers Stripe/Sentry/Supabase** cleanly and would cover any future
  compliant server the same way, no code change, matching the registry's
  "data file, not code" principle.
- **Figma and GitHub both need an explicit fallback decision** because
  neither has an open, unauthenticated path to full OAuth: Figma's DCR is
  allowlist-gated (an external approval this project doesn't control);
  GitHub's isn't open at all. For both, the PAT/static-key path above is
  available today with no vendor dependency; full one-click OAuth for
  either is a real "create/get approved for an app" step layered on later,
  not a blocker for shipping the integration itself.

No implementation change has been made from this research — it's the
input to a decision, not the decision.
