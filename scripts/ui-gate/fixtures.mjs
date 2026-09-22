// State fixtures the ui-gate renders — the UI counterpart of the fake
// agent's lying modes: each fixture exists because a real regression hid in
// it (interleaved stream, RTL-after-completion, broken mermaid, unmapped
// theme tokens, dialog/combobox overlays).

const tool = (id, over = {}) => ({
  kind: "toolCall", id, title: id, status: "completed", toolKind: "other",
  input: null, output: null, locations: [], diffFiles: [], denied: false, ...over,
});

/** Interleaved transcript: markdown+code+mermaid (valid & broken), thought,
 * grouped tool run, denied call, turn metadata, math/RTL/CJK/table. */
export const chatTranscript = [
  // parts model: prose + a mention token + an attachment chip — the shot
  // gates the part renderers, not just plain text
  {
    kind: "user", id: "u1",
    parts: [
      { kind: "text", text: "find foo in " },
      { kind: "mention", name: "api.ts", uri: "file:///ws/src/api.ts" },
      { kind: "text", text: " and fix it" },
      { kind: "attachment", name: "notes.md", path: "/ws/notes.md" },
    ],
  },
  {
    kind: "text", id: "x1",
    text: 'See [the docs](https://example.com/docs) — flow:\n\n```mermaid\ngraph LR\n  A[prompt] --> B{broker}\n  B -->|allow| C[tool runs]\n  B -->|deny| D[blocked]\n```\n\n```ts\nconst pattern: RegExp = /foo/g;\n```',
  },
  { kind: "thought", id: "th1", text: "grep is cheaper than a full parse here — start narrow." },
  tool("t0", { title: "Grep pattern", toolKind: "search", input: '{\n  "pattern": "foo"\n}', output: "3 matches", diffFiles: ["/ws/a.ts"] }),
  tool("g1", { title: "Read a.ts", toolKind: "read" }),
  tool("g2", { title: "Read b.ts", toolKind: "read" }),
  // file-touching + matching the dirty openEditors entry below — lights the
  // read-out strip's files chip and its dirty dot; keeps the run at 5 calls
  tool("g3", { title: "Edit api.ts", toolKind: "edit", locations: ["/ws/src/api.ts"], diffFiles: ["/ws/src/api.ts"] }),
  tool("t9", { title: "rm -rf ./cache", toolKind: "execute", status: "failed", denied: true }),
  {
    kind: "turnEnd", id: "e0", startedAt: "2026-07-07T10:00:00Z", endedAt: "2026-07-07T10:01:29Z",
    stopReason: "max_tokens", usage: { total: 12025, input: 9800, output: 2225, cached: 7200 },
  },
  // harness envelope riding the user role (acp-agents-notes/claude-agent-acp.md § Injected
  // user-role messages) — dim collapsed line, never a bubble, not a prompt
  {
    kind: "user", id: "inj1", injected: true,
    parts: [{ kind: "text", text: "<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n<result>Agent finished.</result>\n</task-notification>" }],
  },
  { kind: "user", id: "u2", parts: [{ kind: "text", text: "keep going" }] },
  { kind: "text", id: "xbroke", text: "broken-mermaid case:\n\n```mermaid\ngraph LR\n  A[unclosed --> ???blah{{\n```" },
  // path=/excerpt fence attributes (the shape the wire-extension rewriter
  // emits — code-block.tsx caption) on a MULTI-LINE fence: line integrity
  // regressed once (streamdown 2.5.0 one-lines fences under
  // lineNumbers={false}; style.css repair rule)
  {
    kind: "text", id: "x4",
    text: 'excerpt case:\n\n```ts path="src/deep/thing.ts" excerpt\nconst one = 1;\nconst two = 2;\n```',
  },
  {
    kind: "text", id: "x3",
    text: "Ohm: $$V = I \\cdot R$$ — but $5 and $10 stay currency.\n\nIntro line in English.\n\nالنتيجة **جاهزة** للمراجعة وهذا نص عربي.\n\nこの**変更**は完了した。\n\n| item | qty |\n|---|---|\n| bolts | 40 |\n| nuts | 80 |",
  },
  // one URL three ways, none with a break opportunity: an autolink, plain
  // text (scheme-less so GFM never autolinks it — the shape issue #2's
  // agent produced: a URL rendered as text, no link), and inline code. The
  // narrow shot gates that every one wraps instead of sliding under the edge.
  {
    kind: "text", id: "x5",
    text: "## Sources\n\n- <https://raw.githubusercontent.com/odoo/odoo/17.0/addons/web/static/src/views/form/form_controller.scss>\n- api.github.com/repos/odoo/odoo/commits?path=addons/web/static/src/views/form/form_controller.scss&sha=17.0\n- `postgresql://user:password@localhost:5432/a_database_with_a_long_name?sslmode=require`",
  },
  // A write proposal larger than the card's preview: the card must say how
  // many lines it is not showing and offer the full diff; a short, resolved
  // one shows everything and offers nothing (issue #27).
  {
    kind: "diff", id: "d-long", file: "/ws/src/api.ts", additions: 60, deletions: 0,
    lines: Array.from({ length: 60 }, (_, i) => ({ kind: "add", text: `line ${i + 1}` })),
    resolution: null,
  },
  {
    kind: "diff", id: "d-short", file: "/ws/src/api.ts", additions: 2, deletions: 1,
    lines: [
      { kind: "context", text: "a" }, { kind: "del", text: "b" },
      { kind: "add", text: "c" }, { kind: "add", text: "d" },
    ],
    resolution: { accepted: true, auto: false },
  },
];

