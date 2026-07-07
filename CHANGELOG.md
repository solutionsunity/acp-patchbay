# Changelog

## Unreleased

- The Patchbay Output channel now shows the extension's actual life (owner:
  "we don't have much showing at OUTPUT"): a vscode-free `Logger` seam
  (src/orchestrator/logger.ts, no-op in tests) injected into the pool,
  session manager, capability tracker, and integrations manager. Info level:
  agent spawn/initialize (name, version, protocol), session lifecycle
  (created/reopened), non-`end_turn` stop reasons, integration connects/
  removals, probe auth_required. Debug level (Output panel's own level
  switch): the agent's stderr live (previously invisible until a crash),
  session/new-fork-load ids, cache seeding, probe failures, mcpServers
  served per agent. no-secret-exposure applies to logs: argv contents and
  env values are never logged (users embed keys in args and URLs) —
  executables, env key names, hosts, ids, and counts only.
- Form layout rebuilt as proper label|control rows (owner: "layout is way
  broken"): every form — custom MCP add, JSON import, JSON edit, catalog
  connects, agent ✎ Edit — is now a column of grid rows (140px label column,
  right-aligned, control beside it), actions in a footer row, notes aligned
  under the controls. The wrap-flex layout that made single-line inputs
  stretch into textarea-looking boxes is gone.
- ui-rendering-strategy.md adopted as the decided webview direction (P13 in
  plan.md, four sub-phases): one shared component layer (shadcn source-copied
  on Radix, Codicons only, a single VS Code-theme bridge) and the chat
  transcript pipeline (Streamdown markdown on the already-built ordered block
  model). The strategy doc now records the two decisions it forced — webviews
  move Preact→React (the cornerstone deps are React-native; Preact's
  zero-toolchain rationale evaporated with Tailwind entering — re-derived per
  the house rule, not carried) and Tailwind v4 alongside esbuild — plus the
  built-vs-net-new inventory, the 3-group-nav and declared-vs-used
  corrections, and the CSP stance (authored by us, never widened silently).
  stack.md, plan.md § Toolchain, architecture.md § UI layer, and ui.md all
  cross-reference the same decision.
- MCP Servers polish (owner testing). The dark-theme "yellowish" inputs were
  unstyled `password`/`textarea` elements falling back to browser defaults —
  every control now uses VS Code's own input theme variables
  (`--vscode-input-*`), including the Chromium autofill override and a real
  focus ring. Forms gained labeled fields (a shared `Field` component:
  label above control, hint on hover) across custom add, URL auth, and
  catalog connects. The active checkbox is a real toggle switch. Destructive
  actions confirm in place — a two-step arm/confirm button (4s auto-disarm)
  on server Disconnect/Remove and agent Remove; one-click-recreatable
  deletions (a command rule) deliberately don't prompt. The shared add form
  resets on every entry-point transition, so a half-filled local prefill
  from an earlier detour never leaks into a fresh add (owner-caught bug).
  Routing is now labeled as what it decides — `reaches:` "fully-brokered
  agents (auto)" vs "only these agents:" — with the auto semantics spelled
  out on hover.
- Figma is back in the catalog — the removal is superseded (owner pointed at
  Figma's remote-server docs; re-verified). The remote stays honestly
  not-connectable: Figma gates it on their MCP client *catalog* ("only
  clients listed... can connect", new clients join a waitlist) — VS Code
  being listed covers VS Code's own OAuth client, which patchbay, as its own
  MCP client, does not inherit by running inside it. What IS open is the
  desktop app's local Dev Mode server (`http://127.0.0.1:3845/mcp`), so the
  registry `local` field gained an http variant alongside stdio, the Figma
  row offers "run it locally" (prefilling the +URL form, no auth), and a
  catalog row with a gated remote but a verified local server now shows
  `Connect…` instead of a dead "not connectable yet" chip.
- MCP Servers, round two (owner notes). Custom adds are structured — display
  name, command, args one-per-line, env `KEY=value` lines — and the id field
  is gone: ids are generated (slug of the name, uniquified); they're the
  storage key, an internal concern. `Import JSON…` accepts the well-known
  `{"mcpServers": {...}}` shape (per-entry validation, failures labeled and
  dismissible, env values straight to SecretStorage), and custom entries
  gained `Edit JSON…` — the same fragment back, env values write-only (`""`
  keeps, filled overwrites, removed deletes), so a secret never rides a
  webview snapshot. An in-flight browser OAuth can now be cancelled (an
  abandoned tab used to mean forever-"Connecting…"): cancel clears with no
  outcome invented — new `integrationConnectResolved` event — and a
  10-minute timeout backstops it; the abandoned flow's eventual result is
  dropped, never stored. Curated key entries show a `Get a key ↗` link to
  the issuing page (new registry `keyUrl`); the per-account URL field is
  labeled as what it is — the account's own MCP endpoint (Supabase/Augment
  ship no fixed URL), used by both connect paths, not an "OAuth URL". And
  the catalog now offers verified official *local* stdio servers — GitHub
  (github-mcp-server via Docker), Stripe (@stripe/mcp), Sentry
  (@sentry/mcp-server), Supabase (@supabase/mcp-server-supabase), Augment
  (auggie --mcp) — as a "run it locally" prefill into the custom form;
  nothing runs until the user adds it. Postman and Stitch stay remote-only:
  no official local server verified.
- MCP Servers page rework (owner review: layout unclean, lifecycle
  half-baked — both confirmed). The section is renamed "MCP Servers" (they
  are MCP servers; internally the record type stays `integration` because
  the ACP SDK owns `McpServer` for the wire config — term contract in
  architecture.md § Terms). Root cause of the layout: `.connect-form` had
  no CSS anywhere — every form on the page rendered unstyled; now defined
  once for all forms. Page reordered working-set-first: connected servers
  (with the new **active/inactive** toggle — the mute switch: credential
  kept, nothing routed), then Add custom, then the curated catalog as
  compact one-line rows expanding one at a time into a connect form that
  presents key paste `— or —` OAuth as the alternatives they are.
  Lifecycle per owner's model: **disconnect is the full clear** (credential
  + env + config; a curated entry reverts to the catalog ready to
  reconnect, a custom one is gone) — replacing the old credential-only
  disconnect whose "reconnect later" promise had no UI path at all (the
  one-way-door hole this review found). No third state survives: custom
  OAuth now connects *before* storing (cancelled consent adds nothing),
  and a header-auth custom add requires its key (was silently creating a
  stranded credential-less record). Figma removed from the registry
  (owner call — no mechanism open to us today, nothing honest to offer);
  a failed key-connect no longer wipes the typed key.
- Agent-card knobs fixed at the root (owner report: model/mode/effort all
  "not offered"). Two causes. First, the card required ACP's `category`
  field to recognize options — the spec marks category UX-only ("MUST NOT
  be required for correctness. Clients MUST handle missing or unknown
  categories gracefully."), so any agent omitting it showed nothing. Knobs
  now render exactly what the agent offered — the mode selector plus one
  select per config option, keyed by the option's own id, category only
  decorating the icon — and per-agent defaults are stored id-keyed
  (`defaults.options`; the old semantic {model, effort} keys are dropped on
  read, `mode` unchanged). `applyDefaults` sets by id with no category
  lookup; the defaults test now proves it against a category-less option.
  Second, never-observed and observed-but-absent were collapsed into one
  "— not offered" label: before the first session the card now says
  "session knobs appear after the first session with this agent" instead.
- Stat tiles size to their content (were pinned narrow), and Add Agent is
  now a tile-shaped button riding the same row — same box as the counters,
  accent ＋, hover lift — replacing the detached button.
- Settings nav grouped into three non-collapsing headers that state the
  placement contract: **This machine** (Agents · Capability matrix ·
  Integrations), **Trust** (Permissions), **This workspace** (Rules · skills
  · commands) — the nav teaches global-vs-workspace instead of captioning it.
- Command rules gained a machine layer: a second rule list in `globalState`
  (`MachineRulesStore`) as the fallback floor for every workspace on this
  machine ("allow `npm test` everywhere"), with the workspace list evaluated
  first so a repo's own rules can tighten or loosen that floor — and no rule
  anywhere still means ask. Neither layer ever rides the repo, preserving
  the cloned-repo-can't-arrive-pre-authorized invariant. Permissions renders
  the two layers as twin cards sharing one component so they can't drift.
  Along the way, features.md's stale "Configuration as files" section
  (repo-shareable workspace config — a design removed earlier) was
  corrected to the global-stores reality.
- The SecretStorage env treatment covers custom-stdio MCP integrations too
  (owner question: "does this apply to MCP as well?"): the generalized
  `SecretEnvStore` (stores/secret-env.ts, one instance per record family)
  replaces the agent-only store; the integration config schema carries no
  env, values ride the add action once into SecretStorage, are read at
  attach time in `mcpServersFor`, and are purged on remove. The custom
  stdio add form gained the env textarea (KEY=value per line) with an
  honest note that values are handed to the agent only when it spawns the
  server — inherent to the ACP model, where the agent, not patchbay,
  spawns stdio servers. Confirmed already-safe: HTTP/registry integration
  credentials never ride agent-visible config — the bridge subprocess
  IPC-fetches its token from the orchestrator at runtime.
- Agent launch env values now live in SecretStorage (no-secret-exposure.md:
  env vars are how agents commonly take API keys, and globalState is for
  non-sensitive config only). The config store keeps key names only; webview
  state snapshots carry names only (`AgentConfigView.envKeys`), and the ✎
  Edit form is write-only — existing vars render as bare `KEY=` lines
  (blank keeps the stored value, filled overwrites, deleting the line
  removes the variable), so a value never travels back to a webview. The
  full record is read fresh from SecretStorage once per connect and joined
  onto the LaunchSpec at spawn (`connectAgent`, the single injection point);
  registry-declared launch env is written into the same record on add, and
  Remove purges it with the agent's other per-agent facts.
- Settings audit round (owner-directed). Command lines are now parsed
  quote-aware everywhere: a custom-stdio integration's typed line used to be
  stored whole as the executable with empty args (any command with arguments
  was broken on spawn), and the agent ✎ Edit form used a naive whitespace
  split — both now route through the house `parseCommandLine`, orchestrator-
  side (render-only-webview: the form sends the raw line), with unterminated
  quotes failing labeled instead of silently. Note on spawning itself: agent
  processes are spawned directly via Node `child_process` (VS Code has no API
  for background protocol subprocesses — its Tasks/Terminal APIs create
  user-visible terminals), and custom-stdio MCP servers are never spawned by
  patchbay at all — the config is handed to the agent, which spawns them.
- Agents and integrations are now global-only, code and copy in agreement:
  the vestigial `scope` machinery (stores/scope.ts, `visibleIn` filters, the
  per-record scope field) is deleted, and the Integrations section no longer
  claims workspace scoping the stores never enforced. The MCP incident that
  shaped the old rule (a production-access server silently following a user
  between repos) stays guarded where the risk lives — a shared config never
  carries its credential — and is recorded in the docs as the rationale;
  workspace binding (workspaces, not repos) is noted as a potential future
  opt-in, deliberately unbuilt.
- Settings § Agents ✎ Edit: dropped the free-text default model/mode/effort
  inputs (the card's knob selects own those, offering only what the agent
  actually offered) and gained env-var editing (KEY=value per line) with an
  honest storage note. Matrix cells got consequence tooltips (ui.md's spec —
  e.g. "without it, branching is emulated"); custom integration cards show
  their command/URL mono; Share config confirms with a native toast; the
  "connected" stat tile is relabeled "agents" (it always counted stopped and
  crashed ones too).
- Remove agent now actually removes the agent: `removeAgentConfig` used to
  delete only the persisted config — the process kept running and the
  `agentRemoved` event, though defined with reducers since P1, was emitted
  nowhere. Remove is now stop + forget: `pool.stopAllFor` takes down the
  primary connection and every process-policy isolated instance reporting
  as that agent, live sessions are invalidated, `agentRemoved` clears the
  agent from both channel states, and its per-agent facts (used-capability
  cache, observed-knobs cache) are purged so a re-add starts honest. The
  session index is deliberately untouched — patchbay's own record of
  sessions that happened.
- Observed knobs (Settings § Agents' default model/mode/effort selects) now
  survive extension-host restarts: the offerings were held in a memory-only
  map, so every reload showed "— not offered" until the next session with
  that agent. They now persist version-keyed in `globalState`
  (`stores/agent-knobs.ts`), mirroring the used-capability cache's lifetime
  rule — seeded on startup while `agentInfo.version` still matches, dropped
  honestly the moment a connect reports a different version.
- Owner-directed terminology and centralization pass on the capability matrix:
  the "verified" state is renamed "used" throughout (`CapabilityCell.used`,
  `CapabilityState`, the `capabilityUsed` event, `hasUnusedProbe`) — a single
  successful round-trip proves a path fired, not that it's certified correct,
  and "verified" overclaimed the latter. Marking a row used — previously
  split between `capability-verifier.ts`'s probe and separate direct emits in
  `session-manager.ts` — is now fully centralized in `pool.ts` (the sole
  channel that already talks to every agent on the wire) via one
  `onCapabilityUsed` hook, called synchronously and never awaited at the
  exact point each RPC succeeds (`newSession` → `auth`, `fork` →
  `session.fork`, `loadSession` → `session.load`) or a notification's kind
  tag arrives (`usage_update` → `usage`), alongside the existing
  `hadOtherSessions` → `concurrentSessions` checks. `capability-verifier.ts`
  is renamed `capability-tracker.ts` (`CapabilityVerifier` →
  `CapabilityTracker`, `markVerified` → `markUsed`) and no longer marks
  anything itself — only decides when to run the synthetic probe and
  persists what pool.ts reports. `stores/verified-capabilities.ts` is
  renamed `stores/used-capabilities.ts` (`VerifiedCapabilityStore` →
  `UsedCapabilityStore`, storage key `acpPatchbay.usedCapabilities` — a
  one-time reset of the persisted cache, not migrated). The Settings matrix
  now states above the table that rows are hand-picked against the ACP
  spec's declared capability surface, not derived automatically.
- Owner-feedback round on Settings § Agents: `+ Add Agent` moved beside the
  stat tiles as a collapse toggle (open by default only with zero agents);
  the Add Agent card is one mode at a time behind a toggle (searchable
  roster combobox, or a custom command — never both half-filled) instead of
  a single crowded row. The manual `Verify…` control now gates on
  `hasUnusedProbe` (protocol.ts) — the same predicate the automatic
  connect/reconnect retry uses (capability-tracker.ts's `onDeclared`),
  replacing what used to be two independent guesses at "does this still
  need a verify" with one; it dims and reads `Verifying…` while a round trip
  (manual or "Verify after add") is in flight, via new
  `agentVerifyStarted`/`agentVerifyFinished` settings events.
  `architecture.md` § Agent capability matrix and the `capability-
  verification.md` rule were also corrected — both still described the state
  as resetting on every reconnect, stale since it became version-keyed.
  Separately: a `Patchbay` Output channel now exists (`vscode.window.
  createOutputChannel(..., { log: true })`) — agent status transitions,
  Verify runs, and previously-silent action failures (restart, branch,
  reload, sendPrompt, authenticate) now log there instead of vanishing.
- Post-audit round (owner-directed): image paste now sends a real
  `ContentBlock::Image` only where `promptCapabilities.image` is declared
  and otherwise falls back to a temp-file `ResourceLink` — the baseline
  every agent must accept, so paste is never disabled *and* never sends a
  block the agent didn't sign up for (architecture.md's original contract,
  now honored by code). The plan strip strictly mirrors agent reports: a
  transcript reset clears it so `session/load` replay alone rebuilds it,
  and the never-emitted `planCleared` event is gone. The remaining
  ui.md-bound controls are built: composer selection ghost chip (appears
  only while the IDE has a live selection; click solidifies it) and the
  `@` context mention picker (open editors + selection/problems/attach —
  standard content blocks, every agent); a chat crash banner with
  one-action Restart; Settings stat tiles (connected/running/sessions
  today), full per-agent cards — launch command, Stop, crashed note +
  Restart, process-policy select stating auto's reason, and default knobs
  enabled only where that agent has actually offered the knob (a new
  settings-side projection of observed session options); the diagnostics
  cost-disclosure modal (today's honest cost: zero agent turns); and the
  explicit plug-in confirmation when routing an integration onto a
  less-than-fully-brokered agent.
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
  `session/fork` when the capability is *used*, otherwise an emulated
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
  connection kind for isolated instances, and `concurrentSessions` now also
  gets marked used from a successful fork (a fork's parent is
  always already on the connection, so it's the same proof by construction)
  — which is what lets "auto" bootstrap toward sharing without ever risking
  a not-yet-used `session/new`. A fork always rides its parent's connection
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
- P5 capability matrix + verification: full declared/used matrix
  (architecture.md's row list) per agent, replaced wholesale on every
  (re)connect so used always resets on reconnect; fidelity label
  (fully/partially brokered, acts outside) as a pure function of the matrix
  plus roster-sourced known-bypass data; Settings' matrix table with legend,
  reset-time chip, and the patchbay-side asset-location row; fidelity chip +
  capability one-liner in the Agent View's Agents drawer; a usage gauge that
  appears only once usage reporting is used. Checks wired to
  what's actually buildable today: an automatic, free session/fork round-trip
  in an ephemeral temp-dir session on every connect, plus opportunistic marks
  on first `usage_update`, first successful `session/load`, and a second
  concurrent `session/new`. fs/terminal/elicitation/MCP-transport marking
  stay honestly declared-but-not-used until P6/P7/P9 give them
  real handlers to exercise — scoping note added to plan.md rather than
  faking the remaining rows. Diagnostics action re-runs the free check on
  demand; behavior-level probes activate once there's something real to run.
  Pulled the check-orchestration logic into a standalone `CapabilityTracker`
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
