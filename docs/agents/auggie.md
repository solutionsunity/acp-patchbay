# Auggie (Augment Code) — ACP conduct notes

Identity: `@augmentcode/auggie` via npx (`--acp`), tested v0.32.0 (commit
eb99b871), protocol 1. Vendor channel: no public issue tracker known —
support@augmentcode.com / Discord.

## Compliance issues

### mcpServers honored only on the process's first session/new

- **Observed:** 2026-07-12, v0.32.0. Found live: a patchbay session reported
  no MCP tools at all — including patchbay's own editor server, which rides
  unconditionally in every session — while the same entries worked verbatim
  under a fresh auggie process.
- **Spec:** `mcpServers` is a parameter of each `session/new` (and
  `session/load`) — MCP server config is per-session, not per-process.
- **Repro (three runs, minimal stdio MCP server that touches a marker file
  when spawned):**
  1. Fresh `auggie --acp` → `initialize` → `session/new` with the marker
     server in `mcpServers` → **marker spawns at session open**, auggie runs
     `initialize` + `tools/list` against it. Correct.
  2. Fresh process → first `session/new` with a real remote-MCP bridge entry
     → prompt asking for one of its tools → `tool_call` fires through it.
     Correct.
  3. Fresh process → **first** `session/new` with `mcpServers: []` → second
     `session/new` with the marker server → **marker never spawns**, not even
     when a prompt explicitly requests its tool. The second session's
     `mcpServers` are silently ignored.
- **Impact:** any client that opens more than one session per process gets
  MCP servers only in the first. In patchbay the connect-time capability
  probe session runs first, so **every real auggie session got zero MCP
  servers** — silently.
- **Re-verified:** 2026-07-13, same version, fresh capture for the vendor
  report — control (marker on first session/new) spawns within ~10s of the
  response (not ~3s: spawn trails the session-open indexing), latch run
  (marker on second) never spawns. Verbatim frames in
  [the compliance report](reports/auggie-acp-compliance-2026-07-13.md).
