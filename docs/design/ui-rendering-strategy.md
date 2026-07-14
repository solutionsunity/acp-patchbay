# UI Rendering Strategy

How the extension's UI is built: the component library shared across every webview
surface, and — specifically for the chat/agent view — how ACP `session/update`
output becomes a transcript (markdown rendering, block ordering, tool-call
interleaving, the thinking feed, and per-turn completion metadata).

## Decisions this strategy forces (recorded, not implied)

Adopting this document changes the webview stack. Two decisions ride along that
the component choices imply but don't state:

1. **The webviews move from Preact to React.** Streamdown and Radix are React
   libraries; `preact/compat` would put permanent compat risk under the two
   cornerstone dependencies. Preact's original justification — "a component
   model at zero extra toolchain cost" (plan.md § Toolchain calls) — evaporates
   with this pivot, so the decision is re-derived, not carried: React proper,
   accepting ~35 KB gzipped in a local webview where it costs nothing
   perceptible. Recorded as an amendment in plan.md.
2. **Tailwind enters the build.** shadcn components are styled with Tailwind
   tokens; the theme bridge maps VS Code CSS variables onto those tokens.
   esbuild stays (stack.md); Tailwind v4 runs alongside it as a CSS build step.
   Also CSP: we author the webview CSP ourselves — Radix needs inline `style`
   attributes (already allowed), and Shiki's default engine needs
   `wasm-unsafe-eval` *or* Streamdown configured with Shiki's JS engine; decide
   at implementation, never widen CSP silently.

What already exists vs. what's net-new — the block model below is **largely
built**: `session-manager.ts` + the `ChatBlock` reducer already produce a single
ordered timeline with tool calls updated in place by id and text blocks closed
on interruption. Net-new from this document: Streamdown markdown (chat renders
plain text today — markdown *requires* the sanitization story, since agent
output is attacker-influenceable content in a DOM-capable webview), thought
auto-collapse, sequential tool-call grouping, the streaming caret, per-turn
rollups, stop-reason chips, plan-widget refinements, and the component-layer
conversion of both webviews.

**Phasing (each phase ships and installs before the next):**
- **A — foundation**: React swap + Tailwind into esbuild + shadcn init + the
  theme bridge (written once, shared) + Codicons re-pointed (already shipped in
  the bundle). Prove on one small surface before converting anything else.
- **B — chat view**: Streamdown + the block components (tool cards, thought
  accordion, caret, grouping) on the existing block model.
- **C — per-turn metadata + plan widget** (duration is client-side timing; the
  stop reason is already on the `PromptResponse` we receive).
- **D — settings conversion, last**: the hand-built `Field`/`Toggle`/
  `ConfirmButton` map 1:1 onto shadcn `Form`/`Switch`/`AlertDialog`; the current
  hand CSS retires gradually, never in one risky sweep.

## UI Component Library (all webviews)

**One shared component layer across every webview surface** — chat, settings, and
any future surface — not a per-surface choice: **shadcn/ui** components on
**Radix UI** primitives, one theme bridge (VS Code CSS variables → shadcn/Tailwind
tokens), and **Codicons** (`@vscode/codicons`) everywhere, not a mix of icon sets
per surface.

Why this is one decision and not several: the chat view and settings view are
deliberately separate webviews (different update frequency, different data
sensitivity), but that split is about state and lifecycle, not visual identity. If
each surface picked its own component library, the extension would end up with two
button styles, two dropdown behaviors, two focus/keyboard patterns across what the
user experiences as one product.

- shadcn is not an npm dependency — its CLI copies component source directly into
  the repo (`components/ui/`), so styling can be freely overridden to track the
  active VS Code theme precisely rather than treated as a black box.
- Radix provides accessibility/interaction correctness (focus trapping, keyboard
  nav, ARIA) — load-bearing for a webview context, not a nice-to-have.
- Use Codicons, not shadcn's default Lucide icons, to match the rest of VS Code's
  own UI (source control, Copilot Chat, command palette) rather than introducing a
  second icon set. shadcn components take icons as props/children, so this is a
  per-component swap, not a rewrite.

Concretely, in the **settings webview** (agent cards, Stop/Verify/Edit/Remove
actions, process-mode and model dropdowns, "acts outside" status badges, the
capability matrix, permission allowlists):

