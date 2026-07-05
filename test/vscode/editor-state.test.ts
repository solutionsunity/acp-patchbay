// P7 gate (vscode-dependent half): EditorStateHost's translation of real
// vscode API state into IPC-shaped data. The wire protocol, tool routing,
// and IPC bridge are already proven against a stand-in host in
// test/mcp-wire.test.ts and test/mcp-end-to-end.test.ts (vitest, no vscode
// available there) — this covers exactly the remaining untested surface:
// real vscode.window/workspace/languages data.
import * as assert from "node:assert";
import * as vscode from "vscode";

interface SelectionInfo {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}
interface CurrentFileInfo {
  file: string;
  content: string;
}
interface DiagnosticInfo {
  file: string;
  line: number;
  severity: string;
  message: string;
}

interface Internal {
  orchestrator: {
    editorStateHost: {
      getSelection(): SelectionInfo | null;
      getCurrentFile(): CurrentFileInfo | null;
      getDiagnostics(): DiagnosticInfo[];
    };
  };
}

async function internal(): Promise<Internal> {
  const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay");
  assert.ok(ext);
  const api = (await ext.activate()) as { internal: Internal };
  return api.internal;
}

suite("EditorStateHost — real vscode data", () => {
  test("getCurrentFile and getSelection reflect the actual open editor", async function () {
    this.timeout(20000);
    const { orchestrator } = await internal();

    const doc = await vscode.workspace.openTextDocument({
      content: "line one\nline two\nline three\n",
      language: "plaintext",
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 8));

    const file = orchestrator.editorStateHost.getCurrentFile();
    assert.ok(file);
    assert.strictEqual(file.content, "line one\nline two\nline three\n");
    assert.strictEqual(file.file, doc.uri.fsPath);

    const selection = orchestrator.editorStateHost.getSelection();
    assert.ok(selection);
    assert.strictEqual(selection.text, "line two");
    assert.strictEqual(selection.startLine, 2); // 1-based
    assert.strictEqual(selection.endLine, 2);
  });

  test("getSelection is null when there is no selection", async function () {
    this.timeout(20000);
    const { orchestrator } = await internal();
    const doc = await vscode.workspace.openTextDocument({ content: "abc", language: "plaintext" });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

    assert.strictEqual(orchestrator.editorStateHost.getSelection(), null);
  });
});
