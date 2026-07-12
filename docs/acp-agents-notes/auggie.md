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
- **Patchbay workaround:** none yet. Planned: defer the connect-time probe
  until after the first real session for quirk-listed agents (giving the
  probe session real servers is worse — the process-wide latch would bind
  all later sessions to the probe's stale editor-server session token).
- **Status:** observed 2026-07-12 — not yet reported.

## Capability gaps

- `mcpCapabilities` absent (no http/sse): honest — auggie takes stdio
  servers only, so integrations ride patchbay's stdio-to-HTTP bridge. Not an
  issue; recorded so nobody mistakes the bridge fallback for a patchbay
  limitation.
- `session.resume` undeclared; `session.load` declared (replay works).

## Behavioral notes

- Requests a "Workspace Indexing Permission" on fresh sessions — patchbay
  auto-declines it on probe sessions (probe etiquette: never grant on the
  user's behalf).
- When the marker tool was unavailable (repro run 3), auggie answered the
  prompt using its built-in tools without flagging the missing server —
  absence of a configured MCP server is invisible to the user unless asked
  directly.

## Communication log

- *(empty — first report pending)*
