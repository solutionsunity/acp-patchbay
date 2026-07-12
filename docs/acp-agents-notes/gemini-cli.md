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
