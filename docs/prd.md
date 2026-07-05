# acp-patchbay — Product Requirements

> Any ACP agent. Every integration it can accept. Shown exactly as it is.

---

## Problem

Developers using AI coding agents in VS Code face a forced trade:

- **Vendor extensions** (Claude Code's own) are deeply integrated — the agent sees
  what you see, edits land as native diffs, images paste — but lock you to one vendor.
- **ACP clients** (vscode-acp and forks) give you agent freedom — any compatible
  agent, today — but the agent is a guest in the editor, not a resident: it cannot
  see your selection, your problems panel, or your unsaved changes. It is a CLI that
  happens to be docked in a sidebar.

Depth or freedom, pick one. That trade is a missing product layer, not a protocol
impossibility — and nobody has built the layer.

## Product

**acp-patchbay** is a VS Code extension where any ACP agent gets the resident
experience: it sees your live editor state, receives pasted images and dropped files,
reaches the services you connect (GitHub and beyond), asks for permission through one
consistent surface, and runs alongside other agents in parallel sessions.

The name is the thesis. A patchbay is the panel where any source routes to any
destination — agents on one side, your editor and your world on the other, and you
own the routing.

## User

A developer who refuses vendor lock-in on the most personal tool in their stack —
because they use different agents for different jobs, because the employer-approved
agent is not their preferred one, or because they want to switch the day something
better ships without losing their working environment.

## Product Bets

1. **Depth is not vendor magic.** The integration gap between vendor extensions and
   ACP clients is a buildable generic layer. Patchbay is that layer.
2. **Honesty is a feature.** Agents are not equal, and pretending they are is how
   every multi-agent product disappoints. Patchbay shows what each agent can
   *actually* do — verified in practice, not claimed in a handshake — and the UI
   never offers what won't work. Trust through candor is the differentiator.
3. **One trust surface.** You grant permissions to patchbay, once, with one set of
   rules — not to N agents with N different security personalities.

## The Promise, Stated Precisely

**Connection promise (v1):** every ACP-compatible agent connects — the full
vscode-acp roster (Claude Code, Codex, Copilot, Gemini, Qwen, OpenCode, Kiro,
OpenClaw, Hermes, …) and anything else that speaks the protocol.

**Depth promise (v1):** each agent receives every integration it is capable of
accepting, and the capability matrix shows exactly what you got.

Never "all agents, all features." The resident experience is per-agent uneven by
nature — some agents take everything patchbay offers, some ignore parts of it. The
product does not hide that; displaying it *is* bet #2.

## v1 Scope

- **Editor depth, in full.** The agent sees active selection, diagnostics, open
  editors, and unsaved buffer state; edits surface as native diffs; images paste and
  files drop into the chat. This is the differentiator and it ships complete.
- **All-agent connection** with per-agent capability matrix (claimed vs. verified,
  visible to the user).
- **Concurrent sessions** — multiple sessions at once, same agent or different
  agents, side by side. Also the only guaranteed context-reset lever, so it is
  load-bearing, not a luxury.
- **Integrations: one curated + open escape hatch.** GitHub ships as the single
  curated one-click integration, proving the registry pattern. "Add any MCP server"
  covers everything else.
- **One permission surface** with per-agent honesty about what can actually be
  brokered (an agent that acts outside the permission flow is labeled as such, not
  silently trusted).

Deliberate scope decisions, not limitations:

- **The curated integrations catalog is v2.** Registry curation is ongoing product
  work (OAuth flows, service churn) and a different muscle than editor depth. Deep
  and narrow beats wide and late; GitHub alone covers the majority case.
- **No agent routing or orchestration.** Patchbay never picks the agent for you.

## What It Isn't

- Not an agent — it makes agents better residents, it doesn't compete with them.
- Not a new protocol — ACP and MCP as they exist, no patchbay-specific dialect.
- Not a vendor UX fork — no reimplementation of any vendor's product decisions.
- Not a router — the user owns the routing, always.

## Positioning

Successor to [vscode-acp](https://github.com/formulahendry/vscode-acp) — built
independently, not on top of it. vscode-acp is a working, well-made ACP client and
the trigger of this project; it is credited as such. It proved the connection layer
works — this very product is being designed and built through it, agent-in-editor.
Patchbay exists for everything the protocol alone doesn't give you.

Published to the VS Code Marketplace as an independent extension.

## Success Test

A Gemini or Codex user in patchbay feels what a Claude user feels in the official
Claude Code extension. The moment someone says *"I didn't know agent X could do that
in VS Code"* — that is the product working.
