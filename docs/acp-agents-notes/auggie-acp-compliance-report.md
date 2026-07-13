# Auggie ACP compliance report — two wire-verified issues

**To:** Augment Code support (support@augmentcode.com)
**From:** acp-patchbay (VS Code ACP client), Solutions Unity — solutionsunity.com
**Date:** 2026-07-13
**Ticket:** TKT-66153 (submitted 2026-07-13)
**Product tested:** `auggie` 0.32.0 (commit eb99b871), spawned as `auggie --acp`, ACP protocol version 1
**Environment:** Linux (WSL2), Node stdio transport, logged-in account

## Summary

Two independent, reproducible deviations from the ACP v1 specification,
both wire-verified on 0.32.0 (transcripts below, each reproducible in under
a minute over stdio):

1. **`mcpServers` are honored only on the process's first `session/new`.**
   Every later session's server list is silently ignored — no error, no
   signal. Any client that opens more than one session per process loses
   MCP integration entirely from the second session on.
2. **Model selection rides a removed draft API** — a top-level `models`
   field on session responses plus `session/set_model` — removed from the
   protocol artifacts on June 1, 2026 in favor of Session Config Options
   (stabilized February 4, 2026). Spec-faithful clients therefore show no
   model picker for Auggie at all, and clients that do adopt the legacy
   surface get no confirmation channel to display honest state.

We maintain an ACP client and would genuinely like both surfaces to work;
issue 1 in particular we currently have no clean workaround for.

