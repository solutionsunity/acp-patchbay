# docs

The design record for acp-patchbay. Two rules govern everything here.

**Docs are facts, not ledgers.** Every document states what is true *now* —
present tense, against the current code and the pinned protocol version. History
lives in git, not in prose. A decision that supersedes an earlier one is written
as the new fact, in the one document it changes; the supersession is not narrated,
and never cross-referenced from other documents. When a fact retires, it leaves
the doc — it is not struck through and kept.

**Code comments never point here.** Comments explain code; docs explain design.
A source comment naming a doc (or a doc-internal id) is cross-reference debt — it
rots the moment the doc moves or a section is renamed. Navigation runs one way:
code never names docs. A doc *may* name code — a file or symbol is a stable
anchor — but does so rarely: the "how" doc (architecture.md) where a mechanism
needs the anchor, and the compliance fact-sheet where each anchor is the
evidence for a status. A "what" doc (prd, features) names no code. You find a
document through this map, not through a breadcrumb in the source.

## Map

Read top to bottom for the whole picture:

1. **[prd.md](prd.md)** — why the product exists; the problem and the promise.
2. **[features.md](features.md)** — what must be possible, as current-release
   capabilities.
3. **[architecture.md](architecture.md)** — how the product becomes a VS Code
   extension; mechanisms and the reasoning behind them.
4. **[roadmap.md](roadmap.md)** — what is deliberately beyond the current release,
   and the bar each
   item clears to enter.

Grouped areas:

- **[ui/](ui/)** — the UI surfaces: [ui.md](ui/ui.md) (what each surface does),
  [ui-architecture.md](ui/ui-architecture.md) (what they're built
  from), and the binding mockups.
- **[agents/](agents/)** — one dossier per ACP agent: versioned, reproducible
  observations of wire behavior and the vendor-communication trail. See
  [agents/README.md](agents/README.md).

References:

- **[acp-compliance.md](acp-compliance.md)** — patchbay's own conformance to the
  ACP protocol, as facts checked against a pinned SDK version.
- **[reference-mcp-oauth.md](reference-mcp-oauth.md)** — how patchbay authenticates
  to remote MCP servers.
