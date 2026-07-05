# acp-patchbay — Architecture

How the product surface becomes a VS Code extension. Inputs: [prd.md](prd.md) (why)
and [features.md](features.md) (what); on any conflict, they win. This document
decides mechanisms and records the reasoning. Stack is fixed by rule: TypeScript
for all extension-host code, esbuild, npm.

---

## Vocabulary

Terms are contracts — one meaning each, held everywhere (docs, code, UI copy):

- **Orchestrator** — the Node process in the extension host. Single source of truth
  for sessions, capability tables, permission rules, secrets, configuration.
- **Agent View** — the one blended webview: agents + sessions + chat. Not three panels.
- **Session index** — patchbay's registry of session IDs, titles, timestamps, agent.
  Exists because ACP has no session enumeration.
- **Decision audit** — append-only record of events that happened *in patchbay*:
  permissions granted, tools approved, routing chosen.
- **Render cache** — disposable render state, rebuilt wholesale from `session/load`
  replay. Never merged, never reconciled.
- **Declared / verified** — the two capability states: claimed at `initialize` vs.
  observed working on the wire.
- **Brokered** — routed through the permission broker. Fidelity labels: fully
  brokered / partially brokered / acts outside the permission flow.
- **Integration** — an MCP server made reachable to agents (curated or custom).
- **Branch** — the user-level concept: continue an alternate path from a session.
  `session/fork` is one mechanism that implements it; emulated seeding is the
  other. "Fork" only ever names the protocol method.
- **Routing** — the user's per-agent selection of which integrations that agent
  receives.

## Core principle

**ACP answers where the agent lives** — sessions, prompts, permissions, file
operations, terminal. **MCP answers what the agent reaches** — tools, resources,
context. Everything ACP doesn't model (live editor state, integrations) is exposed as
a **local MCP server the orchestrator owns**, passed into `session/new` via
`mcpServers`. This is the generic version of the pattern vendor extensions build
privately — it works for any ACP agent by construction, with zero per-vendor code.

## Architecture

```mermaid
flowchart TD
    AV["Agent View webview<br/><small>render only</small>"]
    SET["Settings webview<br/><small>render only</small>"]

    subgraph ORCH["Orchestrator — Node, extension host<br/><small>single source of truth</small>"]
        STATE["State & stores<br/><small>session index, capability tables,<br/>decision audit, config</small>"]
        POOL["ACP client pool<br/><small>stdio JSON-RPC per agent process</small>"]
        BROKER["Permission broker<br/><small>one rule set, one surface</small>"]
        MCP["Local MCP server<br/><small>editor state, integrations, adapters</small>"]
    end

    AGENTS["ACP agent processes"]
    WORLD["Editor state · GitHub · custom MCP servers"]

    AV -- actions --> ORCH
    SET -- actions --> ORCH
    ORCH -- "snapshots + patches" --> AV
    ORCH -- "snapshots + patches" --> SET
    POOL <--> AGENTS
    MCP <--> WORLD
```

Data flows one way: webviews send **actions**; the orchestrator sends **snapshots and
patches**. No business logic, persistence, or protocol handling in webview code —
webviews are disposed when hidden and must rehydrate losslessly on every mount.

## UI layer

Two webviews and one near-empty native settings page:

1. **Agent View** — the single blend (features §1). Its layout is the owed design
   deliverable; what architecture fixes now is its information boundary: it knows
   only its current snapshot + patch stream, and can only emit actions. Anything the
   layout wants to show must arrive through that pipe — which is the whole
   rehydration guarantee.
2. **Settings** — agents and launch config, capability matrix, integrations,
   routing, permission rules. Structured data, low frequency, same render-only
   contract.
3. **VS Code native settings** — flat scalars only (default agent, telemetry
   opt-in). Never credentials: `settings.json` syncs.

Native surfaces — the status bar item (active session, connection health, usage),
permission notifications, and command palette entries — are direct orchestrator
consumers: same state, no webview in the path.

> Agents, sessions, and chat are one surface (features §1). Settings remains its
> own webview because it is genuinely a different activity, not because panels
> are cheap.

### Snapshot + patch protocol — decided

One protocol, one shared TypeScript module (`src/shared/protocol.ts`) both sides
import. No diffing library, no CRDT, no partial hydration:

- **Actions** (webview → orchestrator): a discriminated union — `prompt`, `stopTurn`,
  `switchSession`, `grantPermission`, `connectAgent`, … Fire-and-forget; results come
  back as state, never as replies.
