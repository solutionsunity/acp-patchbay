# claude-agent-acp (Claude Agent SDK bridge) — ACP conduct notes

Identity: `@agentclientprotocol/claude-agent-acp` via npx, tested v0.57.0,
protocol 1. Vendor channel: github.com/agentclientprotocol/claude-agent-acp
(public issues).

## Compliance issues

*(none observed as of v0.57.0)*

## Capability gaps

*(none load-bearing observed)*

## Behavioral notes

- **Clean record: http/sse mcpServers forwarding — verified, and once falsely
  accused (2026-07-12, v0.57.0).** A `type: "http"` entry in `session/new`
  *and* `session/load` lands in the spawned CLI's `--mcp-config` with the
  ACP `headers` array correctly converted to the CLI's record shape
  (standalone repro: spawn bridge, initialize, both session calls, inspect
  the CLI argv). `getOrCreateSession` fingerprints `{cwd, mcpServers}` and
  tears down/respawns the CLI when they change, so a re-attach with different
  servers takes effect. The one-day-earlier claim that it "silently dropped"
  http entries was wrong — the drop was patchbay's own routing gate —
  retracted here so the record can't drift. Related upstream fix worth
  knowing: PR #487 (type-check hardening for clients that send explicit
  `type: "stdio"`).
- **fs/terminal run inside the SDK CLI, not through ACP client calls** —
  legal (capabilities are optional), but it means `fs.readTextFile`/
  `fs.writeTextFile`/`terminal` never mark *used* in the capability matrix:
  patchbay never sees the bytes. Consent still crosses: the bridge wires
  `canUseTool` → `session/request_permission`, so every tool use (file
  writes, bash, MCP calls) hits the permission broker. This asymmetry —
  data plane internal, control plane routed — is what falsified the retired
  fidelity aggregate (architecture.md § Permission broker, 2026-07-12).
- **Injected user-role messages** (observed 2026-07-12 on `session/load`
  replay): the harness injects machine messages on the *user* role —
  `<task-notification>` blobs, `<system-reminder>` context, slash-command
  echoes (`<command-name>`/`<local-command-stdout>` sequences). They replay
  as ordinary `user_message_chunk`s, indistinguishable by role from what the
  human typed. Consumed (graduated to mechanism):
  `session-manager.harnessEnvelopeTag` classifies whole-message XML-ish
  envelopes at the chunk chokepoint and renders them dim/collapsed, never
  counted as a prompt. Conservative on purpose: any text a human plausibly
  typed stays a normal user bubble. Likely generic across bridge-based
  harnesses, not vendor-gated.
- Observed `_meta` conventions (unadopted — adopt via meta.ts when needed):
  `_claude/sdkMessage`, `_claude/rateLimit`, `_claude/askUserQuestionOption`;
  terminal-output `_meta` channel (convention shared with codex-acp).
- Session titles are SDK-generated in the background; the bridge polls at
  turn-end and pushes `session_info_update` when changed.

## Communication log

- *(empty)*
