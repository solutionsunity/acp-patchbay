// P7 gate (vscode-dependent half): EditorStateHost's translation of real
// vscode API state into IPC-shaped data. The wire protocol, tool routing,
// and IPC bridge are already proven against a stand-in host in
// test/mcp-wire.test.ts and test/mcp-end-to-end.test.ts (vitest, no vscode
// available there) — this covers exactly the remaining untested surface:
// real vscode.window/workspace/languages data.
import { focusNote } from "./focus-note";
import { WINDOW_SETTLE, waitFor } from "../support/wait-for";
import * as assert from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { fakeAgentConfig } from "./fake-agent-config";
import { fakeAgentPath, internals, Patchbay } from "./patchbay";
import { tempDir } from "./temp-dir";

interface SelectionInfo {
  file: string;
  selections: { startLine: number; endLine: number; text: string }[];
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

/** The editor-state host is this suite's subject: it is the one thing the
 * suite reaches behind the views. */
interface Internal {
  host: {
    editorStateHost: {
      getSelection(): SelectionInfo | null;
      getCurrentFile(): CurrentFileInfo | null;
      getDiagnostics(): DiagnosticInfo[];
    };
  };
}

suite("EditorStateHost — real vscode data", () => {
  test("getCurrentFile and getSelection reflect the actual open editor", async function () {
    this.timeout(20000);
    const { host } = await internals<Internal>();

    const doc = await vscode.workspace.openTextDocument({
      content: "line one\nline two\nline three\n",
      language: "plaintext",
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 8));

    const file = host.editorStateHost.getCurrentFile();
    assert.ok(file);
    assert.strictEqual(file.content, "line one\nline two\nline three\n");
    assert.strictEqual(file.file, doc.uri.fsPath);

    const selection = host.editorStateHost.getSelection();
    assert.ok(selection);
    assert.strictEqual(selection.file, doc.uri.fsPath);
    assert.deepStrictEqual(selection.selections, [{ startLine: 2, endLine: 2, text: "line two" }]); // lines from 1
  });

  test("getSelection reports every selection holding text, down the file, whichever was made first", async function () {
    this.timeout(20000);
    const { host } = await internals<Internal>();
    const doc = await vscode.workspace.openTextDocument({ content: "one\ntwo\nthree\nfour\n", language: "plaintext" });
    const editor = await vscode.window.showTextDocument(doc);
    const at = (line: number, from: number, to: number) => new vscode.Selection(new vscode.Position(line, from), new vscode.Position(line, to));
    // the first made is a bare cursor; the others hold text, the lower one made before the upper
    editor.selections = [at(1, 0, 0), at(3, 0, 4), at(0, 0, 3), new vscode.Selection(new vscode.Position(2, 2), new vscode.Position(1, 1))];

    assert.deepStrictEqual(host.editorStateHost.getSelection()?.selections, [
      { startLine: 1, endLine: 1, text: "one" },
      { startLine: 2, endLine: 3, text: "wo\nth" },
      { startLine: 4, endLine: 4, text: "four" },
    ]);
  });

  test("a webview taking the editor area keeps the last text editor current; closing its tab ends that (issue #7)", async function () {
    this.timeout(20000);
    const { host } = await internals<Internal>();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    const doc = await vscode.workspace.openTextDocument({
      content: "alpha\nbeta\n",
      language: "plaintext",
    });
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 4));

    // A webview panel beside it — the shape of a detached Patchbay session
    // panel, or Settings — becomes the active editor: VS Code's own
    // activeTextEditor reads undefined from here on.
    const panel = vscode.window.createWebviewPanel("patchbayTest", "panel", vscode.ViewColumn.Beside);
    try {
      // VS Code hands the active editor to the panel only in a focused
      // window; unfocused, the text editor stays active and the scenario
      // can't be set up — fail naming that, never hang.
      await waitFor(() => vscode.window.activeTextEditor === undefined, WINDOW_SETTLE).catch(() =>
        assert.fail(`the panel never became the active editor${focusNote()}`),
      );

      const file = host.editorStateHost.getCurrentFile();
      assert.ok(file, "the file the user was just in stays current");
      assert.strictEqual(file.file, doc.uri.fsPath);
      assert.strictEqual(file.content, "alpha\nbeta\n");
      // Its tab is still on screen in column one, so its selection counts too.
      const selection = host.editorStateHost.getSelection();
      assert.ok(selection);
      assert.deepStrictEqual(selection.selections.map((s) => s.text), ["beta"]);

      // Close the text editor's tab: no current file, no selection.
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      await new Promise<void>((resolve) => {
        if (doc.isClosed) return resolve();
        const sub = vscode.workspace.onDidCloseTextDocument((d) => {
          if (d === doc) {
            sub.dispose();
            resolve();
          }
        });
      });
      assert.strictEqual(host.editorStateHost.getCurrentFile(), null);
      assert.strictEqual(host.editorStateHost.getSelection(), null);
    } finally {
      panel.dispose();
    }
  });