- **Snapshot** (orchestrator → webview): the complete view model for that webview,
  tagged with a monotonic revision. Sent on mount and whenever the webview asks.
- **Patch** (orchestrator → webview): `{ rev, events[] }` — semantically named events
  (`sessionUpdated`, `agentStatusChanged`, `permissionRequested`, …) applied by pure
  reducers in the webview. A webview that sees a revision gap discards its state and
  requests a fresh snapshot. Recovery is always "resnapshot," never "repair."
- **Coalescing**: the orchestrator buffers high-frequency `session/update` streaming
  chunks and flushes one patch per short fixed interval (~30 ms) or turn boundary,
  concatenating text chunks per message. One knob, no adaptive machinery.

One mechanism sized to the actual problem: webviews die and must resurrect
cheaply.

## State — three honest stores, no co-equal copy

The agent owns the conversation (features §1). Patchbay holds exactly three things,
each with different truth semantics, so each gets different placement:

| Store | Contents | Placement | Why |
|---|---|---|---|
| Session index | IDs, titles, timestamps, agent | `workspaceState` | Small, machine-local, non-sensitive |
| Decision audit | Permission/routing events | JSONL in workspace storage | Append-only, grows, belongs to patchbay |
| Render cache | Current render state | Memory; rebuilt from `session/load` replay | Disposable — replay always wins |
| Last-known view | Render cache persisted, labeled "patchbay's view, up to \<time\>" | Files in workspace storage | Only for agents without `session/load`; a labeled fallback, not a competing truth |
| Workspace config | Agents (launch config, defaults), integrations, routing | `.vscode/acp-patchbay.json` | Inspectable, repo-shareable (features §2); no credentials ever |
| Permission rules | Command allowlists, file-write scopes | `workspaceState` + built-in defaults | Per-user, per-workspace, never repo-shipped — a cloned repo must not arrive pre-authorized |
| Secrets | OAuth tokens, API keys | `SecretStorage` | The only place. Never settings, never state stores, never logs |

Integrations are workspace-scoped because the config file is workspace-scoped —
scoping falls out of placement rather than being enforced by extra code. Sharing an
integration into another workspace is an explicit command that copies the config
entry; the credential is reattached only on user confirmation during that act.

## ACP client pool & process model

- Registry: `agentId → { process, declared, verified, sessions[] }`.
- Different agents are always separate subprocesses. Sessions with the *same* agent
  multiplex over one connection by default — that is the protocol's own model
  (`session/new`/`load`/`close` are session-ID-scoped on one connection).
- **Per-agent process policy** (Settings): `auto` (default — share if concurrent
  behavior is *verified*, isolate otherwise), `shared` (force, user accepts risk),
  `isolated` (one process per top-level session).
- Protocol fact: `session/fork` is addressed to the connection holding the parent's
  context — no cross-process handoff exists. A branched session therefore rides its
  parent's process under any policy. Shown in the UI, not hidden (features §1).
- Crash → visible immediately; restart is one action. After reconnect: native
  restore where the agent supports it, else a fresh session seeded from the
  last-known view — which kind of continuation happened is shown.

## Agent capability matrix

Two states per capability, per agent — **declared** (from `initialize`, refreshed
every connect) and **verified** (set only after the path succeeds on the wire;
resets on reconnect, since agent versions change). UI affordances gate on
*verified*, not declared: real bridges have been observed silently dropping
`mcpServers`, collapsing stop reasons, and reporting rejected mode changes as
succeeded. Three honest states per row: not declared / declared-but-unverified /
verified-working.

Rows: `fs.readTextFile` / `writeTextFile`, `terminal`, `elicitation`,
`roots.listChanged`, `resources.subscribe`, `promptCapabilities.image` / `audio` /
`embeddedContext`, `session.fork` / `load` / `resume`, `mcp.http` / `sse`,
usage/context reporting, concurrent-session behavior. One patchbay-side row rides
along: rules/skills/commands locations (mapped / not mapped), sourced from roster
data rather than the handshake.

Verification cost splits the triggers:

| Trigger | Protocol-level (free RPC) | Behavior-level (costs real LLM turns) |
|---|---|---|
| First connect | Automatic | Opportunistic only — verified when naturally exercised |
| User-run diagnostics | Instant | Allowed; cost disclosed first |
| Background schedule | Fine, cheap | Never |

Synthetic behavior probes run in an **ephemeral session scoped to a temp directory**
— never the user's workspace roots, never silently.

## Protocol extensions (`_meta`)

