// W1 (acp-compliance §12): fs/write_text_file routed through WorkspaceEdit
// when an editor holds the file — the agent's write lands in the open buffer
// (undoable, visible) and saves, so buffer and disk agree immediately. Before
// this, the write went to disk underneath a dirty buffer and silently lost to
// the user's next save. The no-editor disk path stays covered by
// verification.test.ts.
import * as assert from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { fakeAgentConfig } from "./fake-agent-config";
import { fakeAgentPath, Patchbay } from "./patchbay";

suite("live-buffer write (W1)", () => {
  test("agent write to an open dirty editor lands in the buffer and saves — no divergence window", async function () {
    this.timeout(30000);
    const pb = await Patchbay.open();
    const dir = await mkdtemp(join(tmpdir(), "patchbay-live-write-"));
    const target = join(dir, "shared.txt");
    await writeFile(target, "on disk\n", "utf8");

    // Open the file and dirty it the way a user would — this is the stale
    // buffer the old disk-write path would have silently diverged from.
    const doc = await vscode.workspace.openTextDocument(target);
    const userEdit = new vscode.WorkspaceEdit();
    userEdit.insert(doc.uri, new vscode.Position(0, 0), "user unsaved ");
    assert.ok(await vscode.workspace.applyEdit(userEdit));
    assert.strictEqual(doc.isDirty, true);

    try {
      const patchbayAgentId = await pb.addAgent(
        fakeAgentConfig("live-write-e2e", "Live Write Fake", fakeAgentPath(), {
          declare: { promptCapabilities: {} },
          turn: [{ type: "writeFile", path: target, content: "from agent\n" }],
        }),
      );
      await pb.connect(patchbayAgentId);
      const sessionId = await pb.newSession(patchbayAgentId);
      const turnDone = pb.prompt(sessionId, "go");
      const diff = await pb.openCard(sessionId, "diff");
      await pb.answerDiff(sessionId, diff, true);
      await turnDone;

      // buffer, dirty flag, and disk all tell the same story
      assert.strictEqual(doc.getText(), "from agent\n", "open buffer got the write");
      assert.strictEqual(doc.isDirty, false, "buffer saved — user's next save can't clobber");
      assert.strictEqual(await readFile(target, "utf8"), "from agent\n", "disk matches the buffer");
    } finally {
      await pb.removeAdded();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a read of a missing file reaches the agent as -32002 for that path", async function () {
    // VS Code's own FileSystemError, not Node's ENOENT — the vocabulary only
    // the real extension host produces.
    this.timeout(30000);
    const pb = await Patchbay.open();
    const dir = await mkdtemp(join(tmpdir(), "patchbay-live-read-"));
    const missing = join(dir, "missing.txt");
    try {
      const patchbayAgentId = await pb.addAgent(
        fakeAgentConfig("live-read-e2e", "Live Read Fake", fakeAgentPath(), {
          declare: { promptCapabilities: {} },
          turn: [{ type: "readFile", path: missing }],
        }),
      );
      await pb.connect(patchbayAgentId);
      const sessionId = await pb.newSession(patchbayAgentId);
      await pb.prompt(sessionId, "go");
      assert.strictEqual(pb.text(sessionId), `read: failed (-32002 Resource not found: ${missing})`);
    } finally {
      await pb.removeAdded();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
