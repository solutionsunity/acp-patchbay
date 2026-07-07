# acp-patchbay

> Any ACP agent. Every integration it can accept. Shown exactly as it is.

**acp-patchbay** is a VS Code extension that gives any [Agent Client
Protocol](https://agentclientprotocol.com) (ACP) coding agent the resident
experience a vendor extension gets: it sees your live editor state — selection,
open files, unsaved buffers, the problems panel — receives pasted images and
attached files, reaches the services you connect (GitHub and any other MCP
server), asks for permission through one consistent surface, and runs alongside
other agents in parallel sessions.

A patchbay is the panel where any source routes to any destination. Agents on
one side, your editor and your world on the other — you own the routing.

## Why

Vendor extensions are deeply integrated but lock you to one agent. Plain ACP
clients give you agent freedom but leave the agent a guest in the editor — no
selection, no live diagnostics, no unsaved buffers. That trade is a missing
product layer, not a protocol limitation. Patchbay is that layer, and it works
the same way for every agent that speaks ACP, not just one vendor's.

## What you get

- **One blended view** — agents, sessions, and chat in a single sidebar. Chat
  is home; switching agents or sessions is one gesture away, never a
  navigation maze.
- **A capability matrix that doesn't lie** — every agent × every capability,
  shown as *not declared* / *declared but not used* / *used*.
  What an agent claims at handshake and what it actually does on the wire are
  tracked separately, and the UI only ever lights up on the latter.
- **Editor depth, brokered** — live selection, current file (including
  unsaved changes), diagnostics, image paste, file attach, and context roots
  reach the agent through a local MCP server patchbay owns — no vendor-specific
  code required.
- **One permission surface** — command allowlists and file-write scope apply
  identically to every agent's own permission requests and to patchbay's own
  file-write/terminal gates. An agent that acts outside the brokered path is
  labeled as such, never silently trusted.
- **Sessions that behave like sessions** — concurrent sessions per agent,
  branching (native `session/fork` where used, an honestly-labeled
  emulated continuation otherwise), one-click reload, and per-agent process
  policy (share a connection or isolate it).
- **Integrations, the same mechanism for curated and custom** — connect
  GitHub in one click (OAuth Device Flow) or add any other MCP server by
  command or URL. Routing is yours, per agent; a shared config never
  carries its credential, so an integration never silently follows you
  into another machine or account.
- **Rules, skills, and commands, visible** — each agent's native rule/skill/
  command files, listed from Settings and opened in VS Code's own editor. An
  agent with no known mapping is shown as unmapped, never silently skipped.

## Getting started

1. Open the **Patchbay** icon in the activity bar.
2. Connect an agent — pick one from the built-in roster or paste any command
   line that speaks ACP.
3. Start a session and go. The composer's `/` opens the agent's own advertised
   commands; the context adder attaches your selection, current file,
   diagnostics, or any other file; pasting an image just works.

Settings (gear icon) is where the capability matrix, integrations, permission
rules, and agent/session/rules-skills-commands management live.

## Credits

Successor to [vscode-acp](https://github.com/formulahendry/vscode-acp) (MIT) —
built independently, not on top of it. vscode-acp is a working, well-made ACP
client and the trigger for this project; its connection-handling approach and
known-agents roster data informed patchbay's own. Patchbay exists for
everything the protocol alone doesn't give you.

## Learn more

- [Product requirements](https://github.com/solutionsunity/acp-patchbay/blob/main/docs/prd.md) — why this exists
- [Feature inventory](https://github.com/solutionsunity/acp-patchbay/blob/main/docs/features.md) — what it does
- [Architecture](https://github.com/solutionsunity/acp-patchbay/blob/main/docs/architecture.md) — how it's built
- [Changelog](CHANGELOG.md)

## License

MIT — see [LICENSE](LICENSE).