ACP reserves `_meta` fields on every type and underscore-prefixed methods for
implementation extensions — a spec-sanctioned mechanism, not a dialect. Adapters
carry real surface there beyond core protocol; observed in `claude-agent-acp`:
`_claude/sdkMessage` (tunnel of the raw Claude Agent SDK stream),
`_claude/rateLimit` (subscription rate-limit windows), `_claude/askUserQuestionOption`
(richer permission options), and a terminal-output `_meta` channel shared as a
convention with `codex-acp` for live command output. The observed pattern:
extensions enrich standard updates in place — `_claude/rateLimit` rides the
standard `usage_update` notification's `_meta` while `used`/`size` stay
protocol-shaped — they don't fork the stream. Token and context reporting is
standard; only the vendor-specific remainder is extension.

Stance: **core ACP is the floor; extensions are per-agent adapter knowledge**,
recorded in roster data and consumed only when a features bullet requires what
core ACP cannot carry. A consumed extension becomes a capability row — present by
observation, verified like everything else. Vendor depth that never reaches the
wire (hooks, subagent definitions, skills) is files in `cwd` — the rules/skills/
commands surface is its channel, no protocol involved.

## Branching

- Agent declares `session/fork` *and it's verified* → native fork.
- Otherwise → emulated: fresh `session/new` seeded from the parent's replay (or
  last-known view for non-replay agents), labeled emulated.
- Either path is a node in the orchestrator's session graph (parent → branches). The
  UI never knows which mechanism produced a branch; the capability matrix is where
  native-vs-emulated honesty lives.

## Session model, mode, effort

Three knobs, each existing only if the agent offers it — model is the only one
observed everywhere; mode and effort are frequent but optional. The knob set is
per-agent reality, not a patchbay form to fill.

- Options come only from the agent — session config options at create, list
  updates after. Patchbay never invents entries, never renders a knob the agent
  didn't offer.
