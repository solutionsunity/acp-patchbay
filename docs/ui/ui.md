# UI — areas, icons, behaviors

Binding companion to [agent-view-mockup.html](agent-view-mockup.html) and
[settings-mockup.html](settings-mockup.html). **The mockups illustrate; this file
binds.** Anything visible in a mockup but absent here is a mockup artifact (demo
bar, canned data), not a requirement. Kept 1:1 with the mockups — a control that
appears in one and not the other is a bug in whichever lags.

*How* these surfaces are built is [the UI Architecture
doc](ui-architecture.md) — this file says what each surface does; that one says
what it's made of.

## Shared vocabulary

| Element | Appearance | Meaning |
|---|---|---|
| Status dot | ● green (glow) / red / amber (pulsing) / gray / ○ hollow | agent running / crashed / reconnecting / stopped / untested (configured, never connected) |
| Session mark | ● amber (pulsing) / green (pulsing) / blue | waiting on you / turn underway / finished while no visible surface showed it — one per session, most urgent first |
| Matrix states | ● / ◌ / — | used / declared but not used / not declared |
| Lit (teal) | accent color on a chip or control | active or available *right now* (external root plugged, live selection exists) |
| Toast | transient strip, bottom-center | confirmation of an action; never the only record (the audit holds the durable one) |

