# Roadmap

What is deliberately beyond v1. Nothing here is a promise with a date — each item
is a scope decision and the bar it must clear before it earns a place. Anything
that emerges during design lands here first, not in v1 by momentum.

## Beyond v1

- **Curated integrations catalog beyond GitHub** — Linear, Jira, Sentry, and
  peers, each a first-class entry in the integrations surface.

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
  by patchbay. v1 proves the management surface first.
