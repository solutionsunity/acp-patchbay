// Minimal activation suite (@vscode/test-electron): the automated proxy for the
// P0 gate — dev host launches, Agent View resolves, settings command runs.
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("activation", () => {
  test("extension activates", async () => {
    const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay");
    assert.ok(ext, "extension not found by id");
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test("agent view is registered and focusable", async () => {
    // The <viewId>.focus command only exists for registered views; focusing
    // resolves the webview, so this exercises the empty Agent View render.
    await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
  });

  test("settings command opens", async () => {
    await vscode.commands.executeCommand("acpPatchbay.openSettings");
  });
});