- Per-agent defaults (one per offered knob, part of the agent's config record) are
  applied at session creation by issuing the corresponding set requests after
  `session/new`; absent options, there is nothing to default.
- Displayed values update only from the agent's subsequent state notifications,
  never from the set-request's success response — bridges have returned success
  for rejected mode changes. What the user sees is the last agent-confirmed
  state, which is the honest one.

## Local MCP server — editor depth

The differentiator (prd §v1 Scope), shipped complete:

- **Tools/resources**: active selection, current file, diagnostics (live, not
  stale), open editors. Explicit user gestures ("add selection to context",
  right-click) inject the same data into the prompt directly.
- **Context roots**: a session's roots are the workspace folders plus user-added
  external folders (multi-repo work). Delivered protocol-native (`roots` +
  `roots.listChanged` where declared; adapter fallback otherwise). Patchbay
  passes roots and never indexes — retrieval depth is the agent's own engine,
  and the UI never implies otherwise.
- **File operations go through ACP, not MCP**: the orchestrator advertises the `fs`
  capability, so `fs/read_text_file` serves live unsaved buffers and
  `fs/write_text_file` lands as a native diff the user accepts or rejects before
  disk is touched. Permission rules (file-write scope) can auto-accept; the diff
  remains visible either way.
- **Terminal**: orchestrator advertises `terminal`; commands run in a visible
  pseudoterminal, output streams live, gated by the same broker rules as everything
  else.
- **Adapters for uneven MCP client support** — every capability the local server
  uses has a protocol-native path and a tool-call fallback, chosen per connection at
  handshake:

| Capability | Native path | Fallback |
|---|---|---|
| `elicitation` | Elicitation request | Tool `request_user_input(schema)`; orchestrator renders the form, returns the answer as a tool result |
| `roots.listChanged` | Push notification | Roots injected into the next `session/prompt` |
| `resources.subscribe` | Live push | `get_workspace_state` tool; one turn of staleness accepted |

- **Image paste is never disabled**: `promptCapabilities.image` →
  `ContentBlock::Image`; otherwise the image is written to a temp file and sent as a
  `ResourceLink`. Same data, best form the agent accepts (features §1).
- **File attach** (drag-drop or picker): inline `ContentBlock::Resource` when
  `promptCapabilities.embeddedContext` is declared, `ResourceLink` otherwise.

## Integrations

Curated and custom are the same mechanism — MCP servers routed to agents:

- **The registry is shipped data from day one.** prd decides this: GitHub ships
  "proving the registry pattern," and a hardcoded integration proves no pattern.
  One data file, one entry; every field earned by what GitHub demonstrably needs —
  `id`, `name`, transport, auth type, scopes, bridge launch — nothing speculative.
  Adding a curated integration in v2 is a data change, not code.
- **Same pattern for the agent roster**: the known-agents list (name, launch
  command, install hint, asset-convention mapping, known quirks such as bypass
  bridges) ships as data. Roster and registry are the two shipped-data files —
  patchbay-side knowledge lives there, never scattered in code.
- **Custom escape hatch**: add any MCP server (command or URL, with auth).
- **Uniform stdio presentation**: agents vary in declared MCP transports, so the
  orchestrator always hands agents a local stdio server; for remote OAuth services
  it owns a small stdio-to-HTTP bridge process that handles token refresh. Every
  agent sees "just another local MCP server" — no per-agent branching.
- **Routing is the user's, per agent.** Default: a new integration auto-attaches
  only to *fully brokered* agents; anything less requires an explicit plug-in
  (features §2).

## Rules, skills, commands

v1 is management, not delivery: the files live in each agent's **own native
locations** (`.claude/`, `CLAUDE.md`, `.augment/`, …) and the agent reads them from
`cwd` itself — patchbay never passes them down. Settings is where the user sees and
edits them, per agent, in place. No patchbay dialect (prd: not a new protocol), no
injection machinery.

- The per-agent location mapping lives in the roster data; v1 ships Claude Code
  and Augment mappings — the agents in real use. An unmapped agent is shown as
  such — never silently skipped, never guessed.
- Commands the agent advertises back (`available_commands_update`) appear in the
  chat input as autocomplete and are sent as ordinary prompts. This is also the
  only compaction lever besides a fresh session: an advertised `/compact` is just
  one of these commands.
- Parked (v2), stated as a scope decision: a shared base with compatibility
  symlinks into each agent's locations (the
  [dotagent](https://github.com/solutionsunity/dotagent) pattern) or full supply
  by patchbay. v1 proves the management surface first.

## Permission broker

- **One rule set, one approval path** — ACP `session/request_permission`, local MCP
  tool calls, and terminal execution all route through the same broker evaluating
  the same command allowlists and file-write scopes from `workspaceState`.
  A second, differently-scrutinized approval surface is exactly what a malicious
  prompt would target.
- **Rules never ride the repo.** The shareable config file carries agents,
  integrations, and routing — exactly features §2's list — and nothing
  privilege-granting. The residual vector is a repo-defined agent launch command:
  first connect of a workspace-defined agent requires one-time explicit adoption
  (command line shown in full), behind VS Code workspace trust.
- **Fidelity label is a pure function of the matrix (v1):** `fs` and `terminal`
  declared *and verified* → fully brokered; a proper subset → partially brokered;
  neither, or a known-bypass bridge (roster data) → acts outside the permission
  flow. Observed-violation downgrades arrive only with v2 post-hoc change
  detection (parked).
- Protocol fact, load-bearing: an agent can route around `fs/write_text_file` via a
  shell command, and at least one bridge does file I/O invisibly regardless of
  client capabilities. `fs/*` is therefore **not a security boundary** — terminal
  gating carries equal rigor, and each agent wears its permission-fidelity label
  (fully brokered / partially brokered / acts outside) rather than being silently
  trusted.
- Allow-once / allow-always / reject inline in chat; when the Agent View is hidden,
  the same request surfaces as a native notification. One approval surface,
  wherever the user is looking.

## Context usage

Visibility only, not control — compaction is internal to each agent. `usage_update`
is **stable in schema v2**: `used` (tokens currently in context) and `size` (window
size) required, `cost` optional — the numerator and denominator of a context gauge.
Emitting it remains optional per agent, so population is uneven in practice: show
what is reported, omit cleanly when absent, never fake it. claude-agent-acp emits
it live mid-stream, so the gauge is a real-time affordance there, not per-turn.
The only guaranteed reset lever is a new or branched session — which is why
concurrent sessions are load-bearing (prd §v1 Scope), not a luxury.

## Code layout

Atoms first; each directory is one responsibility:

```
src/
  orchestrator/   session manager, client pool, broker, stores
  mcp/            local server, adapters, integration bridges
  webview/        agent-view/, settings/ — render only
  shared/         protocol.ts (actions, snapshots, patches), types
```

## Open at implementation

- GitHub integration: thin own bridge vs. wrapping an existing GitHub MCP server —
  pick when building, against the broker's routing requirements.
- GitHub OAuth grant flow: device flow vs. URI-handler callback — an extension
  cannot hold an OAuth client secret, which rules options in or out. The
  registry's auth field carries the outcome.