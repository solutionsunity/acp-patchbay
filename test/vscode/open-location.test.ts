// Issue #41: a tool call's location opens in the real editor at the line the
// agent named — cursor on that line's first non-blank character — clamped
// into the file, and a directory location never opens as a folder.
import { waitFor } from "./wait-for";
import * as assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

interface Internal {
  orchestrator: { handleAction(action: { kind: "openFile"; path: string; line?: number }): void };
}

async function internal(): Promise<Internal> {
  const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay");
  assert.ok(ext);
  const api = (await ext.activate()) as { internal: Internal };
  return api.internal;
}

/** Waits for the active editor to show `path` with the cursor at
 * [line, character]. `vscode.open` makes the editor active before it
 * applies the selection, so the first sight of the file can still carry
 * the cursor at the top — the wait is for the position asserted, and a
 * timeout names the last one seen. */
async function assertCursor(path: string, line: number, character: number): Promise<void> {
  let seen: [number, number] | null = null;
  await waitFor(() => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.fsPath !== path) return undefined;
    seen = [editor.selection.active.line, editor.selection.active.character];
    return seen[0] === line && seen[1] === character ? true : undefined;
  }).catch(() => assert.deepStrictEqual(seen, [line, character], `cursor in ${path}`));
}

suite("open a tool-call location (issue #41)", () => {
  let dir: string;
  setup(async () => {
    dir = await mkdtemp(join(tmpdir(), "patchbay-open-location-"));
  });
  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await rm(dir, { recursive: true, force: true });
  });

  test("a line lands the cursor on that line's first non-blank character", async () => {
    const { orchestrator } = await internal();
    const file = join(dir, "a.ts");
    await writeFile(file, ["one", "two", "three", "four", "    five();", "six"].join("\n"), "utf8");
    orchestrator.handleAction({ kind: "openFile", path: file, line: 5 });
    await assertCursor(file, 4, 4);
  });

  test("a line past the end opens at the last line", async () => {
    const { orchestrator } = await internal();
    const file = join(dir, "b.ts");
    await writeFile(file, "one\ntwo\nthree", "utf8");
    orchestrator.handleAction({ kind: "openFile", path: file, line: 500 });
    await assertCursor(file, 2, 0);
  });

  test("no line opens the file at the top", async () => {
    const { orchestrator } = await internal();
    const file = join(dir, "c.ts");
    await writeFile(file, "one\ntwo", "utf8");
    orchestrator.handleAction({ kind: "openFile", path: file });
    await assertCursor(file, 0, 0);
  });

  test("a binary file with a line still opens — in its own editor, the line moot", async () => {
    // Agents report reads of images with line 1; the line has no text to land in.
    const { orchestrator } = await internal();
    const png = join(dir, "dot.png");
    await writeFile(
      png,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        "base64",
      ),
    );
    orchestrator.handleAction({ kind: "openFile", path: png, line: 1 });
    await waitFor(() =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .some((t) => (t.input as { uri?: vscode.Uri } | undefined)?.uri?.fsPath === png) || undefined,
    );
  });

  test("a directory is revealed, never opened as a folder or an editor", async () => {
    const { orchestrator } = await internal();
    const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath);
    const sub = join(dir, "sub");
    await mkdir(sub);
    orchestrator.handleAction({ kind: "openFile", path: sub });
    // The action is fire-and-forget; give its stat + reveal time to land. A
    // race here can only make this pass vacuously, never fail wrongly.
    await new Promise((r) => setTimeout(r, 500));
    assert.deepStrictEqual(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath), folders);
    assert.ok(
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).every((t) => {
        const input = t.input as { uri?: vscode.Uri } | undefined;
        return input?.uri?.fsPath !== sub;
      }),
      "no tab for the directory",
    );
  });
});
