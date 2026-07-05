# Changelog

## Unreleased

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
