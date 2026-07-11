# ACP Protocol Compliance — spec against code

Audited 2026-07-11 against https://agentclientprotocol.com/protocol/v1 (all chapters)
and the pinned wire surface of `@agentclientprotocol/sdk` **1.1.0** (the SDK schema is
the ground truth for method names and type unions; the site prose is the ground truth
for normative MUST/SHOULD/MAY language). Patchbay is a **Client**: compliance means
(a) every client-side duty is met, and (b) every agent-side feature the protocol lets
a client consume is either consumed or deliberately declined *on record here*.

Verdict vocabulary, used per row:

- **✅ Implemented** — duty met, anchor cited.
- **🟡 Partial** — works, with a named conformance gap.
- **❌ Missing** — a duty or consumable surface with no valid reason to lack; goes to
  the Gap Register.
- **⛔ Declined** — deliberately not implemented; the reasoning is recorded in place
  and is the artifact (scope decision, not limitation).
- **N/A** — an agent-side duty; listed only where confusion is likely.

Anchors are `file.ts:symbol`, not line numbers — this codebase moves.

---

## 1. Transport & framing

| Surface | Verdict | Notes |
|---|---|---|
| JSON-RPC 2.0 over stdio, ndjson framing | ✅ | `pool.ts` spawns the agent subprocess, line-assembles both directions before handing frames to the SDK. |
| HTTP / SSE / WebSocket transports (present in SDK 1.1.0) | ⛔ | v1 scope is local subprocess agents — the reference baseline (vscode-acp) and every roster agent are stdio. The SDK already carries the transports, so the extension point is visible and costs nothing to leave unfilled. Adopt when a real remote-agent need appears, not before. |

## 2. Initialization

Spec: client MUST send `initialize` with the latest protocol version it supports;
SHOULD send name/version; MUST treat capabilities it omits as unsupported; SHOULD
close the connection if the agent answers with a version it can't speak.

| Duty | Verdict | Notes |
|---|---|---|
| `initialize` first, version + capabilities | ✅ | `pool.ts:connect` — `acp.PROTOCOL_VERSION`, `clientCapabilitiesWire()`. |
| `clientInfo` name/version | ✅ | `pool.ts:connect` sends `{ name: "acp-patchbay", version }`. |
| Honest capability advertisement | ✅ | `capabilities.ts:CLIENT_DECLARES` is the single source for both the wire claim and the matrix's client-side cells — they cannot drift. `elicitation` stays `false` until actually wired (declaring it earlier is exactly the lie the capability-verification rule exists to prevent). |
| Close on unsupported agent version | 🟡 | Agent's `protocolVersion` is read and logged; no explicit version-compatibility check/refusal path found. SHOULD-level. → Gap Register G7. |
| Record agent capabilities per connect | ✅ | `capabilities.ts:matrixFromDeclared`, rebuilt wholesale every connect (reset-on-reconnect by construction); *used* state is version-keyed per the capability-verification rule. |

## 3. Authentication

Spec: `authMethods` advertised at initialize; client calls `authenticate` with an
advertised `methodId`; `logout` MUST NOT be called unless `auth.logout` is advertised;
client SHOULD expect post-logout operations to fail with auth errors.

| Duty | Verdict | Notes |
|---|---|---|
| Consume `authMethods` (id/name/description) | ✅ | Matrix `auth` row + method passthrough incl. description (2026-07-09 auth alignment). |
| `authenticate` with advertised method | ✅ | `pool.ts:authenticate` (stable call, not the unstable terminal-auth variant). |
| `logout` gated on `auth.logout` declared | ✅ | `pool.ts:logout`; `auth.logout` capability row. |
| Post-auth-error honesty | ✅ | `needsAuth` has a single writer at the pool's `-32000` chokepoint; `auth_required` never raises capability suspicion (per capability-verification rule). Spec names no numeric code; `-32000` is the observed convention — recorded as such, not as spec. |

## 4. Session setup — new / load / resume / fork

Spec (session-setup): `session/new` with cwd + MCP servers; `session/load` gated on
`loadSession`, agent MUST replay the **entire** conversation as `session/update`
notifications (`user_message_chunk`, `agent_message_chunk`) before responding — **no
pagination or lazy loading exists anywhere in the chapter**. `session/resume` and
`session/fork` are SDK-1.1.0 surface beyond the published chapters (spec-pending).

