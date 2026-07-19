# acp-patchbay — Architecture

How the product surface becomes a VS Code extension. Inputs: [the PRD](prd.md)
(why) and [the Features doc](features.md) (what); on any conflict, they win. This
document decides mechanisms and records the reasoning. Stack is fixed by rule: TypeScript
for all extension-host code, esbuild, npm.

---

## Vocabulary

Terms are contracts — one meaning each, held everywhere (docs, code, UI copy):

- **Orchestrator** — the Node process in the extension host. Single source of truth
  for sessions, capability tables, permission rules, secrets, configuration.
- **Agent View** — the one blended webview: agents + sessions + chat. Not three panels.
- **Known sessions** — patchbay's in-memory mirror of the agent's own
  `session/list` (ids, titles, timestamps, agent), repopulated every connect.
  Patchbay persists no session records; there is no durable index.
- **Decision audit** — append-only record of events that happened *in patchbay*:
  permissions granted, tools approved, routing chosen.
- **Render cache** — disposable render state, rebuilt wholesale from `session/load`
  replay. Never merged, never reconciled.
- **Declared / used** — the two capability states: claimed at `initialize` vs.
  observed firing on the wire.
- **Brokered** — routed through the permission broker.
- **Integration** — the *record*: a configured MCP-server connection (curated or
  custom) with its credential, env, routing, and active state. The UI calls the
  surface "MCP Servers" (that's what they are); the internal type keeps the name
  `integration` because the ACP SDK owns `McpServer` for the *wire config* an
  integration produces into a session — two different things, two names, held.
  Lifecycle is two-state: active/inactive (the mute switch — everything kept,
  nothing routed) and disconnect = full clear (credential + env + config; a
  curated entry reverts to the catalog). Nothing is stored until it can work —
  a cancelled OAuth consent adds nothing.
- **Branch** — the user-level concept: continue an alternate path from a session.
  Out of the current release (§ Branching); "fork" only ever names the protocol
  method `session/fork`, which remains a capability-matrix row.
- **Routing** — the user's per-agent selection of which integrations that agent
  receives.

## Core principle

**ACP answers where the agent lives** — sessions, prompts, permissions, file
operations, terminal. **MCP answers what the agent reaches** — tools, resources,
context. Everything ACP doesn't model (live editor state, integrations) is exposed as
a **local MCP server the orchestrator owns**, passed into `session/new` via
`mcpServers`. This is the generic version of the pattern vendor extensions build
privately — it works for any ACP agent by construction, with zero per-vendor code.

## Architecture

```mermaid
flowchart TD
    AV["Agent View webview<br/><small>render only</small>"]
    SET["Settings webview<br/><small>render only</small>"]

    subgraph ORCH["Orchestrator — Node, extension host<br/><small>single source of truth</small>"]
        STATE["State & stores<br/><small>capability tables,<br/>decision audit, config</small>"]
        POOL["ACP client pool<br/><small>stdio JSON-RPC per agent process</small>"]
        BROKER["Permission broker<br/><small>one rule set, one surface</small>"]
        MCP["Local MCP server<br/><small>editor state, integrations, adapters</small>"]
    end

    AGENTS["ACP agent processes"]
    WORLD["Editor state · GitHub · custom MCP servers"]

    AV -- actions --> ORCH
    SET -- actions --> ORCH
    ORCH -- "snapshots + patches" --> AV
    ORCH -- "snapshots + patches" --> SET
    POOL <--> AGENTS
    MCP <--> WORLD
```

Data flows one way: webviews send **actions**; the orchestrator sends **snapshots and
patches**. No business logic, persistence, or protocol handling in webview code —
webviews are disposed when hidden and must rehydrate losslessly on every mount.

## UI layer

Two webviews and one near-empty native settings page:

1. **Agent View** — the single blend (the Features doc). Its layout is the owed
   design deliverable; what architecture fixes now is its information boundary: it knows
   only its current snapshot + patch stream, and can only emit actions. Anything the
   layout wants to show must arrive through that pipe — which is the whole
   rehydration guarantee.
2. **Settings** — agents and launch config, capability matrix, integrations,
   routing, permission rules. Structured data, low frequency, same render-only
   contract.
3. **VS Code native settings** — flat scalars only, deliberately near-empty.
   Never credentials: `settings.json` syncs.

Native surfaces — the status bar item (active session, connection health, usage),
permission notifications, and command palette entries — are direct orchestrator
consumers: same state, no webview in the path.

> Agents, sessions, and chat are one surface (the Features doc). Settings remains
> its own webview because it is genuinely a different activity, not because panels
> are cheap.

How both webviews are *built* — one shared component layer (shadcn/Radix on
React, Codicons, a single VS Code-theme bridge) and the chat transcript
rendering pipeline (Streamdown markdown, the ordered block model, tool-call
cards) — is decided in
[the UI Architecture doc](ui/ui-architecture.md); the split
above is about state and lifecycle, never visual identity.

### Snapshot + patch protocol

One protocol, one shared TypeScript module (`src/shared/protocol.ts`) both sides
import. No diffing library, no CRDT, no partial hydration:

- **Actions** (webview → orchestrator): a discriminated union — `prompt`, `stopTurn`,
  `switchSession`, `grantPermission`, `connectAgent`, … Fire-and-forget; results come
  back as state, never as replies.
- **Snapshot** (orchestrator → webview): the complete view model for that webview,
  tagged with a monotonic revision. Sent on mount and whenever the webview asks.
- **Patch** (orchestrator → webview): `{ rev, events[] }` — semantically named events
  (`sessionUpdated`, `agentStatusChanged`, `permissionRequested`, …) applied by pure
  reducers in the webview. A webview that sees a revision gap discards its state and
  requests a fresh snapshot. Recovery is always "resnapshot," never "repair."
- **Coalescing**: the orchestrator buffers high-frequency `session/update` streaming
  chunks and flushes one patch per short fixed interval (~30 ms) or turn boundary,
  concatenating text chunks per message. One knob, no adaptive machinery.

One mechanism sized to the actual problem: webviews die and must resurrect
cheaply.

## State — three honest stores, no co-equal copy

The agent owns the conversation (features §1). Patchbay holds exactly three things,
each with different truth semantics, so each gets different placement:

| Store | Contents | Placement | Why |
|---|---|---|---|
| Known sessions | The mirror of the agent's own `session/list` (+ this window's creates): id, title, stamps | Memory only — repopulated from the wire every connect | The agent is the source of truth for sessions; patchbay persists no session records — no index, no transcripts. Agents without `session/list` show only currently-open sessions; nothing survives a reload (deliberate scope decision). |
| Last-connected stamp | Agent ids still running at shutdown, plus write time | `workspaceState` | Reload continuation: consumed (read + cleared, spent either way) by the next activate and honored only while fresh (~60s) — deactivate fires identically for reload and quit, so the stamp's age is the discriminator; stale or absent means only auto-connect-flagged agents start |
| Last-active pointer | The one session id the Agent View returns to on the next activate | `workspaceState` | Reload continuity's third rung (flag → list → pointer). One rule at restore, found or not: looked up in what the startup connects' own `session/list` syncs brought back — found activates, not found lands on the default screen, regardless of why. A miss never clears the pointer (not-found ≠ gone: a failed connect must not erase where a later window could return) |
| Decision audit | Permission/routing events | JSONL in workspace storage | Append-only, grows, belongs to patchbay |
| Render cache | Current render state | Memory; rebuilt from `session/load` replay | Disposable — replay always wins |
| Agent + integration configs | Agents (launch config, defaults), integrations, routing | Machine store — a patchbay-owned JSON file in the extension's `globalStorage` directory (`stores/file-kv.ts`), written atomically, drained once out of `globalState` (the editor-owned shared `state.vscdb` was observed truncated to zero bytes by an unclean shutdown, taking every config with it) | Developer-env, not code-env: global to this machine, never a repo-committed file; no credentials ever |
| Permission rules | Command allowlists, file-write scopes | `workspaceState` (workspace layer) + machine store (machine-layer command rules) + built-in defaults | Workspace rules evaluated first, machine rules the fallback floor, then ask. Per-user either way, never repo-shipped — a cloned repo must not arrive pre-authorized |
| Secrets | OAuth tokens, API keys, env values (agents *and* custom-stdio MCP servers) | `SecretStorage` | The only place. Never settings, never state stores, never logs. Env values are how agents and stdio MCP servers commonly take API keys, so the whole env record is a secret (`stores/secret-env.ts`); config records carry no env, webview snapshots carry key names at most, and values are read at the last moment reality needs them — agent spawn, or MCP attach (where the handoff to the agent is inherent: the agent spawns stdio servers itself). HTTP integration credentials cross to the agent only on the mcp.http passthrough path (a fresh token in the session-open headers — ephemeral per session, exactly a CLI-added server's profile, and better than at-rest plaintext); on the bridge path the credential never touches agent-visible config — the bridge IPC-fetches its token per request |

Agents and integrations are deliberately global-only. The MCP incident behind
this — a production-access MCP server silently following a user between repos —
is guarded where the risk actually lives: a shared/pasted config never carries
its credential; the token reattaches only when its recipient explicitly
connects. Binding configs to workspaces (workspaces, not repos) may return later
as an opt-in; the extension point is visible, deliberately unfilled.

## ACP client pool & process model

- Registry: `agentId → { process, declared, used, sessions[] }`.
- Different agents are always separate subprocesses. Sessions with the *same* agent
  multiplex over one connection by default — that is the protocol's own model
  (`session/new`/`load`/`close` are session-ID-scoped on one connection).
- **Per-agent process policy** (Settings): `auto` (default — share if concurrent
  behavior is *used*, isolate otherwise), `shared` (force, user accepts risk),
  `isolated` (one process per top-level session).
- Crash → visible immediately; restart is one action. After reconnect: the
  attach ladder — `session/load` (replay = truth) > `session/resume` (context
  back, seam notice: no visible history) > honestly not reopenable. Patchbay
  never mints a session and calls it a continuation.

```mermaid
flowchart TD
    R(["Reconnect / reopen a session"]) --> Q1{"declared session/load?"}
    Q1 -- yes --> L["session/load — full replay<br/><small>replay is truth</small>"]
    Q1 -- no --> Q2{"declared session/resume?"}
    Q2 -- yes --> RS["session/resume<br/><small>context back; seam notice: no visible history</small>"]
    Q2 -- no --> N["Honestly not reopenable<br/><small>never mint a session and call it a continuation</small>"]
```
- **Session lifecycle**: switching chats never closes anything. The idle
  reaper is the only closer, and only when *all* hold: not new
  (`everPrompted` — a never-prompted session never closes, period; agents
  404 load/resume on zero-turn ids), nothing in flight, not unseen-completed
  (blue mark), prompt box empty (structural: the composer exists only for
  the active session, which is always exempt), idle past the auto-close time
  (default 60 min — a user setting soon), and declared `session/load` —
  never load-or-resume: patchbay persists no transcripts, so closing anything
  less than fully-replayable would destroy the only copy. "New session" for
  an agent with a never-prompted session focuses it instead of minting a
  sibling.
- **Launcher health** (launcher-health.ts — one central module, consulted at
  the chokepoints, never inlined): npx/uvx stay the installers — a
  patchbay-owned install store was **considered and rejected** (it fixes
  cache corruption by owning atomicity, but the price is reimplementing the
  package manager's lifecycle: GC with in-use guards, single-flight,
  stale-fallback policy, bin resolution; the price exceeds the defect).
  Instead: (a) an interrupted npx install leaves a partial `_npx` entry that
  npx forever treats as installed — the bin-missing death (exit 127 /
  "not found", the launcher-shell's own words in the stderr tail) triggers a
  purge of *attributable* entries and exactly one retry; the warmup's own
  180s-cap SIGKILL — itself the poison mechanism — cleans up the entry it
  interrupted before the real spawn runs. (b) The binary installer, where
  patchbay *does* own the disk, prevents rather than repairs: staging dir +
  rename-on-success, so nothing ever exists at the installed-check path
  unless the whole install succeeded. (c) **Two installs, one memory**: a
  PATH-installed sibling CLI shares the agent's per-user state store with
  the copy patchbay runs (by design — never a second history); a
  major-version divergence between the two writers gets a one-time warning,
  never a gate. The comparison is like-with-like via a per-agent table
  (`PATH_SIBLINGS`): the bundled CLI's version, not the adapter's — entries
  earned by verifying that mapping (claude-acp absent: its adapter bundles
  the SDK, no honest comparison exists). Patchbay never mutates PATH or
  installs globally — a user who wants the CLI in their terminal owns that
  install and its update channel.
- **Runtime resolution** (runtime-resolver.ts, the pool's one launch-phase
  seam, ahead of warmup and spawn alike): an `npx` agent needs Node.js, a
  `uvx` agent needs uv (which provisions its own Python) — neither is
  guaranteed on the machine, and Windows is where the gap bites.
  **Detect-first, sandbox-fallback**, decided over always-sandboxing (Zed
  manages its own Node unconditionally): a working system runtime *is*
  reality, and shadowing it would fork behavior from the user's terminal.
  The gate is a real `--version` round-trip through the same spawn rules as
  the launch (presence on PATH proves nothing — the declared≠used instinct
  applied to interpreters), plus a version floor for node; re-run fresh
  every connect, never persisted. Only a failed gate downloads a
  pin-versioned runtime (curated catalog: nodejs.org / uv release CDN) into
  the same bin-cache as binary agents — same staging+rename integrity, same
  explicit-confirmation-before-download ethos, then re-gated itself before
  use (a glibc build on musl fails the connect with a real reason). The
  applied decision is PATH-prepending into that one agent's spawn env —
  the command is never rewritten, so every downstream spelling (warmup,
  Windows .cmd shim handling, cache repair) works unchanged, and nothing
  is installed system-wide. Deliberate pairing with the data stance:
  **runtime = ours when needed, state = always the agent's own** — the
  managed runtime changes which interpreter runs, never where the agent
  keeps sessions, auth, or config, so terminal and patchbay copies stay
  one history.

## Agent capability matrix

Two states per capability, per agent — **declared** (from `initialize`, refreshed
every connect) and **used** (set only after the path actually fires on the wire —
whether that's real usage or patchbay's own free connectivity probe; "used" over
"verified" because a single success proves the path fired, not that it's
certified correct). Used is **version-keyed**, not connect-keyed
(`stores/used-capabilities.ts`): a reconnect at the *same* `agentInfo.version`
restores what was already proven immediately, from the persisted cache — it does
not re-run the check. Only an actual version change earns a fresh,
honestly-unused matrix. UI affordances gate on *used*, not declared: real bridges have been observed silently dropping `mcpServers`,
collapsing stop reasons, and reporting rejected mode changes as succeeded.
Four honest states per row: not declared / declared-but-not-used / used /
**suspect** — declared, not used, and implicated in at least one failed
request (a wire fact that would have proven the row rode a request that
rejected). Suspicion, not conviction: the failure may not be the row's fault,
so it renders as a warning triangle, never an error, and gates nothing — UI
features still gate on used only. First success acquits (used drops the
flag); `auth_required` never indicts (it's the honest pre-login state, with
its own surface: pool.ts's wire chokepoint raises `needsAuth` on any -32000 —
probe, connect, or a mid-session prompt after credentials expired — one
writer for the spec's "prompt the user to authenticate again"); only
outgoing agent RPCs can indict — a client-side handler
throwing is patchbay's own gate rejecting, never the agent failing. Suspect
persists version-keyed exactly like used: a broken bridge must not look clean
after a restart.

Marking a row used is centralized in one **proof table**
(`CAPABILITY_PROOFS`, capabilities.ts) — the single place that knows which wire
fact proves which row. `pool.ts` — the sole channel that talks to an agent on
the wire — consults it at three chokepoints: an outgoing agent RPC resolving
(`session/new` → `auth`, and → `concurrentSessions` when the connection already
served a session; `logout` → `auth.logout` — declared from
`agentCapabilities.auth.logout`, and the Log out control only exists on a
declared row: the spec's "Clients MUST NOT call it" holds by construction;
`session/fork` → `session.fork` + `concurrentSessions`;
`session/load` → `session.load`; `session/prompt` → `prompt.image` / `audio` /
`embeddedContext` when the prompt actually carried that block type), an
incoming client request handled (`fs/read_text_file`, `fs/write_text_file`,
`terminal/create` — and `elicitation/create` the moment P7 registers its
handler), and a `session/update` kind tag arriving (`usage_update` → `usage`).
The same table serves both verdicts: a fact riding a successful call marks its
rows used; the same fact riding a failed call marks them suspect. No call site
anywhere names a row; adding a `CapabilityRowId` forces a table entry (the
Record is exhaustive) and nothing else. One `onCapabilityEvidence` hook
carries every hit, called synchronously and never awaited so it can't block
the RPC it's reporting on. `capability-tracker.ts` only decides *when* to run
the synthetic probe below and persists whatever pool.ts reports — it does not
mark anything itself. session-manager.ts, which decodes `session/update` payloads for
rendering, marks nothing either; the wire-level fact and the render-level
interpretation are two different concerns living at two different layers.

```mermaid
flowchart LR
    C1["agent RPC settled"] --> PT
    C2["incoming client request handled"] --> PT
    C3["session/update kind tag"] --> PT
    PT["CAPABILITY_PROOFS<br/><small>which wire fact proves which row</small>"] --> H{"rode a success or a failure?"}
    H -- success --> U["used<br/><small>gates UI affordances</small>"]
    H -- failure --> S["suspect<br/><small>warning only; gates nothing</small>"]
    U -. "first success clears" .-> S
```

Rows (`CapabilityRowId`, protocol.ts) are **hand-picked** against the ACP spec's
declared capability surface, not derived automatically: `fs.readTextFile` /
`writeTextFile`, `terminal`, `elicitation`, `roots.listChanged`,
`resources.subscribe`, `promptCapabilities.image` / `audio` / `embeddedContext`,
`session.fork` / `load` / `resume`, `mcp.http` / `sse`, usage/context reporting,
concurrent-session behavior. One patchbay-side row rides along: rules/skills/
commands locations (mapped / not mapped), sourced from the asset-location code
table (`ASSET_LOCATIONS`, asset-locations.ts) rather than the handshake. A new ACP capability needs a row added here before it can show up
at all — a deliberate scope decision (ACP's capability surface is still
settling, and rows need human-curated meaning and a check strategy anyway, so a
schema-driven dynamic list wouldn't remove the manual step), not a limitation.

Verification cost splits the triggers:

| Trigger | Protocol-level (free RPC) | Behavior-level (costs real LLM turns) |
|---|---|---|
| Connect/reconnect: `session/new` always (it doubles as the knob-offering read — offerings are connection state and must be read fresh); the `session/fork` half only while still declared-but-not-used for the current version | Automatic | Opportunistic only — used when naturally exercised |
| User-run diagnostics (Settings › Agents' `Verify…`, itself only shown while a checkable row is still outstanding) | Instant | Allowed; cost disclosed first |
| Background schedule | Fine, cheap | Never |

Connect therefore always implies one throwaway probe session — an accepted
behavioral contract, not an accident: `session/new` is free, the offering read
needs it every connect (see § Session model), and auth/concurrency proof falls
out of the same round-trip opportunistically. The probe session's root is the
agent's **standing probe workspace** (`globalStorage/probe/<agentId>` — never
the user's workspace roots), created idempotently per probe and deleted only
with the agent's config: a workspace-aware agent may validate or index that
root *after* replying to `session/new` (observed: Auggie, where a vanished
root is CLI-fatal), so the root's lifetime must cover the agent's use of it,
not patchbay's RPCs — an ephemeral per-probe temp dir was a promise patchbay
deleted while the other process still held it. The *verification* gates keep
their version-keyed skip: `hasUnusedProbe` (protocol.ts) remains the single
predicate for "a checkable row is still outstanding" — the `session/fork`
sub-check and the manual `Verify…` control's visibility both gate on it, so
the two can't drift on what still needs a check.

Synthetic behavior probes run in an **ephemeral session scoped to a temp directory**
— never the user's workspace roots, never silently.

## Wire log — the opt-in raw-frame tap

Settings › Audit can stream every ACP JSON-RPC frame (the stdio ndjson wire —
there is no gRPC anywhere in this stack) to a dedicated Output channel.
Decisions, recorded:

- **Redaction at the seam, not consent alone.** `session/new`'s `mcpServers`
  array carries the env values patchbay injected for custom-stdio servers —
  real secrets on the wire. Every value patchbay reads out of SecretStorage on
  its way to a session is registered with the wire log and masked before a
  byte reaches the channel (`wire-log.ts`); over-redaction of plumbing values
  is accepted as the safe direction. What an agent echoes back on its own
  initiative cannot be masked — the disclosure prompt says so instead of
  pretending otherwise.
- **Never persisted; TTL-bounded.** Debugging is a session act, not
  configuration: a reload always starts clean, and the log turns itself off
  after 30 minutes unless deliberately extended. While on, a warning-tinted
  status-bar pill shows the countdown; its existence *is* the state. Click →
  stop (fast path) or extend.
- **Tap lives in pool.ts** — the sole channel on the wire — line-assembled so
  redaction always sees whole frames, and zero-cost while off (chunks dropped
  before decode). Frames over 8 KB are truncated with an honest marker.

## Protocol extensions (`_meta`)

ACP reserves `_meta` fields on every type and underscore-prefixed methods for
implementation extensions — a spec-sanctioned mechanism, not a dialect. Adapters
carry real surface there beyond core protocol; observed in `claude-agent-acp`:
`_claude/sdkMessage` (tunnel of the raw Claude Agent SDK stream),
`_claude/rateLimit` (subscription rate-limit windows), `_claude/askUserQuestionOption`
(richer permission options), and a terminal-output `_meta` channel shared as a
convention with `codex-acp` for live command output. The observed pattern:
extensions enrich standard updates in place — `_claude/rateLimit` rides the
standard `usage_update` notification's `_meta` while `used`/`size` stay
protocol-shaped — they don't fork the stream. Token and context reporting is
standard; only the vendor-specific remainder is extension.

Stance: **core ACP is the floor; extensions are per-agent adapter knowledge**,
recorded in code tables (meta.ts) and consumed only when a features bullet requires what
core ACP cannot carry. A consumed extension becomes a capability row — present by
observation, used like everything else. Vendor depth that never reaches the
wire (hooks, subagent definitions, skills) is files in `cwd` — the rules/skills/
commands surface is its channel, no protocol involved.

### Wire-extension modules

The spec-pure-core rule, generalizing meta.ts's discipline from the `_meta`
site to every out-of-spec adoption (extra response fields, undeclared
methods, removed-draft surfaces, behavioral quirk workarounds):

- **Core stays spec-pure.** No core file (pool, session-manager, knobs,
  capability-tracker, orchestrator) may contain a deviation's shape, wire
  method name, or display policy — and never a vendor name; adoption is
  always shape-gated, like everything else in patchbay.
- **One deviation = one module** under `orchestrator/extensions/`, owning:
  the zod schema (trust boundary, degrade-to-absent), the method string,
  the policy decisions the quirk forces, the adoption date, and a **retire
  condition** in its header. Retirement is mechanical: delete the module
  and its one compose line.
- **Core exposes declared doors, not interception points:**
  `pool.unstableRequest(poolKey, method, params)` — the one untracked
  escape hatch (extension-owned methods bear on no capability row);
  `normalizeKnobs(..., extras?)` where an extra is `{ knob, execute }` —
  knobs.ts applies one generic rule (extras append unless a spec-surface
  knob owns the id) and knows nothing of any shape; session-manager runs
  extension routes through one generic branch forever (the route executes
  itself and returns the next state to publish, or null to wait for a
  notification); offering chokepoints pass the raw response through, so a
  new surface never ripples a hook signature.
- **Shape-gated wherever shape exists; id-keyed only where it can't.** A
  silent behavioral quirk (nothing on the wire announces it before it bites
  — e.g. Auggie's first-session mcpServers latch) cannot be shape-gated, so
  its extension module carries an id-keyed curated entry, the
  ASSET_LOCATIONS discipline: earned by reproduction, version-stamped,
  dated. Core still never names the vendor — the id lives in the module.
- **Deliberately NOT a hook/plugin framework.** Function-extension systems
  (Odoo-style inheritance, hook buses) earn their complexity from third-party
  module ecosystems; patchbay's deviations are first-party and curated —
  two at this writing (`_meta` terminal-auth; Auggie's removed-draft models
  surface). Free interception would dissolve the one-door discipline
  (knobs.ts, CAPABILITY_PROOFS) that this codebase is built on. If a third
  and fourth extension start demanding shared machinery, a registry earns
  itself then — extension point visible, not filled prematurely.

The pilot is Auggie's removed-draft models surface (the Auggie dossier),
refactored into `extensions/session-models-field.ts` — precisely the shape this
rule exists to keep out of core files.

## Branching

**Out of the current release.** Standard-ACP-only is the line: an emulated
branch would be a cache presented as a conversation, so it is declined.
`session/fork` remains a capability-matrix row (declared/used honesty about the
agent), with no UI feature riding it. Native-fork-only branching is the visible
extension point when a features bullet demands it.

## Session model, mode, effort

Knobs (model, mode, effort, thinking, …), each existing only if the agent offers
it — model is the only one observed everywhere; the rest are frequent but
optional. The knob set is per-agent reality, not a patchbay form to fill.

**One knob processor.** `knobs.ts` is the knob sibling of `capabilities.ts`: the
only module that reads the wire's modes/configOptions relationship. Every
knob-bearing wire fact (create/load/fork responses, `config_option_update`,
`current_mode_update`, set responses) passes through it and comes out as one
normalized knob list; every knob set goes back through it to be routed
(`session/set_config_option`, or `session/set_mode` on the fallback surface).
No other file — and no webview — may distinguish the two surfaces
(render-only-webview: the UI renders knobs and sends `setSessionKnob`, nothing
else).

- **Exclusivity, per spec**: ACP v1 declares config options the successor —
  clients "SHOULD use `configOptions` exclusively and ignore `modes`", and v2
  drops `session/set_mode` entirely. So any non-empty `configOptions` wins the
  whole surface; `modes` alone synthesizes a single fallback knob
  (`MODE_KNOB_ID`). Category is UX-only ("MUST NOT be required for
  correctness"), so it is never a dedup key; under exclusivity the dup-pill
  class of bug is unrepresentable.
- **`current_mode_update` on the config surface is dropped** (visible in the
  wire log, never guessed at): mapping it onto an option would need category as
  a correctness key. The spec's transition duty ("keep both in sync") means a
  config-surface agent confirms mode changes via `config_option_update`; a
  bridge that doesn't earns a quirk entry in knobs.ts — the designated place —
  never a standing heuristic at a UI leaf.
- **Selections are knob-id-keyed everywhere** (defaults, confirmed
  combinations): one flat record, the modes-fallback knob under `MODE_KNOB_ID`.
  The stores keep their legacy `{mode, options}` / `modeId` fields as
  read-only history, folded on read (`foldSeed`) and never written again.

**Offerings are read, never stored; selections are stored, never inferred.**
ACP has no session-independent "list the knobs" call — `initialize` carries
capabilities only; the option surface rides `session/new`/`load`/`fork`
*responses* and `session/update` notifications, deliberately per-session state.
And offerings are provider inventory, not build behavior: a provider adds or
removes a model without `agentInfo.version` moving, so no persisted copy can be
keyed honestly. Therefore:

- **Offerings** are connection-scoped, in-memory only: read from the
  connect-time probe alone (the free `session/new` every connect performs — see
  the capability matrix section — plus the probe session's own late
  `config_option_update`), gone when the connection ends. Settings renders
  offerings only while the agent is connected; stopped agents show stored
  selections as text. (A live session's option surface is conditioned on that
  session's current selections — fast mode exists only on some models, effort
  lists vary per model — so it is session state, not provider inventory; using
  it would make the default-knob rows track whichever session last touched a
  knob. The probe session sits at agent defaults, so its surface is exactly
  what a new session will be offered — the right inventory for a defaults form.)
- **Selections** (per-agent defaults, part of the agent's config record; and
  per-session confirmed state, below) are the only persisted artifacts — bare
  ids/values, never lists.
- Patchbay never invents entries, never renders a knob the agent didn't offer.
- Displayed values update only from the agent's subsequent state notifications,
  never from the set-request's success response — bridges have returned success
  for rejected mode changes. What the user sees is the last agent-confirmed
  state, which is the honest one.

**Two knob holders, one seeding rule.** A knob combination lives in exactly
two places, and every attach decides between them by one question — *did the
user just do something, or did plumbing?*

- **Session knobs** — the session's own agent-confirmed combination, held
  in-memory only (snapshotted per publish onto the known-session row, which
  outlives the attachment but not the window). An **involuntary re-attach** —
  one-click reload, connection death, idle release, the roots re-apply — must
  re-seed it after the wire attach: agents reset knob state to their defaults
  on `session/load` (observed: claude-agent-acp rebuilds session config), and
  the user asked to change nothing — so honoring the agent's load-time reset
  would force its cache-miss over the user's reality.
- **Composer knobs** — the user's current working combination *per agent*
  (`stores/composer-knobs.ts`, machine store), written only when the user sets
  a knob and the agent confirms it (config surface: off the set response;
  modes surface: off the agent's own `current_mode_update` — set responses
  are never trusted). Never written at attach time — that would make "last
  used" mean "last attached", overwriting the record with agent defaults
  whenever an old session opens.

**Seeding at session birth/attach** — one policy (`reseedAfterAttach`):

| Attach | Seed applied |
|---|---|
| Fresh `session/new` | Entry seed: per-agent defaults, or the composer combination, by the `knobSource` preference — once, via set requests, skipped silently where the option isn't offered |
| Involuntary re-attach (reload, connection death, idle release, roots re-apply) — the window holds the session's combination | The session's own combination, re-seeded over the agent's load-time reset |
| Deliberate entry from history — nothing in hand (fresh window, or never opened here) | Entry seed, same as fresh. This knowingly overrides an agent that honestly restores per-session knob state on load: entry is deliberate, the user's current combination wins |

```mermaid
flowchart TD
    A(["Session attach"]) --> Q{"did the user just act, or did plumbing?"}
    Q -- "fresh session/new" --> E["Entry seed<br/><small>defaults or composer combo, by knobSource</small>"]
    Q -- "deliberate entry from history" --> E
    Q -- "involuntary re-attach (reload, death, idle, roots)" --> W["Re-seed the window's held combination<br/><small>over the agent's load-time reset</small>"]
```

Per-agent defaults themselves are written only by the Settings save path —
read-only to the session layer, the seed's fallback, never its record.

## Local MCP server — editor depth

The differentiator (the PRD's current-release scope), shipped complete:

- **Tools/resources**: active selection, current file, diagnostics (live, not
  stale), open editors. Explicit user gestures ("add selection to context",
  right-click) inject the same data into the prompt directly.
- **Context roots**: a session's roots are the workspace folders plus user-added
  external folders (multi-repo work). Delivered protocol-native (`roots` +
  `roots.listChanged` where declared; adapter fallback otherwise). Patchbay
  passes roots and never indexes — retrieval depth is the agent's own engine,
  and the UI never implies otherwise.
- **File operations go through ACP, not MCP**: the orchestrator advertises the `fs`
  capability, so `fs/read_text_file` serves live unsaved buffers and
  `fs/write_text_file` lands as a native diff the user accepts or rejects before
  disk is touched. Permission rules (file-write scope) can auto-accept; the diff
  remains visible either way.
- **Terminal**: orchestrator advertises `terminal`; commands run in a visible
  pseudoterminal, output streams live, gated by the same broker rules as everything
  else.
- **Adapters for uneven MCP client support** — every capability the local server
  uses has a protocol-native path and a tool-call fallback, chosen per connection at
  handshake:

| Capability | Native path | Fallback |
|---|---|---|
| `elicitation` | Elicitation request | Tool `request_user_input(schema)`; orchestrator renders the form, returns the answer as a tool result |
| `roots.listChanged` | Push notification | Roots injected into the next `session/prompt` |
| `resources.subscribe` | Live push | `get_workspace_state` tool; one turn of staleness accepted |

- **Image paste is never disabled**: `promptCapabilities.image` →
  `ContentBlock::Image`; otherwise the image is written to a temp file and sent as a
  `ResourceLink`. Same data, best form the agent accepts (features §1).
- **One attachment ingress** (composer/ingress.ts): every byte
  entering from the composer — paste or external drop — passes one admission point
  that owns the size cap (Preferences, default 10MB), the image pass-through set
  {png, jpeg, gif, webp} (the set every major LLM API accepts — an industry
  constant, not any agent's quirk table), PNG re-encoding for other decodable
  image types (decodable = Chromium's `createImageBitmap`: bmp/ico/avif in
  practice; svg blobs notably fail it), and every refusal message. An image the
  platform can't re-encode degrades to the file lane — original bytes, original
  type, attached as a resource_link the agent reads itself — so refusal is
  size-only. Nothing is ever guessed: the image chip's `mimeType` is a required
  field with no defaults
  anywhere downstream, because the platform that produced the bytes is the only
  honest source (the spec requires the field to *describe the payload*).
  Motivating incident: auggie 0.32.0 declares `prompt.image` but 400s the whole
  turn on formats outside that set (the Auggie dossier).
- **File attach** (drag-drop or picker): picker reads ride inline
  `ContentBlock::Resource` when `promptCapabilities.embeddedContext` is declared,
  `ResourceLink` otherwise. Drops split by what arrives: URI drops (VS Code
  explorer/tabs) resolve host-side — wire-set images become image chips, all else
  an attachment chip whose `ResourceLink` points at the real path; external drops
  carry bytes only (browsers hide paths; a client path means nothing to a remote
  host), so non-images are staged to a temp file at add time and linked from
  there. Directory drops are refused in the current release — a deliberate scope decision:
  expanding a tree is policy (depth, excludes), not a default. Observed in
  practice (2026-07-14): the VS Code workbench claims OS-file drops on the
  editor area for its own drop-to-open before a webview sees them — so the
  bytes lanes are exercised by *paste* (screenshots, copied files), and the
  drops that actually reach the composer are the explorer/tab URI kind.
  Accepted, not a bug: both entry points land in the same ingress.

## Integrations

The auth mechanisms, the curated set, and the transport-selection rules are the
[MCP Integrations Architecture doc](mcp-architecture.md); this section is how a
configured integration reaches an agent. Curated and custom are the same
mechanism — MCP servers routed to agents:

- **The registry is shipped data from day one.** The PRD decides this: GitHub
  ships "proving the registry pattern," and a hardcoded integration proves no
  pattern. One data file, one entry; every field earned by what GitHub
  demonstrably needs — `id`, `name`, transport, auth type, scopes, bridge launch
  — nothing speculative. Adding a curated integration is a data change, not code.
- **The agent list is NOT shipped data**: the official ACP registry is the one
  agent source (identity, launch, icon, live-fetched + disk-cached), and
  patchbay's own per-agent curation lives in code tables where every other house
  knowledge does — `ASSET_LOCATIONS` (asset-locations.ts), `META_EXTENSIONS`
  (meta.ts). The custom-command escape hatch covers anything the registry omits.
- **Custom escape hatch**: add any MCP server (command or URL, with auth).
- **Capability-conditional transport**: an agent declaring `mcp.http` gets the
  remote server passed through as a real `type: "http"` entry — its own MCP
  client connects, upstream-maintained transport, the declared path actually
  exercised. Everything else rides the stdio-to-HTTP bridge, a pipe between two
  `@modelcontextprotocol/sdk` transports: the guaranteed floor for non-declaring
  agents, plus the per-integration `transport: "bridge"` escape hatch for an
  agent whose declared http support is broken in practice. Routing around an
  agent's declared capability would never let the claim be tested, so a declaring
  agent exercises it. Passthrough traffic is agent↔provider direct (dark to
  patchbay); bridge traffic passes through us. Custom-stdio is handed through
  as-is, both worlds.

```mermaid
flowchart TD
    S(["Configured MCP server"]) --> Q0{"custom stdio?"}
    Q0 -- yes --> ST["handed through as-is"]
    Q0 -- "no — remote HTTP" --> Q1{"transport pinned bridge?"}
    Q1 -- yes --> BR
    Q1 -- no --> Q2{"agent declares mcp.http?"}
    Q2 -- yes --> HP["http passthrough<br/><small>agent↔provider direct, dark to patchbay</small>"]
    Q2 -- no --> BR["stdio-to-HTTP bridge<br/><small>through patchbay; per-request token, redaction</small>"]
```
- **Connect-time tool probe**: the orchestrator runs its own MCP handshake
  (initialize + tools/list — a free read, no agent, no LLM turn) on connect,
  power-on, and manual refresh; the card shows "N tools" expandable, timestamped,
  or the failure reason. Provider-side truth only — "reachable, these tools
  exist", never "working in an agent's session"; the same declared≠used
  discipline one layer down. Session-lived cache, never persisted: a fresh window
  re-reads reality.
- **Routing is the user's, per agent.** "auto" (default) = every agent; an
  explicit id list pins exactly; "except" = every agent minus the listed. Routing
  is reach, not consent: which servers an agent receives is separate from whether
  a given tool call is allowed — consent rides the permission broker per call,
  for every request_permission-routing agent.

## Rules, skills, commands

The current release is management, not delivery: the files live in each agent's
**own native locations** (`.claude/`, `CLAUDE.md`, `.augment/`, …) and the agent reads them from
`cwd` itself — patchbay never passes them down. Settings is where the user sees and
edits them, per agent, in place. No patchbay dialect (prd: not a new protocol), no
injection machinery.

- The per-agent location mapping lives in the `ASSET_LOCATIONS` code table; the
  current release ships Claude Code and Augment mappings — the agents in real use. An unmapped agent is shown as
  such — never silently skipped, never guessed.
- Commands the agent advertises back (`available_commands_update`) appear in the
  chat input as autocomplete and are sent as ordinary prompts. This is also the
  only compaction lever besides a fresh session: an advertised `/compact` is just
  one of these commands.
- Parked (a future release), stated as a scope decision: a shared base with
  compatibility symlinks into each agent's locations (the
  [dotagent](https://github.com/solutionsunity/dotagent) pattern) or full supply
  by patchbay. The current release proves the management surface first.

## Permission broker

- **One rule set, one approval path** — ACP `session/request_permission`, local MCP
  tool calls, and terminal execution all route through the same broker evaluating
  the same command allowlists and file-write scopes from `workspaceState`.
  A second, differently-scrutinized approval surface is exactly what a malicious
  prompt would target.
- **Rules never ride the repo.** Agent and integration configs are global,
  developer-owned stores — nothing config-shaped lives in the repo at all, so
  no repo-authored launch command exists to adopt.
- **No aggregate fidelity verdict.** The per-row matrix carries the honest
  data-plane facts (e.g. `fs.writeTextFile` used ⇒ live diff cards work);
  nothing aggregates them into a conduct label. An aggregate would read
  used=false ("hasn't crossed the wire yet") as "acts outside" — false for the
  entire SDK-CLI class, which does fs/terminal internally while routing
  *consent* through `request_permission` faithfully. If a summary ever returns
  it must be born as a data-plane *visibility* read-out ("patchbay sees this
  agent's edits"), never a gate.
- Protocol fact, load-bearing: an agent can route around `fs/write_text_file` via a
  shell command, and at least one bridge does file I/O invisibly regardless of
  client capabilities. `fs/*` is therefore **not a security boundary** — terminal
  gating carries equal rigor, and the matrix shows each agent's actual wire
  conduct row by row rather than silently trusting any of it.
- Allow-once / allow-always / reject inline in chat; when the Agent View is hidden,
  the same request surfaces as a native notification. One approval surface,
  wherever the user is looking.

## Context usage

Visibility only, not control — compaction is internal to each agent. `usage_update`
is **stable in schema v2**: `used` (tokens currently in context) and `size` (window
size) required, `cost` optional — the numerator and denominator of a context gauge.
Emitting it remains optional per agent, so population is uneven in practice: show
what is reported, omit cleanly when absent, never fake it. claude-agent-acp emits
it live mid-stream, so the gauge is a real-time affordance there, not per-turn.
The only guaranteed reset lever is a new session — which is why
concurrent sessions are load-bearing (the PRD's current-release scope), not a luxury.

## Code layout

Atoms first; each directory is one responsibility:

```
src/
  extension.ts    activation entry
  orchestrator/   session manager, client pool, broker, stores, extensions
  mcp/            local MCP server + its client-capability adapters
  integrations/   the stdio-to-HTTP bridge for remote MCP servers
  webview/        agent-view/, settings/ — render only
  shared/         protocol.ts (actions, snapshots, patches), types
```