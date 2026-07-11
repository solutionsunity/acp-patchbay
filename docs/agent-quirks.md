# Agent quirks & observed wire conventions

Engineering notes on per-agent behavior observed on the wire — knowledge that
is documentation, not mechanism. Anything patchbay actually *consumes* lives
in code tables (`META_EXTENSIONS` in meta.ts, `ASSET_LOCATIONS` in
asset-locations.ts, `KNOWN_BYPASS_BRIDGES` in acp-registry.ts); a note here
graduates to a table entry only when a feature requires it. *(Relocated from
the retired roster-overlay JSON, 2026-07-11 — the notes predate it in
adapter-observation work.)*

## Gemini CLI (`gemini`)

- **Auth method switching is destructive**: `authenticate` with a method other
  than the persisted `selectedType` clears the cached credentials first
  (`clearCachedCredentialFile`) — trying a second method logs the first out
  even if the new one then fails.
- **Key-carrying methods have no stable-ACP input**: `gemini-api-key` /
  `vertex-ai` / `gateway` carry no key input over stable ACP — without the
  `_meta` payload the agent falls back to env (`GEMINI_API_KEY`;
  `GOOGLE_GENAI_USE_VERTEXAI` + `GOOGLE_API_KEY` or
  `GOOGLE_CLOUD_PROJECT`/`LOCATION`) and fails with `-32000` when unset.
- Observed `_meta` conventions (unadopted — adopt via meta.ts when needed):
  `authenticate _meta["api-key"]: string` — key delivery for the
  `gemini-api-key` method (advertised on the declared method as
  `_meta: {"api-key": {provider: "google"}}`); `authenticate
  _meta["gateway"]: {baseUrl?, headers?}` — gateway config for the `gateway`
  method.

## claude-agent-acp (`claude-acp`)

- Observed `_meta` conventions (unadopted): `_claude/sdkMessage`,
  `_claude/rateLimit`, `_claude/askUserQuestionOption`; terminal-output
  `_meta` channel (convention shared with codex-acp — architecture.md § the
  extension landscape).

## codex-acp (`codex-acp`)

- Terminal-output `_meta` channel (convention shared with claude-agent-acp).
