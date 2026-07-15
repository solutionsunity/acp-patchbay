# ACP agent conduct notes

One dossier per agent: versioned, reproducible observations of how it behaves
on the ACP wire — compliance issues, capability gaps, legal-but-surprising
behavior, and the communication trail with its vendor. This is the
*communicable artifact*: when an issue is reported to a vendor (many have no
public repo), the dossier section is what gets handed over.

**Division of knowledge, held strictly:** anything patchbay *consumes* lives
in code tables (`META_EXTENSIONS` in meta.ts, `ASSET_LOCATIONS` in
asset-locations.ts, knob quirks in knobs.ts) — machine-actionable mechanism.
These files hold human-communicable evidence. Each note names its module; code
does not name the note — the binding is held from the doc side. One direction,
never two truths.

**The claim discipline:** every entry carries the version it was observed on
and a reproduction — quirks die with releases, so an unversioned claim is
gossip. Same reason the capability matrix is version-keyed.

## Format

```markdown
# <Agent> — ACP conduct notes
Identity: package, distribution, version(s) tested, vendor channel

## Compliance issues            (spec says X, agent does Y)
### <slug>
- Observed: date, version, how found
- Spec: the clause it violates
- Repro: minimal steps, self-contained
- Impact: what breaks for users
- Patchbay workaround: none | code pointer
- Status: observed → reported (where, when) → fixed in vX / wontfix

## Capability gaps              (undeclared-but-important, declared-but-inert — and why it matters)
## Behavioral notes             (legal-but-surprising; informational; clean records under test belong here too)
## Communication log            (dated, append-only)
```

## Index

- [auggie.md](auggie.md) — Augment's Auggie CLI
- [claude-agent-acp.md](claude-agent-acp.md) — the Claude Agent SDK bridge
- [codex-acp.md](codex-acp.md) — the Codex bridge
- [gemini-cli.md](gemini-cli.md) — Google's Gemini CLI

## Reports

The vendor-facing artifacts — a report is what gets handed to a vendor when an
issue is raised. They live in [reports/](reports/), dated and named
`<agent>-<kind>-YYYY-MM-DD.md`, so an agent can accumulate more than one over
time and reports sit together regardless of agent. Each dossier links its own
reports.
