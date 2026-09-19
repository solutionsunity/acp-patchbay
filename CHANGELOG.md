# Changelog

## Unreleased

- Dependency advisories on code that ships: mermaid 11.16.0 → 11.17.2 (XY
  and radar diagram DoS, `%%{init}%%` prototype pollution, CSS injection),
  dompurify 3.4.11 → 3.4.15 (two sanitizer bypasses — both already blocked
  here by mermaid's strict default and the webview CSP), fast-uri 3.1.3 →
  3.1.8 (six host-confusion advisories in the MCP SDK's schema validator —
  inert in this usage, it resolves `$ref`s and never makes a request). The
  rest of the Dependabot list lives in build and test tooling that never
  reaches the VSIX. (#9)

## 0.82.9 — 2026-09-19

- *Copy config* on an MCP server card now copies a `{"mcpServers": {name:
  entry}}` document — the well-known shape patchbay's own *Import JSON* and
  other clients read. It used to copy patchbay's internal store record,
  which nothing could import back. Curated servers copy as their resolved
  endpoint and auth shape. (#11)
- Env values are readable again where you edit them. The agent form and the
  MCP server *Edit JSON* used to show existing variables as bare `KEY=` /
  `"KEY": ""`, with a blank meaning "keep whatever is stored" — the only
  way to check a value was to remove the entry and add it back. Both forms
  now show what is stored and save what is in the box, and *Copy config*
  carries the values too, so a copy actually reproduces the server. The
  rule: what you typed you can read — env values and a header API key;
  an OAuth token, minted by a login flow, still never shows or copies.
  Storage is unchanged: values live in VS Code SecretStorage and reach only
  the Settings page while it is open. (#12)
- *Current file* and *Selection* in the composer now mean the file you were
  last in, not whichever tab happens to be active. They used to come up empty
  whenever the active tab wasn't a text editor — a detached Patchbay panel,
  Settings, a preview, an image — and the live selection chip vanished the
  moment you clicked into a detached panel to use it. The `get_current_file`
  and `get_selection` tools agents call follow the same rule. When there
  genuinely is nothing — no file open, no selection in a visible editor —
  the adder now says so instead of doing nothing. (#7)
- Drag-and-drop into the composer, stated as it is: a file dropped from the
  OS attaches only while **Shift** is held — without Shift, VS Code takes
  the drop for itself and either opens the file as an editor or does
  nothing. Editor tabs and Explorer entries cannot be dropped onto the
  composer at all; VS Code blocks every webview for the length of an
  in-window drag. Use `@` for open editors and workspace files, paste or
  the picker for anything else. The code path that expected tab and
  Explorer drops never received one and is removed. (#10)
- Typing during *New chat* no longer lands in the previous session. The
  composer used to stay on the session that was open before the click, so
  whatever you typed while "Connecting…" was up vanished when the new
  session appeared and turned up later as the old session's draft. While a
  chat starts, the previous session's row is gone and the box is locked
  with "Starting <agent>…" until the new session is ready. (#6)
- Custom stdio MCP servers are now probed in the workspace directory — the
  same one agents are launched in and their servers inherit — so a server
  that reads project-local config (a `.env`, a local settings file) passes
  or fails the probe exactly as it will in a real session; previously the
  probe ran in the editor's own directory and failed servers that then worked
  fine. A failed probe now names the directory it ran in. (#3)
- Long unbreakable text — URLs, absolute paths, connection strings — now
  wraps inside the panel everywhere instead of being cut off at the edge:
  agent and user messages, dialogs (the download-confirm URL), popovers, and
  settings boxes. A context chip with a long path truncates with an ellipsis
  and keeps its × reachable at any panel width. (#2)
- Agent defaults in Settings now show every knob the agent offers *for the
  defaults you've chosen*, not just the ones it offers out of the box: pick a
  model and its own thinking/effort levels appear as a default you can set,
  because the card reads the surface back from the agent after each change
  (a throwaway session, no LLM turn, ended when the card collapses). New
  sessions then apply the saved combination in dependency order, so a
  default that only exists once another is set still lands. (#1)
- *Log in* on Windows now works under PowerShell and cmd. The login used to
  be pasted into a terminal as a POSIX-quoted command line, which PowerShell
  rejects before running anything; it now runs as a VS Code task that
  receives the executable and its arguments as-is, so no shell quoting
  exists to get wrong on any platform. The login opens in the task panel,
  stays open after it finishes, and takes pasted input as before. (#4)
- A Claude session whose sign-in expired mid-use now locks the agent card
  and offers *Log in*, instead of failing every prompt with an internal
  error while the card still reads as signed in. claude-agent-acp reports
  that case with a different error code than the protocol's auth signal;
  patchbay now reads its structured error data as the same fact. (#5)

## 0.82.8 — 2026-07-22

- Agents offering the ACP draft's typed terminal login (`type: "terminal"`)
  now get a working Log in button — patchbay runs the agent's own command in
  a visible terminal and verifies the result; previously these showed as
  declared but couldn't run.
- Reworked state handling around a single source of truth so the UI always
  reflects what actually happened. Fixes: logged-out agents showing as logged
  in after a reconnect, reload, or Verify (Claude's logout used to vanish); a
  prompt to a logged-out agent fabricating a phantom message and error turn
  (it now holds as a queue row and sends after login); knob selections
  resetting to agent defaults after a reload; and assorted ghosts — chips and
  queued prompts after a crash, an overwritten session title, a reset
  plan-usage gauge, a resurrected upgrade badge.
- Anything prepared but not sent now survives a window reload, per session:
  context folders, pasted images and files, queued prompts, and your
  in-progress message (the prompt box is per-session now — switching chats
  keeps drafts apart). Queued prompts survive an agent crash too, holding as
  visible rows until you reconnect; only Stop or removing a row discards them.
- The edited-files panel is sharper and its numbers now agree with the diffs
  they open: the per-file diff no longer marks the whole file new when an
  agent's edit omitted the original (the real file is the comparison base,
  and tool-call cards recover the same pre-image), CRLF/LF differences no
  longer count every line as changed, opening the panel re-reads the live
  files so outside edits show, and the header totals the session's +/− lines.

## 0.82.7 — 2026-07-20

- Session identity is now honored end to end: a session id recycled by the
  agent (after patchbay's connect-time probe, or by a second agent minting
  the same string) can no longer capture another session's traffic — which
  used to silently auto-deny every permission request (~2ms, no dialog),
  swallow all live rendering until a reload, or land a late MCP
  `request_user_input` form in the wrong transcript.
- Removing an agent now also purges its recorded knob combination and auth
  recipe, so a future re-add under the same id starts clean instead of
  inheriting the old agent's settings.
- UI polish: agent and MCP server cards reorder by drag-drop (order persists),
  boolean composer knobs show their name with a toggle, and session reload
  shows the same loading page as opening a session instead of holding the
  stale transcript.
- **Recovers the data 0.82.6 appeared to lose.** 0.82.6 changed the
  publisher casing (`solutionsunity` → `SolutionsUnity`), and VS Code
  namespaces an extension's stored state by the cased id — so on upgrade,
  every agent, MCP server, and preference looked gone. Nothing was deleted:
  the data sat unreachable under the old id. 0.82.7 reads it back directly
  from VS Code's storage db on first start (once, never clobbering anything
  re-added since). Credentials live in the OS keychain under the old id and
  can't be carried over — API keys and OAuth logins must be re-entered.
  The machine store also no longer writes an empty state file when a
  migration finds nothing, so an unreadable source can never again latch
  into permanent-looking loss.

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
