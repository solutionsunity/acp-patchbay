# acp-patchbay — Feature Inventory

What must be possible, stated as capabilities — not how, not which component. Sits
between [prd.md](prd.md) (why) and [architecture.md](architecture.md) (how). Every
feature here is v1; what is deliberately beyond v1 is in [roadmap.md](roadmap.md).

---

## 1. Agent View (sidebar)

Agents, sessions, and chat are one surface, not three stacked panels. The user lives
in the chat; the active agent's status and the session list are one gesture away,
never a navigation maze. The layout that blends them is a first-class design
deliverable, owed before implementation.

### Agents

- Starting a chat is one intent, one click (P17): "+" with a single configured
  agent goes straight to it — connecting first, inside the chat pane, when it
  isn't running; with several, a picker lists every configured agent with its
  readiness inline. A connection failure surfaces in that same pane with the
  specific reason and a Retry — never a silent bounce to the empty state.
- Adding agents lives in Settings § Agents only — the one rich form (roster
  search or any command line that speaks ACP, Verify toggle, binary confirm).
  The view's picker and empty state route there. *(Supersedes the earlier
  in-view connect form — owner-approved 2026-07-08: two half-featured add
  paths collapsed into the featured one.)*
- User can see each agent's live status: untested (configured, never
  connected), running, stopped, crashed, reconnecting — every configured
  agent is visible from the first frame, not only once connected.
