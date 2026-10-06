# Stores — Architecture

How patchbay holds what it knows and orders the work on it: the stores, the
rule that decides where each fact's truth is, and the queue and gates the
orchestrator runs them with. The mechanisms the stores' operations use — the
client pool, the capability matrix, the session model, the local MCP server,
MCP delivery — are recorded in [the architecture doc](architecture.md); this
file is the model they share.

## The model

- **A store is the one home of one kind of thing.** Three hold what patchbay
  works with — agents (`agents-store.ts`), sessions (`sessions-store.ts`), MCP
  servers (`mcp-servers-store.ts`) — one holds what patchbay asks the user
  on an agent's behalf (`asks-store.ts`), and small saved stores sit beside
  them (`stores/`: preferences, rules, auth locks, saved roots, …). One row
  per item, holding everything known about it, saved and live.
- **Each store allows a fixed set of operations on its rows**, and nothing
  writes a row from outside its store. Every door — a webview action, a
  palette command, a notification's button, startup, an internal flow — calls
  the same operation.
- **A store is a store only.** Its operations are plain; it knows nothing of
  what else runs. When an operation runs is the orchestrator's call, made with
  two tools it owns: the queue and the gates.
- **Stores point at each other by id**, and a fact is read through the
  relation, never copied: a session names its agent, an MCP server's reach
  list names agents, a context token names the attach it was minted at.
- **An id says whose it is.** A row's own id is its `id`; anywhere else one
  of patchbay's ids is named for its store — `patchbayAgentId`,
  `patchbaySessionId`, `patchbayMcpServerId`, `patchbayAskId` — and has that
  store's own type
  (`src/shared/ids.ts`), so one store's id can't stand in for another's, nor
  a string from elsewhere for one of ours. An id an agent mints keeps ACP's
  name and the SDK's type — `sessionId`, `toolCallId`: it is the agent's.
- **Features compose operations across stores** and live in the orchestrator:
  Add saves an agent, connects it and runs the free check; startup connects
  what the window opens with, then returns to the last open session. The
  stores stay the atoms.

## Where a fact's truth is

One source of truth per fact, picked by one test: **after a reload, who can
tell us this fact again?**

- **The agent, its process or the editor can — a live fact.** The truth is the
  thing itself. The row holds the latest reading in memory, reads it again
  after a reload, and never writes it to disk: an agent's status and what its
  handshake declared, the session list, a transcript, the running turn, an MCP
  server's last probe.
- **Nobody can — a saved fact, and disk is the truth.** Agent configs and
  MCP-server records, preferences, rules, auth locks; per session the knob
  combination, roots, held words, staged chips and draft. Read from disk when
  asked and written one row at a time, with no copy kept: the machine store
  reads its file again whenever another window has written it, and builds
  every write from what the file holds at that moment, so a window overwrites
  only what it writes itself (two windows writing one key at the same
  instant: the last write wins).
- **A reading of an outside source may be saved — as a dated reading.** An
  outside source can be read again, but not always: the network fails. What
  it said when last checked is something nobody can tell us again, so a
  copy of it is a saved fact, kept with that date. Its store is the one way
  to the source: it reads it at the moments it matters, and always right
  before anything acts on what it says; between reads the copy is shown
  with its date, and it stands in for the source only while the source
  can't answer. A read that lands replaces it whole. One instance today:
  the ACP registry.
- **A row holds both kinds side by side; each fact is one kind only.** Where
  two look like one, they are two facts: the configured command is saved, the
  command the running process started with is live, and neither overwrites the
  other.
- **What follows from other facts is worked out on read**, never stored: an
  agent's `untested`, an update available, an MCP server's connected state.

| Level | Holds | |
|---|---|---|
| The agent, outside patchbay | live facts | each window runs its own agent processes |
| Disk | saved facts | the machine store (one file every window shares), workspace state (per workspace), SecretStorage (every secret) |
| The orchestrator — the extension host's Node process, one per window | the stores, and what lives only while the window does: the queue, which session each view shows | the only level that talks to an agent or to disk |
| Webviews — several per window | nothing durable | rebuilt from the orchestrator on every mount; send actions only; hold only what is on screen — scroll, an open menu, text being typed until it is handed over |

## The queue and the gates

**The queue** (`queue.ts`) orders the work on a row — an agent, one of a
session's two lines, an MCP server, a connect under way. Per row:

- a request for an operation the row holds, running or waiting, **joins** it
  and gets its outcome; an operation's identity is its kind and every
  parameter that changes its outcome;