/** A queued prompt that is one unbreakable token — the narrow shot gates
 * that the row truncates and its × stays reachable. */
export const longQueuedPrompt = {
  id: "q1",
  text: "https://api.github.com/repos/odoo/odoo/commits?path=addons/web/static/src/views/form/form_controller.scss&sha=17.0",
  // carries its editor state, so the row renders its full set: copy, edit, ×
  draft: '{"root":{}}',
};

/** A selection chip whose label is one unbreakable absolute path — same
 * gate, the chip's own row shape. */
export const longSelectionChip = {
  id: "c1", kind: "selection",
  label: "Selection: /ws/addons/web/static/src/views/form/form_controller.scss:12-40",
  content: ".o_form_view { display: flex; }",
  sourceUri: "file:///ws/addons/web/static/src/views/form/form_controller.scss#L12-L40",
};

export const chatPlan = [
  { content: "locate the unanchored pattern", status: "completed" },
  { content: "fix and add a regression test", status: "in_progress" },
  { content: "run the suite", status: "pending" },
];

/** Complete stored-preferences object, as every snapshot carries. */
const preferences = {
  soundOnDone: false, knobSource: "agent-default", idleCloseMinutes: 60, composerStats: true,
};

/** live=true streams the last block (caret, ticker); live=false is the
 * completed-turn view — where the RTL regression hid. */
export function agentViewState({ live }) {
  return {
    agents: [{ id: "fake", name: "Claude Code", status: "running", needsAuth: false }],
    // s2: newer activity + unseen — must sort above the active s1 and show
    // the blue dot in the sessions drawer.
    sessions: [
      { id: "s1", agentId: "fake", title: "find foo", live, updatedAt: "2026-07-09T10:00:00Z" },
      { id: "s2", agentId: "fake", title: "refactor bar", live: false, updatedAt: "2026-07-09T11:00:00Z", unseen: true },
    ],
    activeSessionId: "s1",
    chatConnect: null,
    registryAgents: [],
    transcripts: { s1: chatTranscript },
    activePlan: { s1: chatPlan },
    activeTurn: live ? { s1: new Date(Date.now() - 42_000).toISOString() } : {},
    commandsBySession: { s1: [{ name: "create-plan", description: "draft a plan" }, { name: "review" }] },
    capabilities: {}, capabilitiesResetAt: {}, authMethods: {}, sessionUsage: {},
    // matches g3's diff-bearing edit below — the files panel's +/- badge
    fileDiffStats: { s1: { "/ws/src/api.ts": { additions: 12, deletions: 4 } } },
    contextChips: { s1: [longSelectionChip] }, sessionKnobs: { s1: [] }, promptQueue: { s1: [longQueuedPrompt] }, drafts: {},
    contextRoots: { s1: [] }, workspaceRoots: [], liveSelection: null,
    openEditors: [{ file: "/ws/src/app.ts", dirty: false }, { file: "/ws/src/api.ts", dirty: true }],
    workspaceFiles: { query: "", files: [], dirs: [] },
    preferences,
  };
}

