// Issue #41: a tool call's location opens in the real editor at the line the
// agent named — cursor on that line's first non-blank character — clamped
// into the file, and a directory location never opens as a folder.
import * as assert from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { Patchbay } from "./patchbay";
import { focusNote } from "./focus-note";
import { WINDOW_SETTLE, waitFor } from "../support/wait-for";
import { tempDir } from "./temp-dir";

/** Waits for the active editor to show `path` with the cursor at
 * [line, character]. `vscode.open` makes the editor active before it
 * applies the selection, so the first sight of the file can still carry
 * the cursor at the top — the wait is for the position asserted, and a
 * timeout names the last one seen. A file that never becomes the active
 * editor is the window lacking focus (VS Code moves the active editor only
 * in a focused window), and the failure says so. */
async function assertCursor(path: string, line: number, character: number): Promise<void> {
  let seen: [number, number] | null = null;
  await waitFor(() => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.fsPath !== path) return false;
    seen = [editor.selection.active.line, editor.selection.active.character];
    return seen[0] === line && seen[1] === character;
  }, WINDOW_SETTLE).catch(() => {
    if (seen === null) {
      assert.fail(`${path} never became the active editor${focusNote()}`);
    }
    assert.deepStrictEqual(seen, [line, character], `cursor in ${path}`);
  });
}

suite("open a tool-call location (issue #41)", () => {
  let dir: string;
  setup(async () => {
    dir = await tempDir("patchbay-open-location-");
  });
  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("a line lands the cursor on that line's first non-blank character", async () => {
    const pb = await Patchbay.open();
    const file = join(dir, "a.ts");
    await writeFile(file, ["one", "two", "three", "four", "    five();", "six"].join("\n"), "utf8");
    pb.act({ kind: "openFile", path: file, line: 5 });
    await assertCursor(file, 4, 4);
  });

  test("a line past the end opens at the last line", async () => {
    const pb = await Patchbay.open();
    const file = join(dir, "b.ts");
    await writeFile(file, "one\ntwo\nthree", "utf8");
    pb.act({ kind: "openFile", path: file, line: 500 });
    await assertCursor(file, 2, 0);
  });

  test("no line opens the file at the top", async () => {
    const pb = await Patchbay.open();
    const file = join(dir, "c.ts");
    await writeFile(file, "one\ntwo", "utf8");
    pb.act({ kind: "openFile", path: file });
    await assertCursor(file, 0, 0);
  });

  test("a binary file with a line still opens — in its own editor, the line moot", async () => {
    // Agents report reads of images with line 1; the line has no text to land in.
    const pb = await Patchbay.open();
    const png = join(dir, "dot.png");
    await writeFile(
      png,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        "base64",
      ),
    );
    pb.act({ kind: "openFile", path: png, line: 1 });
    // The tab, found by the file its input holds — or by the active tab's
    // name where VS Code gives an extension no input for the editor (its
    // image editor, since 1.144).
    await waitFor(() => {
      const opened = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .some((t) => (t.input as { uri?: vscode.Uri } | undefined)?.uri?.fsPath === png);
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      return opened || (active !== undefined && active.input === undefined && active.label === "dot.png");
    }, WINDOW_SETTLE);
  });

  // #171: the folder is outside the test window's workspace (it has none),
  // so it goes to the system's file manager. The command is recorded, not
  // run — the test window's display may be the user's own desktop, where a
  // file manager opened by a test would be theirs to close. Pinned: the
  // file manager is asked, and the window neither opens the folder as a
  // folder nor as an editor.
  test("a directory outside the workspace goes to the file manager, never opened as a folder or an editor", async () => {
    const pb = await Patchbay.open();
    const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath);
    const sub = join(dir, "sub");
    await mkdir(sub);
    const commands = vscode.commands as { executeCommand: (command: string, ...rest: unknown[]) => Thenable<unknown> };
    const original = commands.executeCommand;
    const revealed: string[] = [];
    commands.executeCommand = (command: string, ...rest: unknown[]) => {
      if (command !== "revealFileInOS" && command !== "revealInExplorer") return original.call(vscode.commands, command, ...rest);
      revealed.push(`${command} ${(rest[0] as vscode.Uri).fsPath}`);
      return Promise.resolve(undefined);
    };
    try {
      pb.act({ kind: "openFile", path: sub });
      await waitFor(() => revealed.length > 0, WINDOW_SETTLE, "the folder handed to a reveal");
    } finally {
      commands.executeCommand = original;
    }
    assert.deepStrictEqual(revealed, [`revealFileInOS ${sub}`]);
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
