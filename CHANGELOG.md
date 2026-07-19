# Changelog

## 0.82.6 — 2026-07-19

- Malformed agent data can no longer break patchbay: every agent response and
  notification is now validated at one boundary and degrades gracefully — a
  bad field drops or defaults with a log entry instead of killing a turn's
  rendering, blanking the session drawer, erasing session history, or failing
  a connect. A render error in the view itself now shows an inline fallback
  with retry instead of a permanently blank pane.
- Your prompts now render richly, and identically after a session reload:
  `@file` mentions as inline tokens, pasted images with an inline preview,
  attached files and context as labeled chips (context expands to its
  snapshot) — replacing the raw markdown, "[image content — not rendered]"
  placeholders, and vanished attachments that reloads used to show.
- A cancelled turn now replays with the same "cancelled" line a live cancel
  shows, instead of a raw `[Request interrupted by user]` bubble.
- Permission request cards no longer clip: long button rows and long
  command/path subjects wrap instead of sliding out of reach.
- Error and status messages no longer show a stray "§" where a plain
  arrow separator belongs.
- Opening a session whose history is still replaying shows a "Loading
  session history…" page instead of a blank pane.
- Agent configs, MCP server configs, preferences, and the rest of patchbay's
  machine-scoped data moved out of VS Code's shared state database (which an
  unclean shutdown can wipe — and did, taking every agent config with it)
  into a JSON file patchbay owns, written atomically. Existing data migrates
  over automatically on first load.
- npx/uvx agents no longer require Node.js or uv on the machine: when the
  system runtime is missing or below the version floor, patchbay downloads a
  pinned one into its own storage (first download always asks, never silent)
  and equips just that agent's spawn with it — the system itself is never
  modified.
- Windows: agent commands now resolve to their real executables through
  PATH and PATHEXT before spawning. Bare commands that are npm shims
  (`gemini`, `codex`) work instead of failing with ENOENT, a missing
  command fails the connect with "not found on PATH" instead of a cryptic
  error, and the workspace folder can never shadow a launcher — a
  repo-planted `npx.cmd` no longer runs on connect.

## 0.82.5 — 2026-07-14

- Attachments got one shared entry point with clear rules: paste and drag-drop
  both accept images and files, with a size cap you can set in Preferences
  (default 10MB) — anything refused says so in a warning toast, never silently.
- Fixed image attachments failing the whole turn on some agents (Auggie
  rejected formats outside png/jpeg/gif/webp with an opaque 400): exotic image
  formats are now converted to PNG on entry, and ones that can't be converted
  (e.g. SVG) attach as files instead.
- Drag-and-drop into the composer: files from the VS Code explorer or editor
  tabs attach in place — images as images, everything else as a file link the
  agent reads itself.
- Auggie's code-snippet markup now renders as a proper captioned code block
  (file path + excerpt badge) instead of raw tags in the chat.
- Login and logout are now honest end-to-end: terminal logins report their
  real exit code and restart the agent when fresh credentials need it, and
  logging out immediately marks the agent as needing login again (it no longer
  "verified away" the logged-out state).
- Refactored the agent card's buttons (Log in, Log out, Verify, Stop, Connect,
  Upgrade, Edit, Remove) onto one tested control model, fixing the
  logout/verify inconsistencies that came from scattered per-button rules.

## 0.82.4 — 2026-07-13

- Refactored chat's chunk-to-block accumulation into one message-identity gate,
  fixing adjacent agent messages fusing into a single markdown block (e.g. a
  closing code fence gluing to the next heading, breaking mermaid rendering).
- Fixed the composer footer clipping at narrow widths: session read-outs now
  wrap to their own line, so the knobs and the Send button always stay on
  screen.

## 0.82.3 — 2026-07-13

- Refactored core to handle non-ACP Auggie's MCP-server and model-list onto a new
  extendable wire-extension architecture (fixing both along the way), also
  now used for `_meta` processing — e.g. Claude's plan/rate-limit readout.

## 0.82.2 — 2026-07-13

- Fixed the composer's / and @ suggestion menu: it now opens at the line
  you're typing and keeps the keyboard selection in view.

## 0.82.1 — 2026-07-13

- Fixed z-index layering across the sidebar so overlay menus can no longer
  render invisibly behind other UI.
- Fixed several menu/panel open-close bugs: switching the sessions list's
  ⋯ menu straight from one row to another, "Add or manage agents" not
  navigating Settings when it was already open, and overlay panels
  (composer files, plan) not closing on an outside click.

## 0.82.0 — 2026-07-12

First public stable release.
