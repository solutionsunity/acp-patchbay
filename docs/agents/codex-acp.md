# codex-acp (Codex bridge) — ACP conduct notes

Identity: `codex-acp`. Versions tested: none directly — conventions observed
via shared adapter work. Vendor channel: github.com/agentclientprotocol
ecosystem.

## Compliance issues

*(none observed)*

## Capability gaps

- Declares `sessionCapabilities.additionalDirectories` and `session/list`,
  but its list rows carry `sessionId`, `cwd`, `title`, `updatedAt` only —
  the optional `SessionInfo.additionalDirectories` read-back is never sent
  (source read 2026-09-23, `main`; the bridge keeps a session's roots in
  memory only, and Codex's own thread record has no field for them).
  Spec-legal (the report is a MAY). Patchbay reads an omitted field as
  not reported, so the intended list stands.

## Behavioral notes

- **Command output rides only `_meta`** (1.1.2 `dist/index.js`, read
  2026-10-07; the rival sweep found the same on 2.1.1). Every command tool
  call's content is `{type: "terminal", terminalId: <toolCallId>}`, a
  terminal the client never created (the Zed display-only convention);
  its output arrives as `_meta.terminal_output_delta: {data, terminal_id}`
  chunks and its end as `_meta.terminal_exit: {exit_code, signal,
  terminal_id}` — never in content, and `rawOutput` keeps only the exit
  code. The delta channel is what every client gets unless it declares
  `_meta.terminal_output`. **Adopted 2026-10-07, consume-only**: the
  `toolCall` site of `src/orchestrator/meta.ts` reads both keys, and the
  card embeds a display-only terminal filled as the output arrives. Retire
  when ACP gives agent-run terminals a standard output channel.
- **`diff` content carries whole files** (1.1.2, 2026-09-25, read from the
  shipped `dist/index.js`). The engine returns a unified patch; the bridge
  reads the file and reverses the patch to send the full before and after.
  A new file is `oldText: null`, a deleted one `newText: ""`.

## Communication log

- *(empty)*
