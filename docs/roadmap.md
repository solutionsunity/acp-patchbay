# Roadmap

What is deliberately beyond the current release. Nothing here is a promise with a
date — each item is a scope decision and the bar it must clear before it earns a
place. Anything that emerges during design lands here first, not in the current
release by momentum.

## Beyond the current release

- **External-continuation detection** — watch known agent session stores for
  out-of-band writes and badge a session "possibly continued elsewhere." Requires
  per-agent knowledge of private storage paths; adapter-tier work that earns its
  way in.

- **Post-hoc change detection for uncooperative agents** — snapshot workspace
  state at turn start, watch during the turn, and present every out-of-band change
  as a reviewable, one-click-revertible diff. Not pre-gated, but nothing invisible.

- **Isolated execution workspaces** — the agent works against a copy
  (worktree-style) and every change is applied back as a pre-gated diff. The only
  true gating for uncooperative agents; heavy on paths, terminals, and UX, so it
  earns its way in later.

- **Shared source for rules/skills/commands** — one base directory with
  compatibility symlinks into each agent's native locations (the
  [dotagent](https://github.com/solutionsunity/dotagent) pattern), or full supply
  by patchbay. The current release proves the management surface first.

- **Localization** — internationalize the extension along two axes: content
  correctness (RTL/bidi, CJK layout) for passthrough text that is never ours to
  translate, and chrome translation for the thin shell that is. Correctness-
  bearing locales (`zh-hans`, then `ja`/`zh-hant`/`ko`, then `ar`) are promoted;
  chrome-only locales (`pt-br`/`de`/`fr`/`es`/`ru`) are demand-gated. Earns its
  way in because the chrome surface is small and the correctness work is bounded
  — the current release proves the surfaces first. Design landed in
  [localization.md](localization.md); implementation waits a later cycle.
