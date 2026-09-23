# acp-patchbay — Feature Inventory

What must be possible, stated as capabilities — not how, not which component. Sits
between [prd.md](prd.md) (why) and [architecture.md](architecture.md) (how). Every
feature here is in the current release; what is deliberately beyond it is in
[roadmap.md](roadmap.md).

---

## 1. Agent View (sidebar)

Agents, sessions, and chat are one surface, not three stacked panels. The user lives
in the chat; the active agent's status and the session list are one gesture away,
never a navigation maze. The layout that blends them is a first-class design
deliverable.

### Agents

- Starting a chat is one intent, one click: "+" with a single configured
  agent goes straight to it — connecting first, inside the chat pane, when it
  isn't running; with several, a picker lists every configured agent with its
  readiness inline. A connection failure surfaces in that same pane with the
  specific reason and a Retry — never a silent bounce to the empty state.
- Adding an agent is one form in Settings › Agents — registry search or any
  command line that speaks ACP — with a command-palette shortcut for the quick
  case; a binary agent's download is a phase of its connect, shown on its card
  and confirmed by one modal — never a silent fetch-and-run. The view's picker
  and empty state route to Settings.
- User can see each agent's live status: untested (configured, never
  connected), running, stopped, crashed, reconnecting — every configured
  agent is visible from the first frame, not only once connected.
