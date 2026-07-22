# Localization

The design for internationalizing acp-patchbay. **Status: planned — no code
ships in the current cycle.** This document is the landed design; implementation
follows in a later cycle. It states the decisions as made, so the build is a
matter of execution, not re-derivation.

## The framing: two axes, not one

"Localization" braids two independent concerns that must not be conflated,
because their value and their scope differ:

- **Content correctness** — rendering text that is *not ours to translate*
  correctly regardless of its language: bidirectional (RTL) text, and CJK
  layout. This pays off even if the UI chrome stays English forever, because the
  content is passthrough — agent prose, file paths, user input, tool labels.
- **Chrome translation** — translating the thin shell that *is* ours: command
  titles, settings, buttons, tooltips, our own error and empty-state copy.

Value scales with the ratio of localizable chrome to passthrough content, and in
a conduit like patchbay that ratio is low. Content correctness is therefore the
higher-value axis and is done first. Chrome translation is real but bounded, and
several markets want the former without the latter.

The general law both axes obey: **every target market ships a
content-correctness slice and a chrome-translation slice; the correctness slice
matters more and is sometimes the only one worth doing.** Arabic wants
correctness (bidi) far more than chrome; CJK markets want both, and CJK's
correctness slice (line-break, fonts) is distinct from its chrome.

## What is never localized

A deliberate scope boundary, recorded so no one "helpfully" translates it. These
are passthrough or vocabulary, not copy:

- **Agent-authored content** — chat and thought text, in whatever language the
  model replied. The agent's, never ours.
- **Code, file paths, diffs, diagnostics** — from the workspace and language
  servers.
- **The capability vocabulary** — `declared` / `used` / `suspect`, ACP stop
  reasons, wire method strings, `_meta` keys, `MCP` / `ACP` themselves. These are
  terms of art. Even in a fully translated locale they stay in their canonical
  form; a term drifting across locales is a vocabulary bug. Chinese and Japanese
  developers expect these in English — translating them reduces clarity.
- **The wire log** — a developer diagnostic surface; English by nature.

## Target languages

Targets fall into two buckets, and the bucket — not "which culture" — is the
real discriminator. A locale is promoted ahead of demand only if it brings a
**content-correctness slice** (a script or layout the default handling renders
wrong), because that work pays off even with English chrome. A locale that brings
only chrome is the low-value axis: it rides on market size and an actual demand
signal, never a preemptive guess. Within each bucket, order follows the
community's localization *habit*, not the maintainer's fluency — a population
that runs its IDE in English gains nothing from translated chrome, and VS Code
display-language adoption is the evidence.

### Bucket A — correctness-bearing (promoted)

| Priority | Locale | Chrome | Content correctness | Rationale |
|---|---|---|---|---|
| 1 | `zh-hans` (Simplified Chinese) | yes | CJK | Largest localized VS Code population; the China-market entry. Validates the whole pipeline against a real CJK, RTL-free locale. |
| 2 | `ja` (Japanese) | yes | CJK | Same cluster, high localization propensity. |
| 2 | `zh-hant` (Traditional Chinese) | yes | CJK | Same cluster; largely shares vocabulary decisions with `zh-hans`. |
| 2 | `ko` (Korean) | yes | CJK | Same cluster. |
| 3 | `ar` (Arabic) | yes | bidi (RTL) | A small niche audience the maintainer serves directly. Included by decision despite most Arabic developers using an English IDE; the RTL correctness work is warranted independently. |

`zh-hans` ships first and alone, proving the harness end to end. The rest of the
bucket are same-cluster follow-ons at near-zero marginal cost — translation is
AI-produced, so adding a locale is bounded by review, not by translator
availability. Priority 3 (`ar`) is chrome-included by explicit decision; the RTL
work under content correctness is not gated on it.

### Bucket B — chrome-only (demand-gated)

All LTR Latin/Cyrillic script — nothing new to render, so **no correctness slice
justifies them**. They exist as bundles because AI translation makes the marginal
cost near-zero once the harness from Bucket A exists; they are added on market
size plus a real demand signal, not preemptively. Ordered by developer-population
scale and localization habit.

| Locale | Content correctness | Rationale |
|---|---|---|
| `pt-br` (Portuguese, Brazil) | none (LTR) | Large developer population with genuine IDE-localization habit, ahead of European locales. `pt-br` specifically — the Brazilian market is the driver; `pt-pt` would be a separate signal. |
| `de` (German) | none (LTR) | Large market; localization habit is moderate — most professional devs run English. |
| `fr` (French) | none (LTR) | Notable institutional localization culture. |
| `es` (Spanish) | none (LTR) | One `es` serves Spain and Spanish-speaking Latin America; the `es-es`/`es-419` split isn't maintained. |
| `ru` (Russian) | none (LTR, Cyrillic) | Sizeable market with real localization habit; Cyrillic renders under default handling. |

Europe and Latin America bring no bidi, no CJK, no font-coverage gap. Their whole
cost is chrome, and their whole justification is demand — which is why they sit
below every Bucket A locale regardless of raw market size.

## Content correctness

### Bidirectional (RTL) text — Axis for Arabic

Policy already exists and is proven on one surface; the work is to propagate it,
not to design it.

