# Changelog

## 0.82.0 — 2026-07-12

- New: MCP transport overhaul — the integration bridge is rebuilt on the MCP
  SDK's own transports, with `mcp.http` passthrough for agents that declare
  it and a connect-time tool probe shown right on the integration cards.
- Fixed: `session/load` replay could fuse two distinct messages into one
  chat bubble whenever nothing else separated them — most visibly, a
  cancelled turn followed by the next prompt. Replay now follows the
  protocol's own message identity (`ContentChunk.messageId`) instead of
  guessing from block type alone.
- Chunk-rendering sweep: blank "Thought" accordions from whitespace-only
  replay chunks are gone, non-text thought content no longer drops
  silently, and `resource_link` content renders for real (inline `@name`
  mentions in prompts, markdown links in agent replies).
- Bumped the ACP SDK to 1.2.1 and declared the now-stable
  `session.configOptions` client capability — patchbay already supported
  boolean and select config options end to end; the wire claim now matches.
- Removed the retired capability-fidelity aggregate; auto agent routing
  now covers every connected agent, not just ones scored above a threshold.

## 0.8.9 — 2026-07-11

- Fixed: adding Codex (or any npx-distributed agent) could fail forever
  with "initialize failed: ACP connection closed" after one interrupted
  download — the launcher's package cache was left half-written and never
  healed. Patchbay now detects that exact failure, repairs the cache, and
  retries the connect once, automatically.
- The download phase can no longer cause that corruption in the first
  place: an aborted package download now cleans up after itself, and
  binary-distributed agents install atomically (a killed install leaves
  nothing behind).
- New: if the same CLI is also installed on your PATH (e.g. `codex` in
  your terminal) at a majorly different version than the one patchbay
  runs, a one-time warning points it out — both copies share the same
  sessions, auth, and config, so a wide gap between them is worth knowing
  about. Purely informational; nothing is blocked.

## 0.8.8 — 2026-07-11

- Logging in works for agents that hand the login to a terminal (the
  `_meta["terminal-auth"]` convention — Claude Code and Auggie both use
  it): the Log in button now opens the agent's own login flow in a
  VS Code terminal, and the agent's status re-checks itself when the
  terminal closes.
- When an agent requires login, its own instruction (e.g. "run `auggie
  login` from your terminal") now appears on the agent card and in the
  chat pane, instead of being dropped.
- Fixed: the connect-time capability check could leave an agent's own
  permission question (e.g. Auggie's workspace-indexing prompt) hanging
  unanswered against a hidden throwaway session — it is now declined
  automatically and re-asked in your first real session.
- Fixed: on Windows, npx-distributed agents failed to launch at all on
  current VS Code builds (Node refuses `.cmd` shims without a shell).

## 0.8.7 — 2026-07-11

- Sessions are now 100% the agent's own — patchbay stores no session
  history at all. The sessions list is read live from each agent's own
  `session/list`; closing, reopening, and switching sessions all read and
  write through the agent, never a local cache.
- An idle, fully-caught-up session frees its agent-side resources
  automatically; switching chats never closes anything, and a session
  that's new, busy, or has unread output is never touched.
- Reopening a session after a restart replays full history where the agent
  supports it, or reattaches context with a clear notice where it doesn't —
  never a guessed-at reconstruction.
- Session branching is removed for this release (it depended on the local
  session cache above); native session forking may return in a future
  release for agents that support it.
- Renaming a session now happens in the agent itself (e.g. a `/rename`
  command), for agents that support it.
- Fixed: reopening a past session could replay only its last portion
  instead of the full conversation.
- Fixed: stopping a turn could leave a pending permission request stuck
  showing as unresolved.
- Fixed: reading a file could ignore a requested line range and return the
  whole file.
- Fixed: an interrupted tool call could keep showing as in-progress after
  the turn was stopped.
- Fixed: very long terminal output could be cut off mid-character.
- Fixed: the chat pane could settle a few lines short of the true bottom
  after loading a past session.
- Non-text content from an agent (images, audio, embedded resources) now
  always shows a clearly labeled placeholder instead of silently vanishing.
- Slash commands now show their usage hint in the composer's command menu.
- Connecting to an agent now checks its protocol version up front and
  refuses a clear mismatch instead of failing unpredictably later.
- Performance: long chat transcripts render and scroll smoothly by only
  keeping recently-viewed messages fully rendered.

## 0.8.2 — 2026-07-09

First release.

- One sidebar for every connected agent, its sessions, and chat — switching
  agents or sessions is a single click.
- A capability matrix showing what each agent actually does, not just what
  it claims to support.
- Agents can see your current selection, open file (including unsaved
  changes), and editor problems, and can receive pasted images and attached
  files.
- One consistent permission system for commands and file writes, shared by
  every agent.
- Multiple sessions per agent at once, session branching, one-click reload,
  and the choice to run agents sharing a connection or fully isolated.
- Connect GitHub in one click, or add any other MCP server by command or
  URL — routing is set per agent, and credentials never follow you between
  machines automatically.
- Each agent's rules, skills, and commands are listed in Settings and open
  directly in the editor.
- Rich chat rendering: markdown, code highlighting, diagrams, math notation,
  tables, and right-to-left / CJK text.
- Status bar indicator and command palette actions for switching sessions
  and connecting agents.
- Agents flagged to auto-connect reconnect automatically when VS Code
  reopens.
- "Disconnect & erase all data" for a clean, complete removal of everything
  the extension stored.
