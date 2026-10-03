// The write scope through the real extension (issue #56): the broker asks the
// session manager which roots the session was given, and judges each write by
// where it lands. A root added to the session auto-accepts; a `..` that climbs
// out of it asks; the process cwd standing in for an absent folder is never a
// root — this suite runs with no folder open, so that state is live here.
import { waitFor } from "./wait-for";
import { fakeAgentConfig, type AgentsDoor } from "./fake-agent-config";
import * as assert from "node:assert";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

interface Internal {
  orchestrator: {
    agentView: {
      current: {
        activeSessionId: string | null;
        transcripts: Record<string, Array<{ id: string; kind: string; resolution?: unknown }>>;
      };
    };
    broker: {
      resolve(requestId: string, optionId: string): void;
      evaluateFileWrites(sessionId: string, paths: readonly string[]): Promise<string>;
    };
    agents: AgentsDoor;
    sessionManager: {
      createSession(agentId: string, agentName: string, cwd: string): Promise<string>;
      addRoot(sessionId: string, path: string): Promise<void>;
      sendPrompt(sessionId: string, text: string): Promise<void>;
    };
  };
}

suite("write scope (issue #56)", () => {
  test("a root added to the session auto-accepts; a `..` out of it asks; the fallback cwd is not a root", async function () {
    this.timeout(20000);
    const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay")!;
    const { orchestrator } = ((await ext.activate()) as { internal: Internal }).internal;
    const fakeAgentPath = join(ext.extensionUri.fsPath, "out-test", "fake-agent.mjs");
    const dir = await mkdtemp(join(tmpdir(), "patchbay-write-scope-"));
    const root = join(dir, "root");
    await mkdir(root);
    const inside = join(root, "inside.txt");
    const escaped = join(dir, "escaped.txt");
    try {
      await orchestrator.agents.save(
        fakeAgentConfig("write-scope-e2e", "Write Scope Fake", fakeAgentPath, {
          declare: { promptCapabilities: {} },
          turn: [
            { type: "writeFile", path: inside, content: "in\n" },
            { type: "writeFile", path: `${root}/../escaped.txt`, content: "out\n" },
          ],
        }),
      );
      await orchestrator.agents.connect("write-scope-e2e");
      const born = await orchestrator.sessionManager.createSession("write-scope-e2e", "Write Scope Fake", root);
      await orchestrator.sessionManager.addRoot(born, root);
      // a never-prompted session is re-minted to carry its new root
      const sessionId = orchestrator.agentView.current.activeSessionId!;

      assert.strictEqual(
        await orchestrator.broker.evaluateFileWrites(sessionId, [join(process.cwd(), "x.txt")]),
        "ask",
        "no folder open: the process cwd was never handed to the agent",
      );

      const turnDone = orchestrator.sessionManager.sendPrompt(sessionId, "go");
      const diffs = () => orchestrator.agentView.current.transcripts[sessionId]?.filter((b) => b.kind === "diff") ?? [];
      const asking = await waitFor(() => diffs()[1]);
      assert.deepStrictEqual(diffs()[0]!.resolution, { accepted: true, auto: true }, "inside the root: no card to click");
      assert.strictEqual(asking.resolution, null, "the `..` escape waits on the user");
      orchestrator.broker.resolve(asking.id, "reject");
      await turnDone;

      assert.strictEqual(await readFile(inside, "utf8"), "in\n");
      await assert.rejects(readFile(escaped, "utf8"), "the rejected write never landed");
    } finally {
      await orchestrator.agents.remove("write-scope-e2e");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