- `Card`, `Button`, `Badge`, `Switch` — agent cards and their action rows (the
  hand-built `Toggle` and two-step `ConfirmButton` become `Switch` and
  `AlertDialog`).
- `Select` / `DropdownMenu` — process mode and the per-option default knobs.
- The sidebar keeps the shipped **3-group nav** (This machine / Trust / This
  workspace — it *is* the placement contract, ui.md § Settings); it does not
  regress to flat `Tabs`.
- `Dialog` — the "Verify..." cost-disclosure modal.
- `Table` + `Tooltip` — the capability matrix, where the declared-vs-**used**
  distinction needs to be inspectable per cell without cluttering the default view.
- `Checkbox` / `Command` — permission allowlists and a searchable list of allowed
  binaries/consoles.
- `Form` + labeled fields — the MCP/agent forms (the hand-built `Field`
  label|control rows are the layout to preserve).

In the **chat view**, this same layer covers `Accordion` (tool-call/plan
expand-collapse), `Tooltip` (completion-time hover), `Dialog` (permission prompts),
`Badge` (status chips) — see below for what sits alongside it there.

Practical notes:
- Pull only the shadcn components actually used per surface — tree-shakeable,
  same principle as the Streamdown plugins below.
- Radix renders overlays (tooltips, dropdowns, dialogs) via portals; confirm the
  portal target lives within the webview's own document and that the extension's
  CSP allows the inline `style` attributes Radix uses for positioning (no inline
  `<script>`/`eval` involved, so this is compatible with a strict CSP by default).
- The theme bridge is written once, as a shared stylesheet/module, imported by
  every webview's entry point — not duplicated per surface.

### Overlay surfaces — one behavior, one owner (decided 2026-07-13)

A transient overlay (a menu, a popover, a tooltip, a confirm dialog) is not a
`<div>` you position and toggle. It is four hard problems braided together —
**z-escaping** (rendering above whatever it overlaps regardless of stacking
context), **dismissal** (outside-click and Escape, without swallowing the next
click), **placement** (anchored to a trigger, flipping/shifting to stay
on-screen), and **focus/keyboard/ARIA**. Radix already solves all four,
uniformly, for every primitive; that is the load-bearing reason it's the
chosen primitive layer, not the component styling. So the rule:

- **Every transient overlay is a Radix primitive** — `DropdownMenu`,
  `Popover`, `Tooltip`, `ContextMenu`, `Dialog`, `Select`. Building one from a
  bare `useState(open)` + a positioned `<div>` re-implements those four
  problems by hand, always incompletely: the recurring failures we hit — a
  menu painting *behind* a drawer, a panel that only Escape (never an outside
  click) would close, a popup pinned to a fixed corner instead of the caret —
  were each a surface that opted out of Radix, not a gap in Radix.

- **App CSS never enters the `z-index ≥ 50` band.** That band is Radix's
  portal band (its content mounts at `document.body` at `z-50` to escape
  stacking contexts). An app layer that climbs into it wins the paint but
  loses the interaction: the portal's modal lock still routes pointer events
  to the now-invisible overlay, so clicks fire blind. App layers occupy the
  documented ladder below 50 (agent-view `style.css` § Z LADDER); the boundary
  is enforced by `test/z-ladder.test.ts` — a new violation fails CI, not a
  reviewer's memory.

- **Sibling overlays coordinate through one controlled open-state**, never N
  independent uncontrolled instances. A list of row-action menus rendered as N
  self-managed `DropdownMenu`s races on a cross-row click — Radix defers an
  outside-pointerdown dismiss to the following `click`, which reaches the
  next row's open handler first, so the fresh open is then stomped by the
  stale dismiss. Lift to a single `openId`, and guard the close so only the
  currently-open row can clear it.

- **The one recorded exception is editor-anchored autocomplete** — the
  composer's `/` and `@` menus. These *cannot* be a `DropdownMenu`/`Popover`,
  because those move focus into the overlay (FocusScope + roving tabindex),
  which breaks typing; the caret must stay in the editor while the list is
  open (the combobox pattern, which Radix ships no primitive for). There, and
  only there, the interaction is hand-rolled — but the **placement still is
  not**: it uses `@floating-ui/react` (the same engine Radix wraps internally
  via `@radix-ui/react-popper`), a virtual anchor at the caret rect with
  `flip`/`shift`/`size` middleware. The result is that no bespoke
  popup-positioning math exists anywhere in the tree; the exception is scoped
  to *focus behavior*, not to reinventing collision handling.

