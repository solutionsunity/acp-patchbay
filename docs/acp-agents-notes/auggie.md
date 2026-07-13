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
  [auggie-acp-compliance-report.md](auggie-acp-compliance-report.md).
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
  ([auggie-acp-compliance-report.md](auggie-acp-compliance-report.md),
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
  Verbatim transcript in [auggie-acp-compliance-report.md](auggie-acp-compliance-report.md).
- **Impact:** generic ACP clients show no model selector at all; clients that
  adopt the legacy surface cannot display honest state — nothing on the wire
  ever confirms the active model (`currentModelId` is readable only at
  session-open, where it is `""`; empty sessions aren't persisted, so no
  reload-reconfirm either).
- **Patchbay workaround:** adopted 2026-07-13 as a scoped wire-extension
  (architecture.md § Protocol extensions): knobs.ts `sessionModelsOf` /
  `withModelField` parses the field at the trust boundary (zod,
  degrade-to-absent) and synthesizes one "model" knob — deduped by id, so an
  agent whose configOptions already carry model (claude-agent-acp) never
  collides. Sets ride `session/set_model` via pool.ts `setSessionModel`,
  outside the capability-tracked path. Display is advanced optimistically
  from the user's own pick (knobs.ts `applyModelSet`) — the sole fact in
  existence on an axis with no confirmation channel; the one deliberate
  exception to display-from-agent-state, scoped here. **Retire when Auggie
  migrates to configOptions** — the draft surface is removed upstream, so it
  will never appear in any SDK; vendor migration is the only exit.
- **Status:** observed 2026-07-12 → report drafted 2026-07-13
  ([auggie-acp-compliance-report.md](auggie-acp-compliance-report.md)), pending send.

## Capability gaps

- `mcpCapabilities` absent (no http/sse): honest — auggie takes stdio
  servers only, so integrations ride patchbay's stdio-to-HTTP bridge. Not an
  issue; recorded so nobody mistakes the bridge fallback for a patchbay
  limitation.
- `session.resume` undeclared; `session.load` declared (replay works).

## Behavioral notes

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
  bubbles (G12 rule: id-less chunks never merge); the cancellation itself is
  unrecoverable from this wire — upstream ask if replay-visible turn
  resolution ever matters.
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
  [auggie-acp-compliance-report.md](auggie-acp-compliance-report.md).
  Awaiting vendor response.
