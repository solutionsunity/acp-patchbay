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
  { kind: "user", id: "u1", text: "find foo and fix it" },
  {
    kind: "text", id: "x1",
    text: 'See [the docs](https://example.com/docs) — flow:\n\n```mermaid\ngraph LR\n  A[prompt] --> B{broker}\n  B -->|allow| C[tool runs]\n  B -->|deny| D[blocked]\n```\n\n```ts\nconst pattern: RegExp = /foo/g;\n```',
  },
  { kind: "thought", id: "th1", text: "grep is cheaper than a full parse here — start narrow." },
  tool("t0", { title: "Grep pattern", toolKind: "search", input: '{\n  "pattern": "foo"\n}', output: "3 matches", diffFiles: ["/ws/a.ts"] }),
  tool("g1", { title: "Read a.ts", toolKind: "read" }),
  tool("g2", { title: "Read b.ts", toolKind: "read" }),
  tool("g3", { title: "Read c.ts", toolKind: "read" }),
  tool("t9", { title: "rm -rf ./cache", toolKind: "execute", status: "failed", denied: true }),
  {
    kind: "turnEnd", id: "e0", startedAt: "2026-07-07T10:00:00Z", endedAt: "2026-07-07T10:01:29Z",
    stopReason: "max_tokens", usage: { total: 12025, input: 9800, output: 2225, cached: 7200 },
  },
  { kind: "user", id: "u2", text: "keep going" },
  { kind: "text", id: "xbroke", text: "broken-mermaid case:\n\n```mermaid\ngraph LR\n  A[unclosed --> ???blah{{\n```" },
  {
    kind: "text", id: "x3",
    text: "Ohm: $$V = I \\cdot R$$ — but $5 and $10 stay currency.\n\nIntro line in English.\n\nالنتيجة **جاهزة** للمراجعة وهذا نص عربي.\n\nこの**変更**は完了した。\n\n| item | qty |\n|---|---|\n| bolts | 40 |\n| nuts | 80 |",
  },
];

export const chatPlan = [
  { content: "locate the unanchored pattern", status: "completed" },
  { content: "fix and add a regression test", status: "in_progress" },
  { content: "run the suite", status: "pending" },
];

/** live=true streams the last block (caret, ticker); live=false is the
 * completed-turn view — where the RTL regression hid. */
export function agentViewState({ live }) {
  return {
    agents: [{ id: "fake", name: "Claude Code", status: "running", needsAuth: false }],
    sessions: [{ id: "s1", agentId: "fake", title: "find foo", live, emulated: false, branchOf: null }],
    activeSessionId: "s1",
    chatConnect: null,
    roster: [],
    transcripts: { s1: chatTranscript },
    activePlan: { s1: chatPlan },
    activeTurn: live ? { s1: new Date(Date.now() - 42_000).toISOString() } : {},
    commandsBySession: { s1: [] },
    capabilities: {}, capabilitiesResetAt: {}, authMethods: {}, sessionUsage: {},
    contextChips: { s1: [] }, sessionModes: { s1: null }, sessionConfigOptions: { s1: [] },
    contextRoots: { s1: [] }, liveSelection: null, openEditors: [],
  };
}

export function settingsState() {
  return {
    agents: [
      { id: "claude", name: "Claude Code", status: "running", command: "claude-code-acp", needsAuth: false },
      { id: "aug", name: "Augment", status: "stopped", needsAuth: false },
    ],
    roster: [
      { id: "claude", name: "Claude Code", description: "Anthropic", registryVersion: "1.0.0", unavailableReason: null, knownBypassBridge: false, assetsMapped: true },
      { id: "gemini", name: "Gemini CLI", description: "Google", registryVersion: "0.9.0", unavailableReason: null, knownBypassBridge: false, assetsMapped: false },
      { id: "aug", name: "Augment", description: "Augment Code", registryVersion: "2.1.0", unavailableReason: "requires login", knownBypassBridge: true, assetsMapped: true },
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
    capabilitiesResetAt: {}, authMethods: {},
    commandRules: [], machineCommandRules: [], fileWriteScope: "workspace",
    auditTail: [], integrationRegistry: [], integrations: [], connectFlow: {}, assets: {},
    agentConfigs: [{
      id: "claude", name: "Claude Code", command: "claude-code-acp", args: [],
      envKeys: ["API_KEY"], processPolicy: "auto", defaults: {}, registrySource: null, lastSeenVersion: null,
    }],
    sessionsToday: 7, agentKnobs: {}, registryUpdatedAt: "", pendingBinaryInstall: null, verifyingAgents: {},
  };
}
