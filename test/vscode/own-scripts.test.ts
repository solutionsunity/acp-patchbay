// Issue #94: the servers patchbay runs itself — the editor server, the MCP
// bridge — are its scripts on the editor's own binary. Here, as on any
// desktop editor, that binary is Electron: a script runs as Node only under
// ELECTRON_RUN_AS_NODE, and an agent that hands its servers a filtered
// environment (Hermes Agent keeps PATH, HOME and the entry's own env) drops
// the copy the extension host passed down. Spawned that way, the entry must
// still speak MCP rather than launch the editor.
import * as assert from "node:assert";
import { spawn } from "node:child_process";
import { internals } from "./patchbay";

/** The session set is this suite's subject: the entries it hands an agent
 * are the one thing it reaches behind the views. */
interface Internal {
  orchestrator: {
    mcpServers: {
      mcpServersFor(
        patchbayAgentId: string,
        contextToken: string,
        declaresHttp: boolean,
      ): Promise<{ servers: Array<{ name: string; command?: string; args?: string[]; env?: Array<{ name: string; value: string }> }> }>;
    };
  };
}

suite("Patchbay's own servers (issue #94)", () => {
  test("the editor server answers MCP when spawned with only its entry's env", async function () {
    this.timeout(20000);
    const { orchestrator } = await internals<Internal>();
    const { servers } = await orchestrator.mcpServers.mcpServersFor("own-scripts", "ctx-own", false);
    const editor = servers.find((s) => s.name === "patchbay");
    assert.ok(editor?.command !== undefined);

    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    for (const { name, value } of editor.env ?? []) env[name] = value;
    const child = spawn(editor.command, editor.args ?? [], { env, stdio: ["pipe", "pipe", "ignore"] });
    try {
      const answer = await new Promise<{ result?: { serverInfo?: { name?: string } } }>((resolve, reject) => {
        let buffer = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline !== -1) resolve(JSON.parse(buffer.slice(0, newline)) as { result?: { serverInfo?: { name?: string } } });
        });
        child.on("error", reject);
        child.on("exit", (code) => reject(new Error(`exited (${code}) without answering — launched as the editor?`)));
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "own-scripts", version: "0" } },
          })}\n`,
        );
      });
      assert.ok(answer.result?.serverInfo, "no MCP initialize result");
    } finally {
      child.kill();
    }
  });
});
