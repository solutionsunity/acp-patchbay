# acp-patchbay

> Developers deserve a unified experience across AI agents.

**acp-patchbay** is a VS Code extension built on the [Agent Client
Protocol](https://agentclientprotocol.com) (ACP). Connect any ACP-compatible
coding agent and get the resident experience a vendor extension gets: it sees
your live editor state — selection, open files, unsaved buffers, the problems
panel — receives pasted images and attached files, reaches the services you
connect (GitHub and any other MCP server), asks for permission through one
consistent surface, and runs alongside other agents in parallel sessions.

A patchbay is the panel where any source routes to any destination. Agents on
one side, your editor and your world on the other — you own the routing.

## Where agents come from

Agents are pulled live from the official [ACP agent
registry](https://agentclientprotocol.com/registry) — any agent published
there is available with no extension update needed. Prefer something the
registry doesn't list? Add any ACP-compatible command line directly.

## Features

- **One blended view** — agents, sessions, and chat in a single sidebar.
  Chat is home; switching agents or sessions is one gesture away.
- **A capability matrix that doesn't lie** — every agent × every capability,
  shown as *not declared* / *declared but not used* / *used*. What an agent
  claims at handshake and what it actually does on the wire are tracked
  separately.
- **Editor depth, brokered** — live selection, current file (including
  unsaved changes), diagnostics, image paste, file attach, and context roots
  reach the agent through a local MCP server this extension owns — no
  per-agent code required.
- **One permission surface** — command allowlists and file-write scope apply
  identically to every agent's own permission requests and to the
  extension's own file-write/terminal gates.
- **Sessions that behave like sessions** — concurrent sessions per agent,
  one-click reload, and per-agent process policy (share a connection or
  isolate it). The agent owns its sessions end to end: the sessions list is
  read live from the agent's own history, never a local copy.
- **Integrations, one mechanism** — connect GitHub in a couple of clicks, or
  add any other MCP server by command or URL. Routing is yours, per agent; a
  shared config never carries its credential.
- **Rules, skills, and commands, visible** — each agent's native rule/skill/
  command files, listed in Settings and opened in VS Code's own editor.

## Getting started

1. Open the **Patchbay** icon in the activity bar.
2. Add an agent in Settings § Agents — search the built-in registry or paste
   any command line that speaks ACP. Adding connects and verifies it in one
   step.
3. Hit **+** and go — one agent starts directly, several offer a picker, and
   a not-yet-running agent connects right in the chat pane. The composer's
   `/` opens the agent's own advertised commands; the context adder attaches
   your selection, current file, diagnostics, or any other file; pasting an
   image just works.

Settings (gear icon) is where the capability matrix, integrations,
permission rules, and agent/session/rules-skills-commands management live.

## Uninstalling cleanly

VS Code gives extensions no uninstall hook, and what an extension stores does
not reliably vanish with it — secrets in particular are known to survive
uninstall. So a clean slate is an explicit act, deliberately never automatic:

**Settings → Permissions → "Disconnect & erase all data"** stops every agent
and deletes everything patchbay stored on this machine — agent and
MCP-server configs, every credential and env value, the capability cache,
permission rules, and the decision audit. (Sessions themselves live in each
agent's own storage — patchbay persists no session records.) Run it *before*
uninstalling.

Two honest limits: it reaches only the current window's workspace records
(reopen and erase in other workspaces too if you used patchbay there), and
it deletes by the current config lists, which is why it must run while those
configs still exist.

## License

Proprietary — see the LICENSE file included with this extension.

Built by [Solutions Unity](https://solutionsunity.com).