Flag as an architecture violation, in review: a webview overlay assembled from
raw open-state + a positioned `<div>`; a hand-written outside-click or Escape
handler; an app `z-index ≥ 50`; or popup positioning math written outside the
Radix / Floating-UI path.

### Control logic — derived once, rendered dumb (decided 2026-07-14)

A control cluster (a card's action row, a toolbar, any group of buttons whose
show/disabled/label rules read shared state) is not a set of inline JSX
conditionals. The chat view already votes for the alternative:
`agent-view/chat/view-model.ts` is "the ONE derivation between reducer state
and chat components — components consume the result and stay dumb." The
settings agents card was the surface that never got this, and it produced
three shipped bugs in one week — Verify surviving logout (predicate drift
between two buttons), the logout `AlertDialog` unmounted mid-close (in-flight
handled per-button), and Verify offered as a logout bypass (an escape-hatch
clause nobody re-derived when a second condition arrived). Each was the same
structural failure: rules about *one* cluster scattered across *N* inline
predicates with no place to state cross-control invariants. So the rule:

- **Every control whose rules read domain state goes through the surface's
  derivation function** — a pure function (e.g. `settings/card-controls.ts`'s
  `agentCardControls`) taking the state slices and returning the complete
  controls contract: an entry per control with `show`/`disabled`/whatever
  that control's JSX needs. The line is **provenance, not complexity**: a
  trivial `upgrade !== null` still goes through the derivation (one line
  there), because thresholds that depend on counting conditions erode — the
  next condition gets bolted onto the inline predicate instead of graduated
  into the pattern. With the derivation in place, the JSX literally has
  nowhere to put a second condition.
- **Cross-control invariants live — and are unit-tested — in the derivation**,
  never implied by predicates that happen to agree: Log in and Log out are
  mutually exclusive; every auth-adjacent control disables while the shared
  in-flight signal is up; Stop stays enabled always (the escape hatch).
  Pure function → vitest covers the state matrix without rendering.
- **Local ephemeral UI state stays local.** `useState` that is born and dies
  inside the component and observed by no other control's rules — an open
  accordion, a form draft, which row is editing — does not thread through
  the derivation; forcing it there inverts the pattern (the derivation stops
  being pure over domain state).
- Shared predicates the **orchestrator also gates on** stay in
  `shared/protocol.ts` (e.g. `hasUnusedProbe`) and the derivation calls
  them; webview-only derivations live next to their surface, parallel to
  chat's `view-model.ts`.

Flag as an architecture violation, in review: a JSX conditional in a control
cluster that reads `state.` / a capability matrix / an agent summary instead
of the derived `controls.x`; a show/disabled rule added inline "because it's
just one condition"; a cross-control invariant enforced only by two inline
predicates happening to test the same field.

## Agent Rendering Strategy (chat view)

### Markdown rendering — solved

**Streamdown** (`npm install streamdown`, MIT, Vercel AI SDK team) as a drop-in
`react-markdown` replacement. Handles unterminated/incomplete markdown gracefully
(unclosed code fences, unclosed bold/links) during streaming, Shiki syntax
highlighting, GFM, built-in security hardening (`harden-react-markdown` +
`rehype-sanitize`, allowed image/link origin prefixes) — load-bearing, not optional,
since agent output is attacker-controllable content rendered into a webview with
real DOM access. Memoized block-level re-rendering so only the actively-streaming
tail re-parses per update. Tree-shakeable plugins as needed: GFM, Mermaid, KaTeX
math, CJK.

Streamdown's own styling assumes shadcn's CSS custom properties, so the theme
bridge from the Component Library section above covers it too — one bridge, not a
second one for markdown specifically.

Two integration notes:
- Map VS Code's injected theme CSS variables onto the shadcn/Tailwind variable
  names Streamdown expects, so rendered markdown matches the user's actual active
  theme rather than a hardcoded default palette.
