# Gemini CLI — ACP conduct notes

Identity: Google's Gemini CLI (`gemini`), ACP mode. Versions tested: see
entries. Vendor channel: github.com/google-gemini/gemini-cli (public issues).

## Compliance issues

*(none filed — the auth behaviors below are arguably design choices; recorded
as behavioral until a spec clause is pinned)*

## Capability gaps

- **Key-carrying auth methods have no stable-ACP input**: `gemini-api-key` /
  `vertex-ai` / `gateway` carry no key input over stable ACP — without the
  `_meta` payload the agent falls back to env (`GEMINI_API_KEY`;
  `GOOGLE_GENAI_USE_VERTEXAI` + `GOOGLE_API_KEY` or
  `GOOGLE_CLOUD_PROJECT`/`LOCATION`) and fails with `-32000` when unset.

## Behavioral notes

- **`diff` content carries whole files** (0.50.0, 2026-09-25, read from the
  shipped bundle): `originalContent` → `newContent`, both in the permission
  request and in the tool call's result.
- **A missing file is recognized by message text, not by code** (0.50.0,
  2026-09-25, read from the shipped bundle's `AcpFileSystemService`): a
  failed `fs/read_text_file` or `fs/write_text_file` becomes `ENOENT` only
  when the error *message* contains `Resource not found`, `ENOENT`,
  `does not exist` or `No such file`; the error code is never read. Its edit
  tool treats `ENOENT` as "new file", so a client answering a missing file
  with `-32603 "Internal error"` breaks creating a file through the edit
  tool. Patchbay answers with the SDK's own `resourceNotFound` (message
  `Resource not found: <path>`, `client-replies.ts`). Client fs is used only
  for paths inside the session root and outside `~/.gemini`; everything else
  goes to local disk. Repro: `grep -A10 normalizeFileSystemError` in
  `@google/gemini-cli/bundle/*.js`.
- **Personal Google login is retired** (0.50.0, 2026-09-25): `authenticate`
  with `oauth-personal` and valid cached credentials answers `-32000` "This
  client is no longer supported for Gemini Code Assist for individuals. To
  continue using Gemini, please migrate to the Antigravity suite of
  products". Only the key-carrying methods remain for individuals (see
  Capability gaps). Repro: `gemini --acp`, `initialize`, `authenticate
  {methodId: "oauth-personal"}`.

- **Auth method switching is destructive**: `authenticate` with a method
  other than the persisted `selectedType` clears the cached credentials first
  (`clearCachedCredentialFile`) — trying a second method logs the first out
  even if the new one then fails.
- Observed `_meta` conventions (unadopted — adopt via meta.ts when needed):
  `authenticate _meta["api-key"]: string` — key delivery for the
  `gemini-api-key` method (advertised on the declared method as
  `_meta: {"api-key": {provider: "google"}}`); `authenticate
  _meta["gateway"]: {baseUrl?, headers?}` — gateway config for the `gateway`
  method.

## Communication log

- *(empty)*
