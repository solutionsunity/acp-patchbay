// The Agent View's list layout: the sessions list in place, each chat an
// editor tab. Whatever puts a session in front opens its tab, and the tab
// the user goes to is the session in front — in the chat layout neither
// holds, and a session's tab stays apart from the view.
import * as assert from "node:assert";
import * as vscode from "vscode";
import { fakeAgentConfig } from "./fake-agent-config";
import { fakeAgentPath, Patchbay } from "./patchbay";
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
});
