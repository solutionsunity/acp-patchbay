// Issue #72: patchbay's IPC socket answers only a context token one of its
// attaches minted. Every process of the user can reach the socket; a forged
// token gets nothing — not the editor's buffers, not a session's roots or a
// form in its transcript, not an MCP server's credential — while the editor
// server an agent was given still answers through its own token.
import * as assert from "node:assert";
import { connect } from "node:net";
import { fakeAgentConfig } from "./fake-agent-config";
import { fakeAgentPath, internals, Patchbay } from "./patchbay";
import { waitFor } from "./wait-for";

/** The socket is this suite's subject: its path is the one thing it
 * reaches behind the views. */
interface Internal {
  orchestrator: { editorStateHost: { socketPath: string } };
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
    const { orchestrator } = await internals<Internal>();
    const requests = [
      { method: "getSelection" },
      { method: "getCurrentFile" },
      { method: "getOpenEditors" },
      { method: "getRoots" },
      { method: "requestUserInput", params: { message: "your password?" } },
      { method: "getMcpServerToken", params: { serverId: "github" } },
    ];
    for (const [i, request] of requests.entries()) {
      const answer = await ask(orchestrator.editorStateHost.socketPath, { id: i + 1, sessionId: "ctx-1", ...request });
      assert.strictEqual(answer.result, undefined, `${request.method} answered a forged token`);
      assert.match(answer.error ?? "", /unknown session token/, request.method);
    }
  });

  test("the editor server an agent was given answers through its own token", async function () {
    this.timeout(30000);
    const pb = await Patchbay.open();
    try {
      await pb.addAgent(
        fakeAgentConfig("ipc-admission", "IPC Admission Fake", fakeAgentPath(), {
          turn: [{ type: "callMcpTool", tool: "get_open_editors" }],
        }),
      );
      await pb.connect("ipc-admission");
      const sessionId = await pb.newSession("ipc-admission");
      await pb.prompt(sessionId, "go");
      const text = await waitFor(() => pb.text(sessionId) || undefined);
      assert.ok(!text.startsWith("mcp: rejected"), text);
      assert.ok(Array.isArray(JSON.parse(text)), `open editors answered as a list: ${text}`);
    } finally {
      await pb.remove("ipc-admission");
    }
  });
});
