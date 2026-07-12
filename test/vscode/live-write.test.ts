// W1 (acp-compliance §12): fs/write_text_file routed through WorkspaceEdit
// when an editor holds the file — the agent's write lands in the open buffer
// (undoable, visible) and saves, so buffer and disk agree immediately. Before
// this, the write went to disk underneath a dirty buffer and silently lost to
// the user's next save. The no-editor disk path stays covered by
// verification.test.ts.
import { waitFor } from "./wait-for";
import * as assert from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

interface Internal {
  orchestrator: {
    agentView: {
      current: { transcripts: Record<string, Array<{ id: string; kind: string }>> };
    };
    broker: { resolve(requestId: string, optionId: string): void };
    connectAgent(spec: {
      agentId: string;
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
    }): Promise<void>;
    sessionManager: {
      createSession(agentId: string, agentName: string, cwd: string): Promise<string>;
      sendPrompt(sessionId: string, text: string): Promise<void>;
    };
    pool: { stop(agentId: string): Promise<void> };
  };
}

async function internal(): Promise<Internal> {
  const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay");
  assert.ok(ext);
  const api = (await ext.activate()) as { internal: Internal };
  return api.internal;
}

suite("live-buffer write (W1)", () => {
  test("agent write to an open dirty editor lands in the buffer and saves — no divergence window", async function () {
    this.timeout(20000);
    const { orchestrator } = await internal();
    const extension = vscode.extensions.getExtension("solutionsunity.acp-patchbay")!;
    const fakeAgentPath = join(extension.extensionUri.fsPath, "out-test", "fake-agent.mjs");
    const cwd = await mkdtemp(join(tmpdir(), "patchbay-live-write-"));
    const target = join(cwd, "shared.txt");
    await writeFile(target, "on disk\n", "utf8");

    // Open the file and dirty it the way a user would — this is the stale
    // buffer the old disk-write path would have silently diverged from.
    const doc = await vscode.workspace.openTextDocument(target);
    const userEdit = new vscode.WorkspaceEdit();
    userEdit.insert(doc.uri, new vscode.Position(0, 0), "user unsaved ");
    assert.ok(await vscode.workspace.applyEdit(userEdit));
    assert.strictEqual(doc.isDirty, true);

    try {
      await orchestrator.connectAgent({
        agentId: "live-write-e2e",
        name: "Live Write Fake",
        command: process.execPath,
        args: [fakeAgentPath],
        env: {
          FAKE_AGENT_SCRIPT: JSON.stringify({
            declare: { promptCapabilities: {} },
            turn: [{ type: "writeFile", path: target, content: "from agent\n" }],
          }),
        },
        cwd,
      });
      const sessionId = await orchestrator.sessionManager.createSession(
        "live-write-e2e",
        "Live Write Fake",
        cwd,
      );
      const turnDone = orchestrator.sessionManager.sendPrompt(sessionId, "go");
      const diffBlock = await waitFor(() =>
        orchestrator.agentView.current.transcripts[sessionId]?.find((b) => b.kind === "diff"),
      );
      orchestrator.broker.resolve(diffBlock.id, "accept");
      await turnDone;

      // buffer, dirty flag, and disk all tell the same story
      assert.strictEqual(doc.getText(), "from agent\n", "open buffer got the write");
      assert.strictEqual(doc.isDirty, false, "buffer saved — user's next save can't clobber");
      assert.strictEqual(await readFile(target, "utf8"), "from agent\n", "disk matches the buffer");
    } finally {
      await orchestrator.pool.stop("live-write-e2e");
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