Interaction principles that bind everywhere: UI gates on **used**, not declared ·
absence over fake (a gauge that can't be trusted is not rendered) · requested ≠
confirmed (displays update from agent state, never optimistically) · one approval
surface · a crash is visible the moment it happens and recovery is one action.

---

## Agent View (sidebar)

Vertical order: **header → session row → chat → read-out strip (conditional) →
composer**. Two drawers overlay from the top; the read-out strip's panels overlay
from the bottom. Chat is home; agents and sessions are one gesture away — drawers,
never split panels.

### 1 · Header

| Control | Glyph | Behavior |
|---|---|---|
| Agent chip | ● dot + name (+ ⬆ version) | live status of the session's agent — a read-out, not a picker. While the agent has a newer registry version, an amber `⬆ 1.2.0` chip inside it upgrades on click (asking first when open conversations would be disconnected) |
| Other sessions | ● n per session mark, centered in the header | appears only when a session other than the ones on screen is waiting on you, finished unseen, or running; one trigger — click → a list grouped waiting / finished / running (a waiting row names what it is blocked on); a row opens that session. Always the list, even for one: the counts move, and the list names the session before the user leaves the one they are reading |
| Sessions | 🕘 | click → **Sessions drawer** |
| New chat | ＋ | one intent, one click: zero agents → Settings; exactly one → starts it directly, connecting in-pane if needed; several → Agents drawer as the picker |
| Settings | ⚙ | opens the Settings editor tab **directly** — no menu until a menu earns it |

### 2 · Session row

| Control | Behavior |
|---|---|
| Title | click → Sessions drawer |
| Forked from | a fork's line under the title row: `Forked from ‹original›` opens the original; `Forked from a session no longer listed` once the list no longer names it |
| Kebab ⋯ | open in new window (when detached windows are on) · reload from agent (rejoin truth) · copy session ID · **Fork** where the agent declares `session/fork` — a new session carrying this one's history opens, and this one stays as it is · **Delete…** where the agent declares `session/delete` — asks first, then the agent removes the session from its history and patchbay forgets what it kept for it; a refusal says why and keeps it · **Close** where the agent declares `session/close` — its work stops and it leaves the list, keeping everything patchbay saved for it; an agent that lists its sessions lists it again the next time the history is read. The same menu sits on every row of the Sessions drawer |

### 3 · Read-out strip

One row between chat and composer — live-turn read-outs at the eye's resting
point, deliberately **outside** the composer: its binding rule ("above the input =
what the agent will see") stays intact because nothing here is context. The strip
holds what the agent has done this session — its plan and the files it edited;
it is absent while neither exists — no placeholder.

| Chip | Where | Behavior |
|---|---|---|
| Plan | left | `▸ Plan n/m — current step`, truncating; present only while the agent maintains a plan with >1 tasks; a task completing mid-turn pulses the chip — expand is manual, never forced |
| Files | right | `✎ n files edited` — present once the agent has touched a file; a way in, not a read-out, so no preference hides it |

A chip opens its panel overlaying the chat, growing up from the strip at the
strip's full width (the drawers' mechanic, mirrored) — X, Escape, re-click, or a
click elsewhere closes; one panel is open at a time, so opening the other chip's
panel closes this one. Plan panel: the full checklist (✓ done, ▸ active, ○
pending, ⊘ cancelled; any other status word shows beside its task). Files
panel: one row per file the agent edited, click opens it in the
editor; a dot marks a file whose open editor holds unsaved changes — editor
reality, never a stored flag. It lists files and never counts lines: a change is
counted only on the tool card of the edit that reported it, because a file the
agent writes itself leaves patchbay no trustworthy "before" to measure a
session's worth of change against.

### 4 · Chat blocks

| Block | Glyph | Behavior |
|---|---|---|
| User message | right-aligned bubble | plain content |
| Agent text | flat, no bubble | markdown, streams live |
| Thought | 💭 collapsed line | click to expand; dimmed; never rendered as answer text |
| Meant for the model | dim line | content the agent addressed to the model alone (its audience names no user) — `meant for the model`, and the content as it renders on a click; never woven into the agent's prose |
| Shown as sent | ⓘ dim line | an update kind patchbay gives no surface yet: `‹kind› · not shown here`, and what the agent sent on a click — never dropped |
| Tool call | 🛠 card | title + the first reported file as a link (`name:line`, **+N** for the others) + the lines the call's diffs add and remove (**+a −d**) + spinner while running → ✓/✗. The link opens the file at the line the agent named; the ± opens the edit in VS Code's native diff editor — or, when several files carry a diff, the details; the rest of the header toggles details. The count is what the agent reported, whole file or changed regions, each against its own counterpart. Details: one row per file — name, each reported line, folder relative to the workspace, its own **+a −d** (opening its diff) when the call carried one — listed only when it says more than the header; then what the tool produced for the user (the agent's markdown, images, embedded files), then a collapsed **raw** toggle with the wire input and output. A terminal the call runs in shows inside the card, always visible, never as a separate block |
| Terminal | ▣ card | command output streams live inside the card; exit status in header — the code, or the signal that ended a killed command; inside a tool card, a terminal patchbay didn't run here says so |
| Permission | 🛡 card | tool + exact command shown (argument boundaries kept); a terminal card also lists its cwd and each env var the agent sets, handed-out values masked; an agent's own request shows the call it asks about as the tool card's details do — its files with each diff's **+a −d** (opening VS Code's diff editor), what it produced, and its raw input, open while pending; a request a rule allows shows its card settled ("Allowed (rule)"); a request the agent takes back reads "Withdrawn by the agent"; **Allow once / Always / Reject**; resolution line notes the decision audit; when no visible surface shows the session the same request surfaces as a native notification, whose buttons answer it too, beside **Open**, but only when its one line shows everything the card does — a request with a diff, content, input, or a command's directory and environment offers **Open** alone, and is decided at the card — answered in the card instead, the notification stays until dismissed (VS Code gives no way to close it), and its answers then do nothing |
| Question | ❓ card | "*Agent* asks:" + the agent's message; one control per field (text, number, Yes/No, choice, multi-choice), declared defaults pre-filled; **Send** stays disabled until required fields are filled and limits hold; **Decline / Cancel** reach the agent as themselves; resolution line records the outcome. The same card serves the MCP `request_user_input` tool. Off screen, a native notification names the question with **Open**, which brings the session up — the answer is given in the card, and the notification stays until dismissed (VS Code gives no way to close it) |
| Link | 🔗 card | "*Agent* asks you to open a page:" + the agent's message; the host in bold and the full address as plain text (never a clickable link), with a warning line per suspicious trait; **Open in browser / Decline / Cancel** — Open is the consent and opens the system browser; once opened, "waiting for *Agent* to finish" with **Open again** until the agent reports it done ("completed"); a question the agent takes back reads "withdrawn by the agent" |
| Diff | 📝 card | file + its **+a −d** (the tool card's count, one rendering: only the sides that moved), a bounded body preview that states how many lines it omits, and **Open diff** (VS Code's own diff editor, current vs proposed) while the proposal is open; **Accept / Reject before disk is touched**; auto-accept rules change who clicks, not what is visible; off screen, a native notification offers **Open** — the change is decided at the card, never from a line that can't show it |
| Crash banner | ⚠ red strip | shown the moment the agent dies; `Restart` is the one action; after restart, the continuation is labeled |

### 5 · Composer

**Held prompts** sit in a band above the composer: prompts sent while a turn
runs (or while the agent is signed out), in firing order. Each row shows its
words and, with a 📎 count, the chips staged when it was sent — a held prompt
sends those, never what is staged when it fires. Every row copies and
removes; the tail row takes back into the composer, its words and its chips
together.

Binding rule: **above the input = what the agent will see (context, nouns); below
the input = how the turn fires (dials + dispatch).**

Context row (above):

| Control | Glyph | Behavior |
|---|---|---|
| Roots chip | ⧉ n roots | session context roots (workspace folders + added external ones); lit when an external root is active; click → manage popover; roots pass via protocol — patchbay never indexes. Adding is always on: the session's MCP servers take a root at once. Each row names who holds it, from one gate — "agent + MCP" (the cwd always; every root where the agent takes it now), "MCP · agent at next open" (advertised, after the first turn, no `session/resume` but `session/load` — the note offers "Reopen now"), "MCP only" (the agent doesn't advertise the field, or can neither re-apply nor reopen); the note says why, and points at `@` for an agent that never takes roots. An added row also names its saved list ("saved · this workspace" / "saved · every workspace", read-only) or offers **Save** — a menu, this workspace first, disabled with no folder open; "Manage saved roots…" opens Settings › Saved roots, the one place a saved root is removed |
| Selection ghost chip | ⌖ dashed, lit | **the live-selection indicator**: appears only while the IDE has a selection; click solidifies it into context. Editor-side twin: right-click → add to context. These two are the whole selection story |
| Context chips | 📄 ⌖ ⚠ 🖼 | attached files, solidified selection, diagnostics, images; × removes |
| Adder | ＋ dashed | one popover: Files · Selection · Problems · Roots · Attach (image/file — never disabled; converts to the best form the agent accepts) |