- any other operation **takes its turn**: it starts once everything held
  before it has left the row, however each settled;
- an operation that **cuts in** ends the row's work first — the running one is
  told to stop through its abort signal, the waiting ones are dropped, each
  settling as `Cancelled` at once — and runs once what is left of them has
  unwound. What cuts in is never cut: it is how work ends;
- rows wait on each other only where a caller says so: an operation can take
  its turn after work on another row has settled too.

What a row holds is its **busy** state: the queue reports every move, and the
views read busy from it — never from a flag a writer sets. The queue is live
only, ending with the window like the processes it orders. A running
operation never asks the queue for its own row — the request would wait
behind itself; operations compose by calling each other directly.

**The gates** are the one way any door reaches an operation the queue orders —
one set per store (`agent-gates.ts`, `session-gates.ts`,
`mcp-server-gates.ts`), each deciding how every such operation meets the
queue: whether it waits or cuts in, what makes a repeat the same operation,
what it waits for elsewhere. The orchestrator's reference to each store leaves
those operations out, so a door that goes around the gates does not
typecheck. Saves never meet the gates. **Gates decide policy; a store's
invariants stay at its one writer** — one turn at a time, never under a
standing auth lock, one process per agent, a connect on a running agent
already done — so a gate that admits the wrong thing degrades to a refused or
no-op operation, never to corrupted state. One control plane holds every
store's gates because ordering crosses stores: a session's work waits for its
agent's.

## Agents

**The row** is read whole when asked and sent to the views as one event
whenever any of its facts moves:

- saved — the config (machine store), its env (SecretStorage), the auth lock,
  the used-capability marks, the last knob choices;
- live — the process, its status and what `initialize` returned (the client
  pool), and what the wire has shown (the capability tracker);
- worked out on read — `untested` against `stopped`, an update available, the
  login methods offered, the capability matrix;
- busy — what the agent's line holds.

**Ids and names.** A new agent's id is minted (a UUID); an agent stored
earlier keeps its own, since ids are opaque keys. Anywhere but its own row it
is a `patchbayAgentId`, of its own type (`PatchbayAgentId`), so no other
string passes for one. The registry id is a fact on the row, so one registry
entry can be added more than once — two profiles, two agents — and what the
registry speaks for goes by it: the update fact, a binary's download and its
digest, and the tables that name a vendor (a wire-extension module's curated
entry, the PATH-sibling check). An added agent takes a name no other agent
holds: a taken name gets a number ("Gemini CLI 2"), picked in the same write
as the add.

An agent runs one process per window, holding all its sessions, so a row has
exactly one connection. **Operations:** connect, stop, restart, upgrade,
remove, save, reorder, log in, log out, verify. Add and startup are the
orchestrator's features over them: the store saves (or reads what to open),
and the connect and the free check pass the gates.

**One line per agent.** Connect, restart, upgrade, log in (per method), log
out and verify wait their turn. A request for one the row already holds
joins it — a chat started while the agent auto-connects shares that connect,
a second Upgrade shares the first's question and restart — and a connect
whose turn finds the agent running is already done. Agents never wait on each
other. Stop and Remove cut in, the escape hatch never queued behind a hung
launch: the agent's process goes down at once, and the cut-in runs once what
it cut has unwound, so a Remove never purges under an upgrade still saving; a
Remove asked for during a Stop runs after it. A connect still in its launch
phase — download, runtime check, launcher warmup — stops through its signal:
the pool marks it stopped, kills a warmup and never spawns; a download already
started goes on into the shared cache, where the next launch finds it. A
terminal login is not waited on once its agent is stopped: the terminal stays
the user's to finish, use or close, and its return code — the login's only
word — still counts by the same rules when it comes; only the probe and
restart that follow a login, which need the process the stop ended, don't
run. The window's end and erase cut every agent's work the same way.

**One question before a connection ends.** Stop, Upgrade, Remove and Log out
follow one rule, the gates': nothing in hand, the operation runs; work in hand
— open conversations and running turns, counted at that moment — one question
with the counts, asked at the operation, so every door gets the same one.
Remove always asks, since it also forgets the agent. Stop and Remove ask
before they cut in, so nothing is cut while the question is open; Log out asks
when its turn comes; Upgrade asks only when it would stop a running agent,
once the registry has shown it can upgrade at all.