  test("getSelection is null when there is no selection", async function () {
    this.timeout(20000);
    const { host } = await internals<Internal>();
    const doc = await vscode.workspace.openTextDocument({ content: "abc", language: "plaintext" });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

    assert.strictEqual(host.editorStateHost.getSelection(), null);
  });

  test("Add Selection adds every selection as its own attachment, down the file, and the composer is told of each", async function () {
    this.timeout(60000);
    const pb = await Patchbay.open();
    try {
      const agent = await pb.addAgent(fakeAgentConfig("selections", "Selections Fake", fakeAgentPath(), { turn: [{ type: "chunk", text: "ok" }] }));
      await pb.connect(agent);
      const session = await pb.newSession(agent);
      const doc = await vscode.workspace.openTextDocument({ content: "one\ntwo\nthree\nfour\n", language: "plaintext" });
      const editor = await vscode.window.showTextDocument(doc);
      const line = (n: number, to: number) => new vscode.Selection(new vscode.Position(n, 0), new vscode.Position(n, to));
      editor.selections = [line(3, 4), line(0, 3), new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(2, 5))];

      // the composer's live selection names each, top down
      await waitFor(() => pb.view.liveSelection?.ranges.length === 3, WINDOW_SETTLE, "the composer told of three selections");
      assert.deepStrictEqual(pb.view.liveSelection?.ranges, [
        { startLine: 1, endLine: 1 },
        { startLine: 2, endLine: 3 },
        { startLine: 4, endLine: 4 },
      ]);

      pb.act({ kind: "addSelectionContext", patchbaySessionId: session });
      await waitFor(() => (pb.view.contextChips[session] ?? []).length === 3, WINDOW_SETTLE, "three attachments staged");
      const chips = pb.view.contextChips[session] ?? [];
      assert.deepStrictEqual(chips.map((c) => (c.kind === "selection" ? c.content : c.kind)), ["one", "two\nthree", "four"]);
      assert.deepStrictEqual(chips.map((c) => (c.kind === "selection" ? c.sourceUri?.split("#")[1] : "")), ["L1-1", "L2-3", "L4-4"]);
    } finally {
      await pb.removeAdded();
    }
  });

  test("Add to Patchbay Context links what is in hand — the Explorer's selection, a tab's file — and nothing that is not on disk", async function () {
    this.timeout(60000);
    const pb = await Patchbay.open();
    const dir = await tempDir("patchbay-add-");
    try {
      const agent = await pb.addAgent(fakeAgentConfig("inhand", "In Hand Fake", fakeAgentPath(), { turn: [{ type: "chunk", text: "ok" }] }));
      await pb.connect(agent);
      const session = await pb.newSession(agent);
      const staged = () => (pb.view.contextChips[session] ?? []).map((c) => (c.kind === "attachment" ? c.path : c.kind));
      const a = join(dir, "a.txt");
      const b = join(dir, "b.txt");
      const sub = join(dir, "sub");
      writeFileSync(a, "a");
      writeFileSync(b, "b");
      mkdirSync(sub);

      // the Explorer hands the row clicked and every row selected with it
      await vscode.commands.executeCommand("acpPatchbay.addToContext", vscode.Uri.file(b), [vscode.Uri.file(a), vscode.Uri.file(b), vscode.Uri.file(sub)]);
      await waitFor(() => staged().length === 3, WINDOW_SETTLE, "the three selected rows staged");
      assert.deepStrictEqual(staged(), [a, b, sub], "each where it is, a folder as a folder, in the order selected");

      // an editor tab hands its one file
      await vscode.commands.executeCommand("acpPatchbay.addToContext", vscode.Uri.file(a));
      await waitFor(() => staged().length === 4, WINDOW_SETTLE, "the tab's file staged");
      assert.strictEqual(staged()[3], a);

      // what has no place on disk is not added
      await vscode.commands.executeCommand("acpPatchbay.addToContext", vscode.Uri.parse("untitled:Untitled-1"));
      assert.strictEqual(staged().length, 4);
    } finally {
      await pb.removeAdded();
    }
  });
});
