# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Preferred: GitHub's private vulnerability reporting on this repository
  (**Security → Report a vulnerability**).
- Alternatively, contact Solutions Unity at <https://solutionsunity.com>.

We aim to acknowledge a report within a few business days and will keep you
updated as we investigate. Please allow a reasonable window for a fix to ship
before any public disclosure.

## Supported versions

Security fixes target the latest version published to the VS Code Marketplace.
Older versions are not maintained.

## Scope

acp-patchbay brokers between coding agents and your editor. The areas most
relevant to security:

- **Credential handling** — agent and integration tokens and env values are
  held in VS Code `SecretStorage`; by design they never enter `settings.json`,
  workspace/global state, logs, telemetry, or webview state snapshots. Any path
  by which a secret reaches one of those surfaces is in scope.
- **Permission broker** — the command allowlist and the file-write / terminal
  gates that mediate every agent action.
- **Local MCP server and integration bridge** — the editor-state and
  integration surface exposed to connected agents.
- **Webview boundary** — the content-security policy and the render-only
  message protocol between webviews and the orchestrator.

Out of scope here: vulnerabilities in the ACP agents themselves, in third-party
MCP servers you connect, or in VS Code. Please report those to their respective
projects.
