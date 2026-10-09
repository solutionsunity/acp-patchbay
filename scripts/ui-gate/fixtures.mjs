// State fixtures the ui-gate renders — the UI counterpart of the fake
// agent's lying modes: each fixture exists because a real regression hid in
// it (interleaved stream, RTL-after-completion, broken mermaid, unmapped
// theme tokens, dialog/combobox overlays).

const tool = (id, over = {}) => ({
  kind: "toolCall", id, title: id, status: "completed", toolKind: "other",
  input: null, output: null, locations: [], content: [], diffs: {}, denied: false, ...over,
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
  tool("t0", { title: "Grep pattern", toolKind: "search", input: '{\n  "pattern": "foo"\n}', output: "3 matches", content: [{ kind: "text", text: "Found **3 matches** in 2 files:\n\n```console\nsrc/a.ts:12:  foo()\nsrc/a.ts:30:  foo(1)\nsrc/b.ts:40:  return foo\n```" }], locations: [{ path: "/ws/src/a.ts", line: 12 }, { path: "/ws/src/a.ts", line: 30 }, { path: "/ws/src/b.ts", line: 40 }, { path: "/ws/src/c.ts", line: null }], diffs: { "/ws/src/a.ts": { additions: 3, deletions: 1 } } }),
  tool("g1", { title: "Read a.ts", toolKind: "read" }),
  tool("g2", { title: "Read b.ts", toolKind: "read" }),
  // file-touching + matching the dirty openEditors entry below — lights the
  // read-out strip's files chip and its dirty dot; keeps the run at 5 calls
  tool("g3", { title: "Edit api.ts", toolKind: "edit", locations: [{ path: "/ws/src/api.ts", line: null }], diffs: { "/ws/src/api.ts": { additions: 12, deletions: 4 } } }),
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
  // an update kind with no surface yet, shown as the agent sent it
  { kind: "carried", id: "car1", updateKind: "notice", payload: '{\n  "severity": "warning",\n  "title": "Rate limit near"\n}' },
  // non-text pieces of an agent's message: rendered by the message part
  // renderers, never a placeholder line (an embedded file expands;
  // audio keeps a labeled placeholder — nothing plays it)
  { kind: "text", id: "xp0", text: "Attached the notes I used:" },
  { kind: "agentPart", id: "ap1", part: { kind: "context", label: "file:///ws/notes.md", text: "- foo() is called from 3 places\n- b.ts returns it" }, thought: false },
  { kind: "agentPart", id: "ap2", part: { kind: "unrendered", type: "audio" }, thought: false },
  { kind: "user", id: "u2", parts: [{ kind: "text", text: "keep going" }] },
  // a call running in a client terminal: the terminal renders inside its
  // card (ACP embedded terminal), not as a separate block in the stream
  tool("x9", { title: "Run tests", toolKind: "execute", status: "completed", input: '{\n  "command": "npm test"\n}', content: [{ kind: "terminal", terminalId: "term-9" }] }),
  { kind: "terminal", id: "term-block-term-9", command: "npm test", output: "✓ 12 passed (1.4s)", running: false, exitCode: 0 },
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
  // Decision cards (issues #27, #90): a change too large for the card shows
  // none of itself there, only that it is too large; a small one shows every
  // hunk; a pending one offers Open diff beside its answers — patchbay's own
  // write gate and an agent's edit request (Hermes's shape: no locations,
  // the change only in the request's diff) alike.
  {
    kind: "diff", id: "d-long", file: "/ws/src/api.ts", additions: 60, deletions: 0,
    preview: null,
    resolution: null,
  },
  {
    kind: "diff", id: "d-short", file: "/ws/src/api.ts", additions: 2, deletions: 1,
    preview: [
      { kind: "context", text: "a" }, { kind: "del", text: "b" },
      { kind: "add", text: "c" }, { kind: "add", text: "d" },
    ],
    resolution: { accepted: true, auto: false },
  },
  {
    kind: "permission", id: "p-edit", title: "Approve edit: /ws/src/greet.ts", detail: "", facts: [],
    options: [
      { optionId: "allow_once", label: "Allow edit", kind: "allow_once" },
      { optionId: "deny", label: "Deny", kind: "reject_once" },
    ],
    call: {
      toolCallId: "edit-approval-1", toolKind: "edit", locations: [], content: [],
      diffs: {
        "/ws/src/greet.ts": {
          additions: 1, deletions: 1,
          preview: [
            { kind: "context", text: "export function farewell(name: string): string {" },
            { kind: "del", text: '  return "Bye, " + name;' },
            { kind: "add", text: "  return `Goodbye, ${name}.`;" },
            { kind: "context", text: "}" },
          ],
        },
      },
      input: '{\n  "tool": "patch",\n  "arguments": { "mode": "replace" }\n}',
    },
    resolution: null,
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

/** A command whose description is a paragraph, the way agents advertise
 * skills — the slash-menu shot gates that the name stays whole on one line
 * and only the selected row shows the paragraph in full. */
export const longCommand = {
  name: "change-audit",
  inputHint: "target",
  description:
    "Audit a change before it ships — DRY, no leftover, no dead code, no new bug, nothing existing broken, within the project's architecture. Reads the actual diff, its consumers, and the project's own docs and rules; runs the project's own gate; reports a verdict with findings.",
};

export const chatPlan = [
  { content: "locate the unanchored pattern", status: "completed" },
  { content: "fix and add a regression test", status: "in_progress" },
  { content: "run the suite", status: "pending" },
  { content: "publish a release", status: "cancelled" },
];

/** A full capability matrix for an agent that declared session/load but no
 * session/list — every row present, as the tracker always reads it. */
const unlistedMatrix = Object.fromEntries(
  [
    "fs.readTextFile", "fs.writeTextFile", "terminal", "elicitation", "resources.subscribe",
    "prompt.image", "prompt.audio", "prompt.embeddedContext", "session.fork", "session.load",
    "session.resume", "session.list", "session.delete", "session.close",
    "session.additionalDirectories", "mcp.http", "mcp.sse", "usage", "concurrentSessions",
    "auth", "auth.logout",
  ].map((row) => [row, { declared: row === "session.load", used: false }]),
);

/** Complete stored-preferences object, as every snapshot carries. */
export const preferences = {
  soundOnDone: false, doneSound: "", knobSource: "agent-default", idleCloseMinutes: 60,
  statsPrompts: true, statsToolCalls: true, statsContext: true, statsPlanUsage: true,
  detachWindows: true, attachmentMaxMB: 10, openThinking: false, executeCalls: "grouped",
};

/** live=true streams the last block (caret, ticker); live=false is the
 * completed-turn view — where the RTL regression hid. */
export function agentViewState({ live }) {
  return {
    // `silent` declared no session/list — the sessions drawer must say so
    // fake's agent has a newer version — the agent chip's upgrade chip (#37)
    agents: [
      { id: "fake", name: "Claude Code", status: "running", needsAuth: false, authMethods: [], busy: [], update: { from: "1.0.0", to: "1.2.0" } },
      { id: "silent", name: "Augment", status: "stopped", needsAuth: false, authMethods: [], busy: [], capabilities: unlistedMatrix },
    ],
    // s2: newer activity + unseen — must sort above the active s1 and show
    // the blue dot in the sessions drawer. s3 waits on a question, s4 runs:
    // with s2 they fill the header's read-out of the other sessions.
    sessions: [
      { id: "s1", patchbayAgentId: "fake", title: "find foo", busy: live ? ["prompt"] : [], updatedAt: "2026-07-09T10:00:00Z" },
      { id: "s2", patchbayAgentId: "fake", title: "refactor bar", busy: [], updatedAt: "2026-07-09T11:00:00Z", unseen: true },
      { id: "s3", patchbayAgentId: "fake", title: "migrate the schema", busy: ["prompt"], updatedAt: "2026-07-09T09:00:00Z" },
      { id: "s4", patchbayAgentId: "fake", title: "write the release notes", busy: ["prompt"], updatedAt: "2026-07-09T08:00:00Z" },
    ],
    activePatchbaySessionId: "s1",
    chatConnect: null,
    composerFocus: 0,
    registryAgents: [],
    transcripts: {
      s1: chatTranscript,
      s3: [{ kind: "elicitation", id: "q-s3", message: "Which database?", mode: "form", fields: [], resolution: null }],
    },
    activePlan: { s1: chatPlan },
    activeTurn: live ? { s1: new Date(Date.now() - 42_000).toISOString() } : {},
    commandsBySession: { s1: [{ name: "create-plan", description: "draft a plan" }, { name: "review" }, longCommand] },
    sessionUsage: {},
    contextChips: { s1: [longSelectionChip] }, sessionKnobs: { s1: [] }, promptQueue: { s1: [longQueuedPrompt] }, drafts: {},
    contextRoots: { s1: [] }, workspaceRoots: ["/ws"], liveSelection: null,
    openEditors: [{ file: "/ws/src/app.ts", dirty: false }, { file: "/ws/src/api.ts", dirty: true }],
    workspaceFiles: { query: "", files: [], dirs: [] },
    preferences,
    screen: { pointer: true, pinned: [] },
  };
}

/** Four curated entries spanning the mechanism space — key+local,
 * key+OAuth, a gated remote with a local server, local-only — so the
 * catalog filter's toggles and text have distinct rows to keep and drop.
 * Stripe's caveat note
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
  // local only (#63): no remote at all, its stdio server offered alone
  catalogEntry("odoo-surface", "OdooSurface", "user-equivalent Odoo access", {
    connectable: false, note: "Local only: no remote endpoint.",
    local: { kind: "stdio", command: "npx", args: ["-y", "@suco/odoo-surface-mcp@latest"], envKeys: ["ODOO_URL", "ODOO_DB", "ODOO_USER", "ODOO_PASSWORD"], note: "needs a running Odoo" },
  }),
];

export function settingsState() {
  return {
    // Host-owned since the deep-link work — a snapshot REPLACES state, so a
    // fixture without it renders no section at all (the gate's own
    // regression: it timed out on `.section h1` when this field landed).
    section: "agents",
    agents: [
      {
        id: "claude", name: "Claude Code", status: "running", command: "claude-code-acp", needsAuth: false,
        authMethods: [], busy: [], protocolVersion: 1,
        // the card's upgrade chip (#37)
        update: { from: "0.9.0", to: "1.0.0" },
        capabilities: {
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
      { id: "aug", name: "Augment", status: "stopped", needsAuth: false, authMethods: [], busy: [] },
    ],
    registryAgents: [
      { id: "claude", name: "Claude Code", description: "Anthropic", icon: null, version: "1.0.0", unavailableReason: null },
      { id: "gemini", name: "Gemini CLI", description: "Google", icon: null, version: "0.9.0", unavailableReason: null },
      { id: "aug", name: "Augment", description: "Augment Code", icon: null, version: "2.1.0", unavailableReason: "requires login" },
    ],
    commandRules: [], machineCommandRules: [], fileWriteScope: "workspace",
    auditTail: [], mcpCatalog: catalogEntries, mcpServers: [], mcpConnects: [], mcpImportReview: null,
    agentConfigs: [{
      id: "claude", name: "Claude Code", command: "claude-code-acp", args: [],
      env: { API_KEY: "sk-fixture" }, defaults: {}, registrySource: null, lastSeenVersion: null,
    }],
    sessionsActiveToday: 7, agentKnobs: {}, agentQuestions: {}, registryFetchedAt: "",
    wireLog: { active: false, until: null }, dataInventory: null,
    preferences, doneSounds: ["Glass", "Ping"],
  };
}