- **Patchbay workaround:** implemented 2026-07-13 —
  `extensions/first-session-mcp-latch.ts` (id-keyed curated entry; the
  capability probe defers until the first real session attaches, which then
  triggers it via session-manager's attach ceremony). Giving the probe
  session real servers was rejected as worse: the process-wide latch would
  bind all later sessions to the probe's stale editor-server session token.
  Cost while latched: matrix/offerings stay declared-only until first real
  use, and a logged-out auggie's needsAuth surfaces at first session
  instead of at connect.
- **Status:** observed 2026-07-12 → report drafted 2026-07-13
  ([the compliance report](reports/auggie-acp-compliance-2026-07-13.md),
  combined with the models issue), pending send.

### Model selection rides a removed draft API (root `models` field + `session/set_model`)

- **Observed:** 2026-07-12 (field), 2026-07-13 (set path + confirmation-channel
  audit), v0.32.0. Found live: no model picker appeared for Auggie in any
  spec-faithful rendering.
- **Spec:** the surface was a real draft — never stabilized, **removed from
  the protocol artifacts June 1, 2026** with the guidance "Agents should
  continue to expose model selection through Session Config Options"
  (https://agentclientprotocol.com/rfds/updates). Under current v1 it is
  also non-conforming on its own terms: root custom fields on spec types
  are MUST NOT (extensibility § `_meta`), custom methods are reserved the
  `_` prefix (`session/set_model` squats the protocol namespace), and the
  extension is undeclared in `initialize`. The stable replacement —
  `configOptions` with `category: "model"` — landed February 4, 2026.
- **Repro:** three frames over stdio — `initialize` → `session/new` (response
  carries root `models: { availableModels: [28 entries], currentModelId: "" }`)
  → `session/set_model { sessionId, modelId }` → response `{}`; then silence
  (no notification within 3s; Auggie's `session/update` vocabulary has no
  model variant and `usage_update` carries only `{ cost, size, used }`).
  Verbatim transcript in [the compliance report](reports/auggie-acp-compliance-2026-07-13.md).
- **Impact:** generic ACP clients show no model selector at all; clients that
  adopt the legacy surface cannot display honest state — nothing on the wire
  ever confirms the active model (`currentModelId` is readable only at
  session-open, where it is `""`; empty sessions aren't persisted, so no
  reload-reconfirm either).
- **Patchbay workaround:** adopted 2026-07-13 as a scoped wire-extension
  (the architecture doc): `extensions/session-models-field.ts`
  `sessionModelsExtras` parses the field at the trust boundary (zod,
  degrade-to-absent) and synthesizes one "model" knob — id `model`, so the
  generic id-dedup lets a spec configOption model knob (claude-agent-acp) win
  wherever both could exist. Sets ride `session/set_model` through the knob's
  own self-executing `execute` door, outside the capability-tracked path.
  Display advances optimistically from the user's own pick (`withKnobValue`) —
  the sole fact in existence on an axis with no confirmation channel; the one
  deliberate exception to display-from-agent-state, scoped here. **Retire when Auggie
  migrates to configOptions** — the draft surface is removed upstream, so it
  will never appear in any SDK; vendor migration is the only exit.
- **Status:** observed 2026-07-12 → report drafted 2026-07-13
  ([the compliance report](reports/auggie-acp-compliance-2026-07-13.md)), pending send.

### Unknown image format kills the whole turn with an opaque 400

- **Observed:** 2026-07-14, v0.32.0 (commit eb99b871). `promptCapabilities.image`
  is declared `true`, and png/jpeg/gif/webp ImageContent works end-to-end
  (wire-verified same day, including a 153KB png on `claude-fable-5` and a
  `session/load`ed history session). But auggie maps the block's `mimeType`
  to a private format enum — `jpeg/jpg→2, png→1, gif→3, webp→4, else→0` —
  and ships the enum; the backend rejects format 0 by failing the **entire
  prompt** with `-32603 "Internal error: HTTP error: 400 Bad Request"`
  (`apiStatus: invalidArgument`, `/chat-stream`).
- **Repro:** `session/prompt` with `{type:"image", data:<png b64>,
  mimeType:"image/bmp"}` → the 400 above. Same block with
  `mimeType:"image/png"` → `end_turn`. (Bytes are never sniffed; the
  mimeType string alone decides.) Note `image/svg+xml` also lands on 0 —
  `split("/")[1]` is `"svg+xml"`.
- **Spec:** ImageContent's `mimeType` is a free string ("MIME type
  describing the encoded media payload") — no format enumeration; format
  scoping of a declared capability has no wire surface. Quality-of-
  implementation aside, the *conduct* gap is unmistakable: auggie's own
  oversize gate degrades gracefully (skip + local warn), while unknown
  format detonates the turn with an error that names nothing.
- **Impact on patchbay:** none since 2026-07-14 — the composer's attachment
  ingress normalizes every decodable image outside {png, jpeg, gif, webp}
  to PNG before a chip exists (the architecture doc's single attachment ingress),
  chosen as the industry-universal set, not as an auggie workaround — so no
  extension module, no retire condition. This entry documents the vendor
  behavior, not a live dependency.
- **Ask:** degrade unknown formats the way oversize already degrades (skip
  the block, warn, let the turn run) — or at minimum return an error that
  names the offending block and format.
- **Status:** observed + wire-verified 2026-07-14; to ride the TKT-66153
  channel as a follow-up.

## Capability gaps

- `mcpCapabilities` absent (no http/sse): honest — auggie takes stdio
  servers only, so integrations ride patchbay's stdio-to-HTTP bridge. Not an
  issue; recorded so nobody mistakes the bridge fallback for a patchbay
  limitation.
- `session.resume` undeclared; `session.load` declared (replay works).

## Behavioral notes

- **ACP auth surface not implemented at all** (wire-observed 2026-07-14,
  v0.32.0): `initialize` declares `authMethods: []`, and the -32000 error
  text says it plainly — *"Auggie does not currently support authenticating
  over ACP. Please run `auggie login` from your terminal then try again."*
  No `authenticate`, no `auth.logout`; login and logout exist only as
  out-of-band CLI commands (`auggie login` / `auggie logout`). Every auth
  transition therefore happens outside the running ACP process — which is
  exactly what makes the two findings below bite.
- **Auth state is read at spawn, never re-read — in both directions**
  (observed live 2026-07-14, v0.32.0):
  - **Login side:** with a running `auggie --acp` in `auth_required` state,
    a successful out-of-band `auggie login` (exit 0, credentials on disk)
    does not unlock it — the very next session/new still answers -32000; a
    fresh spawn of the same version is authenticated immediately. UX bug:
    any client offering a terminal-recipe login must restart the process
    after a successful login or the login appears to do nothing. Patchbay:
    `loginViaTerminal` (orchestrator.ts) probes after exit 0 and, on a
    still-`auth_required` answer, restarts the process — shape-gated
    (out-of-band login + still-locked probe), not vendor-gated.
  - **Logout side (the security half), now observed:** process spawned
    while logged in, then `auggie logout` out of band, then session/prompt
    driven on the running process — on both a *fresh* session and a
    *continuation of an already-loaded* session. Both stalled for **exactly
    4m39s, then errored out**. At no point did the agent raise
    `auth_required` (-32000) or any auth-shaped notification: the client
    sees a silent multi-minute stall indistinguishable from a long turn,
    then a generic failure. Server-side revocation does eventually bite
    (the error proves the token stopped working upstream), so this is not
    an indefinitely-authenticated actor — but the logged-out state is
    simply unhandled in the agent's ACP layer: auth is checked at spawn
    and at session/new only; the prompt path has no auth handling at all
    (consistent with the "does not support authenticating over ACP"
    stance). The precise 4m39s (279s) smells like an internal
    retry/timeout budget, not a decision. Candidate addition to the
    TKT-66153 thread.
  - Patchbay defense (policy, all agents, not auggie-gated): patchbay's
    own logout disconnects every process for the agent
    (orchestrator.logoutAgent) — a process that has held credentials is
    never trusted to shed them. Moot for auggie specifically (no
    `auth.logout` to offer, so the control never shows) — the exposure
    here is out-of-band logout, which only a process restart clears.
- **Permission declines persist globally and durably** (on-disk evidence
  2026-07-14): `~/.augment/settings.json` `indexingDenyDirs` carried
  `/tmp/acp-cancel-test/ws` — a patchbay throwaway test dir whose
  session's "Workspace Indexing Permission" was auto-declined. A
  session-scoped answer written as permanent global config is the same
  scope-latch family as the mcpServers bug: consent broadened past the
  session that gave it. Client consequence: auto-declining a probe
  session's indexing question mutates the user's global auggie config —
  patchbay's probe etiquette (auto-decline, never grant on the user's
  behalf) is still right, but the decline should be scoped once auggie's
  options allow it; worth checking which reject kinds auggie actually
  offers on that request. Also noted the same day: a broad `/opt` deny
  entry covering the live workspace — origin not pinned down, listed here
  so a future indexing-related stall checks this file first (and see the
  next bullet: that entry also defeated the workspace's exact allow).
- **Ancestor deny overrides exact allow in indexing config** (observed
  live 2026-07-14, v0.32.0): `~/.augment/settings.json` carried
  `/opt/vscode-extensions` in `indexingAllowDirs` *and* `/opt` in
  `indexingDenyDirs` — and `codebase-retrieval` against
  `/opt/vscode-extensions` failed with *"This directory is in your
  indexing deny list and cannot be indexed."* The resolver walks
  ancestors on the deny side without letting a more specific allow entry
  punch through, so an explicitly allowed workspace is unindexable while
  the config plainly says it's allowed. Broken precedence: an exact
  allow is the user's explicit consent for that directory and should win
  over a broader ancestor deny (most-specific-rule-wins, the standard
  allow/deny resolution order). Consequence compounds with the previous
  bullet: auto-written deny entries land in this same global file, so a
  single broad decline can silently disable indexing for workspaces the
  user separately allowed. Fixed locally by removing `/opt` from
  `indexingDenyDirs` (2026-07-14). Vendor-reportable; product config
  bug, not ACP-layer — separate from the TKT-66153 thread.

- **Proprietary render directive in message text** (wire-verified
  2026-07-14, v0.32.0): agent message chunks wrap code excerpts in
  `<augment_code_snippet path="…" mode="EXCERPT">` around a normal fence,
  closed with `</augment_code_snippet>` — Augment's own client renders this
  as an excerpt card; every other ACP client shows the tag as literal text
  (markdown renderers with raw HTML off — the safe default — pass unknown
  tags through as prose). **Authored by the model, not by any tool:**
  across a full session store the tag appears 9× in assistant
  `response_nodes` and 0× in any tool result, including runs where
  `codebase-retrieval` wasn't even attached (`Tool codebase-retrieval not
  found`) and the model read files via `view` — so it's the system
  prompt's presentation convention, emitted on any wire including ACP.
  Recommendation for the vendor report: an ACP-bound agent should suppress
  client-proprietary output conventions on the protocol wire — ACP message
  content is plain markdown by contract, and a directive only one client
  can render is noise on every other. Patchbay honors rather than strips
  it: `extensions/augment-code-snippet.ts` (streaming rewriter — chunk
  boundaries can split the tag) drops the wrapper and hoists `path`/`mode`
  onto the fence info string, which the chat code block renders as a
  file-path caption + EXCERPT badge, vendor-free. Candidate addition to
  the TKT-66153 thread.
- **Model surface:** graduated to Compliance issues 2026-07-13 (§ Model
  selection rides a removed draft API) once the June 1, 2026 upstream
  removal notice was found — the earlier benefit-of-the-doubt read
  ("preview/fork surface") turned out precisely right: it *was* a draft,
  never stabilized, since removed.
- **Replay carries no messageId and no interruption trace** (wire-verified
  2026-07-12): `user_message_chunk`s arrive id-less, one whole message per
  chunk; a cancelled turn's exchange is stored `completed: false` with an
  empty response and replays as nothing at all — adjacent cancelled prompts
  arrive as back-to-back user chunks. Patchbay renders them as separate
  bubbles (id-less chunks never merge — the message-boundary rule); the
  cancellation itself is unrecoverable from this wire — upstream ask if
  replay-visible turn resolution ever matters.
- Requests a "Workspace Indexing Permission" on fresh sessions — patchbay
  auto-declines it on probe sessions (probe etiquette: never grant on the
  user's behalf).
- When the marker tool was unavailable (repro run 3), auggie answered the
  prompt using its built-in tools without flagging the missing server —
  absence of a configured MCP server is invisible to the user unless asked
  directly.

## Communication log

- **2026-07-13** — combined compliance report **submitted as TKT-66153**,
  covering both open issues: (1) the mcpServers first-session latch —
  re-verified same day with a fresh marker-server capture, named the
  higher-impact fix; (2) model selection on the removed draft API (root
  `models` field + `session/set_model`, no confirmation channel) — asks
  migration to Session Config Options. Plus one rider request (spec-legal
  omission, not a compliance issue): emit `ContentChunk.messageId` — or
  minimally confirm agent/thought replay granularity, the fact that decides
  whether patchbay's id-less merge rule (`runBlockFor`) can tighten for
  replay. Full text + verbatim wire transcripts:
  [the compliance report](reports/auggie-acp-compliance-2026-07-13.md).
  Awaiting vendor response.