- A crash is visible the moment it happens, with its reason and the process's
  own stderr inline; recovery is one action (the crash banner's Restart).
  Stop/restart beyond that are Settings troubleshooting controls — the
  process is normally managed implicitly by session lifecycle.
- After reconnect, a session continues natively where the agent supports it:
  `session/load` (full replay) or `session/resume` (context back, no visible
  history — said so with an inline notice). Where it supports neither, the
  session honestly cannot be reopened — patchbay never mints a new session and
  presents it as a continuation. *(Supersedes the emulated-continuation
  fallback: minting a session and seeding it from a cached view was a cache
  presented as a conversation.)*

### Sessions

- User can create a session with any configured agent — connection is the
  flow's job, not a prerequisite the user manages.
- Multiple sessions run concurrently — same agent or different agents, side by side.
- Sessions are cheap to create and never a process-management chore: whether
  concurrent sessions share one agent process or get isolated ones is per-agent
  policy (Settings), decided by used concurrent-session behavior in `auto` mode.
- A brand-new session knows it is new: clicking "new session" for an agent that
  already has a never-prompted session focuses that one instead of minting a
  sibling. The first prompt is what ends newness.
- User can switch and close sessions. Switching never closes the session being
  left; an attached session auto-closes (`session/close`, resources freed, row
  kept) only when *all* hold: not new, nothing in progress, not
  unseen-completed, prompt box empty, idle past the auto-close time (default
  60 min, a user setting soon), and the agent declares `session/load` — anything
  less than full replay would destroy the only transcript, since patchbay
  persists none. *(Supersedes release-on-switch.)*
- Renaming lives in the agent, not patchbay: ACP has no rename request, so
  agents with an in-chat `/rename` round-trip the title through their own
  `session/list` / `session_info_update` — which patchbay always honors.
  *(Supersedes the patchbay-side rename and its `renamedByUser` overlay.)*
- Branching is out of v1. `session/fork` stays a capability-matrix row; no UI
  feature rides it yet. *(Supersedes the branch menu item and the emulated
  branch path.)*
- The agent owns the sessions — 100%. The agent's own `session/list` is the
  only session list; patchbay persists no session records at all — no index,
  no transcripts. What patchbay holds: a **decision audit** (permissions
  granted, tools approved, routing chosen — those events happened in patchbay
  and belong to it) and an in-memory **render cache** — disposable, rebuilt
  wholesale from `session/load` replay on every reopen, never merged. Replay
  always wins; there is no reconciliation logic anywhere. Agents without
  `session/list` show only their currently-open sessions, and nothing survives
  a reload — a deliberate scope decision, not a limitation. *(Supersedes the
  session index as fallback+overlay and the persisted last-known views.)*
- A session continued outside patchbay (the agent's own CLI, another editor) simply
  appears complete on reopen — the replay carries the detour, because the truth was
  never patchbay's.
- Live edge: if a session stays connected in the editor while being continued
  elsewhere, no protocol signal announces the external turns — the connected agent
  process itself has forked from its own store. Patchbay offers one-click session
  reload (re-`load` from the agent) to rejoin truth. Driving one session from two
  places simultaneously is agent-side undefined behavior, out of scope and stated
  as such.
- Opening a closed session rides the ladder: `session/load` (replay = truth) >
  `session/resume` (context live, a notice says history can't be shown) >
  cannot open — nothing in hand, nothing to fetch, said as such. *(Supersedes
  the persisted last-known view and its read-only seeding.)*
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
  declared / declared but not used / used. Refreshes on every connect. Rows are
  hand-picked against the ACP spec's declared capability surface, not derived
  automatically.
- ~~Each agent carries a permission-fidelity label~~ *(removed 2026-07-12: the
  label aggregated data-plane rows — do fs/terminal bytes proxy through
  patchbay — into a conduct verdict, and read "not exercised yet" as "acts
  outside"; structurally wrong for SDK-CLI agents whose consent still routes
  through the permission broker. The capability matrix rows carry the honesty
  unaggregated.)*
- User can run explicit diagnostics against an agent; the cost (real agent turns)
  is disclosed before running.
- User can set per-agent process policy: auto / shared / isolated.
- User can mark an agent auto-connect: it connects on every window open.
  Independently of the flag, a window reload restores whatever agents were
  still running when the window went down — a manually connected agent
  survives reload but not quit-and-reopen-later (the running set is stamped
  at shutdown and honored only while fresh; `stores/last-connected.ts`).
  In-flight turns and process warmth do not survive a reload — a deliberate
  scope decision; the connection-keeper daemon that would preserve them is
  deferred until mid-turn reload loss demonstrates the need.
- User can set per-agent defaults for the session mode and for every config
  option the agent actually offers (model and effort being the common ones) —
  keyed by the agent's own option id, since ACP defines the semantic category
  as UX-only, never a correctness dependency. Applied at session creation; the
  session shows what actually applied, not what was requested.

### MCP servers (integrations)

- User can connect GitHub by pasting a token — one field, no app setup — and
  disconnect as easily. *(Originally "one click (OAuth)"; superseded by the
  standing auth decision in [reference-mcp-oauth.md](reference-mcp-oauth.md):
  GitHub's OAuth is closed to third-party clients. MCP-spec OAuth remains the
  one-click path for curated entries whose registration is open.)*
- User can add any MCP server — command or URL, with auth — as a custom entry.
- Two-state lifecycle: **active/inactive** toggles routing without touching the
  credential (the mute switch); **disconnect is the full clear** — credential,
  env, and config — identical to removing a custom server, with a curated entry
  simply returning to the catalog ready for a fresh connect. Nothing is stored
  until it can actually work: a cancelled OAuth consent means nothing was added.
- User owns the routing: which servers each agent receives is the user's
  choice, per agent, not all-or-nothing. Default ("auto"): a new server
  attaches to every agent; "only" pins an explicit list; "except" attaches to
  all minus the listed. *(Supersedes the fully-brokered auto-gate + explicit
  plug-in confirmation, 2026-07-12 — the gate conflated data-plane fidelity
  with control-plane consent; per-tool consent already rides the permission
  broker for every request_permission-routing agent.)*
- Servers are global to this machine, and a shared config never carries its
  credential — connecting is always the user's own explicit, visible act. (The
  real incident behind this rule — a production-access MCP server silently
  followed a user from one repo into another — is guarded by the
  credential-never-travels rule. Binding integrations to specific workspaces —
  workspaces, not repos — may return later as an opt-in feature; deliberately
  not built until the need is demonstrated.)

### Rules, skills, commands

- User can see and edit each agent's rules, skills, and commands from Settings —
  the files stay in the agent's own native locations, and the agent reads them
  from the workspace itself; patchbay never passes them down.
- v1 maps Claude Code and Augment locations; an unmapped agent is shown as such —
  never silently skipped.

### Permissions

- User can define permission rules once — command allowlists, file-write scope —
  and they apply identically to every agent and every integration.
- Command rules layer: machine-level defaults (every workspace on this machine)
  with per-workspace rules evaluated first — a workspace can tighten or loosen
  its own floor, and no rule anywhere means ask. Neither layer ever rides the
  repo.

### Configuration placement

- Configuration (agents, integrations, routing) lives in developer-owned stores,
  global to this machine — never a repo-committed file. Sharing a config entry is
  an explicit copy (Share…); credentials are never in what's shared, never
  displayed, and revocable at any time. *(Supersedes the earlier
  "configuration as repo-shareable files" design — the workspace config file is
  gone, and with it the possibility of a repo arriving pre-configured.)*

## 3. Editor Surface

- Agents that route file changes through patchbay get native diff views — user
  accepts or rejects before anything touches disk. The capability matrix shows
  which agents deliver this brokered tier row by row; for agents that write on
  their own, the matrix's honest ◌ cells and live terminal visibility carry the
  honesty in v1.
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

- ~~Default agent~~ — superseded by the per-agent auto-connect flag (Settings
  § Agents): the setting's one semantic, connect an agent on window open,
  generalized to any number of agents. An existing `acpPatchbay.defaultAgent`
  value is migrated onto its agent's config automatically on activate.
- Telemetry opt-in.
- Nothing else unless it proves to be a genuinely flat scalar. Never credentials.
