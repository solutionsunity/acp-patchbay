# Changelog

## Unreleased

- Final pre-publish audit: wired the opportunistic fs/terminal capability
  verification that P5 deferred to P6's handlers but was never actually
  connected — without it no agent could ever reach "fully brokered" (every
  agent showed "acts outside", and `auto` integration routing could never
  attach to anything). First live-buffer read, first gated write (rejected
  counts — a rejection is the broker working), and first accepted terminal
  now verify their rows, covered by a new end-to-end test-electron case.
  The automatic fork probe no longer leaves its two throwaway sessions in
  the connection's session set (they read as real concurrent sessions to
  process-policy `auto` and could force needless isolation of the first
  real session). Chat blocks no longer clip when the transcript outgrows
  the view (`.card`'s `overflow: hidden` let flex compress them —
  permission buttons rendered half-visible; caught by the screenshot
  pass). Stale device-flow references in features.md/ui.md aligned to the
  recorded P9v2 auth decision.
- P9v2 integrations auth, per docs/reference-mcp-oauth.md (supersedes the
  Device Flow design): two mechanisms replace the per-service OAuth-App
  route entirely. (1) Static key in a configurable header — the v1 floor
  for every integration; `headerName`/`valuePrefix` are per-integration
  data (GitHub PAT rides `Authorization: Bearer`, Stitch's key rides
  `X-Goog-Api-Key` raw), and the bridge receives the shape via env.
  (2) MCP-spec OAuth 2.1 (`mcp-oauth.ts`): RFC 9728 protected-resource
  discovery → RFC 8414 auth-server metadata → RFC 7591 dynamic client
  registration → Authorization Code + PKCE — URL-only, no pre-provisioned
  credentials; refresh context (discovered token endpoint + issued client
  id) travels with the token in SecretStorage. The browser redirect uses
  registerUriHandler + asExternalUri — resolved correctly under SSH
  remote/WSL/Codespaces by construction, never a raw loopback server (the
  documented failure mode that motivated Device Flow originally). Gated
  DCR (Figma-style client_name allowlists) fails immediately with a
  labeled error pointing at the key path — never a hang.
  `oauth-device-flow.ts` removed; the "create a GitHub OAuth App" owner
  touchpoint is gone with it. data/registry.json now ships the curated
  eight — GitHub, Figma, Stitch, Stripe, Sentry, Postman, Supabase,
  Augment Context Engine — each with only the mechanisms its vendor
  actually opens (Figma remote is visible-but-not-connectable, with its
  Desktop-MCP stdio alternative named; Supabase/Augment take a user-pasted
  per-account endpoint). Settings' registry cards grew key-paste and
  OAuth connect paths, docs links, and per-entry honesty notes. Tested
  against a fake spec-compliant OAuth provider that genuinely verifies
  S256 PKCE and can gate DCR (test/support/fake-oauth-provider.ts).
- P12 marketplace pack: a real README (was a 9-line stub); `vsce package`
  dry run is clean (145.96 KB, 15 files, no warnings) — the rest of the
  Marketplace checklist (repository, categories, keywords, icon, license,
  publisher) was already in place from P0. A final features-inventory pass
  found and closed real gaps: a Stop button for running agents and a full
  add/edit/remove form for workspace agent launch config in Settings (both
  reusing backend methods that existed since P1/P2 but were never wired to
  a control), a right-click "Add Selection to Patchbay Context" editor
  command, and three features.md bullets — image paste, file attach, and
  context roots — that were explicitly deferred at P7 but never assigned a
  landing phase since. All three now real: image paste and file-picker
  attach ride the existing context-chip mechanism (a new "image" chip kind
  sent as a genuine `ImageContent` block; file attach reuses the same shape
  as "add current file"); context roots plug into ACP's own
  `additionalDirectories` field on `session/new`/`/load`/`/fork`, tracked
  per session, honestly reaching the agent only on the next reload/branch
  since the protocol has no live-update request for it. Fixed a real
  pre-existing bug surfaced while wiring roots through `reopen()`:
  reconnecting a crashed session via `session/load` never re-attached the
  local MCP server or any integrations at all — silently regressing P7/P9's
  depth story after every crash+reload.
- P11 native surfaces + native settings: a status bar item mirroring the
  active session's title, agent health glyph, and usage percentage once
  reported (absent, never a fake 0%, until then) — click focuses the Agent
  View. Command palette gained New Session, Switch Session, and Connect
  Agent (QuickPicks over running agents / all sessions / roster + custom
  command), alongside the existing Open Settings. `acpPatchbay.defaultAgent`
  (VS Code native settings) connects a configured agent once, only when
  nothing is connected yet — the user's own choice, never patchbay routing.
  Verified (by inspection, no new code needed) that all three permission-ask
  paths already share one native-notification hook since P6. Deliberately
  dropped "telemetry opt-in": this project sends no telemetry anywhere, so a
  toggle for it would gate nothing — recorded as a scope call in plan.md,
  not silently skipped. `ChannelHost` gained a small `onChange` subscription
  so native surfaces (just the status bar today) can react to canonical
  state without being a webview; the status bar's own text/tooltip
  formatting (`status-bar.ts`) is vscode-free and unit-tested.
