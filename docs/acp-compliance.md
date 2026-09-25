# ACP Protocol Compliance — facts

Facts as checked **2026-07-12** against the pinned wire surface of
`@agentclientprotocol/sdk` **1.2.1** (ground truth for method names and type unions),
with the type unions and stability markers (§9, §10, §19) re-checked **2026-09-23**
against **1.5.0**
and https://agentclientprotocol.com/protocol/v1 (ground truth for normative
MUST/SHOULD/MAY language). Patchbay is a **Client**: compliance means (a) every
client-side duty is met, and (b) every agent-side surface the protocol lets a client
consume is either consumed or deliberately declined *on record here*.

This document states the current fact set only — what is true now, against which
version, checked when. It carries no fix history; git holds that. Retired gap ids
(G1–G14) mean "resolved — the resulting behavior is stated as a
present-tense fact in its section below."

Verdict vocabulary, used per row:

- **✅ Implemented** — duty met, anchor cited.
- **🟡 Partial** — works, with a named conformance gap (listed in Open Gaps).
- **⛔ Declined** — deliberately not implemented; the reasoning recorded in place is
  the artifact (scope decision, not limitation).
- **N/A** — an agent-side duty; listed only where confusion is likely.

Anchors are `file.ts:symbol`, not line numbers — this codebase moves.

---

## 1. Transport & framing

| Surface | Verdict | Notes |
|---|---|---|
| JSON-RPC 2.0 over stdio, ndjson framing | ✅ | `pool.ts` spawns the agent subprocess, line-assembles both directions before handing frames to the SDK. |
| `$/cancel_request` (protocol-level request cancellation) | ✅ | Handled inside the SDK's jsonrpc layer (`jsonrpc.js`: `CANCEL_REQUEST_METHOD`, incoming-side dispatch — verified by reading, 2026-07-12); patchbay neither needs nor adds code. |
| HTTP / SSE / WebSocket transports (present in the SDK) | ⛔ | the current release's scope is local subprocess agents — the reference baseline (vscode-acp) and every agent in the registry are stdio. The SDK already carries the transports, so the extension point is visible and costs nothing to leave unfilled. Adopt when a real remote-agent need appears, not before. |

## 2. Initialization

Spec: client MUST send `initialize` with the latest protocol version it supports;
SHOULD send name/version; MUST treat capabilities it omits as unsupported; SHOULD
close the connection if the agent answers with a version it can't speak.

