# acp-patchbay — Feature Inventory

What must be possible, stated as capabilities — not how, not which component. Sits
between [prd.md](prd.md) (why) and [architecture.md](architecture.md) (how). Every
feature here is v1 unless parked at the bottom.

---

## 1. Agent View (sidebar)

Agents, sessions, and chat are one surface, not three stacked panels. The user lives
in the chat; the active agent's status and the session list are one gesture away,
never a navigation maze. The layout that blends them is a first-class design
deliverable, owed before implementation.

### Agents

- User can connect an agent by picking from the known ACP roster or supplying any
  command line that speaks ACP.
- User can see each agent's live status: running, stopped, crashed, reconnecting.
- User can start, stop, and restart an agent; a crash is visible the moment it
  happens and recovery is one action.
- After reconnect, a session continues natively where the agent supports session
  restore; where it doesn't, patchbay seeds a fresh session from its last-known
  view. Either way the user continues — which kind of continuation they got is
  shown, not hidden.

### Sessions

- User can create a session with any connected agent.
- Multiple sessions run concurrently — same agent or different agents, side by side.
- Sessions are cheap to create and never a process-management chore: whether
  concurrent sessions share one agent process or get isolated ones is per-agent
  policy (Settings), decided by verified concurrent-session behavior in `auto` mode.
  One protocol-imposed exception: a branched session rides its parent's process —
  shown, not hidden.
- User can switch, rename, and close sessions.
- User can branch a session — continue an alternate path without polluting the
  parent's history. Works with every agent; the capability matrix shows whether the
  agent does this natively.
- The agent owns the conversation — patchbay never holds a co-equal copy. It holds
  three honestly different things: a **session index** (IDs, titles, timestamps,
  agent — ACP has no session enumeration, so finding a session again is patchbay's
  job), a **decision audit** (permissions granted, tools approved, routing chosen —
  those events happened in patchbay and belong to it), and a **render cache** —
  disposable, rebuilt wholesale from `session/load` replay on every reopen, never
  merged. Replay always wins; there is no reconciliation logic anywhere.