- **Agent prose is done.** All message and thought chunks render through the one
  Streamdown configuration (`chat/markdown.tsx`), forced into per-block mode with
  `dir="auto"` so each block detects its own base direction from its first strong
  character. This defends a known failure mode — a leading Latin character
  flipping a following Arabic paragraph to LTR — and a past RTL regression is
  recorded in the view model. For pure-LTR English-plus-code content this is a
  no-op, which is why it shipped invisibly.
- **The non-markdown content surfaces are the pending work.** The composer input,
  user-message parts, context chips, tool-call cards, and the plan/files read-out
  strips carry no `dir="auto"` today. With English/LTR content, adding it is a
  no-op; the moment RTL content lands on them — Arabic typed into the composer, an
  Arabic tool-call label, a path with an RTL run — they render wrong. The fix is
  mechanical: apply the same first-strong-character direction policy the markdown
  path already decided.

The single left-truncation hack that forces `direction: rtl` on long file paths
(so the filename stays visible) is orthogonal and stays.

### CJK layout — Axis for the East Asia cluster

CJK is not just a string table; it is a rendering-correctness slice of its own,
parallel to bidi.

- **Emphasis parsing is done.** The markdown path runs the CJK-friendly remark
  plugins that fix `**bold**` and `~~strike~~` mis-parsing adjacent to CJK
  punctuation. No effect on non-CJK text.
- **Line-breaking and fonts are the pending work.** CJK has no inter-word spaces,
  so `word-break` / `line-break` / `overflow-wrap` behave differently on the
  composer, chips, and card labels, and the font stack needs CJK glyph coverage.
  These surfaces are reviewed for CJK layout in the same pass that adds their
  `dir="auto"` — one sweep closes both correctness axes on the non-markdown
  surfaces at once.

## Chrome translation

### The three-way mechanism split

Chrome strings originate in three places and resolve through three matching
mechanisms. There is no fourth, hand-rolled path.

1. **Manifest contributions** (command titles, settings labels and descriptions,
   categories, menu items) → **`package.nls.json`** plus per-locale
   `package.nls.<locale>.json`, the VS Code-native mechanism. This is the correct
   home for declared surface — never free text in `contributes.configuration`
   that would have to be synced by hand.
2. **Orchestrator-originated user strings** (notifications, error and toast copy,
   anything whose key and parameters live in the extension host) → **`vscode.l10n`**,
   resolved in the orchestrator *before* the string enters a state snapshot. The
   webview receives finished text, never a key it must look up — consistent with
   the webview holding render state only, not a translation catalog for
   host-owned copy.
3. **Webview static chrome** (buttons, labels, tooltips, empty states authored in
   the React tree) → a **webview-side string table** resolved by one `t()` helper,
   keyed on the active locale. The catalog is presentation data (like icon names
   or Tailwind classes), not durable or business state, so it lives webview-side
   without violating render-only. The orchestrator owns the *active locale* —
   read from `vscode.env.language` — and passes it in the snapshot; the webview
   owns the tables and resolves. This keeps snapshots small: one locale string,
   not every resolved label.

One `t()` home mirrors the one-theme-bridge and one-Streamdown-config
discipline: translation policy has exactly one seam per surface.

### Extension point visible, not filled

The cheap, mechanical move lands first and independent of any translation:
**route every chrome string through its `t()` / NLS-key indirection with an
English-only table.** This is scaffolding, not a feature — no user-facing change,
zero locale files beyond `en`. Actual translated bundles land per the target
priority above, starting with `zh-hans`. A half-populated locale file is
maintenance debt pretending to be a feature; an English-only `t()` seam is an
honest, visible door.

### The string catalog and its classification

The first implementation step is not translation — it is producing the
**catalog**, and the catalog's value is its *classification*, which is a
per-string judgment, not a mechanical extraction:

- **`chrome`** — localize. Buttons, labels, settings, our own messages.
- **`frozen`** — never translate. The capability vocabulary, wire terms,
  `MCP`/`ACP`, method names, stop reasons (see *What is never localized*).

The extraction sweeps the webview React tree and the orchestrator's user-facing
strings, tags each entry, and emits `en.json` (webview) + `package.nls.json`
(manifest) plus the `t()` call sites. The `frozen` set is signed off before any
locale bundle is generated, so a term of art is never silently translated.

## Packaging

- `package.json` declares the `l10n` bundle directory and ships
  `package.nls.<locale>.json` files; the extension follows the VS Code display
  language automatically.
- Locale bundles are AI-translated and review-gated. Adding a locale is a bundle
  plus a review pass — no toolchain change, no CSP change.
- Publishing stays a manual step, and a locale bump is not an implementation
  churn bump — it consolidates into a release like any other arc.

## Scope decisions, recorded

- Arabic chrome is **in**, by maintainer decision, for a small direct-served
  niche — overriding the default "Arabic developers run an English IDE, skip
  chrome" reasoning. The bidi correctness work stands on its own regardless.
- The `frozen` vocabulary is **out of localization entirely**, in every locale —
  a terminology contract, not an oversight.
- Content correctness ships ahead of, and independent of, chrome translation.
  Bidi and CJK layout are worth doing even for locales whose chrome is never
  translated.