| Surface | Verdict | Notes |
|---|---|---|
| `session/new` | ✅ | `pool.ts:newSession`; cwd, mcpServers, additionalDirectories. |
| `session/load` full-replay consumption | ✅ | Fixed 2026-07-11 (G1): `user_message_chunk` consumed with delta semantics (`activeUserBlockId` run, `inFlight` guard against live echo); replay reduces silently into canonical state and lands in the webview as one wholesale swap (`loadSilently`/`ChannelHost.resync`). |
| `session/resume` (spec-pending) | ✅ | `pool.ts:resumeSession`; adopted ahead of stabilization, gated on declared + used per capability rule; honest seam notice marks where the cached view ends (`session-manager.ts:resumeReattach`). |
| `session/fork` (spec-pending) | ✅ | Same adoption posture; `session.fork` capability row; native fork gates on *used*. |
| Roots re-apply (`additionalDirectories` set-complete-list) | ✅ | `session-manager.ts:reapplyRoots` — the three-case rung (recreate / in-place load-or-resume / deferred) is a recorded design. |

## 5. Session list / delete / close

Spec (session-list): cursor is opaque; missing `nextCursor` = end; MUST NOT call
without the capability; list is read-only. Delete: idempotent (SHOULD succeed
silently on unknown id). Close: SDK surface (frees resources, history intact).

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
| Stop reason handling | ✅ | `stopReason` flows through `turnEnded` verbatim and renders; non-`end_turn` reasons logged. No per-reason branching is required by spec; display is honest. |
| Usage on response (`usage`) | ✅ | `toTurnUsage` on the prompt response + `usage_update` notifications both feed the ticker. |

## 7. Cancellation

Spec: client MAY send `session/cancel` (notification). On cancellation the client
**MUST respond to pending permission requests with `cancelled`**, SHOULD preemptively
mark incomplete tool calls cancelled, SHOULD still accept trailing tool updates.

| Duty | Verdict | Notes |
|---|---|---|
| `session/cancel` notify | ✅ | `pool.ts:cancel` ← `session-manager.ts:stopTurn`. |
| **Cancel pending permission requests** | ✅ | Fixed 2026-07-11 (G2): `broker.cancelPending(sessionId)` sweeps the session's pending requests — agent requests and patchbay's own gates alike — wired from `stopTurn` and `closeSession`; cards close with an honest "Cancelled — turn stopped" label, audited as `turn-cancelled`. |
| Preemptively mark incomplete tool calls cancelled | 🟡 | Not done (SHOULD). Trailing `tool_call_update`s *are* accepted (no turn-gating in `handleUpdate`), so state converges when the agent reports; the UI just doesn't jump ahead. → G6, low priority. |

## 8. Content types

Spec: six ContentBlock types. Client-side receive support is not individually
mandated, but silently dropping renderable content is against this project's own
honesty rules, which bind harder than the spec here.

| Direction / type | Verdict | Notes |
|---|---|---|
| Prompt out: text | ✅ | Baseline. |
| Prompt out: image | ✅ | Capability-gated with `resource_link` fallback (§6). |
| Prompt out: audio | ⛔ | Patchbay has no audio capture surface; nothing to send. Revisit only if a recording feature ever exists. |
| Prompt out: embedded resource (`embeddedContext`) | ⛔ | Mentions deliberately ride as `resource_link` (baseline, uniform across agents) and the agent pulls content through `fs/read_text_file`, which also gets it *live editor state* rather than a stale snapshot. Embedding would trade freshness for nothing. `prompt.embeddedContext` row tracks the declaration regardless. |
| Receive: text chunks | ✅ | `handleUpdate` text cases. |
| Receive: non-text in `agent_message_chunk` (image/audio/resource) | ✅ | Fixed 2026-07-11 (G4): a closed in-place placeholder block (`*[image content — not rendered]*`) — the honest floor until real rendering is justified. |
| Annotations / `_meta` on content | ⛔ | Not consumed; no current agent emits meaning patchbay could render. Unknown fields pass through untouched (safe by construction). |

## 9. Session updates — the full union

SDK 1.1.0 `sessionUpdate` union (13 kinds) vs `session-manager.ts:handleUpdate`:

