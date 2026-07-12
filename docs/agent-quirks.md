# Agent quirks — SUPERSEDED

Superseded by [acp-agents-notes/](acp-agents-notes/README.md), 2026-07-12:
one dossier per agent (compliance issues, capability gaps, behavioral notes,
vendor communication log), each claim versioned with a reproduction — the
single-file form didn't scale with the roster and couldn't serve as a
vendor-facing document. All content moved:

- Gemini CLI → [acp-agents-notes/gemini-cli.md](acp-agents-notes/gemini-cli.md)
- claude-agent-acp → [acp-agents-notes/claude-agent-acp.md](acp-agents-notes/claude-agent-acp.md)
- codex-acp → [acp-agents-notes/codex-acp.md](acp-agents-notes/codex-acp.md)

The division of knowledge is unchanged: anything patchbay *consumes* lives in
code tables (meta.ts, asset-locations.ts, knobs.ts); the notes hold
human-communicable evidence.