- Tool calls, diffs, and plans never go through Streamdown. Parse `session/update`
  content by type upstream; only `agent_message_chunk` / `agent_thought_chunk` text
  deltas are markdown-rendered. Everything else gets its own dedicated component
  (see below). Feeding a tool's raw JSON output through a markdown parser is a
  second, independent source of "broken formatting."

### The core problem: interleaved, heterogeneous, streamed updates

A single turn's `session/update` stream looks like:

```
agent_message_chunk   (text)
agent_message_chunk   (text)
tool_call             (started)
tool_call_update      (completed)
tool_call             (started)
tool_call_update      (completed)
agent_message_chunk   (text)
```

The fix is not to bucket by type ("all text up top, tool calls below," or vice
versa) — that destroys the actual reasoning-acting sequence the agent followed,
which is exactly what gives users a legible, trustworthy sense of what happened.
Render a **single ordered timeline of blocks**, in the literal order updates arrive.

#### Block model

Maintain an ordered array of blocks for the current turn:

```ts
type Block =
  | { type: 'text';    id: string; content: string; streaming: boolean }
  | { type: 'thought'; id: string; content: string; streaming: boolean }
  | { type: 'tool_call'; id: string /* = tool_call_id */; kind: string;
      title: string; status: 'pending' | 'in_progress' | 'completed' | 'failed';
      input?: unknown; output?: unknown }
```

Rules for appending vs. updating:

