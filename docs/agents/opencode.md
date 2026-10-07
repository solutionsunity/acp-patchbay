# OpenCode — ACP conduct notes

Identity: `opencode acp` (anomalyco/opencode), ACP registry binary
distribution, tested 1.18.35 (registry and npm `latest`, released
2026-10-06), protocol 1. Source read at tag `v1.18.35` and `dev` 3865c69.
Vendor channel: github.com/anomalyco/opencode (public issues; features need
core-team design approval first). Patchbay's tracking issue: #87.

## Compliance issues

*(none)*

## Capability gaps

### The to-do list is a tool call, never an ACP `plan`

- **Observed:** 2026-10-07, 1.18.35, live capture (raw JSON-RPC driver, free
  Zen model `opencode/big-pickle`, no credentials) plus source. Its ACP layer
  (`packages/opencode/src/acp/`) sends no `plan` update at all; the agent's
  plan lives in its own `todowrite` tool.
- **Spec:** ACP's `plan` update carries an agent's execution plan, whole
  list every time ("Client MUST replace the current plan completely").
  Nothing makes it mandatory — a gap, not a violation.
- **Wire, live write:**
  1. `tool_call` — title `"todowrite"`, kind `other`, status `pending`,
     `rawInput: {}`.
  2. `tool_call_update` — `in_progress`, title `"todowrite"`,
     `rawInput.todos` = the **proposed** list.
  3. `tool_call_update` — `completed`, title `"N todos"` (N = entries whose
     status isn't `completed`), `content` = the list as JSON text,
     `rawOutput = { output: <same text>, metadata: { todos, truncated } }`.
- **Wire, rejected write** (`permission.todowrite: "ask"`, reject): the
  `in_progress` frame with the proposed list still arrives *after* the
  rejection, then `failed` with `rawOutput.error`. So `rawInput` is an intent;
  only `completed` + `rawOutput.metadata.todos` is the stored list
  (`tool/todo.ts`: ask, then `todo.update`, then return `metadata.todos`).
- **Wire, `session/load`:** each past write replays as `tool_call` titled
  `"N todos"` with the full list in `rawInput`, then its `completed` update —
  in order, so the last write is the current plan.
- **Entries:** `{ content, status, priority }` — ACP's `PlanEntry` field
  names. Status and priority are free strings
  (`packages/schema/src/session-todo.ts`; the enum is only described);
  status adds `cancelled`, which is in ACP's v2 draft vocabulary. An empty
  list is allowed and clears it.
- **Permission:** no ask under the default config. With `todowrite: "ask"`
  the request's call is title `"todowrite"`, `rawInput: {}` — the user
  approves without seeing the list.
- **Impact:** without a workaround the plan chip stays empty and every write
  is a "N todos" tool card in the transcript.
- **Patchbay workaround:** `extensions/todowrite-plan.ts`, adopted
  2026-10-07 (decided with the user: the todo list IS the plan). A write is
  held from its announcement — by its name live (no shape exists in that
  frame), by its list's shape on replay — and decided at its end: a
  completed write whose stored list reads becomes the plan, words as said,
  and shows no card; anything else (failed, rejected, unreadable, stranded
  at turn end) lands as the agent sent it. A permission ask still shows its
  card. Retire when OpenCode sends `plan`.
- **Open (to be discussed):** an agent sending both `plan` updates and a
  to-do tool. Today whichever arrives last is the plan; nothing is designed
  for it.
- **Status:** upstream asked and not merged —
  anomalyco/opencode#30659 (closed not planned 2026-09-15),
  anomalyco/opencode#40745 (closed not planned 2026-10-05), PRs
  anomalyco/opencode#40746 and anomalyco/opencode#41132 closed unmerged,
  PR anomalyco/opencode#31834 open since 2026-06-11 (maps `cancelled` to
  `completed` and an unknown priority to `medium`). Mentioned from #87 only;
  no comment on their tracker.

## Behavioral notes

*(none)*

## Communication log

- 2026-10-07 — #87 filed in patchbay, cross-referencing the upstream issues
  and PRs above.
