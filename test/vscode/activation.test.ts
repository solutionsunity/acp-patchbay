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

  test("command palette items are registered (P11 — features.md § 3)", async () => {
    // Registration only, not execution: every one of these can show a real
    // QuickPick (new/switch session do too, once another suite in this same
    // shared extension host has connected an agent) — actually driving that
    // interactive picker is manual-smoke territory, not a headless assertion.
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("acpPatchbay.newSession"));
    assert.ok(commands.includes("acpPatchbay.switchSession"));
    assert.ok(commands.includes("acpPatchbay.connectAgent"));
    assert.ok(commands.includes("acpPatchbay.addSelectionToContext"));
  });
});
