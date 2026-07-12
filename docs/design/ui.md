# UI — areas, icons, behaviors

Binding companion to [agent-view-mockup.html](agent-view-mockup.html) and
[settings-mockup.html](settings-mockup.html). **The mockups illustrate; this file
binds.** Anything visible in a mockup but absent here is a mockup artifact (demo
bar, canned data), not a requirement. Kept 1:1 with the mockups — a control that
appears in one and not the other is a bug in whichever lags.

*How* these surfaces are built (component layer, chat transcript rendering
pipeline, theme bridge) is [ui-rendering-strategy.md](ui-rendering-strategy.md) —
this file says what each surface does; that one says what it's made of.

## Shared vocabulary

| Element | Appearance | Meaning |
|---|---|---|
| Status dot | ● green (glow) / red / amber (pulsing) / gray / ○ hollow | agent running / crashed / reconnecting / stopped / untested (configured, never connected — P16) |
| Fidelity chip | `fully brokered` green · `partially brokered` amber · `acts outside` red | pure function of the used capability matrix — never hand-assigned |
| Matrix states | ● / ◌ / — | used / declared but not used / not declared |
| Lit (teal) | accent color on a chip or control | active or available *right now* (external root plugged, live selection exists) |
| `emulated` badge | amber outline | continuation or branch seeded by patchbay, not replayed natively — always labeled |
| `⑂ branch` badge | teal outline | branched session; names its parent |
| Toast | transient strip, bottom-center | confirmation of an action; never the only record (audit holds the durable one) |

