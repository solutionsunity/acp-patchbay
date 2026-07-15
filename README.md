<div align="center">

# ACP Patchbay

**One VS Code experience for every AI agent.**

[![VS Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/SolutionsUnity.acp-patchbay?label=Marketplace&labelColor=2c2c2c&color=5b9bd5)](https://marketplace.visualstudio.com/items?itemName=SolutionsUnity.acp-patchbay)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/SolutionsUnity.acp-patchbay?label=Installs&labelColor=2c2c2c&color=5b9bd5)](https://marketplace.visualstudio.com/items?itemName=SolutionsUnity.acp-patchbay)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-5b9bd5.svg)](LICENSE)

ACP Patchbay is a unified VS Code client for any
[ACP](https://agentclientprotocol.com)-compatible coding agent — consistent chat,
capabilities you can trust, and deep editor context. Stop learning a new extension
every time you switch agents.

[**Install from the Marketplace →**](https://marketplace.visualstudio.com/items?itemName=SolutionsUnity.acp-patchbay)
&nbsp;·&nbsp;
[Product page](https://solutionsunity.com/products/vscode-acp-patchbay)

![ACP Patchbay — an agent session in VS Code](https://raw.githubusercontent.com/solutionsunity/acp-patchbay/main/media/recordings/agent-session.gif)

</div>

---

## The agent you pick shouldn't decide the tools you get

The AI coding space fragmented fast. Every vendor ships its own VS Code extension,
and they're uneven — one has a great chat but no session history, another has
history but a clumsy permission flow, a third has no extension at all and lives
only in a terminal. Switch agents and you switch muscle memory, lose features, and
relearn the quirks.

That's backwards. The **agent** should be the variable. The **experience** should
be the constant.

## ACP makes the agent a plug-in, not a lock-in

The **Agent Client Protocol** standardizes how an editor and an agent talk —
sessions, prompts, tool calls, permissions. Patchbay speaks it fluently, so any
ACP-compatible agent drops into the *same* client: one chat surface, one
permission model, one place for sessions and history. The agent becomes something
you swap, not something you're married to.

And because the bar is "speaks ACP," not "shipped an extension," agents that only
ever existed as a CLI are first-class citizens here. Patchbay bets on the protocol,
not on any single vendor's roadmap — a vendor's own extension can improve or be
retired, and either way your workflow stays put.

## What Patchbay adds

A faithful ACP client already proves the connection works. Patchbay adds the
orchestrator layer on top:

- **🧭 Capabilities you can trust.** An agent's handshake tells you what it
  *claims*, not what works on the wire. Patchbay tracks every capability as
  **declared vs. used** and only lights up a feature once the path has genuinely
  fired — "native fork" or "MCP servers" means *verified*, not *promised*.
- **🛡️ One permission model.** A single permission broker across every agent. You
  review and approve what an agent does — file writes, terminal, tools — the same
  way regardless of which agent is driving.
- **🧩 Editor-aware context.** A built-in local MCP server hands agents real editor
  state — current file, selection, open editors, diagnostics, workspace layout —
  and can ask *you* for input mid-turn. The agent sees what you see.
- **🎛️ Sessions in parallel.** Run many sessions at once, on one agent or across
  several, each with its own history. A live dot marks a turn in flight, an unseen
  dot marks a session that finished while you were elsewhere, and a chime — or a
  native OS notification when the view is hidden — tells you the moment a turn
  lands. Detached panels and prompt queueing included.

![Settings — the capability matrix, integrations, and permissions](https://raw.githubusercontent.com/solutionsunity/acp-patchbay/main/media/recordings/settings.gif)

## Everything you'd expect from a great client

- Polished chat composer with inline `/` commands and `@`-mentions of workspace files
- Full session history — list, resume, and fork, backed by the agent's own store
- Faithful replay of past sessions (no "last message only" gaps)
- A live plan and a touched-files read-out while the agent works
- MCP integrations, including remote servers over Streamable HTTP, added and verified in-client
- Theme-native UI that follows your VS Code theme

## Getting started

1. Open the **Patchbay** icon in the activity bar.
2. Add an agent in **Settings › Agents** — search the built-in registry or paste
   any command line that speaks ACP. Adding connects and verifies it in one step.
3. Hit **+** and go — one agent starts directly, several offer a picker, and a
   not-yet-running agent connects right in the chat pane. The composer's `/` opens
   the agent's own advertised commands; the context adder attaches your selection,
   current file, diagnostics, or any other file; pasting an image just works.

Settings (gear icon) is where the capability matrix, integrations, permission
rules, and agent / session / rules-skills-commands management live.

## Uninstalling cleanly

VS Code gives extensions no uninstall hook, and what an extension stores does not
reliably vanish with it — secrets in particular are known to survive uninstall. So
a clean slate is an explicit act, deliberately never automatic:

**Settings → Permissions → "Disconnect & erase all data"** stops every agent and
deletes everything patchbay stored on this machine — agent and MCP-server configs,
every credential and env value, the capability cache, permission rules, and the
decision audit. (Sessions themselves live in each agent's own storage — patchbay
persists no session records.) Run it *before* uninstalling.

Two honest limits: it reaches only the current window's workspace records (reopen
and erase in other workspaces too if you used patchbay there), and it deletes by
the current config lists, which is why it must run while those configs still exist.

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright © 2026
[Solutions Unity](https://solutionsunity.com). See [NOTICE](NOTICE) for attribution.

Source: [github.com/solutionsunity/acp-patchbay](https://github.com/solutionsunity/acp-patchbay).