- **Text/thought chunks**: append to the *last* block if it's the same type,
  nothing has interrupted it since (no tool call in between), and message identity
  continues — two non-null `ContentChunk.messageId`s that differ mean a new message
  and split the block (fused boundaries corrupt markdown: a message ending ``` `` ``
  glued to the next message's heading un-closes the fence). Id-less chunks keep
  merging: no boundary on the wire means no guessed split (live they're stream
  deltas; replayed they may lawfully be the recorded chunk log). User chunks are
  stricter — id-less never merges (whole-message-per-chunk, wire-verified). One
  gate owns this rule: `runBlockFor`, session-manager.ts. This merges "stream /
  stream" into one continuous flowing paragraph instead of fragmenting every chunk
  into its own component — a common bug in other ACP clients — without fusing what
  the wire proves separate.
- **Tool calls are updated in place, never appended twice.** `tool_call` creates the
  block keyed by `tool_call_id`; a later `tool_call_update` for the same ID mutates
  that same block's `status`/`output`, it does not create a second card. This is
  the single most common interleaving bug — apps that treat `tool_call` and
  `tool_call_update` as independent events end up with duplicate or orphaned cards.
- **A tool call always closes the preceding text block.** When a `tool_call`
  arrives, the currently-streaming text block (if any) stops accepting further
  chunks and its streaming caret disappears; a *new* text block starts fresh after
  the tool resolves and text resumes. This visually confirms "the agent paused to
  act," rather than implying the prose and the tool call happened simultaneously.

#### Tool call card design

- **Icon by `kind`** (ACP's own taxonomy: read, edit, delete, move, search,
  execute, think, fetch, other) rather than a generic spinner-only look — lets
  users pattern-match at a glance without reading the title.
- **Icon color by weight, one axis (decided 2026-07-11, palette refined
  2026-07-12)**: did this call change reality or observe it? Observing kinds
  stay chrome-dim; mutating (edit, move, execute) and destructive (delete)
  kinds take one cold hue — `editorInfo` blue — at two intensity steps: mutate
  at 55% alpha, destroy at full (`TOOL_WEIGHT`, blocks.tsx; contract rows in
  theme.css). The axis is ordinal, so it's a ramp within one hue, not a hue
  pair — CVD-safe by construction, and "more weight, more ink" is the honest
  mapping. *Supersedes the original `gitDecoration` orange/red palette: its
  zero-learning-cost rationale didn't survive the base rate — mutate is the
  majority class for a coding agent, so a warm saturated glyph at the row's
  scan entry point lit nearly every row and out-shouted the content it was
  meant to annotate. git's vocabulary works because modified files are a
  minority; ours aren't. A referential note must rank below the row text:
  cold hue, and the alpha step doubles as the salience reducer.* Weight, not
  verdict:
  the status tag keeps ok/warn/err, so a full-ink trash icon on a successful
  delete marks the kind's gravity, not an error. Never a color per kind (decoration, and it
  collides with status colors on the same row), and never a whole-line tint —
  card-vs-prose shape already says "tool call", and full-width tints fight the
  theme bridge across light/dark. A grouped run's header takes the heaviest
  weight present (destroy > mutate > observe), same precedence idea as its
  status tag.
- **Collapsed by default**, showing only title + status. A tool call's `output`
  can be arbitrarily large (a full file read, a long command's stdout) and
  shouldn't dominate the transcript unless the user asks to see it. Expand reveals
  input args and output/content — route file diffs specifically to VS Code's
  native diff editor rather than an inline diff view, consistent with the
  fs-ops-through-client design.
- **Status treatment**: spinner while `pending`/`in_progress`, checkmark on
  `completed`, distinct red state on `failed`. A **permission-denied** tool call
  (blocked by the permission broker) needs its own visually distinct state from a
  genuine execution failure — "blocked by permission" and "command failed" are
  different facts the user needs to tell apart at a glance, not the same red icon.
- **Auto-group runs of sequential tool calls.** When an agent fires several small
  tool calls back-to-back with no intervening text (common during search/glob-heavy
  work), collapse them into a single "3 tool calls" summary row, expandable to the
  individual cards — otherwise a search-heavy turn buries the actual prose under a
  wall of small cards.

#### Thinking / reasoning feed

`agent_thought_chunk` blocks are not the final answer and should read that way:
muted/italic styling, and — importantly — auto-collapse into a "Thinking..."
accordion once the first `agent_message_chunk` of the real answer starts streaming.
Keep it expandable on demand rather than deleting it; users debugging a bad answer
often want to see the reasoning that led there, but it shouldn't compete visually
with the answer once it exists.

#### Plans

`session/update` `plan` events represent persistent **session-level** state, not a
per-turn transcript event — a plan spans many prompts, so it must not reset or
repeat each turn. Render it as a single widget anchored to the read-out strip
above the composer (only when a plan exists and has more than one task),
independent of the per-turn timeline.

*Position superseded 2026-07-12: originally pinned at the top of the session. The
"session-level, not per-turn" argument only rules the widget out of the transcript;
it never forced the top. Re-derived: plan ticks are live-turn signals, and during a
turn the eye rests at the bottom of the stream — so the widget moved to the
read-out strip between chat and composer (ui.md § Read-out strip), alongside the
edited-files chip. Expansion became an overlay panel over the chat (X/Escape
closes) instead of inline growth, which would shove the composer around from the
new position.*

- **Collapsed state** (default): just the fraction (`2/16`) plus the current
  in-progress task's title, truncated.
- **Expand is manual, never forced.** When a task flips to completed mid-turn,
  don't auto-expand the widget — that yanks attention from whatever the user is
  currently reading. A brief, subtle highlight/pulse on the collapsed pill (the
  fraction ticking up) is enough peripheral signal; expanding is the user's choice.
- **Expanded view**: full checklist with each item's status (done / in-progress /
  pending). Persists across turns until the plan is superseded or the session ends.
- **Optional polish, not required for v1**: expanded plan items clickable to
  scroll/highlight the transcript block where that task was actually completed —
  ties the plan back to the literal evidence of the work.

#### Per-turn summary

Once a turn closes, compute a rollup from the block array already built for it —
no separate tracking needed:

- **Tool call count** — total `tool_call` blocks in the turn.
- **Distinct files touched** — unique paths across tool calls with
  `kind: edit/delete/move`, **deduped**. If the agent edits the same file three
  times in one turn, that's 1 file, not 3 — raw event count and distinct-file count
  are different numbers and both are useful, but "N files edited" must mean the
  latter.
- **Duration**, **token usage** — as in Per-turn completion metadata below.

Show as a compact one-line summary (e.g. "9 tool calls · 6 files · 1m 29s ·
12,025 tokens"), itself expandable on click to a breakdown by kind (reads vs.
edits vs. execute vs. search) — same collapse-by-default principle as individual
tool cards, rather than a flat, unexpandable line.

#### Streaming caret

Show a blinking caret at the end of whichever block is actively streaming (text or
thought). This is the cheap detail that disambiguates "still generating text" from
"waiting on a tool call" from "turn is fully done" — without it, a mid-turn pause
(e.g., waiting on a slow tool) reads as indistinguishable from a stalled UI.

### Per-turn completion metadata

Once a turn resolves (a `stop_reason` is received on the `PromptResponse`), render a
subtle metadata line under that turn — not loud, but present:

- **Duration** — compute client-side from first chunk to stop event. Always
  available regardless of what the agent reports; don't depend on the agent for
  this one. Show a live-updating elapsed ticker *while* the turn is still in
  progress (small stopwatch, updates per second) so a slow response has visible
  feedback instead of silence.
- **Completion time** — wall-clock timestamp, shown as a subtle hover tooltip
  rather than always-visible text (standard chat-UI convention — Slack-style).
- **Token usage** — from `PromptResponse.usage` when the agent reports it
  (input/output/cached counts). This is optional/unstable per-agent (see the
  protocol-confirmations section of the architecture doc) — show it when present,
  omit cleanly when absent. Never render a "—" placeholder that looks like a
  broken feature; just don't show the row.
- **Stop reason chip** — only surface this when it's *not* a clean `end_turn`:
  `max_tokens`, `refusal`, `cancelled`, etc. are meaningfully different completion
  states the user should notice, not silently identical to a normal finish.
- **Cost estimate** — only if you maintain your own per-agent/per-model price table
  client-side; ACP does not give you cost directly in most agents (the
  `context_update`/`usage_update` cost field is itself optional and inconsistently
  populated). If shown, label it clearly as an estimate — prices change and this is
  inherently something the orchestrator is guessing at, not reporting
  authoritatively.

### Transcript scale: three costs, three mechanisms (decided 2026-07-11)

A transcript has three independent rendering costs, and each gets its own
mechanism — no single tool covers them, and no platform default covers the one
that hurts most:

| Cost | When it's paid | Handler | Status |
|---|---|---|---|
| **Mount** — React reconciliation, Streamdown parse, DOM construction | Every webview show (webviews are disposed when hidden — render-only rule — so this recurs on every tab switch) | **Nothing, by default.** No engine feature skips work explicitly requested on the main thread. → windowed mount, below | decided |
| **Layout/paint per frame** | Every scroll/update frame | `content-visibility: auto` + `contain-intrinsic-size` on the block wrapper — opt-in, one CSS line; Chromium then skips offscreen subtrees entirely | decided |
| **Update** — re-render on each streaming delta | Every bus flush during a live turn | `React.memo` on the block renderer; blocks are immutable objects out of the reducer, so identity is the memo key for free — only the streaming block re-renders | decided |

The platform owns exactly one cost: memory of *hidden* webviews (disposal).
That justifies never unmounting in-session — it does **not** make whole-render
safe; it makes it worse, because the full mount cost recurs per glance.

#### Windowed mount (reverse infinite scroll)

Opening a session is recency-anchored task resumption — users read the last
exchange first (the same behavioral fact that makes chat UIs bottom-anchor).
So mount the tail, extend upward, and engineer for one invariant: **the user
never sees the window's top edge.** With `H` = viewport height:

- **Initial window** `R = k·H`, `k = 3` (three "pages" of content, mounted
  bottom-anchored, viewport jumped instantly to the bottom — no smooth scroll).
- **Extension trigger**: when the viewport enters the top 25 % of the rendered
  strip — i.e. remaining margin `M = 0.25·R = 0.75·H`. Safety condition
  `M ≥ v·(t_detect + t_mount)`: fast wheel/trackpad scrolling sustains
  `v ≈ 3–4·H/s`, one batch commits in `t ≈ 50–100 ms` with memoized blocks →
  required `M ≈ 0.4·H`; the 25 % rule passes with ~2× headroom.
- **Batch size**: one viewport-page per trigger, keeping each prepend under the
  ~100 ms perceptually-instant threshold.
- **Scroll anchoring on prepend**: manual — record `scrollHeight` before the
  batch, `scrollTop += Δ` in a layout effect after. (Chromium's native
  `overflow-anchor` does not survive React list prepends reliably.)
- **Teleport contract**: scrollbar-drag-to-top / `Ctrl+Home` cannot be beaten
  by prefetch. Split the promise: *smooth for scrolling, chunked fill for
  jumps* — rAF-batched mounts behind a slim "loading earlier…" shim, each
  chunk under 100 ms.
- **Live appends** are end-anchored and bypass the window entirely.
- The window index (`windowStart`) is **ephemeral webview state** in chat.tsx —
  exactly what the render-only-webview rule assigns to the UI. The full
  transcript still rides the snapshot from the orchestrator; only *mounting*
  is windowed. No protocol change, no new actions.
- **Self-scoping**: when the window is larger than the transcript it renders
  everything and the mechanism is a no-op — it only engages for sessions long
  enough to hurt.

#### No in-session unmounting (deliberate scope decision)

Blocks, once mounted, stay mounted for the webview's lifetime. Three reasons,
recorded so this isn't re-litigated as an oversight:

1. `content-visibility: auto` *is* un-rendering, done by the compositor per
   frame — offscreen blocks cost zero layout/paint; what remains is text DOM,
   a few MB per thousand blocks.
2. The platform already un-mounts everything at a coarser grain: these
   webviews are disposed whenever hidden, so every re-show is a fresh mount
   where the initial window applies. In-session unmounting would duplicate
   that while taking on the genuinely hairy part of list virtualization
   (bidirectional edge anchoring).
3. Unmounting below the viewport would make jump-to-bottom — the *common*
   move in a live agent session — the janky path, to save a cost nobody has
   demonstrated.

Revisit only on evidence. (Corollary: no react-window/virtualization library —
variable-height blocks with embedded terminals, diffs, and permission cards
make it a complexity sink; containment gets the paint win for zero deps.)

#### Scroll-follow contract

Force-scrolling to the bottom on every block change (the current effect) is
wrong during live turns — it makes scrollback physically impossible while
streaming. The contract: track whether the user is **pinned** to the bottom
(within a small threshold, from the scroll handler); auto-follow only while
pinned; on session switch or transcript seed, jump instantly to the bottom
once. Scrolling up detaches; returning to the bottom re-pins.

The two directions use different signals — the asymmetry is the design.
**Unpin on intent** (upward wheel, touch drag), not position: under a fast
stream the first few upward pixels are still inside the bottom band, so a
threshold-only unpin loses the race — the next re-stick yanks the gesture
back and the user can never escape. **Re-pin on position**, direction-guarded:
reaching the bottom band while not moving up re-pins. Programmatic sticks
scroll downward, so they re-affirm an existing pin but can never re-pin over
a user's upward intent; the wheel gesture's own scroll event moves up, so it
can't undo the unpin it just caused. Whenever unpinned, a "jump to latest"
control floats at the scrollport's bottom corner — the way back without
scrolling through a long transcript, and during a live turn the visible
read-out of pin state. Because it is present during plain scrollback reading
too, it is a corner nav control, dimmed at rest — never a centered banner in
the reading path. *(Refined from live-turn-only: the teleport is wanted for
idle scrollback as well; the placement/weight change is what keeps the
always-on variant from being a nag.)*

#### Hydration delivery (orchestrator side, recorded here for the seam)

`session/load` replay is a bounded window (request sent → RPC resolved).
Streaming it to the webview as live-style patches is the wrong shape — dozens
of flushes, each a postMessage + reducer pass + re-parse, pane visibly
churning. During replay, transcript events reduce into the orchestrator's
render cache but are withheld from the webview; on completion one
`transcriptSeeded` swaps the pane wholesale (which is the standing
rebuilt-wholesale rule expressed in one message), and the old view stays up
until then — no blank flash. See `docs/acp-compliance.md` § 4 (G1) for the
replay-correctness side of the same seam.

### Summary of the ordering principle

Every rule above serves one goal: the transcript should look like *exactly what the
agent did, in the order it did it* — prose, a pause to think, a tool call, another
pause, more prose — because that sequence is the actual value of watching an agent
work instead of just reading its final answer. Bucketing, reordering, or hiding
parts of that sequence for tidiness is the wrong trade every time; collapsing
verbose detail (long tool output, finished reasoning, grouped tool runs) while
preserving order is the right one.
