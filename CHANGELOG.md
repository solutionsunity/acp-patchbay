# Changelog

## Unreleased

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
