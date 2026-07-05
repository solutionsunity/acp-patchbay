# Changelog

## Unreleased

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
