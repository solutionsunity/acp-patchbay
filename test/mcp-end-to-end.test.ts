// P7 gate: "real agent reads selection + diagnostics in a turn." The fake
// agent here plays both roles honestly — a real ACP agent AND a real MCP
// client, exactly as production would — spawning the actual bundled MCP
// server as its own subprocess from the mcpServers entry session/new gave
// it. Only EditorStateHost's data source is stood in for (real vscode
// state needs a real extension host; see test-electron for that half).
//
// Every IPC request carries the context token the server was spawned with,
// and the host admits a request only by a token the sessions store minted
// for an attach (#72) — so these turns prove the token the store mints is
// the one the spawned server sends. get_selection/get_diagnostics/etc. are
// global editor state and need nothing more; request_user_input needs the
// real session (to know which transcript to post the elicitation card
// into), so that's where token → session is exercised and asserted.
import { beforeEach, describe, expect, it } from "vitest";
import { orchestratorHarness } from "./support/orchestrator-harness";
import { waitFor } from "./support/wait-for";
import type { EditorReads } from "../src/orchestrator/ipc-host";
import { echoed } from "./support/transcript";
import { fakeAgent } from "./support/fake-agent";
import { tempDir } from "./support/teardown";
import { type LaunchSpec } from "../src/orchestrator/pool";
import type { FakeAgentScript } from "./fake-agent/main";
import type { PatchbayAgentId, PatchbaySessionId } from "../src/shared/ids";


/** An editor with one selection and one problem in it — what the host would
 * read from VS Code for the IPC host to answer with. */
const EDITOR: EditorReads = {
  getSelection: () => ({ file: "/ws/pool.ts", startLine: 42, endLine: 87, text: "class AgentPool { ... }" }),
  getCurrentFile: () => null,
  getDiagnostics: () => [{ file: "/ws/pool.ts", line: 10, severity: "error", message: "unused import" }],
  getOpenEditors: () => [],
};

let dir: string;
beforeEach(async () => {
  dir = await tempDir("patchbay-e2e-cwd-");
});

const spec = (script: FakeAgentScript, patchbayAgentId: string): LaunchSpec => fakeAgent(script, patchbayAgentId, dir);

/** The window's orchestrator: the editor server entry it builds for every
 * attach, and the IPC host that answers it, are the ones that ship. */
function harness() {
  const h = orchestratorHarness(dir, { ports: { editor: EDITOR } });
  const o = h.orchestrator;
  return { pool: o.pool, sessions: o.sessions, gates: o.sessionGates, asks: o.asks, state: h.agentView.state };
}

/** The question card a session shows, once it shows it. */
const questionIn = (h: ReturnType<typeof harness>, patchbaySessionId: PatchbaySessionId) =>
  waitFor(() => h.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "elicitation"));

describe("local MCP server, end to end through a real agent process", () => {
  it("the agent reads the live selection via the local MCP server", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "callMcpTool", tool: "get_selection" }] }, "e1" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("e1" as PatchbayAgentId, "Fake Agent", dir);
    await h.gates.prompt(patchbaySessionId, { text: "what's selected?" });

    expect(echoed(h.state(), patchbaySessionId)).toEqual({
      file: "/ws/pool.ts",
      startLine: 42,
      endLine: 87,
      text: "class AgentPool { ... }",
    });
    await h.pool.stop("e1" as PatchbayAgentId);
  });

  it("the agent reads diagnostics via the local MCP server — opportunistically verifiable data", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "callMcpTool", tool: "get_diagnostics" }] }, "e2" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("e2" as PatchbayAgentId, "Fake Agent", dir);
    await h.gates.prompt(patchbaySessionId, { text: "any problems?" });

    expect(echoed(h.state(), patchbaySessionId)).toEqual([
      { file: "/ws/pool.ts", line: 10, severity: "error", message: "unused import" },
    ]);
    await h.pool.stop("e2" as PatchbayAgentId);
  });

  it("request_user_input resolves against the real sessionId, not the raw correlation token", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ turn: [{ type: "callMcpTool", tool: "request_user_input", args: { message: "ok?" } }] }, "e3" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.gates.create("e3" as PatchbayAgentId, "Fake Agent", dir);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });

    // the subprocess asked with its correlation token; the question shows in
    // the session the token was minted for, and the user's answer goes back
    const card = await questionIn(h, patchbaySessionId);
    h.asks.answerQuestion(card.id, { action: "accept", content: { answeredIn: patchbaySessionId } });
    await turn;
    expect(echoed(h.state(), patchbaySessionId)).toEqual({ answeredIn: patchbaySessionId });
    await h.pool.stop("e3" as PatchbayAgentId);
  });

  it("two sessions on the same agent get independent correlation tokens", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ turn: [{ type: "callMcpTool", tool: "request_user_input", args: { message: "ok?" } }] }, "e4" as PatchbayAgentId),
    );
    const s1 = await h.gates.create("e4" as PatchbayAgentId, "Fake Agent", dir);
    const s2 = await h.gates.create("e4" as PatchbayAgentId, "Fake Agent", dir);
    expect(s1).not.toBe(s2);

    // each session's tool call asks in its own session, never the other's —
    // and each gets its own session's answer
    for (const sid of [s1, s2]) {
      const turn = h.gates.prompt(sid, { text: "go" });
      const card = await questionIn(h, sid);
      h.asks.answerQuestion(card.id, { action: "accept", content: { answeredIn: sid } });
      await turn;
    }
    expect(echoed(h.state(), s1)).toEqual({ answeredIn: s1 });
    expect(echoed(h.state(), s2)).toEqual({ answeredIn: s2 });
    await h.pool.stop("e4" as PatchbayAgentId);
  });
});
