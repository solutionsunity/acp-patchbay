// Issue #72: patchbay's IPC socket answers only a context token one of its
// attaches minted. Every process of the user can reach the socket; a forged
// token gets nothing — not the editor's buffers, not a session's roots or a
// form in its transcript, not an MCP server's credential — while the editor
// server an agent was given still answers through its own token.
import { waitFor } from "./wait-for";
import { fakeAgentConfig, type AgentsDoor, type GatesDoor, type SessionGatesDoor } from "./fake-agent-config";
import * as assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { answeringYes } from "./modal";

interface Internal {
  orchestrator: {
    editorStateHost: { socketPath: string };
    agentView: { current: { transcripts: Record<string, Array<{ kind: string; text?: string }>> } };
    agents: AgentsDoor;
    gates: GatesDoor;
    sessions: { createSession(agentId: string, agentName: string, cwd: string): Promise<string> };
    sessionGates: SessionGatesDoor;
  };
}

/** One request on the socket, the way a spawned subprocess sends it —
 * newline-delimited JSON — and the one line it gets back. */
function ask(socketPath: string, request: object): Promise<{ result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)) as { result?: unknown; error?: string });
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

suite("IPC admission (issue #72)", () => {
  test("a token no attach minted gets nothing — editor reads, roots, forms and credentials alike", async () => {
    const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay")!;
    const { orchestrator } = ((await ext.activate()) as { internal: Internal }).internal;
    const requests = [
      { method: "getSelection" },
      { method: "getCurrentFile" },
      { method: "getOpenEditors" },
      { method: "getRoots" },
      { method: "requestUserInput", params: { message: "your password?" } },
      { method: "getIntegrationToken", params: { integrationId: "github" } },
    ];
    for (const [i, request] of requests.entries()) {
      const answer = await ask(orchestrator.editorStateHost.socketPath, { id: i + 1, sessionId: "ctx-1", ...request });
      assert.strictEqual(answer.result, undefined, `${request.method} answered a forged token`);
      assert.match(answer.error ?? "", /unknown session token/, request.method);
    }
  });

  test("the editor server an agent was given answers through its own token", async function () {
    this.timeout(20000);
    const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay")!;
    const { orchestrator } = ((await ext.activate()) as { internal: Internal }).internal;
    const fakeAgentPath = join(ext.extensionUri.fsPath, "out-test", "fake-agent.mjs");
    const cwd = await mkdtemp(join(tmpdir(), "patchbay-ipc-admission-"));
    try {
      await orchestrator.agents.save(
        fakeAgentConfig("ipc-admission", "IPC Admission Fake", fakeAgentPath, {
          turn: [{ type: "callMcpTool", tool: "get_open_editors" }],
        }),
      );
      await orchestrator.gates.connect("ipc-admission");
      const sessionId = await orchestrator.sessions.createSession("ipc-admission", "IPC Admission Fake", cwd);
      await orchestrator.sessionGates.prompt(sessionId, { text: "go" });
      const text = await waitFor(
        () => orchestrator.agentView.current.transcripts[sessionId]?.find((b) => b.kind === "text")?.text,
      );
      assert.ok(!text.startsWith("mcp: rejected"), text);
      assert.ok(Array.isArray(JSON.parse(text)), `open editors answered as a list: ${text}`);
    } finally {
      await answeringYes(() => orchestrator.gates.remove("ipc-admission"));
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
