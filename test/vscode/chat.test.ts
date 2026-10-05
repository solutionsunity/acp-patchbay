// P4 gate: a full turn streams end-to-end against the fake agent through the
// real orchestrator and a real webview, and a webview kill/reopen mid-turn
// recovers to the accumulated chat state. (The Claude-Code-over-ACP half of
// this gate is a manual smoke test outside this harness — no live agent
// credentials are available in this sandboxed run.)
import * as assert from "node:assert";
import * as vscode from "vscode";
import { fakeAgentConfig } from "./fake-agent-config";
import { fakeAgentPath, Patchbay } from "./patchbay";
import { waitFor } from "./wait-for";

suite("chat vertical slice", () => {
  test("full turn streams end-to-end; webview kill/reopen mid-turn recovers", async function () {
    this.timeout(30000);
    const pb = await Patchbay.open();
    try {
      await pb.addAgent(
        fakeAgentConfig("chat-e2e", "Chat E2E Fake", fakeAgentPath(), {
          turn: [
            { type: "chunk", text: "part one " },
            { type: "chunk", text: "part two " },
            { type: "chunk", text: "part three" },
          ],
          stepDelayMs: 250,
        }),
      );
      await pb.connect("chat-e2e");
      const sessionId = await pb.newSession("chat-e2e");

      // mount the real webview and let it hydrate at the session-created snapshot
      await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
      await pb.agentView.waitForApplied(pb.agentView.revision);

      // send without waiting for the end — we want to interrupt mid-stream
      const turnDone = pb.prompt(sessionId, "go");

      // wait for the first chunk to land, then kill the webview mid-turn
      await waitFor(() => (pb.text(sessionId).length > 0 ? true : undefined));
      assert.ok(pb.busy(sessionId).includes("prompt"), "turn should still be underway");

      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await waitFor(() => (pb.view.screen.pointer ? undefined : true));

      // reopen mid-turn — the webview must resync to whatever canonical state
      // has accumulated by now (render cache lives in the orchestrator, not
      // the disposed webview)
      await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
      const revAtReopen = pb.agentView.revision;
      const acked = await pb.agentView.waitForApplied(revAtReopen);
      assert.ok(acked >= revAtReopen, `webview acked ${acked}, wanted ${revAtReopen}`);

      // let the turn finish, then verify the complete, correctly-ordered transcript
      await turnDone;
      assert.strictEqual(pb.text(sessionId), "part one part two part three");
      assert.deepStrictEqual(pb.busy(sessionId), []);

      // and the final state reached the webview too
      await pb.agentView.waitForApplied(pb.agentView.revision);
    } finally {
      await pb.remove("chat-e2e");
    }
  });
});