| Duty | Verdict | Notes |
|---|---|---|
| `initialize` first, version + capabilities | ✅ | `pool.ts:connect` — `acp.PROTOCOL_VERSION`, `clientCapabilitiesWire()`. |
| `clientInfo` name/version | ✅ | `pool.ts:connect` sends `{ name: "acp-patchbay", version }`. |
| Honest capability advertisement | ✅ | `capabilities.ts:CLIENT_DECLARES` is the single source for both the wire claim and the matrix's client-side cells — they cannot drift. Declared: `fs` (read+write), `terminal`, `session.configOptions` incl. `boolean` (the knob surface supports both types end to end — knobs.ts; wire-verified accepted at initialize by claude-agent-acp 0.58.1 and auggie 0.32.0, 2026-07-12; deliberately no matrix row — rows are hand-picked, the knob strip is this claim's visible proof). `elicitation` is declared per mode, each only once its path is wired end to end (declaring earlier is exactly the lie the capability-verification rule exists to prevent): `form` and `url` are both declared. `auth.terminal` is declared there too (spec surface since the 1.5.0 schema), and only because its executor is wired. Adopted wire extensions declare their own opt-ins outside `CLIENT_DECLARES` (`_meta` keys via meta.ts's table) — each claim lives and retires with its module. |
| Close on unsupported agent version | ✅ | Pool refuses a mismatched negotiated version with a named reason (`markDead`); the negotiated version is agent-level truth, shown as an "ACP vN" badge in the Settings capability matrix, refreshed per connect. |
| Record agent capabilities per connect | ✅ | `capabilities.ts:matrixFromDeclared`, rebuilt wholesale every connect (reset-on-reconnect by construction); *used* state is version-keyed per the capability-verification rule. |

## 3. Authentication

Spec: `authMethods` advertised at initialize; client calls `authenticate` with an
advertised `methodId`; `logout` MUST NOT be called unless `auth.logout` is advertised;
client SHOULD expect post-logout operations to fail with auth errors.

| Duty | Verdict | Notes |
|---|---|---|
| Consume `authMethods` (id/name/description) | ✅ | Matrix `auth` row + method passthrough incl. description. |
| `authenticate` with advertised method | ✅ | `pool.ts:authenticate` (stable call, not the unstable terminal-auth variant). |
| Evidence-gated auth state | ✅ | One writer (`orchestrator.noteAuthEvidence`) over one authority table (`auth-evidence.ts`): wire `auth_required` and a successful `logout` lock; `authenticate` success, terminal login exit 0, a completed prompt, or a success contradicting the lock's own method clear; a bare connect or a lazy-auth agent's `session/new` success bears nothing. Locks persist machine-side (`stores/auth-locks.ts`) — reload/reconnect cannot launder a witnessed logout, a success bears only on a lock older than its call (every success carries when its RPC started; a prompt in flight when the lock was raised clears nothing), and evidence for removed agents is dropped. The matrix `auth` row is proven only by the affirmative actions (authenticate round-trip, terminal login exit 0), never by `session/new` or by a lock merely clearing. |
| `logout` gated on `auth.logout` declared | ✅ | `pool.ts:logout`; `auth.logout` capability row. |
| Post-auth-error honesty | ✅ | The pool's chokepoints report the wire fact — `-32000`, or a rejection the extensions door reads as an auth failure (`extensions/turn-auth-failure.ts`: `-32603` carrying an auth-classified `data.errorKind`, the claude-agent-acp shape for a credential failing mid-turn); `noteAuthEvidence` is the single writer (row above). `auth_required` never raises capability suspicion (per capability-verification rule). Spec names no numeric code; `-32000` is the observed convention — recorded as such, not as spec. |
| Auth method types (`terminal \| agent`; stable in the 1.5.0 schema, `env_var` retired with the RFD) | ✅ | Core: `capabilities.ts:terminalAuthOf` parses the executable half (the SDK types these fields but validates no response) and `authMethodKind` classifies from it — the one rule the matrix row and the login executor both read. `auth.terminal` is declared at initialize, which is what makes an agent offer terminal methods at all; such a method runs as the agent's own spawn command with its args appended and env merged, in a visible terminal, then re-probes (orchestrator `typedLoginViaTerminal`, exit-code-then-probe evidence chain included). `authenticate` is never called on it — login success is always terminal-ran-plus-reprobe, never the RPC's word. Anything patchbay cannot run — a type outside the spec's pair, or a terminal whose args/env didn't parse — classifies `unsupported`: shown as declared, never a button, and never passed to `authenticate` (the spec's MUST NOT), so there is no fallback that would call it. |

## 4. Session setup — new / load / resume / fork

Spec (session-setup): `session/new` with cwd + MCP servers; `session/load` gated on
`loadSession`, agent MUST replay the **entire** conversation as `session/update`
notifications before responding — no pagination or lazy loading exists anywhere in
the chapter. `session/resume` and `session/fork` are SDK surface beyond the published
chapters (see §19).

| Surface | Verdict | Notes |
|---|---|---|
| `session/new` | ✅ | `pool.ts:newSession`; cwd, mcpServers, and `additionalDirectories` only when the agent advertises `sessionCapabilities.additionalDirectories` (client MUST — `pool.ts:dirsIfAdvertised`, one gate for new/load/resume/fork). |
| `session/load` full-replay consumption | ✅ | Every replayed update kind is consumed (§9), with message-boundary fidelity per `messageId` (§8). Replay reduces silently into canonical state and lands in the webview as one wholesale swap (`loadSilently`/`ChannelHost.resync`); an `inFlight` guard keeps live prompt echoes from double-rendering. |
| `session/resume` | ✅ | `pool.ts:resumeSession`; capability-gated on declared + used per the capability rule; an honest seam notice marks where the cached view ends and the agent's unreplayed memory continues (`session-manager.ts:resumeReattach`). |
| `session/fork` | ✅ | Same adoption posture; `session.fork` capability row; native fork gates on *used*. |
| Roots re-apply (`additionalDirectories` set-complete-list) | ✅ | `session-manager.ts:reapplyRoots` — the three-case rung (recreate on a zero-turn session / in place via `session/resume` only, never `load` / deferred to turn end and awaited before the held queue drains) is a recorded design; where no rung applies the list is still recorded and the session's MCP servers told (they read `session-manager.ts:rootsOf`), and the roots chip says the agent takes it at the next open, or never. |
| Roots read-back (`SessionInfo.additionalDirectories` on `session/list`) | ✅ | `session-manager.ts:adoptReportedRoots` — a present list replaces the intended user-added list (never merged: spec MUST NOT), workspace folders subtracted, for sessions not open here; a malformed list degrades to not reported (`response-guards.ts:guardListedSession`). **Deliberate departure:** an omitted field is read as *not reported*, not as *no roots* — the spec makes the report a MAY, so omission cannot distinguish the two, and it lets the client's list differ from any reported list. Observed: claude-agent-acp 0.81.0 and codex-acp declare the field and omit it on every row. A proposal to restore the RFD's earlier wording (#1227) was declined upstream (agentclientprotocol/agent-client-protocol#2212, 2026-09-23): the published spec keeps "omitted and empty are equivalent". |

## 5. Session list / delete / close

Spec (session-list): cursor is opaque; missing `nextCursor` = end; MUST NOT call
without the capability; list is read-only. Delete: idempotent (SHOULD succeed
silently on unknown id). Close: frees resources, history intact.

| Duty | Verdict | Notes |
|---|---|---|
| `session/list` pagination, opaque cursor | ✅ | `session-manager.ts` sync walk (`MAX_LIST_PAGES` guard); stricter than spec: a *truncated* walk never prunes local rows — "a truncated read must never erase". |
| Capability gating | ✅ | All session ops check `declared` first; delete additionally gates on **used** (honest-close rule: forgetting locally while a delete-capable agent keeps the row would resurrect it on next sync). |
| `session/delete` idempotency tolerance | ✅ | Failure tolerated and logged; sync stays truthful either way. |
| `session/close` | ✅ | `pool.ts:closeSession`; `release()` additionally requires declared `session/load` — **deliberately not** `load || resume`: patchbay persists no transcripts, so closing anything less than fully-replayable would destroy the only history there is. Recorded guard, do not relax. |

## 6. Prompt turn & stop reasons

Spec: prompt content restricted to negotiated capabilities; all five stop reasons
(`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`) must be
recognized.

| Duty | Verdict | Notes |
|---|---|---|
| Capability-gated prompt content | ✅ | `session-manager.ts:sendPrompt` — images ride as `ImageContent` only when `promptCapabilities.image` is declared, else bytes go to a temp file sent as `resource_link` (baseline every agent MUST accept). Mentions ride as positional `resource_link` parts. |
| Stop reason handling | ✅ | `stopReason` flows through `turnEnded` verbatim and renders; non-`end_turn` reasons logged. No per-reason branching is required by spec; display is honest. Stop reasons exist only on the live prompt response — replay carries no turn resolution anywhere in the protocol, so a replayed turn's boundary renders with `stopReason: null` (absence over fake; wire-verified on claude-agent-acp and auggie, 2026-07-12). |
| Usage on response (`usage`) | ✅ | `toTurnUsage` on the prompt response + `usage_update` notifications both feed the ticker. |

## 7. Cancellation

Spec: client MAY send `session/cancel` (notification). On cancellation the client
**MUST respond to pending permission requests with `cancelled`**, SHOULD preemptively
mark incomplete tool calls cancelled, SHOULD still accept trailing tool updates.

| Duty | Verdict | Notes |
|---|---|---|
| `session/cancel` notify | ✅ | `pool.ts:cancel` ← `session-manager.ts:stopTurn`. |
| Cancel pending permission requests | ✅ | `broker.cancelPending(sessionId)` sweeps the session's pending requests — agent requests and patchbay's own gates alike — wired from `stopTurn` and `closeSession`; cards close with an honest "Cancelled — turn stopped" label, audited as `turn-cancelled`. |
| Preemptively mark incomplete tool calls cancelled | ✅ | A *sidecar fact* (`ToolCallBlock.interrupted`), not the ACP `status` field — the wire has no cancelled tool status, so patchbay doesn't put words in it. Set once, at the real quiet points, by `session-manager.ts:sweepOpenToolCalls` (the tool-call analogue of `broker.cancelPending`): **every** turn end (any stop reason — even a claimed clean `end_turn` leaves nothing running, so a call still open then is stranded; the error path included) and **replay end** (`loadSilently` — live cancel and its later replay normalize identically). Turn-scoped by construction: a later turn in the same session never revives an old turn's stalled spinner. A trailing `tool_call_update` still wins — any fresh upsert clears the flag, since the wire is still talking about the call. A persisted last-known view (`transcriptSeeded`, resume-without-replay) normalizes the same way: a snapshot with no live turn behind it is interrupted on sight. |

## 8. Content types

Spec: five ContentBlock types — six shapes: an embedded `resource` is text-formed
(`TextResourceContents`) or blob-formed (`BlobResourceContents`). Client-side receive
support is not individually mandated, but silently dropping renderable content is
against this project's own honesty rules, which bind harder than the spec here.

| Direction / type | Verdict | Notes |
|---|---|---|
| Prompt out: text | ✅ | Baseline. |
| Prompt out: image | ✅ | Capability-gated with `resource_link` fallback (§6). |
| Prompt out: audio | ⛔ | Patchbay has no audio capture surface; nothing to send. Revisit only if a recording feature ever exists. |
| Prompt out: embedded resource (`embeddedContext`) | ✅ ⛔ | Split by semantics: **context chips** are snapshots the user took — they ride as embedded `resource` blocks where the capability is declared (uri-attributed; selections carry a `#L` fragment), labeled-text fallback otherwise — capability first, fallback second, switched at the `sendPrompt` chokepoint. **@mentions** deliberately stay `resource_link` even when declared: a mention is a reference, not a snapshot — the agent pulls the slice it wants through brokered fs (live buffer, `line`/`limit`). |
| Receive: text chunks | ✅ | `handleUpdate` text cases. |
| Receive: `ContentChunk.messageId` (message identity on every chunk) | ✅ | Governs run continuation on all three chunk channels (one gate: `runBlockFor`, session-manager.ts): two non-null ids decide alone — equal continues, different splits (a fused agent-message boundary un-closes markdown fences). With an id missing on either side: user runs never merge (id-less agents replay whole messages per chunk; an agent splitting one message across id-less chunks would be unreconstructable by any client); agent/thought runs always merge — an id-less wire carries no boundary, and splitting on a guess would shred live stream deltas and chunk-log replays alike. Wire-verified 2026-07-12: claude-agent-acp 0.58.1 replays multi-part prompts as several chunks under ONE id and adjacent messages under distinct ids; auggie 0.32.0 omits the field (its agent-chunk replay granularity is uncaptured — until a capture lands, its agent message boundaries are invisible by honest necessity). |
| Receive: non-text in message chunks (image/audio/resource_link/resource) | ✅ | Never a silent drop, and never a placeholder for content the chat can show. All three chunk paths (user/message/thought) go through the one content mapping (`content-parts.ts:contentPartOf`), shared with tool-call content: images are stashed and previewed (the webview's `img-src` already trusts its own resource root — no CSP change), embedded text-formed `resource` renders as a labeled, expandable snapshot, `resource_link` as `@name` in user prose or a `[name](uri)` link in agent prose. An agent's non-text piece is its own block between prose runs (`agentPart`, `thought` kept). Audio and blob-formed resources keep a type-labeled placeholder — a recorded floor (decided 2026-09-25): nothing plays or saves them until a surface for that is justified. Whitespace-only chunks never *open* a run (an open run still takes them — mid-stream spacing is real content) and never sever a neighboring run. |
| Annotations / `_meta` on content | ⛔ | Not consumed; no current agent emits meaning patchbay could render. Unknown fields pass through untouched (safe by construction). |

## 9. Session updates — the full union

SDK 1.5.0 `sessionUpdate` union (16 kinds) vs `session-manager.ts:handleUpdate`:

| Kind | Verdict | Notes |
|---|---|---|
| `agent_message_chunk` | ✅ | Fully consumed: text streamed; non-text rendered as its own part block (§8). |
| `agent_thought_chunk` | ✅ | Block-interruption rule per the UI Architecture doc; non-text rendered like message chunks, reading as a thought. |
| `user_message_chunk` | ✅ | Delta semantics with `messageId`-governed boundaries (§8); `inFlight` guard against live echo. |
| `tool_call` / `tool_call_update` | ✅ | See §10. |
| `plan` | ✅ | Whole-replace per spec ("Client MUST replace the current plan completely") — `planUpdated` swaps the pinned strip snapshot. |
| `plan_update` / `plan_removed` | ⛔ | UNSTABLE as of 1.5.0 ("not part of the spec yet") and modeling a *different* plan system than the stable whole-replace `plan`: multi-plan (`PlanId`-keyed), three content forms. Gated behind a client capability patchbay does not declare, so no conforming agent sends them; the stable `plan` already covers the feature. Watch each SDK bump (the exhaustive `handleUpdate` switch forces the look); adopt when it lands in the published spec — contribution upstream is an option if the shape stalls. |
| `notice` / `compaction_update` / `compaction_summary_chunk` | ⛔ | UNSTABLE as of 1.5.0, new since 1.2.1 (session-notices and compaction RFDs). Each is gated behind a client session capability (`notices`, `compaction`) patchbay does not declare, so no conforming agent sends them. Revisit when they land in the published spec. |
| `available_commands_update` | ✅ | Name/description/input-hint all consumed; the hint shows in the composer's slash menu. |
| `current_mode_update` | ✅ | Modes surface only; config surface deliberately owns its own confirmations (knobs.ts normalizer — spec forbids category as a correctness key). |
| `config_option_update` | ✅ | Spec: notification carries complete state — consumed as a whole-replace. |
| `session_info_update` | ✅ | Title-authority rule: the agent's title wins; null title is a clear, not a rename. Handled before the live-session guard (agent may retitle sessions patchbay isn't attached to). |
| `usage_update` | ✅ | Declared+used marked on first sight at the pool chokepoint (no initialize-time claim exists for usage). |
| *Unknown / future kinds* | ✅ | Runtime-ignored per the spec's extensibility rule; the switch is compile-time exhaustive over the SDK union (`assertUnconsumed` backstop) — an SDK upgrade adding a kind fails typecheck and demands a verdict here, consumed or declined, never silent. Same forcing pattern as `CAPABILITY_PROOFS`. |

## 10. Tool calls

`ToolCallContent` union: `content` | `diff` | `terminal` (re-checked at 1.5.0). The
optional `ToolCall.name` (programmatic tool name, stabilized 2026-09-17) is not
consumed: the card names the call by its `title`, which every agent sends.

| Duty | Verdict | Notes |
|---|---|---|
| `tool_call` create + `tool_call_update` merge semantics | ✅ | Upsert with "absent field inherits" in both the reducer and the bus coalescer — matches "only the fields being changed need to be included". Present `content` replaces the call's display content and its diff collection; absent keeps both (`toolContentOf`, `stashToolDiffs`). |
| Statuses (`pending/in_progress/completed/failed`) | ✅ | Rendered on the tool card. |
| Kinds (read/edit/delete/move/search/execute/think/fetch/other) | ✅ | `toolKind` drives iconography; unknown → `other`. |
| Content `diff` | ✅ | Fully rendered, three surfaces from two sources (agent-reported diffs here; the fs/write gate's pre-image at the orchestrator chokepoint): the tool card's openable per-call diff (`toolCallDiff`), the files panel's since-first-touch baseline diff (`fileBaselines`, first note wins), and the cumulative ± badges (`fileStats`). |
| Content `content` (regular blocks) | ✅ | Rendered in the card's details in the agent's order, through the one content mapping every chat surface shares (`content-parts.ts`): text as the agent's markdown (bounded, like the raw fields), `resource_link` as a mention, images previewed from the attachments stash, embedded text resources as labeled snapshots; audio and blob resources keep a labeled placeholder — a recorded floor, nothing plays or saves them. |
| Content `terminal` (embedded by id) | ✅ | The terminal renders inside its tool-call card, visible without expanding — command, live state, output as it streams, kept after release — and leaves the transcript stream as a block of its own (`embeddedTerminalIds`). A terminal no call claims still renders standalone. |
| `locations` follow-along | ✅ | Each location rides the block as path + line (`tool-locations.ts`) and opens from the tool-call card — the cursor on the named line's first non-blank character, clamped into the file; a directory is revealed in the Explorer. The spec leaves `line`'s base unstated; it is read **1-based** (decided 2026-09-25), because the agents that send one count from 1 — claude-agent-acp (Read `offset ?? 1`, Edit hunk `newStart`), Gemini CLI 0.50 (`start_line`, documented 1-based) — and a whole-file read reports `line: 1`. `0` is taken as the first line. Zed reads it 0-based (its own tools send `start_line - 1`); OpenCode and codex-acp send no line. Covered by `test/tool-locations.test.ts` and `test/vscode/open-location.test.ts`. |
| `rawInput`/`rawOutput` | ✅ | Bounded (`boundedRaw`) with an explicit truncation marker, and shown behind a collapsed **raw** toggle in the card's details: the exact arguments and unformatted result, kept for transparency, never the main view — that is the agent's content. |

## 11. Permission requests (`session/request_permission`)

| Duty | Verdict | Notes |
|---|---|---|
| Respond with `selected` / `cancelled` | ✅ | `broker.ts:resolveAgentPermissionRequest`; dismissal → `{ cancelled: true }`. |
| Option kinds inform UI | ✅ | allow/reject × once/always rendered distinctly. |
| Auto-resolution per user settings (MAY) | ✅ | Broker rules; per the capability rule, an auto-*rejection* is patchbay's own gate working and never marks the agent suspect. |
| Cancelled turn → pending requests resolve `cancelled` | ✅ | See §7. |

## 12. File system (client-exposed)

| Duty | Verdict | Notes |
|---|---|---|
| `fs/read_text_file` returns live editor state | ✅ | `orchestrator.ts:readTextFileLive` — open (possibly dirty) buffer wins over disk; "the agent sees what the user sees". |
| `fs/read_text_file` `line`/`limit` params | ✅ | `sliceTextFileRead` applies the 1-based line and max-line-count limit after the live-buffer read. |
| `fs/write_text_file` creates file (MUST) | ✅ | `broker.ts:applyFileWrite` — `mkdir -p` + write. |
| Write vs. open dirty editor | ✅ | `orchestrator.ts:writeTextFileLive` — the mirror of `readTextFileLive`. An open editor gets the write via `WorkspaceEdit` + save: visible, undoable, buffer and disk agree at once. No editor → plain disk write. A failed apply throws to the agent — a silent disk fallback would recreate the buffer/disk divergence this exists to prevent. Covered end-to-end in `test/vscode/live-write.test.ts`. |
| Permission gating | ✅ | Writes gate through the broker; reads are free by design (recorded stance: read = editor state the user already shows the agent). |
| Error replies say what happened | ✅ | `client-replies.ts` — the one place a client-side "no" becomes a reply, for fs and terminal alike. Missing file on read → `-32002` (`RequestError.resourceNotFound`, spec-defined) for that path, from VS Code's `FileNotFound` or Node's `ENOENT`. Turn stopped under an open write/command card → `-32800` (the spec's Request cancelled; the cancellation MUST names only `session/request_permission`, and the request-cancellation RFD answers `-32800` regardless of cancellation source). User rejection (a click or a deny rule) → `-32803` with the message naming the request: ACP's `ErrorCode` is open (`\| number`) but defines no permission-denied code, so this takes LSP's RequestFailed, the lineage ACP took `-32800` from — a choice within the spec, not a deviation (decided 2026-09-25). Never success. Any other failure stays `-32603`. Covered by `test/fs-terminal.test.ts` (real handlers, `client-host.ts`) and, for VS Code's own not-found error, `test/vscode/live-write.test.ts`. |

## 13. Terminals (client-exposed)

| Duty | Verdict | Notes |
|---|---|---|
| All five methods | ✅ | `client-host.ts` handlers → `terminal-runner.ts`; create gates the command through the broker, and a refused command is answered like a refused write (§12). |
| Kill ends the whole tree | ✅ | Process-group spawn (`treeSpawnOptions`) — ACP's contract is "the command stops", not "its top process stops". |
| Truncate from the beginning when over `outputByteLimit` | ✅ | `tailBytes` counts real bytes and cuts at a UTF-8 code-point boundary — surrogate pairs stay whole by construction. |
| Output survives release when embedded in tool calls | ✅ | Terminal blocks live in the transcript; release invalidates the id, not the rendered history. |
| Non-blocking `terminal/output` + `truncated` flag | ✅ | `currentOutput()` is synchronous state. |

## 14. Agent plan — ✅

Whole-replace consumed (§9). The pinned strip mirrors only what the agent reports and
dies with `transcriptReset` — a stale plan never outlives its source.

## 15. Session modes — ✅

Modes read from new/load/resume responses; `session/set_mode` sent (response carries
no state — display waits for the agent's own `current_mode_update`, because bridges
have returned success for rejected changes); agent-initiated switches consumed.
Exit-mode permission requests ride the generic §11 path. The spec's own deprecation
note (modes will fold into config options) is already matched by the knobs.ts
normalizer treating both as one surface with spec-mandated exclusivity.

## 16. Session config options — ✅

`session/set_config_option` with complete-state response consumed;
`config_option_update` whole-replace consumed; seeds/defaults applied through the
same guarded route (`applySeed`), rejections swallowed because the agent's own
responses are the display truth. The `session.configOptions` client capability
(incl. `boolean`) is declared (§2) — the consumption and the claim match.

## 17. Slash commands — ✅

`available_commands_update` consumed dynamically; invocation is plain text in the
prompt, which works by construction — the composer sends the user's text verbatim.
The per-command input hint rides through to the slash menu.

## 18. Extensibility

| Duty | Verdict | Notes |
|---|---|---|
| MUST NOT add custom root-level fields to spec types | ✅ | Patchbay adds none. |
| SHOULD ignore unrecognized notifications | ✅ | The `default: break` — kept deliberately at *runtime* alongside the compile-time-exhaustive switch (§9): exhaustive over the SDK union, tolerant beyond it. |
| Unknown custom methods → `-32601` | 🟡 | Expected from the SDK connection layer; not independently verified. → Verify list V2. |
| `_meta` consumption / emission | ⛔ | Neither consumed nor emitted beyond the adopted extensions in `meta.ts` (declare flags there are the single source). No current integration needs more; W3C trace keys reserved by the spec are therefore trivially respected. Extension point visible, unfilled on purpose. |

## 19. Unstable SDK surface — adoption stances

Stability markers as of SDK **1.5.0**. Stance: adopt only what has a proven consumer,
always gated on declared (+ used where it gates UI), never silently.

| Surface | 1.5.0 marker | Stance |
|---|---|---|
| `session/resume` | stable | **Adopted** — real agents declare it; capability-gated and used-tracked. |
| `session/fork` | UNSTABLE (the SDK method is still `unstable_forkSession`) | **Adopted** — same posture; native fork gates on *used*. |
| `session/close` | stable | **Adopted** (§5). |
| `session.configOptions` client capability | stable | **Declared** (§2, §16). |
| `session_info_update`, `usage_update` | stable | **Adopted** — purely additive notifications with visible value. |
| Elicitation (form and url modes, `elicitation/create` + `elicitation/complete`) | stable (spec 2026-07-24; SDK 1.4.0) | **Adopted** (decided 2026-09-23) — **form** mode declared and wired: the question renders as a chat card naming the agent, answers are checked against the schema's limits before Send, and Decline and Cancel reach the agent as themselves; a schema with a field patchbay cannot present is declined, never guessed at. **url** mode declared and wired: the card shows the full address and its host before consent, marks punycode hosts, a user name before the host, bare IP hosts and unencrypted non-loopback links, and opens nothing until the user clicks Open — then in the system browser, outside the editor and the model's reach; only `http(s)` addresses are ever opened (anything else is declined). `elicitation/complete` settles the card as completed, matched per agent connection in whichever order it and its request (or the agent's withdrawal) arrive — the SDK dispatches incoming messages concurrently, so a notice can overtake its request; a repeat for an already-completed id is ignored. An agent withdrawing a request (`$/cancel_request`) settles its card as withdrawn and gets `-32800`. A mode patchbay never declared gets `-32602`. **Request-scoped** asks (`requestId`, no session) are declined — deliberate scope decision (2026-09-24): no agent sends them (checked: claude-agent-acp 0.81.0, codex-acp 1.1.2, auggie 0.36, gemini-cli 0.50, kilo 7.7, opencode `dev`), and their surface would be the call that raised them (connect, login, session start), not a transcript; revisit when an agent does. |
| Session notices, context compaction | UNSTABLE (new since 1.2.1) | **Declined** (§9). |
| `plan_update` / `plan_removed` | UNSTABLE | **Declined** (§9). |
| Providers config (`ProviderId`), NES (`NesSuggestionId`), position encoding | UNSTABLE | **Declined** — no consumer in patchbay's feature set; re-evaluate per feature, not per SDK release. A `models` root field observed from auggie on new/load responses is outside even this SDK's schema — an agent-side preview surface, nothing to consume (the Auggie dossier). |

## Open gaps

None open as of 2026-09-25. A new gap takes the next id (G15).

**Verify:** V1 — that the SDK surfaces load-replay notifications before the
`session/load` response resolves in all transports we use (stdio: confirmed by
design). V2 — `-32601` for unknown methods (§18).

---

*Maintenance rule: this document re-checks on every SDK version bump and on any
change to `handleUpdate`, `clientCapabilitiesWire`, or the pool's client-handler
table. A new `sessionUpdate` kind or method in the SDK diff must land here as a
verdict — adopted or declined, never silent. The check date and SDK version in the
header move together; rows state facts, git states history.*