A third item rides along as a **request, not a compliance issue** — omitting
the optional `ContentChunk.messageId` is spec-legal, but it makes message
boundaries unreconstructable by any client (§ "Request — emit
`ContentChunk.messageId`" below).

`C→A` = client to agent, `A→C` = agent to client, frames verbatim from
captures taken 2026-07-13. Model list and mode list truncated by us for
readability where marked.

---

## Issue 1 — `mcpServers` honored only on the first `session/new` per process

### Spec position

`mcpServers` is a parameter of **every** `session/new` and `session/load`:
"Clients create a new session by calling the `session/new` method with …
a list of MCP servers the Agent should connect to."
MCP configuration is per-session state, not per-process state — nothing in
the spec scopes it to the first call on a connection.
— https://agentclientprotocol.com/protocol/session-setup#creating-a-session

### Reproduction

Marker methodology: a minimal stdio MCP server that writes a marker file
the moment it is spawned (`node /tmp/acp-marker-server.mjs <marker-path>`),
so "did Auggie connect to the configured server" reduces to a file-existence
check. Spawn is observed within ~10 s of `session/new` returning.

**Run A (control) — marker server on the FIRST `session/new`: spawned.**

```json
C→A {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true}}}
C→A {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[{"name":"marker","command":"node","args":["/tmp/acp-marker-server.mjs","/tmp/acp-marker-A1"],"env":[]}]}}
```
→ marker file `/tmp/acp-marker-A1` **created** (server spawned). Correct.

**Run B (fresh process) — `[]` first, marker server on the SECOND
`session/new`: never spawned.**

```json
C→A {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true}}}
C→A {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}
C→A {"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[{"name":"marker","command":"node","args":["/tmp/acp-marker-server.mjs","/tmp/acp-marker-B2"],"env":[]}]}}
```
→ marker file `/tmp/acp-marker-B2` **never created**. Both `session/new`
calls succeed normally; the second session's `mcpServers` are silently
dropped. In earlier runs (2026-07-12) we additionally verified the tool
stays unavailable even when a prompt explicitly requests it, and that the
same entries work verbatim under a fresh process.

### Impact

Any client that opens more than one session per `auggie --acp` process gets
MCP servers only in the first — with zero indication. In our client a
connect-time capability probe session runs first, so **every real user
session got zero MCP servers** (including our own editor-context server),
and nothing on the wire said so. Auggie also answers prompts using built-in
tools without flagging the missing server, so users don't notice unless
they ask directly. One session per process is a costly workaround (Auggie
processes are heavyweight), and spec-compliant per-session `mcpServers` is
the behavior we'd like to rely on.

---

## Issue 2 — model selection rides a removed draft API

### Observed wire behavior

**`initialize` — the extension surface is not advertised anywhere:**

```json
C→A {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true}}}
A→C {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true},"sessionCapabilities":{"list":{}}},"agentInfo":{"name":"auggie","title":"Auggie Agent","version":"0.32.0 (commit eb99b871)"},"authMethods":[]}}
```

**`session/new` — undocumented root `models` field on the response
(28 entries at test time; truncated here):**

```json
C→A {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}
A→C {"jsonrpc":"2.0","id":2,"result":{"sessionId":"07c9b87d-8a7f-40df-9cda-80b892804c1d","modes":{"currentModeId":"default","availableModes":[…]},"models":{"availableModels":[{"modelId":"butler_a","name":"Prism (Claude + Gemini)","description":"Routes between Claude Opus 4.8, Claude Sonnet 4.6, and Gemini 3.0 Flash."},{"modelId":"claude-opus-4-8","name":"Opus 4.8","description":"Great for complex, multi-step agentic tasks"},{"modelId":"gpt-5-5","name":"GPT-5.5","description":"Best for complex tasks"},"…25 more entries…"],"currentModelId":""}}}
```

Note `currentModelId: ""` — the agent does not report which model a fresh
session will actually use.

**`session/set_model` — accepted, but the response carries no state:**

```json
C→A {"jsonrpc":"2.0","id":3,"method":"session/set_model","params":{"sessionId":"07c9b87d-8a7f-40df-9cda-80b892804c1d","modelId":"claude-opus-4-8"}}
A→C {"jsonrpc":"2.0","id":3,"result":{}}
```

**No confirmation channel exists.** After the set we listened for
notifications: none arrived. Auggie's `session/update` vocabulary
(`current_mode_update`, `config_option_update`, `usage_update`, …) has no
model variant, and `usage_update` carries only `{ cost, size, used }`. A
client therefore has **no way to display the session's model truthfully**:
the set response is empty, no notification confirms or corrects it, and
`currentModelId` is readable only at session open — where it is `""`.

### Spec position

1. **The surface is a removed draft.** ACP protocol updates, June 1, 2026:
   *"The never-stabilized `session/set_model` API and related session model
   response fields have been removed from the protocol artifacts. Agents
   should continue to expose model selection through Session Config
   Options."* — https://agentclientprotocol.com/rfds/updates
2. **Under current v1, the root field is non-conforming.** Extensibility:
   *"Implementations MUST NOT add any custom fields at the root of a type
   that's part of the specification"* (custom data belongs in `_meta`), and
   custom methods are reserved the underscore prefix — `session/set_model`
   occupies the protocol's own `session/` namespace. Extensions *SHOULD*
   also be advertised via capabilities; this one is undiscoverable.
   — https://agentclientprotocol.com/protocol/v1/extensibility
3. **The replacement is stable and purpose-built.** Session Config Options
   (stabilized February 4, 2026) exists precisely for "models, modes,
   reasoning levels": a `configOptions` entry with `category: "model"`,
   set via `session/set_config_option` (whose response is required to carry
   the full resulting state), corrected asynchronously via
   `config_option_update`. Other agents (e.g. the Claude Agent SDK bridge)
   already ship model selection this way.
   — https://agentclientprotocol.com/protocol/v1/session-config-options
   — https://agentclientprotocol.com/rfds/session-config-options

### Impact

- Any spec-faithful ACP client shows **no model selection for Auggie** —
  the list rides a field outside every published schema, so generic clients
  drop it silently. Auggie's rich catalog (28 models at test time) is
  invisible.
- Clients that do adopt the legacy surface (as we now have, behind a scoped
  compatibility shim) cannot render honest state: nothing on the wire ever
  confirms which model is active.

---

## Request — emit `ContentChunk.messageId` (spec-legal omission, fidelity cap)

### Observed wire behavior

All of Auggie's `session/update` chunks — `user_message_chunk`,
`agent_message_chunk`, `agent_thought_chunk`, live and in `session/load`
replay — omit the optional `ContentChunk.messageId` (wire-verified
2026-07-12 on 0.32.0).

### Why it matters

`messageId` is the only signal the spec provides for message boundaries:
chunks of one message share it, a change means a new message. Without it a
client cannot tell "next delta of the same message" from "first chunk of a
new message" — the information does not exist anywhere else on the wire,
so no client can reconstruct it:

- Merging adjacent messages corrupts rendered markdown at the seam: a
  message ending with a closing ``` ``` ``` fence glued to the next
  message's opening line un-closes the fence and the code block swallows
  the following prose (we hit exactly this shape with an agent that does
  emit ids — fixable there, unfixable where ids are absent).
- Splitting on a guess is worse: a real delta stream cut mid-fence breaks
  well-formed single messages.
- On the user side the consequence is already visible on your replay wire:
  adjacent prompts arrive as back-to-back id-less chunks, and only the
  whole-message-per-chunk convention keeps them apart.

To be clear: this is not a spec violation — the field is optional. It is
the one field that caps every client's rendering fidelity for Auggie.

### Two useful levels of fix

1. **Full:** emit `messageId` on every chunk, live and replay — boundaries
   become exact everywhere.
2. **Minimal (replay only):** confirm that replayed agent/thought chunks
   are one whole message per chunk (as your `user_message_chunk` replay
   already is). Even just this confirmation lets clients adopt a safe
   per-chunk boundary rule for replay without guessing.

---

## Requests

1. **Honor `mcpServers` on every `session/new`/`session/load`**, not just
   the process's first — this is the higher-impact fix of the two.
2. **Migrate model selection to Session Config Options**
   (`category: "model"`), which fixes discovery, state confirmation, and
   schema conformance in one move — the June 1 removal notice names exactly
   this path. If the legacy surface will remain for a while, a note on its
   intended lifetime would help us scope our compatibility shim honestly.
3. **Emit `ContentChunk.messageId` on chunks** (or, minimally, confirm the
   replay granularity of agent/thought chunks) — see the request section
   above; without it message boundaries are unreconstructable by any
   client.

We're happy to re-verify either fix against a build — both reproductions
are a handful of JSON-RPC frames over stdio and take under a minute. And to
be clear, the underlying capability is good: Auggie's model list is the
richest we've seen over ACP. We'd just like to be able to show it — and
its MCP servers — without vendor-specific code.
