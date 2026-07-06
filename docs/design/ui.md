# UI — areas, icons, behaviors

Binding companion to [agent-view-mockup.html](agent-view-mockup.html) and
[settings-mockup.html](settings-mockup.html). **The mockups illustrate; this file
binds.** Anything visible in a mockup but absent here is a mockup artifact (demo
bar, canned data), not a requirement. Kept 1:1 with the mockups — a control that
appears in one and not the other is a bug in whichever lags.

## Shared vocabulary

| Element | Appearance | Meaning |
|---|---|---|
| Status dot | ● green (glow) / red / amber (pulsing) / gray | agent running / crashed / reconnecting / stopped |
| Fidelity chip | `fully brokered` green · `partially brokered` amber · `acts outside` red | pure function of the verified capability matrix — never hand-assigned |
| Matrix states | ● / ◌ / — | verified working / declared but unverified / not declared |
| Lit (teal) | accent color on a chip or control | active or available *right now* (external root plugged, live selection exists) |
| `emulated` badge | amber outline | continuation or branch seeded by patchbay, not replayed natively — always labeled |
| `⑂ branch` badge | teal outline | branched session; names its parent |
| Toast | transient strip, bottom-center | confirmation of an action; never the only record (audit holds the durable one) |

Interaction principles that bind everywhere: UI gates on **verified**, not declared ·
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
| Usage gauge | ring, orange arc | arc = `used/size` from `usage_update`, live mid-turn; hover: tokens + cost; **absent** (not grayed) when usage reporting is unverified |
| Sessions | 🕘 | click → **Sessions drawer** |
| New session | ＋ | agent picker (roster + custom command), then empty session |
| Settings | ⚙ | opens the Settings editor tab **directly** — no menu until a menu earns it |

### 2 · Session row

| Control | Behavior |
|---|---|
| Title | click → Sessions drawer; rename via kebab |
| Badges | `emulated` / `⑂ branch` per Shared vocabulary — always visible, never hover-only |
| Kebab ⋯ | rename · branch (labeled `native fork ✓` or `emulated` per verified matrix) · reload from agent (re-`load` replay — rejoin truth) · close |

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

Input: placeholder teaches the two typed triggers. **`/`** → advertised-commands
menu (`available_commands_update`, sent as an ordinary prompt; typed-only — a `/`
*button* is a vendor-menu pattern that doesn't apply here). **`@`** → context
mention picker (resolves to standard content blocks — works for every agent).

Action row (below):

| Control | Glyph | Behavior |
|---|---|---|
| Model / Mode / Effort | ◈ ⚙ ⚡ pills | **only the knobs this agent offers** — an unoffered knob does not render; change shows ⏳ until the agent's state notification confirms; display never optimistic |
| Send / Stop | ↑ / ■ | send prompt / `session/cancel` mid-turn |

### 6 · Drawers

**Agents drawer** — per agent: status dot · name · capability one-liner ·
fidelity chip · `Restart` button inline when crashed. Footer: `＋ Connect agent`
(roster or custom command). **Sessions drawer** — per session: live-dot (turn in
flight) · title · agent + state subtitle · badges · kebab (same actions as
session row). Footer: `＋ New session`.

---

## Settings (editor tab)

Left nav + cards. Nav footer pins the placement contract: workspace config is
`.vscode/acp-patchbay.json`, credentials in SecretStorage only — never in the file.

### Agents

Stat tiles (connected / running / sessions today). Per-agent card: launch command
(mono) · `✎ Edit` (launch config + defaults) · `Remove` · process policy select — `auto` states its reason (`shared, concurrency
verified ✓` vs `isolated, unverified`) · default knobs **only where offered**
(unoffered renders disabled `— not offered`) · Stop · `Diagnostics…` → modal that
**discloses cost before running** (behavior probes consume real turns; ephemeral
session in a temp directory — never the workspace). Crashed card: red note with
time + one `Restart`. Add-agent row: roster select or custom command.

### Capability matrix

Legend ● ◌ — · one column per agent · a reconnected agent wears a `reset <time>`
chip (verified resets on every reconnect). Protocol rows from the handshake;
separated **patchbay-side** row (`rules/skills/commands locations`) sourced from
roster data. Cell tooltips explain consequences ("not declared — branching is
emulated, labeled"). Footer note: behavior rows verify opportunistically during
real use; synthetic probes only via Diagnostics; never on a schedule.

### Integrations

Curated cards: each registry entry offers exactly the connect mechanisms its
vendor opens (docs/reference-mcp-oauth.md — the device-flow modal this section
originally specified is superseded by that decision): **key paste** (hint
names where the key comes from; per-account services take an endpoint URL
first) and/or **`Connect with OAuth…`** (browser; MCP-spec OAuth where DCR is
open — a gated-DCR rejection surfaces as an immediate labeled failure).
Token → SecretStorage, revocable. Custom card: command shown mono, `Remove`. Add row: command/URL + auth type.
**Routing table**: integrations × agents as toggles; toggling onto a
less-than-fully-brokered agent interrupts with the **explicit plug-in
confirmation** (auto-attach covers fully-brokered only). Per-integration
`Share…` — the explicit, visible act of copying its config into another
workspace; the credential reattaches only on confirm. Workspace-scope warning
cites the real incident (a production-access MCP server following a user between
repos).

### Permissions

Command rules list (`pattern → allow / ask / deny`) + add row. File-write scope
radios (workspace only / + temp / always ask) with the note that writes surface
as diffs regardless. The placement statement in green: **rules live in
workspaceState — per user, per workspace, never in the repo; a cloned repository
cannot arrive pre-authorized.** Workspace-defined agents: adoption row showing
the full launch command with one-time `Adopt…` behind workspace trust. Decision
audit: recent entries, mono, append-only.

### Rules · skills · commands

Per-agent cards for **mapped** agents: native paths (mono) + counts + ✎ edit in
place — files stay in the agent's own locations, the agent reads its own `cwd`.
Unmapped agent card states it plainly (`not mapped — locations unknown, never
guessed`). Footer note: shared source / symlinks (dotagent pattern) is parked, v2.