| Kind | Verdict | Notes |
|---|---|---|
| `agent_message_chunk` | ✅ | Text streamed; non-text → in-place placeholder (G4, fixed). |
| `agent_thought_chunk` | ✅ | Block-interruption rule per ui-rendering-strategy. |
| `user_message_chunk` | ✅ | Fixed 2026-07-11 — see §4. |
| `tool_call` / `tool_call_update` | ✅ | See §10. |
| `plan` | ✅ | Whole-replace per spec ("Client MUST replace the current plan completely") — `planUpdated` swaps the pinned strip snapshot. |
| `plan_update` / `plan_removed` | ⛔ | Gated behind a *client* capability patchbay does not declare, so a conforming agent never sends them; the whole-replace `plan` model already covers the feature. Adopt only if incremental plans show a real win; declaring without handling would be the capability lie again. |
| `available_commands_update` | ✅ | Name/description/input-hint all consumed (G8 fixed 2026-07-11); the hint shows in the composer's slash menu. |
| `current_mode_update` | ✅ | Modes surface only; config surface deliberately owns its own confirmations (knobs.ts normalizer — spec forbids category as a correctness key). |
| `config_option_update` | ✅ | Spec: notification carries complete state — consumed as a whole-replace. |
| `session_info_update` | ✅ | Title-authority rule: agent wins unless user renamed; null title is a clear, not a rename. Handled before the live-session guard (agent may retitle sessions patchbay isn't attached to). |
| `usage_update` | ✅ | Declared+used marked on first sight at the pool chokepoint (no initialize-time claim exists for usage). |
| *Unknown / future kinds* | ✅ | Runtime-ignored per the spec's extensibility rule, and since 2026-07-11 the switch is compile-time exhaustive over the SDK union (`assertUnconsumed` backstop): an SDK upgrade adding a kind fails typecheck and demands a verdict here — consumed or declined, never silent. Same forcing pattern as `CAPABILITY_PROOFS`. |

## 10. Tool calls

| Duty | Verdict | Notes |
|---|---|---|
| `tool_call` create + `tool_call_update` merge semantics | ✅ | Upsert with "absent field inherits" in both the reducer and the bus coalescer — matches "only the fields being changed need to be included". Present `content` replaces the diff collection; absent keeps it (`stashToolDiffs`). |
| Statuses (`pending/in_progress/completed/failed`) | ✅ | Rendered on the tool card. |
| Kinds (read/edit/delete/move/search/execute/think/fetch/other) | ✅ | `toolKind` drives iconography; unknown → `other`. |
| Content: regular blocks | 🟡 | Only diffs are extracted; text content inside tool-call content is not rendered. → G5. |
| Content: `diff` | ✅ | Stashed per path, viewable via `toolCallDiff`. |
| Content: `terminal` (embedded by id) | 🟡 | Terminal output renders as its own live transcript block (`terminalStarted`/`terminalOutputAppended`) and persists after release ✅ — but it is not visually attached to the owning tool-call card, and a `tool_call` content entry of `type:"terminal"` is not linked. Functionally honest, structurally loose. → G5. |
| `locations` follow-along | ✅ | Paths captured onto the block; opening/following is a MAY and a UI affordance, present as click-through. |
| `rawInput`/`rawOutput` | ✅ | Bounded (`boundedRaw`, `RAW_CAP`) with an explicit truncation marker — display honesty kept. |

## 11. Permission requests (`session/request_permission`)

| Duty | Verdict | Notes |
|---|---|---|
| Respond with `selected` / `cancelled` | ✅ | `broker.ts:requestPermission`; dismissal → `{ cancelled: true }`. |
| Option kinds inform UI | ✅ | allow/reject × once/always rendered distinctly. |
| Auto-resolution per user settings (MAY) | ✅ | Broker rules; per the capability rule, an auto-*rejection* is patchbay's own gate working and never marks the agent suspect. |
| Cancelled turn → pending requests must resolve `cancelled` | ✅ | Fixed 2026-07-11 — see §7 (G2). |

## 12. File system (client-exposed)

| Duty | Verdict | Notes |
|---|---|---|
| `fs/read_text_file` returns live editor state | ✅ | `orchestrator.ts:readTextFileLive` — open (possibly dirty) buffer wins over disk; "the agent sees what the user sees". |
| `fs/read_text_file` `line`/`limit` params | ✅ | Fixed 2026-07-11 (G3): `sliceTextFileRead` applies the 1-based line and max-line-count limit after the live-buffer read. |
| `fs/write_text_file` creates file (MUST) | ✅ | `broker.ts:applyFileWrite` — `mkdir -p` + write. |
| Write vs. open dirty editor | 🟡 | Write goes to disk; an open dirty buffer for the same path keeps its unsaved content until the user reloads — divergence window. Not a spec violation (spec is silent); watch item W1: route writes through `WorkspaceEdit` when an editor is open. |
| Permission gating | ✅ | Writes gate through the broker; reads are free by design (recorded stance: read = editor state the user already shows the agent). |

## 13. Terminals (client-exposed)

| Duty | Verdict | Notes |
|---|---|---|
| All five methods | ✅ | `pool.ts` handlers → `terminal-runner.ts`; create gates the command through the broker. |
| Kill ends the whole tree | ✅ | Process-group spawn (`treeSpawnOptions`) — ACP's contract is "the command stops", not "its top process stops". |
| Truncate from the beginning when over `outputByteLimit` | ✅ | Fixed 2026-07-11 (G9): `tailBytes` counts real bytes and cuts at a UTF-8 code-point boundary — surrogate pairs stay whole by construction. |
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

`session/set_config_option` with complete-state response consumed; `config_option_update`
whole-replace consumed; seeds/defaults applied through the same guarded route
(`applySeed`), rejections swallowed because the agent's own responses are the display
truth. This is the knob architecture (2026-07-09) and it is spec-shaped.

## 17. Slash commands — ✅

`available_commands_update` consumed dynamically; invocation is plain text in the
prompt, which works by construction — the composer sends the user's text verbatim.
The per-command input hint rides through to the slash menu (G8, fixed 2026-07-11).

## 18. Extensibility

| Duty | Verdict | Notes |
|---|---|---|
| MUST NOT add custom root-level fields to spec types | ✅ | Patchbay adds none. |
| SHOULD ignore unrecognized notifications | ✅ | The `default: break` — kept deliberately at *runtime* even after the exhaustive-switch fix (§9): compile-time exhaustive over the SDK union, runtime-tolerant beyond it. |
| Unknown custom methods → `-32601` | 🟡 | Expected from the SDK connection layer; not independently verified. → Verify list V2. |
| `_meta` consumption / emission | ⛔ | Neither consumed nor emitted. No current integration needs it; W3C trace keys reserved by the spec are therefore trivially respected. Extension point visible, unfilled on purpose. |

## 19. Unstable SDK surface — adoption ledger

SDK 1.1.0 carries surface marked **UNSTABLE** ("not part of the spec yet"). Stance:
adopt only what has a proven consumer, always gated on declared (+ used where it
gates UI), never silently.

| Surface | Stance |
|---|---|
| `session/resume`, `session/fork` | **Adopted** — real agents declare them; both capability-gated and used-tracked. |
| `session_info_update`, `usage_update` | **Adopted** — purely additive notifications with visible value. |
| Elicitation (session-scoped, form mode) | **Planned (P7)** — declared `false` until the adapter is real; flipping `CLIENT_DECLARES.elicitation` is the only wire change needed. The render path (`elicitation` blocks) already exists. |
| `plan_update` / `plan_removed` | **Declined** for now (§9). |
| Providers config, NES (next edit suggestions), position encoding | **Declined** — no consumer in patchbay's feature set; re-evaluate per feature, not per SDK release. |

## Gap Register

Ordered by severity. Fixed entries stay listed — decisions are recorded, not deleted.

| # | Level | Gap | Status |
|---|---|---|---|
| G1 | MUST-fix bug | `user_message_chunk` unhandled → session/load history loss + block merging (§4, §9) | **Fixed 2026-07-11** — new case + `activeUserBlockId` + `inFlight` guard; switch made compile-time exhaustive (`assertUnconsumed`), runtime tolerant of newer kinds. |
| G2 | MUST | Turn cancellation left pending permission requests hanging (§7, §11) | **Fixed 2026-07-11** — `broker.cancelPending(sessionId)` from `stopTurn`/`closeSession`; honest card resolution, `turn-cancelled` audit. |
| G3 | MUST-shaped | `fs/read_text_file` ignored `line`/`limit` (§12) | **Fixed 2026-07-11** — `sliceTextFileRead`, 1-based line, after the live-buffer read. |
| G4 | Honesty | Non-text agent/user message content silently dropped (§8) | **Fixed 2026-07-11** — closed in-place placeholder block. |
| G5 | SHOULD | Tool-call content: plain content blocks unrendered; embedded terminals not linked to their card (§10) | Open — phase-B rendering work (ui-rendering-strategy), not a patch. |
| G6 | SHOULD | No preemptive local "cancelled" on incomplete tool calls at cancel (§7) | Open — the tool-status enum has no `cancelled`; needs its own block state. Trailing agent updates are already accepted, so state converges. |
| G7 | SHOULD | No explicit protocol-version compatibility check after initialize (§2) | Open — wants a UX decision (what the user sees on refusal/downgrade). |
| G8 | Cosmetic | Slash-command input hint dropped (§17) | **Fixed 2026-07-11** — rides through to the slash menu. |
| G9 | Nit | Terminal truncation counted UTF-16 units, could split surrogates (§13) | **Fixed 2026-07-11** — `tailBytes`: byte accounting, code-point-boundary cut. |

**Watch items:** W1 write-vs-dirty-editor divergence (§12). **Verify:** V1 that the SDK
surfaces load-replay notifications before the `session/load` response resolves in all
transports we use (stdio: confirmed by design); V2 `-32601` for unknown methods (§18).

---

*Maintenance rule: this document re-audits on every SDK version bump and on any change
to `handleUpdate`, `clientCapabilitiesWire`, or the pool's client-handler table. A new
`sessionUpdate` kind or method in the SDK diff must land here as a verdict — adopted,
partial, or declined with reasoning — before code touches it.*
