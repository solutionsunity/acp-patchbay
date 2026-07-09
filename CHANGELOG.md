# Changelog

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
