# ACP agent conduct notes

One dossier per agent: versioned, reproducible observations of how it behaves
on the ACP wire — compliance issues, capability gaps, legal-but-surprising
behavior. This is the *communicable artifact*: when an issue is reported to a
vendor with no public tracker, the dossier section is what gets handed over.

**A dossier stores only what can't be read elsewhere.** A vendor's public
tracker already holds a report's status and history, so the dossier links the
report and copies nothing of it; no link means not reported. A vendor with no
public tracker keeps its trail here — status lines, a communication log,
reports — since nothing else shows it. An observation filed on a public tracker
gets an entry only when patchbay's code or behavior rests on it; otherwise the
issue is the record.

**Division of knowledge, held strictly:** anything patchbay *consumes* lives
in code tables (`META_EXTENSIONS` in meta.ts, knob quirks in knobs.ts) —
machine-actionable mechanism.
These files hold human-communicable evidence. Each note names its module; code
does not name the note — the binding is held from the doc side. One direction,
never two truths.

**The claim discipline:** every entry carries the version it was observed on
and a reproduction — quirks die with releases, so an unversioned claim is
gossip. Same reason the capability matrix is version-keyed.

## Format

```markdown
# <Agent> — ACP conduct notes
Identity: package, distribution, vendor channel

## Compliance issues            (spec says X, agent does Y)
### <slug>
- Observed: date, version, how found
- Spec: the clause it violates
- Repro: minimal steps, self-contained
- Impact: what breaks for users
- Patchbay workaround: none | code pointer
- Reported: link to the vendor's public tracker
- Status: observed → reported (where, when) → fixed in vX / wontfix (no public tracker only)

## Capability gaps              (undeclared-but-important, declared-but-inert — and why it matters)
## Behavioral notes             (legal-but-surprising; informational; clean records under test belong here too)
## Communication log            (dated, append-only; no public tracker only)
```

## Index

- [auggie.md](auggie.md) — Augment's Auggie CLI
- [claude-agent-acp.md](claude-agent-acp.md) — the Claude Agent SDK bridge
- [codex-acp.md](codex-acp.md) — the Codex bridge
- [gemini-cli.md](gemini-cli.md) — Google's Gemini CLI
- [opencode.md](opencode.md) — OpenCode

## Reports

The vendor-facing artifacts — a report is what gets handed to a vendor with no
public tracker when an issue is raised. They live in [reports/](reports/), dated
and named `<agent>-<kind>-YYYY-MM-DD.md`, so an agent can accumulate more than
one over time and reports sit together regardless of agent. Each dossier links
its own reports.
