// The Agent View's list layout: the sessions list in place, each chat an
// editor tab. Whatever puts a session in front opens its tab, and the tab
// the user goes to is the session in front — in the chat layout neither
// holds, and a session's tab stays apart from the view.
import * as assert from "node:assert";
import * as vscode from "vscode";
import type { Orchestrator } from "../../src/orchestrator/orchestrator";
import type { AgentPanelHost } from "../../src/orchestrator/webview-host";
import { fakeAgentConfig } from "./fake-agent-config";
import { fakeAgentPath, internals, Patchbay } from "./patchbay";
import { WINDOW_SETTLE, waitFor } from "../support/wait-for";

/** The session tabs open in the window, by their titles, in tab order. */
const sessionTabs = (): vscode.Tab[] =>
  vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes("acpPatchbay.agentPanel"));
const titles = (): string[] => sessionTabs().map((t) => t.label);
const activeTitle = (): string | undefined => vscode.window.tabGroups.activeTabGroup.activeTab?.label;

suite("sessions layout: the list, each chat in a tab", () => {
  test("in the list layout a session in front has its tab, and the tab in focus is the session in front", async function () {
    this.timeout(60000);
    const pb = await Patchbay.open();
    try {
      const agent = await pb.addAgent(fakeAgentConfig("layout", "Layout Fake", fakeAgentPath(), { turn: [{ type: "chunk", text: "ok" }] }));
      await pb.connect(agent);
      const alpha = await pb.newSession(agent);
      await pb.prompt(alpha, "alpha"); // titled by its first prompt, and no longer the agent's blank session
      const beta = await pb.newSession(agent);
      await pb.prompt(beta, "beta");
      assert.deepStrictEqual(titles(), [], "the chat layout opens no tab on its own");

      // to the list: the session in front opens as a tab, its chat still on screen
      pb.act({ kind: "setPreferences", patch: { sessionsLayout: "list" } });
      await waitFor(() => titles().includes("beta"), WINDOW_SETTLE, "the session in front opened as a tab");
      assert.deepStrictEqual(titles(), ["beta"]);

      // a pick in the list puts a session in front: its tab opens, and takes the focus
      pb.switchTo(alpha);
      await waitFor(() => activeTitle() === "alpha", WINDOW_SETTLE, "the picked session's tab in front");
      assert.deepStrictEqual(titles().sort(), ["alpha", "beta"]);

      // going to another session's tab makes it the session in front
      await vscode.commands.executeCommand("workbench.action.previousEditor");
      await waitFor(() => activeTitle() === "beta" && pb.view.activePatchbaySessionId === beta, WINDOW_SETTLE, "the focused tab's session in front");

      // back to the chat: the tabs stay, and the view goes its own way again
      pb.act({ kind: "setPreferences", patch: { sessionsLayout: "chat" } });
      await waitFor(() => pb.view.preferences.sessionsLayout === "chat", WINDOW_SETTLE);
      pb.switchTo(alpha);
      await waitFor(() => pb.view.activePatchbaySessionId === alpha, WINDOW_SETTLE);
      assert.strictEqual(activeTitle(), "beta", "the chat layout leaves the tabs alone");
      assert.deepStrictEqual(titles().sort(), ["alpha", "beta"]);
    } finally {
      pb.act({ kind: "setPreferences", patch: { sessionsLayout: "chat" } });
      await vscode.window.tabGroups.close(sessionTabs());
      await pb.removeAdded();
    }
  });

  test("a session's tab the editor kept across a restart returns to its session, and one whose session is gone closes", async function () {
    this.timeout(60000);
    const pb = await Patchbay.open();
    const { orchestrator, agentPanelHost } = await internals<{ orchestrator: Orchestrator; agentPanelHost: AgentPanelHost }>();
    // a panel as the editor hands one back: of the agent panel's type, with nothing in it yet
    const kept = (title: string) =>
      vscode.window.createWebviewPanel("acpPatchbay.agentPanel", title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    try {
      const agent = await pb.addAgent(fakeAgentConfig("kept", "Kept Fake", fakeAgentPath(), { turn: [{ type: "chunk", text: "ok" }] }));
      await pb.connect(agent);
      const gamma = await pb.newSession(agent);
      await pb.prompt(gamma, "gamma");
      const name = orchestrator.sessions.pairOf(gamma);
      assert.ok(name !== undefined);

      const back = kept("an older title");
      await agentPanelHost.deserializeWebviewPanel(back, { session: name });
      assert.deepStrictEqual(agentPanelHost.pinnedPatchbaySessionIds(), [gamma], "the returned tab is its session's panel");
      assert.strictEqual(back.title, "gamma", "titled as the session is now");
      // the one panel of the session: asking for its tab brings this one forward
      await vscode.commands.executeCommand("acpPatchbay.detachSession", gamma, "tab");

      let closed = 0;
      for (const memo of [{ session: { patchbayAgentId: agent, sessionId: "no-such-session" } }, undefined, { session: 7 }]) {
        const stray = kept("stray");
        stray.onDidDispose(() => closed++);
        await agentPanelHost.deserializeWebviewPanel(stray, memo);
      }
      await waitFor(() => closed === 3, WINDOW_SETTLE, "a tab with no session here, or nothing readable, closed");
      // a tab's label follows its panel's title a moment later
      await waitFor(() => titles().join() === "gamma", WINDOW_SETTLE, "only the session's own tab is left, under its title");
    } finally {
      await vscode.window.tabGroups.close(sessionTabs());
      await pb.removeAdded();
    }
  });
});
