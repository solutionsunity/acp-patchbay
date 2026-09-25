# Changelog

## Unreleased

- Everything in the chat that expands — a thought, a turn's summary line,
  an embedded file, an injected message, a tool call and a run of them —
  now opens the same way and can be reached with the keyboard; the turn
  line shows its arrow too, so it no longer hides that it opens. A linked
  file (an `@file` in your message, a link in a thought or a tool's output)
  now opens in the editor when clicked; it used to do nothing. Content the
  chat can't show says so plainly: audio reads "audio · not playable here".
- An agent's images and embedded files now show in the chat. Anything but
  text in an agent's message or thought used to appear as a line like
  "[image content — not rendered]", even though the same content showed
  fine in your own messages. Images now preview, and an embedded file's
  contents show as a labeled snapshot you can expand, the same way they do
  everywhere else in the chat. Audio still shows as a labeled line: nothing
  in patchbay plays it yet. (#45)
- A tool call now shows what the tool produced, the way the agent meant it
  to be read. Expanded, a call used to show two boxes of raw data — the
  arguments as JSON and the tool's unformatted result — while the output
  the agent had prepared for you (a command's console output, a summary,
  an image, an embedded file) was thrown away. That content now renders in
  the call's details, formatted like the agent's messages, and the raw
  data sits behind a "raw" toggle for when you need to see exactly what
  ran. A command that runs in a VS Code terminal now shows inside its tool
  call, output streaming live, instead of as a separate block further down.
  The show-details arrow is now a real button, so the keyboard reaches
  it. (#44)
- A file an agent's tool call reports can now be opened from the chat, at
  the line the agent named. The file's name sits in the call's header —
  click it and the file opens with the cursor on that line, whether or not
  the call carried a diff; "+2" says the call touched two more files.
  Expanded, a call lists one row per file: its name, every line the agent
  pointed at, its folder relative to the workspace, and "diff" when there
  is one. A line past the end of the file opens at the last line, an image
  opens in its preview, and a folder the agent reported shows in the
  Explorer. Before, the line was dropped on arrival and the card had no way
  to open the file at all. The files panel's folder labels also stop
  misreading a folder whose name merely starts like a workspace root's. (#41)
- A file change you reject is now reported to the agent as rejected. Before,
  the agent was told the write succeeded, carried on as if the file had
  changed, and its picture of your workspace no longer matched the disk. A
  rejected command gets the same honest reply instead of a generic internal
  error, and a stopped turn with a card still open is reported as cancelled
  rather than rejected. Reading a file that doesn't exist now tells the
  agent "not found" for that path, so it no longer mistakes a missing file
  for patchbay breaking. (#39)
- Agents can now ask you questions with a form in the chat. ACP's
  elicitation reached the stable protocol, and patchbay declares its form
  mode: the question arrives as a card naming the agent, with one control
  per field (text, number, Yes/No, a choice, or several) and the agent's
  defaults already filled in. Send stays disabled until required fields
  are filled and the form's limits hold; Decline and Cancel reach the
  agent as themselves, so a "no" is not mistaken for a dismissal. Claude
  Code's multiple-choice questions arrive this way. A form with a field
  patchbay cannot show is declined rather than guessed at. The
  `request_user_input` tool that patchbay's MCP server offers every agent
  now uses the same card and rules, including defaults, and tells the
  agent whether you declined or cancelled.
  Agents can also send you to a page — Claude Code uses this to sign in to
  an MCP server, and Codex passes on an MCP server's own requests. The card shows the full address with its site
  in bold, warns about addresses built to mislead (an encoded look-alike
  name, a user name placed before the site, a bare IP address, an
  unencrypted link), and opens nothing until you click Open; the page then
  opens in your browser, where neither patchbay nor the agent sees what you
  type. Only web addresses ever open. While the agent waits, Open again
  brings the page back if you closed it, and the card marks it completed
  when the agent reports it done — also when the sign-in finished another
  way before you answered. A question the agent takes back now reads as
  withdrawn instead of staying open, forms included. Questions asked
  outside any session (during connect or login) are declined for now: no
  agent asks them yet. (#36)
- A login method patchbay cannot run is now shown without a button instead
  of being offered as if the agent handled it. Auth method types reached
  the stable protocol, so the type an agent declares is read directly: a
  terminal method runs in a terminal as before, an agent-handled one asks
  the agent, and anything else — a type from outside the spec, or a
  terminal whose details didn't parse — is listed and left alone, never
  answered with a call the spec reserves for agent-handled logins.
- An agent that writes something other than protocol messages to its
  protocol channel (a banner, a debug print) is now named once in the
  Patchbay log, without the content, pointing at the wire log for the full
  case. The session is not interrupted.
- Folders you always work with can be saved once, for this workspace or for
  every workspace, and every new session starts with them. Before, each
  extra directory (a backend repo beside a frontend, a framework's source
  checkout) cost a click in every new chat. Settings › Saved roots manages
  both lists; the roots chip saves an added root in one click and links
  there. Saved roots ride the new session's first request, so an agent that
  cannot take roots later still gets them; the session's MCP servers get
  them too, and now hear a new session's list once it exists instead of
  finding none. A session owns its list once started: saving changes new
  sessions only. A saved path is stored absolute and must be a folder; a
  root whose folder is gone is skipped at every session start or reopen,
  with a notice in the chat, and a saved one is marked in Settings until
  you restore or remove it. (#32)
- A session's roots now reach its MCP servers, not only the agent. The
  agent learned them through ACP, and the servers attached to the session
  learned nothing: patchbay's own editor-state server served without
  knowing the session's scope, and a remote integration behind the bridge
  was never told. The local server now offers the list as a `get_roots`
  tool, and the bridge declares MCP's client-side `roots` capability on the
  agent's behalf, answers `roots/list` with the session's folders, and
  sends `list_changed` the moment the list moves. Since a root always
  reaches the servers, adding one is no longer refused where the agent
  could not take it; the chip names, per root, who holds it — the servers
  always, the agent now, at its next open (with a "Reopen now"), or never.
  Servers the agent connects to itself are the agent's own MCP client's
  affair. (#34)
- A session's roots set by another client are no longer overwritten by
  patchbay's own list at the next open. An agent that lists its sessions
  may report each one's complete root list, and patchbay never read it: the
  persisted user-added list was the only truth even where the agent could
  contradict it. A reported list now replaces the persisted one for any
  session not open in this window (workspace folders subtracted, never
  merged, per spec); an omitted field changes nothing, since the report is
  optional and the agents that declare the field send none today. (#33)
- A prompt that was already running when an agent's auth lock was raised
  can no longer clear that lock by finishing. A completed prompt is the
  wire fact that proves credentials, but it proves them as of the moment
  the call left, and the authority table judged only what the evidence
  was, never when it was earned — so a long turn started before a sibling
  session hit `auth_required`, or before a logout, unlocked the composer on
  completion and the next prompt hit the wall again. Every success now
  carries when its call started and bears only on a lock older than that.
  The special case that suspended clears during a logout is gone, covered
  by the rule. (#35)
- The feature inventory (docs/features.md) is re-read against the code and
  says what the product does today, at the altitude of a promise rather than
  a mechanism. (#31)
- After a crash or process death, "new session" no longer mints a blank
  sibling next to a dead never-prompted one. The newness fact lived on the
  live attachment, which the drop discards while keeping the row, so the row
  was still there but no longer counted as new — and even found, it could
  not be used: the agent holds nothing for a zero-turn session, so load and
  resume have nothing to open. Newness (and whether a title has been set)
  now live on the session row, and the attach ladder gains a zero-turn rung:
  a never-prompted session is minted again from its row on its next use —
  new-session focus, a drawer click, or a prompt typed into it — carrying
  the draft, chips, held words, title, and knob choices, with the dead id
  retired. One row, one session, by every door. (#30)
- Per-session continuity rows (knobs, roots, held prompts, chips, draft) no
  longer accumulate for sessions nothing can bring back. A row's only reader
  is the agent's own `session/list` naming the session again after a reload,
  followed by `session/load` or `session/resume` to open it; rows were
  written for every agent regardless, and reclaimed only through an in-memory
  index that a reload empties — so an agent without `session/list` left a
  row per session forever, and even a list-capable agent leaked the rows of
  sessions deleted while no window was open. Now one predicate gates the
  writer: no row unless the agent declares the list and a rung. Each row
  records its workspace, and every complete list walk reconciles that
  workspace's rows against what the agent reported; an agent whose handshake
  cannot bring sessions back drops all its rows at connect, and agent removal
  drops them by agent rather than by index. Rows from earlier builds carry no
  workspace: the first walk that names one stamps it, one that does not
  drops it. The Sessions drawer now names each agent that declared no
  `session/list`, so a missing history is explained where it is felt. (#29)
- In a multi-root workspace every folder now reaches the agent. The first
  folder was the session's working directory and the rest went nowhere,
  while the roots chip counted them all. Folders beyond the first ride as
  ACP additional directories — on session open, on every roots change, and
  when a folder is added or removed while sessions are live — composed once
  from the same facts the chip shows. Roots now follow the protocol's own
  rules: the field is sent only to agents that advertise it (the spec's
  MUST — it used to go to every agent), a change after the first turn
  re-applies through `session/resume` only (a full `session/load` replay is
  too high a price for a root), and where neither applies the chip says so
  instead of counting a root that never landed. A root added during a live
  turn now lands before the next
  held prompt fires. The capability matrix's `roots.listChanged` row is
  gone: an MCP-side placeholder ACP superseded before it was ever built. (#28)
- A write proposal's diff card no longer ends silently at forty lines. The
  body is a bounded preview that now says how many lines it is not showing,
  and while the proposal is open the card offers "Open diff": the full change
  in VS Code's own diff editor, the file as it is against what the agent
  wants to write. Accept and Reject stay on the card; the texts are held
  only until the decision lands. (#27)
- Removed: the Settings section "Rules · skills · commands" and the capability
  matrix's "locations mapped" row. It listed files the user already manages in
  each agent's own native locations, which is a mirror, not a capability. The
  feature as intended is delivery — author once, patchbay supplies each agent
  in its own standard — and ACP carries no channel for it yet; it returns when
  one exists (roadmap). Skills never appeared in the old list because the
  resolver kept only files and a skill is a directory; removal supersedes the
  fix. (#26)
- Attaching a file with the picker no longer corrupts anything that is not
  UTF-8 text. A picked file used to be decoded as text into a chip, so an
  image, a PDF, or an archive reached the agent as mojibake with no error.
  The picker now takes the same decision paste and drop take — one shared
  admission table for both runtimes — and a picked file rides in the form
  it is: a wire-set image under the cap as an image chip, everything else
  as a link to its real path that the agent reads itself. (#25)
- Stop works mid-turn even when the agent is flagged as needing login. The
  flag is per agent and a turn is per session, so a second chat hitting
  `auth_required` used to disable the Stop button of a turn still streaming
  in the first — "Stop" showed, looked live, and did nothing. The button now
  gates each of its roles on its own precondition: Send on a healthy agent,
  Stop on a turn in flight. (#24)
- Adding a binary-distributed agent (OpenCode, Kimi CLI, Cursor, …) shows its
  card at once, with the archive download as a phase on it — the same way an
  npx agent shows its package download. The download used to run before the
  card existed, so two binary adds looked queued and a second install prompt
  replaced the first; the prompt is now the one modal every launch download
  passes, asked once per version. (#22)
- Curated MCP servers can be requested: a "Curated MCP server request" issue
  form asks for the facts an entry needs and the vendor page they come from;
  CONTRIBUTING says how an entry is written and lands. The catalog file is
  now `data/mcp-catalog.json` (it holds MCP servers, and "registry" already
  means the ACP agent registry), and the architecture doc no longer restates
  its entries — the data file is the record. (#18)
- The curated MCP catalog can be narrowed: a search box over name and
  description, and the key / OAuth / local chips double as filter toggles
  (all selected mechanisms must be offered). Every entry gained a one-line
  description, shown on its row — search only hits what the row shows, so
  a match never looks like a false positive. The full list stays the
  default — the catalog is data meant to grow, and a fifty-row list needs
  a way in. (#16)
- Held prompts (sent mid-turn) can be copied and, for the last one in the
  queue, taken back into the composer for editing — exactly as typed,
  mentions included; the other rows are edited by copy, ×, paste. The rows
  moved out of the composer into their own band above it: they are messages
  already written, not part of the one being written. Take-back needs an
  empty composer — merging two messages is your call, not the tool's — and
  the button says so instead of hiding. (#15)
- Session order and the Settings tile now read one activity stamp. The
  drawer's "latest first" stayed frozen in a second VS Code window until
  its agent reconnected — opening the drawer (and the palette's "Switch to
  session…") now re-reads every running agent's own `session/list`, so
  another window's activity is on the rows when you look. The Settings tile
  is now "active today" (sessions whose last activity is today) instead of
  a creation count that meant two different things for wire-listed and
  locally created rows, and that showed 0 after a reload until a session
  was created. Root cause: `updatedAt` was written in two places with two
  rules; it now has one home, the Agent View's canonical row — and so does
  the title, which had the same second copy. The session-manager keeps a
  routing index (session → agent, knob seed), nothing the view shows. (#14)
- "Open in new window" on a session that isn't loaded now loads it: the
  pinned window ran connect-on-demand but never the attach ladder, and an
  agent coming up re-hydrated only the sidebar's active session — a pinned
  one stayed blank until Reload. The palette's "Switch to session…" had the
  mirror gap (ladder, no connect). Opening a session is now one ceremony
  for every entrance: pointer unless pinned, ladder, connect-on-demand; an
  agent coming up hydrates everything on view. (#13)
- Knob seeding converges instead of setting once: an entry a later set reset
  (an agent that resets `effort` when the model changes) is re-asked until
  the surface reads the seed back, and an entry the agent already holds
  costs no wire call. A rejected entry is never nagged — re-asked only when
  a different entry fired after it. Seeds from agent defaults, the
  composer's per-agent combination, and the Settings defaults editor all
  ride the one loop.
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
