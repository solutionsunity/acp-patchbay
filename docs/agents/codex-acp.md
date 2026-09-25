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

- Terminal-output `_meta` channel — convention shared with claude-agent-acp
  (the architecture doc). Unadopted; adopt via meta.ts
  when a feature needs it.
- **`diff` content carries whole files** (1.1.2, 2026-09-25, read from the
  shipped `dist/index.js`). The engine returns a unified patch; the bridge
  reads the file and reverses the patch to send the full before and after.
  A new file is `oldText: null`, a deleted one `newText: ""`.

## Communication log

- *(empty)*
