// P1 gate: a dummy state round-trips through a real webview, kill/reopen
// included. Drives the settings panel (deterministic dispose) and the sidebar
// Agent View (hide/show remount).
import * as assert from "node:assert";
import * as vscode from "vscode";

type Internal = {
  orchestrator: {
    agentView: {
      emit(...events: unknown[]): void;
      flushNow(): void;
      revision: number;
      waitForApplied(rev?: number): Promise<number>;
    };
    settings: {
      emit(...events: unknown[]): void;
      flushNow(): void;
      revision: number;
      waitForApplied(rev?: number): Promise<number>;
    };
  };
  settingsPanelHost: {
    currentPanel: { dispose(): void } | null;
    openOrReveal(): void;
  };
};

async function internal(): Promise<Internal> {
  const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay");
  assert.ok(ext);
  const api = (await ext.activate()) as { internal: Internal };
  return api.internal;
}

const upsert = (id: string) => ({
  kind: "agentUpserted",
  agent: { id, name: id, status: "running" },
});

suite("snapshot/patch round-trip through real webviews", () => {
  test("settings panel hydrates, patches, survives kill/reopen", async () => {
    const { orchestrator, settingsPanelHost } = await internal();
    const ch = orchestrator.settings;

    await vscode.commands.executeCommand("acpPatchbay.openSettings");
    await ch.waitForApplied(ch.revision); // hydrated at current rev

    // live patch reaches the webview
    ch.emit(upsert("dummy-1"));
    ch.flushNow();
    await ch.waitForApplied(ch.revision);

    // kill
    settingsPanelHost.currentPanel!.dispose();
    await new Promise((r) => setTimeout(r, 200));

    // state advances while the webview is dead
    ch.emit(upsert("dummy-2"));
    ch.flushNow();
    const targetRev = ch.revision;

    // reopen → fresh mount → ready → snapshot at the advanced revision
    await vscode.commands.executeCommand("acpPatchbay.openSettings");
    const acked = await ch.waitForApplied(targetRev);
    assert.ok(acked >= targetRev, `webview acked ${acked}, wanted ${targetRev}`);
  });

  test("agent view hydrates on focus and re-hydrates after hide/show", async () => {
    const { orchestrator } = await internal();
    const ch = orchestrator.agentView;

    await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
    await ch.waitForApplied(ch.revision);

    ch.emit(upsert("dummy-3"));
    ch.flushNow();
    await ch.waitForApplied(ch.revision);

    // hide the sidebar (kills non-retained webview content), advance state, re-show
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await new Promise((r) => setTimeout(r, 200));
    ch.emit(upsert("dummy-4"));
    ch.flushNow();
    const targetRev = ch.revision;

    await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
    const acked = await ch.waitForApplied(targetRev);
    assert.ok(acked >= targetRev, `webview acked ${acked}, wanted ${targetRev}`);
  });
});
