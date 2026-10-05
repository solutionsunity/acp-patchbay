// A session waiting on the user must say so wherever the user is looking
// (issue #38): a question from a session no visible surface shows raises
// the native notification — with the Agent View hidden, and with it open on
// a different session.
import * as assert from "node:assert";
import * as vscode from "vscode";
import { fakeAgentConfig } from "./fake-agent-config";
import { fakeAgentPath, Patchbay } from "./patchbay";
import { waitFor } from "./wait-for";

const AGENT_ID = "waiting-notice";

suite("waiting-on-user notice", () => {
  test("a question from an off-screen session notifies — view hidden, and view on another session", async function () {
    this.timeout(40000);
    const pb = await Patchbay.open();
    const window = vscode.window as { showWarningMessage: (...args: unknown[]) => Thenable<unknown> };
    const original = window.showWarningMessage;
    const shown: unknown[][] = [];
    window.showWarningMessage = (...args: unknown[]) => {
      shown.push(args);
      return Promise.resolve(undefined); // the user ignores it
    };

    // Answers the session's open question the way its card would, and lets
    // the turn finish.
    const answer = async (sessionId: string, turn: Promise<void>) => {
      const card = await pb.openCard(sessionId, "elicitation");
      pb.act({ kind: "resolveElicitation", requestId: card.id, answer: { action: "cancel" } });
      await turn;
    };
    const noticeFor = (question: string) => shown.find((args) => String(args[0]).includes(question));

    try {
      await pb.addAgent(
        fakeAgentConfig(AGENT_ID, "Waiting Fake", fakeAgentPath(), { turn: [{ type: "elicit", message: "Which branch?" }] }),
      );
      await pb.connect(AGENT_ID);

      // 1. The Agent View is hidden.
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await waitFor(() => (pb.view.screen.pointer ? undefined : true));
      const first = await pb.newSession(AGENT_ID);
      const firstTurn = pb.prompt(first, "go");
      const hiddenNotice = await waitFor(() => noticeFor("Which branch?"));
      assert.ok(hiddenNotice.includes("Open"), "a question's notice offers Open");
      await answer(first, firstTurn);

      // 2. The Agent View is open, on a different session.
      shown.length = 0;
      const asking = await pb.newSession(AGENT_ID);
      pb.switchTo(first);
      await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
      await waitFor(() => (pb.view.screen.pointer && pb.view.activeSessionId === first ? true : undefined));
      const askingTurn = pb.prompt(asking, "go");
      await waitFor(() => noticeFor("Which branch?"));
      await answer(asking, askingTurn);

      // 3. The session on screen asks: its card is in front of the user —
      // no notice. The card being in state means the notice was judged.
      shown.length = 0;
      await answer(first, pb.prompt(first, "go"));
      assert.strictEqual(noticeFor("Which branch?"), undefined);
    } finally {
      window.showWarningMessage = original;
      await pb.remove(AGENT_ID);
    }
  });

  test("an ask left open when its agent stops settles — no card waits on a dead process", async function () {
    this.timeout(30000);
    const pb = await Patchbay.open();
    try {
      await pb.addAgent(
        fakeAgentConfig(AGENT_ID, "Waiting Fake", fakeAgentPath(), {
          turn: [{ type: "askPermission", title: "Run tests", kind: "execute", subject: "npm test" }],
        }),
      );
      await pb.connect(AGENT_ID);
      const sessionId = await pb.newSession(AGENT_ID);
      void pb.prompt(sessionId, "go").catch(() => {});
      const card = await pb.openCard(sessionId, "permission");

      await pb.stop(AGENT_ID);
      await waitFor(() =>
        pb.view.transcripts[sessionId]?.find((b) => b.id === card.id)?.resolution != null ? true : undefined,
      );
    } finally {
      await pb.remove(AGENT_ID);
    }
  });
});