Interaction principles that bind everywhere: UI gates on **used**, not declared ·
absence over fake (a gauge that can't be trusted is not rendered) · requested ≠
confirmed (displays update from agent state, never optimistically) · one approval
surface · a crash is visible the moment it happens and recovery is one action.

---

## Agent View (sidebar)

Vertical order: **header → session row → plan strip (conditional) → chat →
composer**. Two drawers overlay from the top. Chat is home; agents and sessions
are one gesture away — drawers, never split panels.

### 1 · Header

| Control | Glyph | Behavior |
|---|---|---|
| Agent chip | ● dot + name + ▾ | live status of the session's agent; click → **Agents drawer** |
| Sessions | 🕘 | click → **Sessions drawer** |
| New chat | ＋ | one intent, one click (P17): zero agents → Settings; exactly one → starts it directly, connecting in-pane if needed; several → Agents drawer as the picker |
| Settings | ⚙ | opens the Settings editor tab **directly** — no menu until a menu earns it |

### 2 · Session row

| Control | Behavior |
|---|---|
| Title | click → Sessions drawer; rename via kebab |
| Badges | `emulated` / `⑂ branch` per Shared vocabulary — always visible, never hover-only |
| Kebab ⋯ | rename · branch (labeled `native fork ✓` or `emulated` per used matrix) · reload from agent (re-`load` replay — rejoin truth) · close |

### 3 · Plan strip

Present **only** while the agent maintains a plan (`agent-plan` updates). One line,
sticky under the session row — survives chat scroll: `▸ Plan n/m — current step`.
Click toggles the full checklist inline (✓ done, ▸ active, ○ pending). Absent
entirely otherwise — no empty placeholder.

### 4 · Chat blocks

| Block | Glyph | Behavior |
|---|---|---|
| User message | right-aligned bubble | plain content |
| Agent text | flat, no bubble | markdown, streams live |
| Thought | 💭 collapsed line | click to expand; dimmed; never rendered as answer text |
| Plan card | 📋 | inline snapshot of the plan at that point in the transcript (the strip is the live one) |
| Tool call | 🛠 card | title + spinner while running → ✓/✗; collapsible |
| Terminal | ▣ card | command output streams live inside the card; exit status in header |
| Permission | 🛡 card | tool + exact command shown; **Allow once / Always / Reject**; resolution line notes the decision audit; when the view is hidden the same request surfaces as a native notification |
| Diff | 📝 card | file + `+n −m`, body preview; **Accept / Reject before disk is touched**; auto-accept rules change who clicks, not what is visible |
| Crash banner | ⚠ red strip | shown the moment the agent dies; `Restart` is the one action; after restart, continuation kind (native/seeded) is labeled |

### 5 · Composer

Binding rule: **above the input = what the agent will see (context, nouns);
below the input = how the turn fires (dials + dispatch).**

Context row (above):

| Control | Glyph | Behavior |
|---|---|---|
| Roots chip | ⧉ n roots | session context roots (workspace folders + added external ones); lit when an external root is active; click → manage popover; roots pass via protocol — patchbay never indexes |
| Selection ghost chip | ⌖ dashed, lit | **the live-selection indicator**: appears only while the IDE has a selection; click solidifies it into context. Editor-side twin: right-click → add to context (features §3). These two are the whole selection story |
| Context chips | 📄 ⌖ ⚠ 🖼 | attached files, solidified selection, diagnostics, images; × removes |
| Adder | ＋ dashed | one popover: Files · Selection · Problems · Roots · Attach (image/file — never disabled; converts to the best form the agent accepts) |

Input: placeholder teaches the two typed triggers; both menus navigate by
arrow/Enter/Tab/Escape with focus never leaving the input (Lexical-backed —
a textarea can't style ranges, which is what forced the editor; recorded
2026-07-09). **`/`** → advertised-commands menu (`available_commands_update`,
sent as an ordinary prompt; typed-only — a `/` *button* is a vendor-menu
pattern that doesn't apply here); an accepted command becomes an inline
token. **`@`** → context mention picker: open editors first, then workspace
files (queried from the orchestrator — render-only-webview, the input never
reads the filesystem), plus the adder's fixed rows. A picked file becomes an
inline token sent as a `resource_link` block *at its position in the prompt*
(the baseline every agent MUST accept); the fixed rows resolve to context
chips as before.

Action row (below):

| Control | Glyph | Behavior |
|---|---|---|
| Model / Mode / Effort | ◈ ⚙ ⚡ pills | **only the knobs this agent offers** — an unoffered knob does not render; change shows ⏳ until the agent's state notification confirms; display never optimistic |
| Stats strip | 💬 🛠 ✎ counts + ring | the one read-out in the dials row: whole-session prompt / tool-call / edited-file counts (view-model totals, same single pass as the rollups; files deduped across turns) and the usage gauge — ring, orange arc, arc = `used/size` from `usage_update`, live mid-turn; hover: tokens + cost; **absent** (not grayed) when usage reporting hasn't been used yet. Counts hide at zero; the whole strip is preference-gated (Preferences § Composer stats, default shown) |
| Send / Stop | ↑ / ■ | send prompt / `session/cancel` mid-turn |

### 6 · Drawers

**Agents drawer** — the picker (P17): one row per **configured** agent —
status dot · name · readiness sub-line (crash reason when crashed; else
`ready` / `never connected` / capability one-liner) · fidelity chip; clicking
the row starts a chat with it, connecting in-pane when it isn't running.
Footer: `＋ Add or manage agents — Settings…` — adding lives in Settings only
(the in-view connect form is gone, superseded 2026-07-08, features.md §1);
stop/restart are Settings troubleshooting controls plus the crash banner's
`Restart`. **Sessions drawer** — per session: live-dot (turn in flight) ·
title · agent + state subtitle · badges · kebab (same actions as session
row). Footer: `＋ New chat` (the same smart ＋).

### 7 · Chat pane states

Empty (zero agents → `Set up an agent…` → Settings; otherwise `New chat` →
the smart ＋) · connecting takeover (`Connecting {agent}…`, spinner) ·
connect-failed takeover (the specific reason + `Retry` / `Settings` /
`Dismiss`) — a failure never bounces silently back to the empty state, and a
session arriving clears the takeover (P17). The crash banner carries the
process's stderr tail inline (P16) — the reason readable without the Output
panel.

---

## Settings (editor tab)

Left nav + cards, grouped in three non-collapsing headers that *are* the
placement contract: **This machine** (Agents · Capability matrix ·
MCP Servers · Preferences — everything global to this machine,
globalState/SecretStorage), **Trust** (Permissions · Audit · Data — the one
trust surface: the contract, the evidence, what's held and the way out; one
verb per page), **This workspace** (Rules · skills · commands — files in the
workspace itself). Groups don't collapse: eight items don't earn the
interaction. Nav footer restates the credential rule: SecretStorage only.
*(Refined 2026-07-11: the interim **Transparency** group (Audit · Data)
merged into Trust — all three pages are facets of the one trust surface the
PRD promises; splitting them grouped by verb, which is the page boundary's
job, not the group's. Supersedes the earlier `.vscode/acp-patchbay.json`
workspace-config design — binding to workspaces, not repos, may return later
as an opt-in.)*

### Agents

Stat tiles (agents / running / sessions today), auto-width, with an
`add agent` tile-button riding the same row — same box as the counters, but
it reads as an action (accent ＋, hover lift). Collapsed by default once any
agent exists, open by default on first run (nothing to collapse to yet).
Toggling reveals the Add Agent card; adding one collapses it back.

Add Agent card: one mode at a time behind a toggle, never a roster field and a
command field half-filled together — a searchable combobox (type to filter,
click to pick, ✕ to clear) or a custom command line. Buttons in order: `Add`
(submits whichever mode is active) · the mode toggle itself (`Add custom…` in
roster mode, `Add from list` in custom mode) · `Verify after add` checkbox.

Per-agent card: launch command (mono) · `✎ Edit` (launch config + env) ·
`Remove` · process policy select — `auto` states its reason (`shared, concurrency
used ✓` vs `isolated, not yet used`) · default knobs render **exactly what the
agent offered**: the mode selector (when modes exist) plus one select per
offered config option, keyed by the option's own id — category is UX-only in
ACP ("MUST NOT be required for correctness"), so it only decorates with an
icon when reported; boolean options render a tri-state default (agent default /
on / off). Offerings are connection state (architecture.md § Session model:
read fresh at every connect via the probe's session/new, never persisted), so
the card states exactly one honest fact per situation: stopped → the stored
selections as text (`saved defaults: … — connect to edit`); connected with the
offering read still in flight → `reading this agent's knob offering…`; an agent
that offered nothing reads `this agent offered no session knobs`, and saved
selections the current connection doesn't offer are stated rather than
silently blanked · Stop · `Diagnostics…` → modal that
**discloses cost before running** (behavior probes consume real turns; ephemeral
session in a temp directory — never the workspace). Crashed card: red note with
time + one `Restart` + the process's stderr tail (mono, scrolling — P16); an
initialize timeout names interactive first-run setup as the likely cause. A
never-connected config shows the hollow `untested` dot with a `Connect`
button, never a claimed `stopped`.

`Diagnostics…`'s card-level trigger (`Verify…`) shows only while
`hasUnusedProbe` (protocol.ts) says a checkable row is still outstanding
for the current `agentInfo.version`, or the agent needs auth — the same
predicate the connect/reconnect auto-retry gates on (architecture.md § Agent
capability matrix), so the manual control can't drift from what the automatic
one already covers. Once a version is fully used, reconnecting restores
that instantly from the persisted cache and the button stays hidden — nothing
to do. While a Verify round-trip (manual or "Verify after add") is in flight,
the trigger dims and reads `Verifying…` — no separate status line, the button
itself is the state.

### Capability matrix

Legend ● ◌ — · one column per agent · a reconnected agent wears a `reset <time>`
chip (used resets on every reconnect). Protocol rows from the handshake;
separated **patchbay-side** row (`rules/skills/commands locations`) sourced from
roster data. Rows are hand-picked against the ACP spec's declared capability
surface, not derived automatically — noted above the table. Cell tooltips
explain consequences ("not declared — branching is emulated, labeled"). Footer
note: behavior rows get marked used opportunistically during real use;
synthetic probes only via Diagnostics; never on a schedule.

### MCP Servers

*(Renamed from "Integrations" — they are MCP servers, say so. Internally the
record type stays `integration` because the ACP SDK owns the name `McpServer`
for the wire config we hand agents — two different things, two names, the
contract recorded in architecture.md § Terms.)*

Order is the working set first: **Connected servers** on top (dot ·
name · `curated`/`custom-*` chip · **active toggle** · `Share config…` ·
`Disconnect` for curated / `Remove` for custom · mono command/URL · routing ·
`Edit JSON…` for custom entries — the mcpServers-fragment, env values
write-only: `""` keeps, filled overwrites, removed deletes), then **Add
custom** (structured fields: display name, command, args one-per-line, env
`KEY=value` lines — the id is generated, a slug of the name, never
user-typed; or `Import JSON…` accepting the well-known
`{"mcpServers": {...}}` shape, per-entry failures labeled), then the
**Curated catalog** last: compact one-line rows (name · `key`/`OAuth`/`local`
chips · Docs · `Connect…`), one row expanding at a time into its connect
form — key paste (with a `Get a key ↗` link to the issuing page) `— or —`
OAuth `— or run it locally —` (verified official local stdio servers —
GitHub, Stripe, Sentry, Supabase, Augment — prefill the custom form; nothing
runs until the user adds it). Per-account services label the URL field as
what it is: the account's MCP endpoint, used by both connect paths. A
pending browser flow shows `Cancel` (an abandoned tab must not mean
forever-pending — cancel clears with no outcome invented, and a 10-minute
timeout backstops it); failed notes carry `Dismiss`.

Lifecycle, two-state: **active/inactive** is the mute switch (config and
credential intact, the server reaches no agent until toggled back);
**Disconnect is the full clear** (credential + env + config — identical to
removing a custom server; a curated entry simply reappears in the catalog,
ready for a fresh connect). No third state: a custom OAuth add runs the
browser flow *before* storing anything, so cancelled consent means nothing
was added — never a stranded credential-less record.

**Routing table**: servers × agents as toggles; toggling onto a
less-than-fully-brokered agent interrupts with the **explicit plug-in
confirmation** (auto-attach covers fully-brokered only). Per-server
`Share…` — the explicit, visible act of copying its config for someone else;
the credential never travels with it, reattaching only when its recipient
explicitly connects. Servers are global to this machine. *(The real
incident that shaped this — a production-access MCP server silently following
a user between repos — is guarded by the credential-never-travels rule, not by
workspace-scoping the config; binding to workspaces, not repos, may return
later as an opt-in feature.)*

### Preferences

Machine-scoped behavior defaults (stores/preferences.ts — globalState,
non-sensitive), four cards, each a full read of the stored truth
(`setPreferences` patch out, `preferencesChanged` whole-object back — the
page never assumes its own write landed; the same event feeds the agent
view, whose composer gates its stats strip on it):

- **Turn end** — done-sound toggle (default off). Host-side player
  (sound.ts), never webview audio: webviews die when hidden, and the chime
  matters most when the user is looking elsewhere. OS system chime, no
  bundled asset; a cancelled turn never chimes; under WSL the sound plays
  through Windows interop on the machine the user actually sits at.
- **New sessions** — knob seed source: `agent defaults` (the config's saved
  defaults, as before) or `last used` (the last agent-confirmed combination,
  recorded per agent at the session-manager's one knob-state exit —
  stores/last-knobs.ts; falls back to the defaults when none). Either way
  the seed rides knobs.ts routing, so a stale knob is skipped, never forced.
- **Idle sessions** — the reaper's timer (reapIdle condition 5) in minutes,
  default 60, `0` disables; read fresh every sweep, applies without
  reconnect. The card restates the reaper's honesty guards: replayable
  history only, never the open session, an unseen result, or a turn in
  flight.
- **Composer stats** — show/hide the composer's session-stats strip
  (default shown). Pure render furniture: hiding it stores nothing less,
  changes nothing else.

### Permissions

Command rules in **two layers**, one card each, identical shape (`pattern →
allow / ask / deny` + add row): *this workspace* (workspaceState, evaluated
first — the repo's own tightening or loosening) and *this machine*
(globalState, the fallback floor for every workspace — consulted only where
the workspace layer stays silent; no rule anywhere means ask). File-write
scope radios (workspace only / + temp / always ask) with the note that writes
surface as diffs regardless — file-write scope has no machine layer, it's
defined relative to the current workspace root. The placement statement in
green: **workspace rules in workspaceState, machine rules in global storage —
never in the repo either way; a cloned repository cannot arrive
pre-authorized.** Decision audit: recent entries, mono, append-only. *(The
adoption row this section once specified is gone with the workspace config
file it guarded — agent configs are global and developer-owned now, so no
repo-authored launch command exists to adopt.)* Last card: **Disconnect &
erase all data** (P18) — AlertDialog-confirmed; states what dies (every
process now; configs, credentials, caches, rules, session records
permanently) and the reach limit (other workspaces' records need their own
window). Explicit and user-triggered, never a lifecycle side effect.

### Rules · skills · commands

Per-agent cards for **mapped** agents: native paths (mono) + counts + ✎ edit in
place — files stay in the agent's own locations, the agent reads its own `cwd`.
Unmapped agent card states it plainly (`not mapped — locations unknown, never
guessed`). Footer note: shared source / symlinks (dotagent pattern) is parked, v2.