- A crash is visible the moment it happens, with its reason and the process's
  own stderr inline; recovery is one action (the crash banner's Restart).
  Stop/restart beyond that are Settings troubleshooting controls — the
  process is never the user's chore: it starts when a session needs it and
  stays warm for the next one.
- After reconnect, a session continues natively where the agent supports it:
  `session/load` (full replay) or `session/resume` (context back, no visible
  history — said so with an inline notice). Where it supports neither, the
  session honestly cannot be reopened — patchbay never mints a new session and
  presents it as a continuation.

### Sessions

- User can create a session with any configured agent — connection is the
  flow's job, not a prerequisite the user manages.
- Multiple sessions run concurrently — same agent or different agents, side by side.
- Sessions are cheap to create and never a process-management chore: whether
  concurrent sessions share one agent process or get isolated ones is per-agent
  policy (Settings), decided by used concurrent-session behavior in `auto` mode.
- A brand-new session knows it is new: clicking "new session" for an agent that
  already has a never-prompted session focuses that one instead of minting a
  sibling — after a crash too: the row is still the new session, and its next
  use brings it back with everything staged on it. The first prompt is what
  ends newness.
- User can switch and close sessions. Switching never closes the session being
  left. An idle session releases its agent-side resources on its own (row
  kept, reopened on the next click) only when nothing can be lost: never a new
  session, never mid-turn, never one with a result not yet seen or words still
  held, and only where the agent can bring it back with full replay — patchbay
  persists no transcript to fall back on. The idle time is a user setting;
  zero disables it.
- Renaming lives in the agent, not patchbay: ACP has no rename request, so
  agents with an in-chat `/rename` round-trip the title through their own
  `session/list` / `session_info_update` — which patchbay always honors.
- Branching is out of the current release. `session/fork` stays a
  capability-matrix row; no UI feature rides it yet.
- The agent owns the sessions — 100%. The agent's own `session/list` is the
  only session list; patchbay persists no session index and no transcripts.
  What patchbay holds: a **decision audit** (permissions
  granted, tools approved, routing chosen — those events happened in patchbay
  and belong to it) and an in-memory **render cache** — disposable, rebuilt
  wholesale from `session/load` replay on every reopen, never merged. Replay
  always wins; there is no reconciliation logic anywhere. Agents without
  `session/list` show only their currently-open sessions, and nothing survives
  a reload — a deliberate scope decision, not a limitation — and the Sessions
  drawer names each such agent, so the missing history is explained where it
  is felt.
- A session continued outside patchbay (the agent's own CLI, another editor) simply
  appears complete on reopen — the replay carries the detour, because the truth was
  never patchbay's.
- Live edge: if a session stays connected in the editor while being continued
  elsewhere, no protocol signal announces the external turns — the connected agent
  process itself has forked from its own store. Patchbay offers one-click session
  reload (re-`load` from the agent) to rejoin truth. Driving one session from two
  places simultaneously is agent-side undefined behavior, out of scope and stated
  as such.
- Opening a closed session rides the ladder: a never-prompted session is
  minted again (the agent holds nothing for it; the draft, chips, held words,
  title, and knob choices carry over) > `session/load` (replay = truth) >
  `session/resume` (context live, a notice says history can't be shown) >
  cannot open — nothing in hand, nothing to fetch, said as such.
- User can see and change the session's model, mode, and effort when the agent
  offers them, and the result reflects what the agent confirmed — never what
  was merely requested.

### Chat

- Responses stream live, including tool calls, thoughts, and plans as the agent
  reports them.
- When the agent maintains a task list / plan, the user can follow it live
  alongside the chat.
- User can paste an image and any agent receives it in the best form it supports —
  paste is never disabled.
- User can attach files by paste, by picker, or by dropping from the OS with
  Shift held (without Shift, VS Code takes the drop for itself). Editor tabs
  and Explorer entries cannot be dropped onto the composer — VS Code blocks
  every webview for the duration of an in-window drag — so open editors and
  workspace files are reached through `@` in the prompt.
- User can explicitly add editor state to the prompt: current selection, current
  file, diagnostics.
- The open workspace's folders are the session's context roots, and the user
  can add external ones (the backend repo while working in the frontend).
  Shown as a chip — added ones removable, workspace folders fixed — and
  handed to the agent through the protocol where it supports that, and to
  the session's MCP servers regardless. The chip says, per root, who holds
  it: the servers always; the agent now, at its next open, or never — never
  pretending. Folders the user always works with are saved once — for this
  workspace (the default) or for every workspace — and every new session
  starts with them; managed in Settings, with a one-click save from the chip.
  A session owns its list once started: saving shapes new sessions, never an
  open one. A root whose folder is gone is skipped whenever a session starts
  or reopens, and the session says so; a saved one is flagged in Settings as
  needing the user's action. Roots another client set on the same session show up here, where the
  agent reports them. What the agent's engine does with roots is the
  agent's business — patchbay passes, it does not index.
- Slash commands the agent advertises are discoverable and invokable in the input.
- Permission requests appear inline with the choices the requester actually
  offers — the agent's own options verbatim, patchbay's own for the gates it
  runs — and are impossible to miss when the view is hidden.
- Context/token usage is shown when the agent reports it and cleanly absent when it
  doesn't — never a fake number.
- User can stop a running turn at any time.

## 2. Settings Page

### Agents

- User can add, edit, and remove agents, including launch configuration per agent.
- Capability matrix: every agent × every capability, honest states only — not
  declared / declared but never exercised / exercised on the wire / suspect
  (the path that should have proven it failed). Claims refresh on every
  connect; proof is remembered per agent version, never invented. Rows are
  hand-picked against the ACP spec's declared capability surface, not derived
  automatically.
- User can run explicit diagnostics against an agent; the cost (real agent turns)
  is disclosed before running.
- User can set per-agent process policy: auto / shared / isolated.
- User can mark an agent auto-connect: it connects on every window open.
  Independently of the flag, a window reload restores whatever agents were
  still running when the window went down — a manually connected agent
  survives reload but not quit-and-reopen-later (the running set is stamped
  at shutdown and honored only while fresh).
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
  disconnect as easily. Curated entries whose registration is open connect with
  one-click OAuth instead.
- User can add any MCP server — command or URL, with auth — as a custom entry.
- Two-state lifecycle: **active/inactive** toggles routing without touching the
  credential (the mute switch); **disconnect is the full clear** — credential,
  env, and config — identical to removing a custom server, with a curated entry
  simply returning to the catalog ready for a fresh connect. Nothing is stored
  until it can actually work: a cancelled OAuth consent means nothing was added.
- User owns the routing: which servers each agent receives is the user's
  choice, per agent, not all-or-nothing. Default ("auto"): a new server
  attaches to every agent; "only" pins an explicit list; "except" attaches to
  all minus the listed.
- Servers are global to this machine and never ride a repo — a config moves
  only by the owner's explicit Copy and paste, and nothing attaches by opening
  a folder (a production-access server must never follow a user from one repo
  into another). Binding integrations to specific workspaces is deliberately
  not built until the need is demonstrated.

### Permissions

- User can define permission rules once — command allowlists, file-write scope —
  one rule set for everything patchbay gates, never scoped per agent.
- Command rules layer: machine-level defaults (every workspace on this machine)
  with per-workspace rules evaluated first — a workspace can tighten or loosen
  its own floor, and no rule anywhere means ask. Neither layer ever rides the
  repo.

### Configuration placement

- Configuration (agents, integrations, routing) lives in developer-owned stores,
  global to this machine — never a repo-committed file. Sharing an integration
  is an explicit copy (Copy config, in the well-known `mcpServers` shape);
  agents are entered, never exported. What the owner typed — env values, a
  header API key — is readable in the edit forms and rides the copy; an OAuth
  token, minted by a login flow, never shows and never copies. Everything is
  revocable at any time.

## 3. Editor Surface

- Agents that route file changes through patchbay get a diff to accept or
  reject before anything touches disk — inline in the chat, with the full
  change one click away in the editor's own diff view. The capability matrix
  shows which agents deliver this brokered tier row by row; for agents that
  write on their own, the matrix's honest not-declared cells and live terminal
  visibility carry the honesty in the current release.
- The agent sees what the user sees: unsaved buffers, not just disk state.
- The agent can read the problems panel (diagnostics) — current, not stale.
- Right-click on a selection: add it to the prompt's context.
- Status bar shows the active session, connection health, and usage when available;
  clicking it jumps to the session.
- Command palette covers every core action: new session, switch session, connect
  agent, open settings.
- Permission prompts surface as native notifications when the chat view is hidden —
  one approval surface, wherever the user happens to be looking.
- Commands the agent runs are visible live — output streams where the user can
  watch, gated by the same permission rules as everything else.

## 4. VS Code Native Settings

Deliberately empty: nothing is contributed. A native setting earns its place
only as a genuinely flat scalar, searchable in the standard Settings UI. Never
credentials.