/** Three curated entries spanning the mechanism space — key+local,
 * key+OAuth, local-only-not-connectable — so the catalog filter's toggles
 * and text have distinct rows to keep and drop. Stripe's caveat note
 * carries the word the text probe types: the note must NOT match. */
const catalogEntry = (id, name, description, over = {}) => ({
  id, name, description, brandIcon: { viewBox: "0 0 24 24", path: "M4 4h16v16H4z" }, connectable: true, note: "", docsUrl: "https://example.com/docs",
  userUrl: false, headerAuth: null, oauth: false, local: null, ...over,
});
const catalogEntries = [
  catalogEntry("github", "GitHub", "repositories, issues, pull requests, code search", {
    headerAuth: { hint: "Personal Access Token", keyUrl: "https://github.com/settings/tokens" },
    local: { kind: "stdio", command: "docker", args: ["run", "-i"], envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"], note: "official server via Docker" },
  }),
  catalogEntry("stripe", "Stripe", "customers, payments, subscriptions", {
    headerAuth: { hint: "Restricted API key", keyUrl: "" }, oauth: true, note: "Design your restricted key's scopes first.",
  }),
  catalogEntry("figma", "Figma", "design context — frames, components, variables", {
    connectable: false, note: "Remote gated on a client allowlist; the desktop server is open.",
    local: { kind: "http", url: "http://127.0.0.1:3845/mcp", note: "desktop app running" },
  }),
];

export function settingsState() {
  return {
    // Host-owned since the deep-link work — a snapshot REPLACES state, so a
    // fixture without it renders no section at all (the gate's own
    // regression: it timed out on `.section h1` when this field landed).
    section: "agents",
    agents: [
      { id: "claude", name: "Claude Code", status: "running", command: "claude-code-acp", needsAuth: false },
      { id: "aug", name: "Augment", status: "stopped", needsAuth: false },
    ],
    registryAgents: [
      { id: "claude", name: "Claude Code", description: "Anthropic", icon: null, version: "1.0.0", unavailableReason: null },
      { id: "gemini", name: "Gemini CLI", description: "Google", icon: null, version: "0.9.0", unavailableReason: null },
      { id: "aug", name: "Augment", description: "Augment Code", icon: null, version: "2.1.0", unavailableReason: "requires login" },
    ],
    capabilities: {
      claude: {
        "fs.readTextFile": { declared: true, used: true },
        "fs.writeTextFile": { declared: true, used: false },
        terminal: { declared: true, used: true },
        "session.fork": { declared: true, used: false },
        "session.load": { declared: true, used: true },
        "prompt.image": { declared: true, used: false },
        usage: { declared: true, used: true },
        auth: { declared: true, used: true },
      },
    },
    capabilitiesResetAt: {}, agentProtocol: { claude: 1 }, authMethods: {},
    commandRules: [], machineCommandRules: [], fileWriteScope: "workspace",
    auditTail: [], integrationRegistry: catalogEntries, integrations: [], connectFlow: {},
    agentConfigs: [{
      id: "claude", name: "Claude Code", command: "claude-code-acp", args: [],
      env: { API_KEY: "sk-fixture" }, processPolicy: "auto", defaults: {}, registrySource: null, lastSeenVersion: null,
    }],
    sessionsActiveToday: 7, agentKnobs: {}, registryFetchedAt: "", verifyingAgents: {},
    wireLog: { active: false, until: null }, dataInventory: null,
    preferences,
  };
}