**A connection's end reaches its sessions.** Every way a connection ends — a
Stop, a crash, an upgrade's restart — detaches the sessions that rode it,
keeping everything they saved; they reopen when next used. The context tokens
their attaches minted end with it. Remove also lets go of the agent's live
state: the pool's entry, the tracker's marks, a chat pane on it.

**Busy, in the views.** The Settings card dims the controls that would only
wait (never Stop) and spins Verify, Stop or Remove while its own operation
runs; the upgrade chip reads `upgrading to x.y.z…`; the chat pane says what the
agent is busy with while a chat waits on it, and closes when a Stop or Remove
ends that chat's connect.

## Sessions

**Ids are patchbay's.** A session's id is minted by patchbay when the session
enters — created here, or first named by its agent's `session/list` — and kept
for the window's life; the views, actions, events, the broker and the context
tokens use it. Anywhere but its own row it is a `patchbaySessionId`, of its
own type (`PatchbaySessionId`). The agent's own id for the session is a fact
on the row under ACP's name, `sessionId`: what every wire call carries, and
what inbound traffic names the session by. The agent and its `sessionId`
together — the pair — find the one row meant, since an agent's ids are unique
only per agent; traffic naming a session patchbay doesn't hold is answered
cancelled or refused at once. A never-prompted session its agent must create
again keeps its id and gets a new `sessionId`. What crosses a reload keys on
the pair: the session's saved row, and the last-open pointer.

**The row.**

