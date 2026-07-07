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

- **Text/thought chunks**: append to the *last* block if it's the same type and
  nothing has interrupted it since (no tool call in between); otherwise start a new
  block. This merges "stream / stream" into one continuous flowing paragraph
  instead of fragmenting every chunk into its own component — a common bug in other
  ACP clients.
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
repeat each turn. Render it as a single widget pinned at the top of the session
(only when a plan exists and has more than one task), independent of the per-turn
timeline below it.

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

### Summary of the ordering principle

Every rule above serves one goal: the transcript should look like *exactly what the
agent did, in the order it did it* — prose, a pause to think, a tool call, another
pause, more prose — because that sequence is the actual value of watching an agent
work instead of just reading its final answer. Bucketing, reordering, or hiding
parts of that sequence for tidiness is the wrong trade every time; collapsing
verbose detail (long tool output, finished reasoning, grouped tool runs) while
preserving order is the right one.