Input: placeholder teaches the two typed triggers; both menus navigate by
arrow/Enter/Tab/Escape with focus never leaving the input. **`/`** →
advertised-commands menu (typed-only — a `/` *button* is a vendor-menu pattern
that doesn't apply here); an accepted command becomes an inline token. **`@`** →
context mention picker: open editors first, then workspace files (queried from the
orchestrator; the input never reads the filesystem), plus the adder's fixed rows.
A picked file becomes an inline token sent at its position in the prompt; the fixed
rows resolve to context chips as before. The input takes the cursor when a chat
opens for typing — a new session, a connect, a selection added from the editor, a
session revealed, the status bar item — and when a session is switched to in the
view the user is in; it never pulls focus into a view the user isn't in.

Action row (below):

| Control | Glyph | Behavior |
|---|---|---|
| Model / Mode / Effort | ◈ ⚙ ⚡ pills | **only the knobs this agent offers** — an unoffered knob does not render; a change shows ⏳ until the agent's state confirms; display never optimistic. Each option's description shows under it in the list; options sharing a name carry their description in the label (`Sonnet · Deep`), so the pill tells them apart — the Settings defaults list too |
| Stats strip | 💬 🛠 counts + ring + plan usage | the one read-out in the dials row: whole-session prompt / tool-call counts, the context gauge — ring, orange arc = `used/size`, live mid-turn; hover or keyboard focus: tokens + cost — and the plan-usage gauge (the most severe plan window, labeled; hover: every window). Gauges are **absent** (not grayed) until the agent reports them; counts hide at zero. Each of the four has its own switch (Preferences › Composer stats, all shown by default) |
| Send / Stop | ↑ / ■ | send prompt / stop the turn underway — mid-stream, or still waiting for its session to attach. A stopped turn waits for its agent's answer, the button spinning ("Stopping"); pressed again, it ends the turn here |

### 6 · Drawers

Both are sheets dropping from the top over a dimmed view: Escape, a click
outside or the ✕ closes one, the keyboard walks and picks its rows, and
focus goes back to the button that opened it.

**Agents drawer** — the picker: one row per **configured** agent — status dot ·
name · readiness sub-line (crash reason when crashed; else `ready` / `never
connected` / capability one-liner); picking the row starts a chat with it,
connecting in-pane when it isn't running. Footer: `＋ Add or manage agents —
Settings…` — adding lives in Settings only; stop/restart are Settings
troubleshooting controls plus the crash banner's `Restart`. **Sessions drawer** —
per session: session mark (waiting on you / turn underway / finished unseen) · title · agent + state subtitle · kebab
(same actions as the session row). Below the rows, one line per agent whose
handshake declared no `session/list`: `{agent} doesn't report its sessions —
only the ones open in this window are listed`. Footer: `＋ New session` (the
same smart ＋).

### 7 · Chat pane states

Empty (zero agents → `Set up an agent…` → Settings; otherwise `New chat` → the
smart ＋) · in-progress takeover (spinner + while the chat waits on its
agent, what the agent's queue runs for it: `Connecting {agent}…` with the
launch phase while it starts, `Upgrading {agent} to {version}…`,
`Restarting {agent}…`, …; `Starting a chat with {agent}…` once the agent
runs — a running agent serves a chat at once, never behind its other work)
· connect-failed takeover (the specific
reason + `Retry` / `Settings` / `Dismiss`) — a failure never bounces silently
back to the empty state, and a session arriving clears the takeover. The pane
is one place: the latest connect on demand owns it, and an earlier one whose
pane was taken stands down — its agent still comes up, its chat doesn't land. The crash banner carries the process's stderr tail inline — the reason
readable without the Output panel.

---

## Settings (editor tab)

Left nav + cards, grouped in two non-collapsing headers that *are* the placement
contract: **This machine** (Agents · Capability matrix · MCP Servers · Preferences
· Saved roots — everything global to this machine, plus Saved roots' own
per-workspace list beside its machine one), **Trust** (Permissions · Audit · Data — the
one trust surface: the contract, the evidence, what's held and the way out; one
verb per page). Groups don't collapse: eight items don't earn the interaction.
Nav footer restates the credential rule: SecretStorage only.

### Agents

Stat tiles (agents / running / active today — sessions whose last activity
falls on today, the drawer's own stamp counted), auto-width, with an `add agent`
tile-button riding the same row — same box as the counters, but it reads as an
action (accent ＋, hover lift). Collapsed by default once any agent exists, open by
default on first run (nothing to collapse to yet). Toggling reveals the Add Agent
card; adding one collapses it back.

Add Agent card: one mode at a time behind a toggle, never a registry field and a
command field half-filled together — a searchable combobox (type to filter, click
to pick, ✕ to clear) or a custom command line. Buttons in order: `Add` (submits
whichever mode is active) · the mode toggle itself (`Add custom…` in registry
mode, `Add from list` in custom mode). A
registry agent already added is listed with `— added`; adding it again adds a
second agent under a numbered name.

Per-agent card: the amber `⬆ version` upgrade chip beside the name while the
registry has a newer version than the pin — the same chip as the Agent View's,
indicator and action in one; while an upgrade runs it reads `upgrading to
{version}…` with a spinner and takes no click · launch command (mono) · `✎ Edit` (launch config + env) · `Remove`
(spins and takes no click while the agent is being removed) — no dialog of
its own: Stop, Upgrade, Remove and Log out put the host's one question, a
modal with the open conversations and running turns they would cut off,
and only when there are any; Remove always asks, since it also forgets the
agent · default knobs render **exactly what the agent
offered**: the mode selector (when modes exist) plus one select per offered config
option, keyed by the option's own id — category is UX-only in ACP, so it only
decorates with an icon when reported; boolean options render a tri-state default
(agent default / on / off). Offerings come from the agent itself, for the
defaults being edited: expanding the card opens a throwaway session seeded with
the saved defaults, every change re-reads the surface the agent answers with (a
model's own effort levels appear the moment that model is the default), and
collapsing the card ends it — never persisted, so the card states exactly one
honest fact per situation: stopped → the stored selections as text (`saved
defaults: … — connect to edit`); connected with the session still opening →
`reading this agent's knob offering…`; an agent that can't open one yet (a
latched agent before its first session) states why; an agent that offered
nothing reads `this agent offered no session knobs`, and saved selections the
current surface doesn't offer are stated rather than silently blanked · Stop —
offered whenever there is something to stop: the process, its launch (a
download included), or work the agent's queue holds; it spins while a Stop
runs and never dims; `Connect` shows only when there is nothing to stop ·
`Diagnostics…` → modal that **discloses cost before running**
(behavior probes consume real turns; ephemeral session in a temp directory — never
the workspace). Crashed card: red note with time + one `Restart` + the process's
stderr tail (mono, scrolling) — for a launcher package that couldn't install,
the launcher's own words. A connecting agent that writes something other than
ACP before its first answer names interactive first-run setup as the likely
cause, and waits until it answers or is stopped. A never-connected config shows the hollow `untested`
dot with a `Connect` button, never a claimed `stopped`.

Anything the queue holds for the agent dims the controls that would only wait
behind it (Log in, Log out); Stop never dims.

What an agent asks outside any session — its login's page to open, sent
while Log in runs — shows on its card, under the header, as the same Link or
Question card the chat shows. It stays while it waits on the user or on the
page the user opened, leaves once settled, and leaves with the connection.

### Capability matrix

Legend ● ◌ — · one column per agent · a reconnected agent wears a `handshake <time>`
chip: the time of its last handshake, when declared was read again (used carries
over while the agent's version stays the same). Protocol rows from the handshake. Rows are
hand-picked against the ACP spec's declared capability surface, not derived
automatically — noted above the table. Cell tooltips explain consequences ("not
declared — this capability is unavailable"). Footer note: behavior rows get marked
used opportunistically during real use; synthetic probes only via Diagnostics;
never on a schedule.

### MCP Servers

Order is the working set first: **Connected servers** on top (dot · name ·
`curated`/`custom-*` chip · **active toggle** · `Copy config` · `Disconnect` for
curated / `Remove` for custom · mono command/URL · routing · `Edit JSON…` for
custom entries — the mcpServers entry, env values and a header key shown as
stored and saved as written; an OAuth token never appears), then **Add custom** (structured fields:
display name, command, args one-per-line, env `KEY=value` lines — the id is
minted, never user-typed, and a name another server holds gets a number; or
`Import JSON…` accepting the
well-known `{"mcpServers": {...}}` shape, per-entry failures labeled), then the
**Curated catalog** last: a filter toolbar (search over name and description —
what the row shows, never the caveat note · the `key`/`OAuth`/`local` chips as
AND-combined toggles · `N of M` while narrowed; an emptied list offers
`Clear filter`) over compact rows (the vendor's monochrome mark, which every
entry has, in the row's own text color · name · mechanism chips · Docs · `Connect…`,
with the entry's one-line description dim underneath, whole — never truncated,
never behind a hover), one row expanding at a time into its connect form — key
paste (with a `Get a key ↗` link to the issuing page) `— or —` OAuth `— or run it
locally —` (verified official local stdio servers — GitHub, Stripe, Sentry,
Supabase, Augment — prefill the custom form; nothing runs until the user adds it).
Per-account services label the URL field as what it is: the account's MCP endpoint,
used by both connect paths. Every entry stays in the catalog: connecting one again
adds a second server (two accounts), named with a number. A pending browser flow
shows `Cancel` — the browser is waited on as long as the user takes (an MFA
prompt, a password reset, an approval step), and an abandoned tab is ended by
Cancel, which clears with no outcome invented and drops the waiting callback,
so a tab finished later changes nothing; failed notes carry `Dismiss`.

Lifecycle, two-state: **active/inactive** is the mute switch (config and credential
intact, the server reaches no agent until toggled back); **Disconnect is the full
clear** (credential + env + config — identical to removing a custom server; the
catalog entry stays, ready to connect again). No third
state: a custom OAuth add runs the browser flow *before* storing anything, so
cancelled consent means nothing was added — never a stranded credential-less
record.

**Routing table**: servers × agents as toggles — auto = every agent, only = the
ticked list, except = every agent minus the ticked. Routing is reach; consent rides
the permission broker per tool call. Per-server `Copy config` — the explicit,
visible act of copying the server as a `{"mcpServers": {name: entry}}` document,
the shape `Import JSON…` reads back and other clients take. It carries what the
owner typed — env values, a header key — and never an OAuth token; copy and paste
are the owner's explicit acts. Servers are global to this machine. Binding to
workspaces, not repos, may return later as an opt-in feature.

### Preferences

Machine-scoped behavior defaults (non-sensitive), four cards, each a full read of
the stored truth — the page never assumes its own write landed:

- **Turn end** — done-sound toggle (default off). Host-side, never webview audio:
  webviews die when hidden, and the chime matters most when the user is looking
  elsewhere. OS system chime, no bundled asset; a cancelled turn never chimes;
  under WSL the sound plays through Windows interop on the machine the user
  actually sits at.
- **New sessions** — knob seed source: `agent defaults` (the config's saved
  defaults) or `last used` (the last agent-confirmed combination, recorded per
  agent; falls back to the defaults when none). Either way a stale knob is
  skipped, never forced.
- **Idle sessions** — the idle-close timer in minutes, default 60, `0` disables;
  read fresh every sweep, applies without reconnect. The card restates the close
  guards: replayable history only, never the open session, an unseen result, or a
  turn in flight.
- **Composer stats** — one switch per read-out: prompts, tool calls, context
  window, plan usage (all shown by default). Pure render furniture: hiding one
  changes nothing else. The files chip is not among them — it is a way in, not
  a read-out, and lives in the read-out strip.

### Saved roots

The folders every new session starts with, beyond the workspace's own — two
cards, one shape (list + change + remove + `Add folder…`; add and change both
open the native folder picker, a change replacing its entry in place):
*this workspace* (the default) and *every workspace*. With no folder open the
workspace card says there is no workspace to save to. A saved folder gone
from disk carries a warning mark — needs the user's action: restore, change, or
remove;
sessions skip it meanwhile, each with a notice in its chat. The page states the
ownership rule: a session owns its list once started, so a change here reaches
new sessions only, and removing a root from one session leaves these lists
alone. The roots chip's Save writes the same lists.

### Permissions

Command rules in **two layers**, one card each, identical shape (`pattern → allow /
ask / deny` + add row, and a note that an allow rule trusts the command itself —
the cwd and env the agent runs it with ride along): *this workspace* (evaluated first — the repo's own
tightening or loosening) and *this machine* (the fallback floor for every workspace
— consulted only where the workspace layer stays silent; no rule anywhere means
ask). File-write scope radios (workspace only / + temp / always ask) with the note
that writes surface as diffs regardless — file-write scope has no machine layer,
it's defined relative to the session's granted roots (every workspace folder plus
the roots added to the session), judged by where a write lands. The placement statement in
green: **workspace rules and machine rules live in developer-owned storage, never
in the repo either way; a cloned repository cannot arrive pre-authorized.**

### Audit

Decision audit: recent entries, mono, append-only. Wire log below it, off until
confirmed.

### Data

Storage inventory: what patchbay holds on this machine. Last card, the danger zone:
**Disconnect & erase all data** — AlertDialog-confirmed; states what dies (every process now; configs,
credentials, caches, rules, saved roots, session records permanently) and the reach limit (other
workspaces' records need their own window). Explicit and user-triggered, never a
lifecycle side effect.