- live — the attachment and its stream state (`session-stream.ts` turns the
  session's updates into transcript events), and the running turn. The
  transcript and the title have one holder, the Agent View's canonical state,
  which the store reads through a hook and never copies;
- saved — the continuity row (`stores/session-continuity.ts`, machine store):
  the knob combination, user-added roots, held words, staged chips and the
  draft. It is these facts' one home: read whenever one is needed, written
  field by field before the view hears of it, kept for every session whatever
  its agent declares. What each field carries and when the row leaves:
  [the session model](architecture.md#session-model-mode-effort); and the
  files the session was given, in its own folder
  (`stores/session-files.ts`), which leave with the session wherever its row
  does — but not when the row empties: a file sent stays in the agent's
  history;
- busy — what the session's two lines hold.

**Operations:** create, open, prompt, stop, reload, delete, close, set a knob,
release, list, and the saves — roots, chips, the draft, held-word edits. Those that
ride the session's connection pass the session gates; a saved root list is
re-applied to the agent's copy on the attachment line. A duty lives in its
operation, never at a door: ending a turn answers the asks it left open as
cancelled, as ACP requires, and a prompt whose turn never started goes back to
the held words.

**Two lines per session.**

- **The attachment line** orders what binds the session to its connection or
  rides it between turns: an open's attach (the zero-turn re-mint with it), a
  reload, a roots re-apply, a knob set, an idle release, a delete, a close.
- **The turn line** holds the session's turn, one at a time, as ACP has it.
  Held words wait on the continuity row and enter the line one by one — after
  a turn that ended by itself, an open or a reload, a login that clears the
  auth lock, or a prompt sent while nothing runs. A turn that ended in an
  error holds them: firing into what just failed would retry a deterministic
  rejection forever.

A turn starts once the attachment line is idle, so nothing re-binds a session
under its turn and no prompt fires into a replay. A knob set waits for the
attachment line only — a mode or option change may land mid-turn. A root
change made during a turn is re-applied when the turn ends, however it ends,
ahead of the next held words. A repeat joins: a second open of a session still
attaching, a second Reload, the same knob value set again.

Four doors end a turn. **Stop** ends it and drops the held words — Stop means
stop; words sent after it go once the stopped turn has wound down. **Reload**
ends it (words that never reached the wire go back to the front of the held
ones), reads the session again, then lets the held words go. **Delete** and
**Close** end the turn and drop the attach work, then the session leaves —
Delete once the agent has removed it from its history (a refused delete
leaves it where it was), Close at once. Each is offered only as the agent
offers it (`src/shared/session-ends.ts`): Delete where the agent proved
`session/delete`, Close where the agent lists no sessions, so nothing could
bring one back; an agent that lists its sessions but can't delete them
offers neither, and patchbay stands in for neither. A turn told to
stop while on the wire sends `session/cancel`, answers the asks it leaves open
as cancelled, and gives the agent 3 s to end it before ending it here — an
agent that ignores the cancel never holds a session; a turn still waiting for
its attach just ends.

**Waits across rows.** Sessions never wait on each other, but every session's
work except a delete or a close enters behind what its agent's row holds at
that moment — a restart, an upgrade, a login — so nothing binds a session to
a connection being replaced. A delete ends the session's own work first and
waits for its agent after — it needs the agent. A close waits on nothing: a
hung restart never keeps a session open.

**Busy, in the views.** A turn on the turn line is a turn **underway** — the
running mark, the composer's Stop. An open or a reload on the attachment line
is the session **attaching** — the loading page, Reload's wait. A turn is
**live** only once it is on the wire: a turn still waiting for its attach
streams nothing.

## MCP servers

**The row.**

- saved — the record (machine store); its credential and env (SecretStorage);
  the curated entry it was connected from, read through its catalog id —
  shipped data, fixed per build;
- worked out on read — connected;
- live, held by the store and published with the rows — each server's last
  probe outcome, and the failure of the last attempt under each connect key (a
  connect's, an add's, an import entry's, a save's), held until it is dismissed
  or the same thing is tried again. The Settings view keeps no copy of either;
- busy — what the server's line holds, and the connects under way.

**Ids and names.** A new server's id is minted (a UUID); a server stored
earlier keeps its own, since ids are opaque keys. Anywhere but its own row it
is a `patchbayMcpServerId`, of its own type (`PatchbayMcpServerId`). The
catalog id (`catalogId`) and the display name are facts on the row, so one
curated entry can be connected more than once — two accounts, two servers. The
display name rides the wire as the server's name, so no two servers share one:
a taken name gets a number ("GitHub 2"), picked in the same write as the add,
and "patchbay" is the built-in editor server's. Reach lists name agents by id;
an agent's removal takes it off every list in one write.

**Operations:** connect a curated entry (a pasted key, or the browser OAuth
flow), add a custom server, import, probe, remove — disconnect is remove:
credential, env and record — and the saves: edit, reach, transport, order,
mute.

**Lines.** A server's line holds its probe and its remove; the connect line
holds the connects under way, one line per curated entry and one per custom
name. A repeat joins: a second Connect on a card while its browser flow is out
is that flow, and a second probe of a server is the one running. Remove cuts
in: a probe still running is told to stop and keeps no outcome, and the remove
runs once it has unwound. Saves never wait.

**The credential's own rule.** A refresh is held at the credential's writer,
not on a line: one refresh per credential at a time, shared by whoever asks
meanwhile — a bridge, an attach, a probe — since a refresh token spent twice
can cost the grant (every connect here is an OAuth public client, whose
refresh tokens the server rotates or binds). An answer that lands after the
credential was removed or replaced stores nothing; a failed refresh is logged
and leaves the old token for the server's own 401 to speak.

**One composition.** One place builds a session's servers: the editor server
first — built in, never stored or removed, given to every session over stdio —
then every server that reaches the session's agent and can work, each with its
delivery — stdio, an `http` passthrough or the stdio-to-HTTP bridge, picked by
[capability-conditional transport](architecture.md#mcp-servers) — and every
value that crosses to the agent registered with the wire log's redaction. A
change to a server reaches an attached session at its next attach.

**The attach relation.** Each attach mints a context token, and the sessions
store holds what the attach was given — its agent, its session, every server
and how it went. The editor-state socket answers through that record only:
[one socket, admitted by token](architecture.md#local-mcp-server--editor-depth).

## Asks

**The row** — one per ask: a permission the agent asked for, a file write or
a command patchbay gates, a question — from the moment it is asked until it
ends. Live only: an ask dies with the connection it was asked on, and
nothing can ask it again after a reload. It names its session by
`patchbaySessionId`; its card in the transcript carries the ask's own id,
and every answer names it as `patchbayAskId`. Its saved half is the
decision audit.

**Operations:** open, show its card, answer (an option, a write's accept,
a question's answer), a rule's allow, stop (every ask of a session), the
agent's withdrawal, a page reported done, open a page again. Asks need no
queue: they are concurrent by nature, and each ends once.

**One writer, one table.** An ask can end several ways, and they race — a
rule, the user on its card or its notification, a stop, the agent
withdrawing, a page reported done, which can even overtake its question.
Which end may move an ask from which state is declared once (`MOVES`), and
one writer applies it, writing what the end owes in order: the card's
resolution, the record, then the answer the caller waits for — no end
answers the agent and leaves the card open, and no action runs ahead of its
record. An answer that doesn't fit its ask — an option it doesn't offer, a
write's answer at a permission card — moves nothing. The broker judges the
ask; the store holds it.

## Where saved facts live

| Fact | Where | Why |
|---|---|---|
| Agent configs and MCP-server records | Machine store — a patchbay-owned JSON file in the extension's `globalStorage` directory (`stores/file-kv.ts`), written atomically; on its first load it takes over what older versions kept in `globalState` and deletes it there | Developer-env, not code-env: global to this machine, never a repo-committed file; no credentials ever. The file is patchbay's own because the editor-owned `state.vscdb` was observed truncated to zero bytes by an unclean shutdown, taking every config with it |
| Session continuity, preferences, last knob choices, auth locks, used-capability marks, spawned-process records, the old default-agent setting's folded value | Machine store | Facts nothing else can tell again, per machine |
| Saved roots | `workspaceState` (this workspace) + machine store (every workspace) | Folders every new session starts with, read at session birth only; per user either way, never repo-shipped |
| Permission rules | `workspaceState` (workspace rules) + machine store (machine command rules) + built-in defaults | Workspace rules first, machine rules the floor, then ask. Per user either way, never repo-shipped — a cloned repo must not arrive pre-authorized |
| Last-connected stamp | `workspaceState` | The agents still running at shutdown, with the stamp's time. The next activate consumes it — read and cleared, spent either way — and honors it only within 60 s: deactivate fires the same for a reload and a quit, so the stamp's age tells them apart. Stale or absent, only the agents set to connect on window open start |
| Last-open pointer | `workspaceState` | The session the Agent View returns to on the next activate, named by its agent and the agent's own id for it. Looked up in what the startup connects' own `session/list` syncs brought back: found, it opens; not found, the view lands on its default screen, whatever the reason. A miss never clears it — not found is not gone: a failed connect must not erase where a later window could return |
| Decision audit | JSONL in workspace storage | Append-only; what happened in patchbay belongs to patchbay. Written by the asks store when an ask ends, before the agent hears the answer; a question is never recorded. An entry about a session names it by its pair — the agent and the agent's `sessionId` — which a later window can still match |
| ACP registry | A copy of the last read in the extension's `globalStorage` directory, with the date it was last confirmed | A dated reading of an outside source: loaded at start, shown with its date while a read is out or failing, replaced whole by every read that lands; Add and Upgrade read the registry first, acting on the copy only when the registry can't be reached; a copy in an older shape reads as none |
| Files a session was given — pasted or picked images, dropped files | The session's own folder in the extension's `globalStorage` directory, under its agent and workspace (`stores/session-files.ts`) | Kept as long as the session lives: its staged chips name them, and an agent may follow a link to one in any later turn — so never the OS temp directory, which a reboot can empty. They leave with the session (deleted or closed, gone from its agent's list, its agent removed) and move with it when a never-prompted session is minted again. A folder's name is a short hash of its ids: no id an agent mints can steer a path, or stretch one past what a Windows path holds |
| Image previews | The attachments stash, a temp directory | Ephemeral: the OS owns cleanup, and a preview whose file is gone degrades to a label chip |
| Secrets — OAuth tokens, API keys, env values (agents and custom-stdio MCP servers) | `SecretStorage` | The only place: never settings, never state stores, never logs. Env values are how agents and stdio MCP servers commonly take API keys, so the whole env record is a secret at rest (`stores/secret-env.ts`); configs and records carry no env. Values are read when reality needs them — an agent's spawn, or an MCP attach, where the handoff to the agent is inherent: the agent spawns stdio servers itself — and shown back to their owner over the Settings channel (that webview exists only while Settings is open): the forms show what is stored and save what is in the box. What the user typed is readable — env values, a header API key; an OAuth token, minted by a flow, never reaches a webview. How an HTTP MCP server's credential reaches the agent: [capability-conditional transport](architecture.md#mcp-servers) |

**A saved shape changes by migration, once.** What a store reads in an
older shape is rewritten in the new one — where the store is built, or,
when it takes facts only a later moment has (the startup lists), at that
moment. Every migration consumes what triggers it: the rewrite itself, or
a record that it ran where the old value can't be rewritten (an
unregistered setting), so none runs twice and none undoes what the user
did since. Live code reads only the current shape.

Agents and MCP servers are deliberately global-only. The risk this guards —
a production-access MCP server silently following a user between repos — is
held where it lives: neither rides a repo, so nothing attaches by opening a
folder; each moves only by its owner's explicit Copy and paste, carrying what
the owner typed, never an OAuth token. Binding them to workspaces may come
later as an opt-in; the extension point is visible, deliberately unfilled.
