// P1 gate: a dummy state round-trips through a real webview, kill/reopen
// included. Drives the settings panel (deterministic dispose) and the sidebar
// Agent View (hide/show remount).
import { waitFor } from "./wait-for";
import * as assert from "node:assert";
import * as vscode from "vscode";
import { internals } from "./patchbay";

/** The channels' sync with their webviews is this suite's subject: it is
 * the one thing the suite reaches behind the views. */
type Internal = {
  orchestrator: {
    agentView: {
      emit(...events: unknown[]): void;
      flushNow(): void;
      revision: number;
      attached: boolean;
      waitForApplied(rev?: number): Promise<number>;
      current: { screen: { pointer: boolean } };
    };

    settings: {
      emit(...events: unknown[]): void;
      flushNow(): void;
      revision: number;
      attached: boolean;
      waitForApplied(rev?: number): Promise<number>;
    };
  };
  settingsPanelHost: {
    currentPanel: { dispose(): void } | null;
    openOrReveal(): void;
  };
};

const upsert = (id: string, over: Record<string, unknown> = {}) => ({
  kind: "agentUpserted",
  agent: { id, name: id, status: "running", needsAuth: false, authMethods: [], busy: [], ...over },
});

suite("snapshot/patch round-trip through real webviews", () => {
  test("settings panel hydrates, patches, survives kill/reopen", async () => {
    const { orchestrator, settingsPanelHost } = await internals<Internal>();
    const ch = orchestrator.settings;

    await vscode.commands.executeCommand("acpPatchbay.openSettings");
    await ch.waitForApplied(ch.revision); // hydrated at current rev

    // live patch reaches the webview
    ch.emit(upsert("dummy-1"));
    ch.flushNow();
    await ch.waitForApplied(ch.revision);

    // kill — settled once the channel reports the webview detached
    settingsPanelHost.currentPanel!.dispose();
    await waitFor(() => (ch.attached ? undefined : true));

    // state advances while the webview is dead
    ch.emit(upsert("dummy-2"));
    ch.flushNow();
    const targetRev = ch.revision;

    // reopen → fresh mount → ready → snapshot at the advanced revision
    await vscode.commands.executeCommand("acpPatchbay.openSettings");
    const acked = await ch.waitForApplied(targetRev);
    assert.ok(acked >= targetRev, `webview acked ${acked}, wanted ${targetRev}`);
  });

  test("busy rows round-trip to the real settings webview", async () => {
    const { orchestrator } = await internals<Internal>();
    const ch = orchestrator.settings;

    await vscode.commands.executeCommand("acpPatchbay.openSettings");
    await ch.waitForApplied(ch.revision);

    // Needs-auth so the card's Log in control actually renders, then the
    // rows a real Log in and an Upgrade send while the queue holds them —
    // this exercises the real bundled AgentsSection JS, not just the pure
    // reducer, catching anything a plain reducer test can't (a render-time
    // throw in a busy control or the upgrade chip).
    ch.emit(upsert("dummy-busy", { needsAuth: true }));
    ch.flushNow();
    await ch.waitForApplied(ch.revision);

    ch.emit(upsert("dummy-busy", { needsAuth: true, busy: [{ kind: "login" }, { kind: "upgrade", to: "2.0.0" }] }));
    ch.flushNow();
    await ch.waitForApplied(ch.revision);

    ch.emit(upsert("dummy-busy", { needsAuth: true }));
    ch.flushNow();
    const acked = await ch.waitForApplied(ch.revision);
    assert.ok(acked >= ch.revision, `webview acked ${acked}, wanted ${ch.revision}`);
  });

  test("agent view hydrates on focus and re-hydrates after hide/show", async () => {
    const { orchestrator } = await internals<Internal>();
    const ch = orchestrator.agentView;

    await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
    await ch.waitForApplied(ch.revision);

    ch.emit(upsert("dummy-3"));
    ch.flushNow();
    await ch.waitForApplied(ch.revision);

    // hide the sidebar (kills non-retained webview content), advance state, re-show
    // closing the sidebar hides the view (it is not disposed) — settled once
    // the provider has reported not-visible and the hidden iframe is gone
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await waitFor(() => (orchestrator.agentView.current.screen.pointer ? undefined : true));
    ch.emit(upsert("dummy-4"));
    ch.flushNow();
    const targetRev = ch.revision;

    await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
    const acked = await ch.waitForApplied(targetRev);
    assert.ok(acked >= targetRev, `webview acked ${acked}, wanted ${targetRev}`);
  });
});