- P10 rules/skills/commands management: a real Settings section listing each
  connected agent's rules/commands/skills files, resolved from the roster's
  location mapping against what's actually on disk in this workspace — a
  single file for rules, every file inside the directory for commands/skills.
  An unmapped agent (most of the roster — v1 only maps Claude Code and
  Augment) renders an honest "not mapped" per category rather than being
  silently skipped. Clicking a listed file opens it in VS Code's own editor;
  patchbay never reimplements editing in the webview (v1 is management, not
  delivery — no symlinks, no supply). Resolution logic
  (`asset-locations.ts`) is vscode-free behind a small structural `FsLike`,
  unit-tested against a fake in-memory filesystem.
- P9 integrations + GitHub (mechanism complete; blocked on the two named
  owner touchpoints — OAuth App creation, Augment live smoke): curated
  (registry) and custom integrations are the same mechanism throughout —
  MCP servers routed per agent, "auto" (fully-brokered only) or an explicit
  pinned list. A real OAuth Device Flow client (RFC 8628 — device code
  request, poll with authorization_pending/slow_down/access_denied/
  expired_token handling, refresh) against `data/registry.json`'s GitHub
  entry, whose `deviceCodeUrl`/`tokenUrl` are GitHub's own stable public
  endpoints but whose `clientId`/`url` stay empty — both bound to the OAuth
  App the owner touchpoint creates, so connecting is inert, never guessed,
  until then. A real stdio-to-HTTP bridge subprocess (`integration-bridge.js`,
  a 5th esbuild bundle) is the "just another local MCP server" presentation
  for both registry and custom-http integrations — a transparent JSON-RPC
  proxy that fetches a current token from the orchestrator over the same
  IPC channel P7 built (extended, not duplicated) and retries once on a 401.
  Proven end-to-end with a real subprocess chain: fake ACP agent → real
  bundled bridge → fake remote MCP server's `list_issues` tool, including the
  retry path — the automated stand-in for the gate's "routed agent lists
  issues via MCP," honestly short of the real GitHub connection the owner
  touchpoint alone can exercise. Custom-stdio integrations skip the bridge
  entirely (handed straight through, no auth concept). Credentials live only
  in a new `IntegrationTokenStore` (SecretStorage, `SecretsLike` structural
  interface so it's fakeable in tests) — routing and source config live in
  `.vscode/acp-patchbay.json` (workspace-scoped by construction), and the
  config schema carries no credential field at all. "Share" is a clipboard
  copy of the sanitized config entry; a pasted entry shows as configured-but-
  disconnected until its own workspace explicitly connects it — workspace-
  scoped SecretStorage makes credential-following impossible without extra
  machinery, per the incident features.md records. Settings gained a real
  Integrations section (registry connect card with live device-code/
  verification-URL display, per-integration routing checkboxes, custom-add
  form, disconnect/remove/share).
- P8 sessions advanced: a real session graph — branching produces a native
  `session/fork` when the capability is *verified*, otherwise an emulated
  continuation seeded from the parent's current transcript, either way a
  labeled node (`branchOf`/`emulated`) the UI never has to reason about
  mechanism-wise. One-click reload re-runs `session/load` replay on demand,
  distinct from the automatic reopen-on-crash path. Agents without
  `session/load` get a persisted last-known view (JSON per session in
  workspace storage) as the seed for an automatic emulated continuation when
  their connection dies — previously a hard failure, now the fallback
  architecture.md always intended. Model/mode/effort knobs render only the
  options an agent actually offers (`session/new`/`load`/`fork` responses,
  refreshed by `current_mode_update`/`config_option_update` notifications),
  display only ever updated from the agent's own confirmation — never a
  set-request's response, matching the same distrust-the-response rule P6
  and P5 already established. Per-agent defaults (already-scaffolded config
  file fields since P1) apply once, post-create. Process policy
  auto/shared/isolated is real: `AgentPool` gained a second, invisible
  connection kind for isolated instances, and `concurrentSessions`
  verification now also fires from a successful fork (a fork's parent is
  always already on the connection, so it's the same proof by construction)
  — which is what lets "auto" bootstrap toward sharing without ever risking
  an unverified `session/new`. A fork always rides its parent's connection
  regardless of policy (protocol fact, not a choice). Five scoping calls
  recorded in plan.md. Kebab menu gained Branch/Reload (labeled
  `native fork ✓`/`emulated`); composer gained the knob pills — both caught a
  pre-existing popover-positioning bug via visual verification, fixed
  alongside since it directly affects the menu this phase extends.
- P7 local MCP server + adapters: a real stdio MCP server
  (`src/mcp/server-main.ts`, bundled as its own entry) exposing six tools —
  get_selection, get_current_file, get_diagnostics, get_open_editors,
  get_workspace_state, request_user_input — passed to every session via
  `mcpServers`. Since the agent spawns this process (not patchbay), it can't
  reach vscode APIs directly; a small IPC bridge carries tool calls back to
  an orchestrator-side host with real editor access, correlated by a token
  patchbay mints before the real sessionId exists (session/new hasn't
  returned one yet when `mcpServers` must already be in the request).
  Tools-only design (no MCP resources) — one uniform path per capability,
  matching the "every agent sees just another local MCP server" bet.
  Elicitation ships as the `request_user_input` tool only; native ACP
  elicitation stays undeclared since the SDK marks it unstable/experimental.
  Explicit "add selection / current file / diagnostics to context" wired
  through the composer's adder, injected as their own labeled prompt blocks
  ahead of the user's message, cleared once sent. Scoped out as separate UI
  mechanisms rather than silently dropped: image paste, file attach,
  right-click actions, and context roots (`additionalDirectories`) — real
  features, not this phase's architectural bet. Recorded in plan.md.
- P6 permission broker + editor depth (fs/terminal): one broker path
  (`PermissionBroker`) for the agent's own `session/request_permission` calls
  and patchbay's own mandatory gates on `fs/write_text_file` and
  `terminal/create` — same command-pattern and file-write-scope rules, same
  decision-audit trail, allow-once/allow-always/reject everywhere. Real
  handlers land for `fs/read_text_file` (live VS Code buffer wins over disk),
  `fs/write_text_file` (LCS-based diff card, pre-gated, auto-accept still
  shows the diff), and the full terminal/* set (real child-process execution
  via a new `TerminalRunner`, live-streamed output card). A native
  `vscode.window.showWarningMessage` mirrors any pending card when the Agent
  View is hidden, wired to the webview's real visibility events. Repo-defined
  agents (`.vscode/acp-patchbay.json`) now require one-time, workspace-trust-
  gated adoption before connecting, surfaced in Settings' new Permissions
  section alongside command rules, file-write scope, and the decision audit
  tail. Extended the fake agent with real fs/terminal/permission-asking turn
  steps so the whole path is tested against genuine child processes and a
  temp filesystem, not mocks — including an automated "reject leaves disk
  untouched" case that's stronger than the manual smoke it stands in for.
- P5 capability matrix + verification: full declared/verified matrix
  (architecture.md's row list) per agent, replaced wholesale on every
  (re)connect so verified always resets on reconnect; fidelity label
  (fully/partially brokered, acts outside) as a pure function of the matrix
  plus roster-sourced known-bypass data; Settings' matrix table with legend,
  reset-time chip, and the patchbay-side asset-location row; fidelity chip +
  capability one-liner in the Agent View's Agents drawer; a usage gauge that
  appears only once usage reporting verifies. Verification triggers wired to
  what's actually buildable today: an automatic, free session/fork round-trip
  in an ephemeral temp-dir session on every connect, plus opportunistic marks
  on first `usage_update`, first successful `session/load`, and a second
  concurrent `session/new`. fs/terminal/elicitation/MCP-transport
  verification stay honestly declared-but-unverified until P6/P7/P9 give them
  real handlers to exercise — scoping note added to plan.md rather than
  faking the remaining rows. Diagnostics action re-runs the free check on
  demand; behavior-level probes activate once there's something real to run.
  Pulled the verification logic into a standalone `CapabilityVerifier`
  (mirrors `SessionManager`'s vscode-free, dependency-injected shape) so it's
  unit-testable against the fake agent.
- P4 chat vertical slice: session/new → prompt → streamed session/update →
  live transcript (text, thoughts, tool calls, plan cards, plan strip); stop
  turn; session index switch/rename/close (first prompt auto-titles an
  untitled session); slash-command autocomplete from
  `available_commands_update`; render cache rebuilt wholesale from
  `session/load` replay after an agent crash+restart, with a clear failure
  (not a silent stale-ID call) when the agent can't replay — emulated
  reseeding for that case is P8. Fixed a real hydration race along the way:
  the webview subscribed to channel updates in a `useEffect`, which runs
  after paint, so a snapshot arriving before the effect fired was silently
  dropped; the mount now subscribes synchronously before the first paint.
  Markdown renders as Preact vnodes (no `dangerouslySetInnerHTML`), so
  agent-authored text can't carry a live attribute or tag.
- P3 Agent View + Settings shells from the approved design: header/session
  row/chat/composer regions, agents + sessions drawers, connect-agent flow
  (roster or custom command), honest empty states; controls gate on state —
  no gauge, knobs, or fidelity chips before their data exists.
- P2 client pool + fake agent + roster: agent subprocess pool over the ACP
  SDK 1.x client API (crash detection, one-action restart, declared-table
  capture per connect, concurrent sessions on one connection); scriptable
  lying fake agent as the standing regression bed; data/roster.json from
  vscode-acp's defaults (credited) with Claude Code + Augment asset mappings.

- P1 protocol + orchestrator core: snapshot/patch channel machinery with
  ~30 ms coalescing and resnapshot-on-gap recovery; session index, decision
  audit (JSONL), workspace config (JSONC + zod), permission-rules stores.
- P0 scaffold: extension skeleton, three esbuild bundles (extension host,
  agent-view webview, settings webview), vitest + @vscode/test-electron wiring.
