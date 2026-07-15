# Contributing

Thanks for your interest in acp-patchbay. Contributions are welcome.

## Ground rules

- **License — inbound = outbound.** By contributing you agree your contribution
  is licensed under the project's [Apache License 2.0](LICENSE). You keep
  copyright on your work; there is no copyright assignment.
- **Developer Certificate of Origin.** Every commit must be signed off,
  certifying you have the right to submit it under the project license (see
  <https://developercertificate.org>). Add the sign-off with `git commit -s`,
  which appends:

      Signed-off-by: Your Name <you@example.com>

## Development

    npm ci            # install
    npm run check     # the full gate — typecheck, lint, tests, build, UI shots
    npm test          # unit tests only (vitest)
    npm run build     # esbuild bundle

`npm run check` is the source of truth for "green." The electron suite needs a
VS Code test host and skips loudly where one isn't available — run it where a
host can be downloaded before you rely on it.

## Pull requests

- Keep each PR to **one concern**; unrelated changes belong in separate PRs.
- Use [Conventional Commits](https://www.conventionalcommits.org) for messages
  (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`) — the history reads as a
  changelog.
- The architecture is documented in
  [docs/architecture.md](docs/architecture.md). A PR that changes behavior
  should keep the docs honest.

## Reporting

- Bugs and feature requests: open an issue.
- Security vulnerabilities: **do not** open a public issue — see
  [SECURITY.md](SECURITY.md).