- A session continued outside patchbay (the agent's own CLI, another editor) simply
  appears complete on reopen — the replay carries the detour, because the truth was
  never patchbay's.
- Live edge: if a session stays connected in the editor while being continued
  elsewhere, no protocol signal announces the external turns — the connected agent
  process itself has forked from its own store. Patchbay offers one-click session
  reload (re-`load` from the agent) to rejoin truth. Driving one session from two
  places simultaneously is agent-side undefined behavior, out of scope and stated
  as such.
- For agents that cannot replay (`session/load` undeclared): patchbay keeps its
  last-known view, labeled exactly as that — "patchbay's view, up to \<time\>" —
  and continuation means a new session seeded from it, labeled emulated. A
  fallback, not a competing truth. This view is also what seeds branch-emulation
  for these agents.
- User can see and change the session's model, mode, and effort when the agent
  offers them, and the result reflects what actually happened — not what was
  requested.

### Chat

- Responses stream live, including tool calls, thoughts, and plans as the agent
  reports them.
- When the agent maintains a task list / plan, it renders live in the session.
- User can paste an image and any agent receives it in the best form it supports —
  paste is never disabled.
- User can attach files by drag-and-drop or picker.
- User can explicitly add editor state to the prompt: current selection, current
  file, diagnostics.
- User can add workspace folders as session context roots — the open workspace's
  folders plus explicitly added external ones (the backend repo while working in
  the frontend). Shown as a chip, removable; passed to the agent through the
  protocol. What the agent's engine does with roots is the agent's business —
  patchbay passes, it does not index.
- Slash commands the agent advertises are discoverable and invokable in the input.
- Permission requests appear inline with allow-once / allow-always / reject, and
  are impossible to miss when the view is hidden.
- Context/token usage is shown when the agent reports it and cleanly absent when it
  doesn't — never a fake number.
- User can stop a running turn at any time.

## 2. Settings Page

### Agents

- User can add, edit, and remove agents, including launch configuration per agent.
- Capability matrix: every agent × every capability, three honest states — not
  declared / declared but unverified / verified working. Refreshes on every connect.
- Each agent carries a permission-fidelity label: fully brokered / partially
  brokered / acts outside the permission flow. Never silently trusted.
- User can run explicit diagnostics against an agent; the cost (real agent turns)
  is disclosed before running.
- User can set per-agent process policy: auto / shared / isolated.
- User can set per-agent defaults for model, mode, and effort — each only where
  the agent offers it (model is the common must; mode and effort are per-agent
  reality). Applied at session creation; the session shows what actually applied,
  not what was requested.

### Integrations

- User can connect GitHub in one click (OAuth), and disconnect as easily.
- User can add any MCP server — command or URL, with auth — as a custom integration.
- User owns the routing: which integrations each agent receives is the user's
  choice, per agent, not all-or-nothing. Default: a new integration auto-attaches
  only to fully-brokered agents; anything less than fully-brokered requires an
  explicit plug-in.
- Integrations are workspace-scoped by default: an integration connected in one
  repo is never silently available in another. Sharing one across workspaces is an
  explicit act, made visibly. (This rule exists because of a real incident — a
  production-access MCP server followed a user from one repo into another.)

### Rules, skills, commands

- User can see and edit each agent's rules, skills, and commands from Settings —
  the files stay in the agent's own native locations, and the agent reads them
  from the workspace itself; patchbay never passes them down.
- v1 maps Claude Code and Augment locations; an unmapped agent is shown as such —
  never silently skipped.

### Permissions

- User can define permission rules once — command allowlists, file-write scope —
  and they apply identically to every agent and every integration.
- Rules can differ per workspace, with sane defaults.

### Configuration as files

- Workspace-level configuration (agents, integrations, routing) is inspectable and
  repo-shareable as files. Credentials are never in those files, never displayed,
  and revocable at any time.

## 3. Editor Surface

- Agents that route file changes through patchbay get native diff views — user
  accepts or rejects before anything touches disk. The capability matrix shows
  which agents deliver this brokered tier; for agents that write on their own, the
  permission-fidelity label and live terminal visibility carry the honesty in v1.
- The agent sees what the user sees: unsaved buffers, not just disk state.
- The agent can read the problems panel (diagnostics) — current, not stale.
- Right-click on a selection: add to context / ask the agent about it.
- Status bar shows the active session, connection health, and usage when available;
  clicking it jumps to the session.
- Command palette covers every core action: new session, switch session, connect
  agent, open settings.
- Permission prompts surface as native notifications when the chat view is hidden —
  one approval surface, wherever the user happens to be looking.
- Commands the agent runs are visible live — output streams where the user can
  watch, gated by the same permission rules as everything else.

## 4. VS Code Native Settings

Deliberately near-empty — flat toggles only, searchable in the standard Settings UI:

- Default agent.
- Telemetry opt-in.
- Nothing else unless it proves to be a genuinely flat scalar. Never credentials.

---

## Parked (v2)

- Curated integrations catalog beyond GitHub (Linear, Jira, Sentry, …).
- External-continuation detection — watch known agent session stores for
  out-of-band writes and badge the session "possibly continued elsewhere." Requires
  per-agent knowledge of private storage paths; adapter-tier work that earns its
  way in.
- Post-hoc change detection for uncooperative agents — snapshot workspace state at
  turn start, watch during the turn, present every out-of-band change as a
  reviewable, one-click-revertible diff. Not pre-gated, but nothing invisible.
- Isolated execution workspaces — the agent works against a copy (worktree-style)
  and every change is applied back as a pre-gated diff. The only true gating for
  uncooperative agents; heavy on paths, terminals, and UX, so it earns its way in
  later.
- Shared source for rules/skills/commands — one base directory with compatibility
  symlinks into each agent's native locations (the
  [dotagent](https://github.com/solutionsunity/dotagent) pattern) or full supply
  by patchbay. v1 proves the management surface first.
- Anything not listed above that emerges during architecture — it lands here first,
  not in v1 by momentum.
