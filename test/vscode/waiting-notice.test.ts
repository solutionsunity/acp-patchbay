// A session waiting on the user must say so wherever the user is looking
// (issue #38): a question from a session no visible surface shows raises
// the native notification — with the Agent View hidden, and with it open on
// a different session.
import { waitFor } from "./wait-for";
import * as assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

const AGENT_ID = "waiting-notice";

interface Internal {
  orchestrator: {
    handleAction(action: {
      kind: "resolveElicitation";
      requestId: string;
      answer: { action: "cancel" };
    }): void;
    agentView: {
      current: {
        screen: { pointer: boolean };
        transcripts: Record<string, Array<{ id: string; kind: string; resolution?: unknown }>>;
      };
    };
    connectAgent(spec: {
      agentId: string;
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
    }): Promise<void>;
    sessionManager: {
      createSession(agentId: string, agentName: string, cwd: string): Promise<string>;
      sendPrompt(sessionId: string, text: string): Promise<void>;
      open(sessionId: string): void;
    };
    pool: { stop(agentId: string): Promise<void> };
  };
}

async function internal(): Promise<Internal> {
  const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay");
  assert.ok(ext);
  const api = (await ext.activate()) as { internal: Internal };
  return api.internal;
}

suite("waiting-on-user notice", () => {
  test("a question from an off-screen session notifies — view hidden, and view on another session", async function () {
    this.timeout(30000);
    const { orchestrator } = await internal();
    const extension = vscode.extensions.getExtension("solutionsunity.acp-patchbay")!;
    const fakeAgentPath = join(extension.extensionUri.fsPath, "out-test", "fake-agent.mjs");
    const cwd = await mkdtemp(join(tmpdir(), "patchbay-waiting-"));
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
      const card = await waitFor(() =>
        orchestrator.agentView.current.transcripts[sessionId]?.find((b) => b.kind === "elicitation"),
      );
      orchestrator.handleAction({ kind: "resolveElicitation", requestId: card.id, answer: { action: "cancel" } });
      await turn;
    };
    const noticeFor = (question: string) => shown.find((args) => String(args[0]).includes(question));

    try {
      await orchestrator.connectAgent({
        agentId: AGENT_ID,
        name: "Waiting Fake",
        command: process.execPath,
        args: [fakeAgentPath],
        env: { FAKE_AGENT_SCRIPT: JSON.stringify({ turn: [{ type: "elicit", message: "Which branch?" }] }) },
        cwd,
      });

      // 1. The Agent View is hidden.
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await waitFor(() => (orchestrator.agentView.current.screen.pointer ? undefined : true));
      const hiddenSession = await orchestrator.sessionManager.createSession(AGENT_ID, "Waiting Fake", cwd);
      const hiddenTurn = orchestrator.sessionManager.sendPrompt(hiddenSession, "go");
      const hiddenNotice = await waitFor(() => noticeFor("Which branch?"));
      assert.ok(hiddenNotice.includes("Open"), "a question's notice offers Open");
      await answer(hiddenSession, hiddenTurn);

      // 2. The Agent View is open, on a different session.
      shown.length = 0;
      const asking = await orchestrator.sessionManager.createSession(AGENT_ID, "Waiting Fake", cwd);
      const reading = await orchestrator.sessionManager.createSession(AGENT_ID, "Waiting Fake", cwd);
      orchestrator.sessionManager.open(reading);
      await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
      await waitFor(() => (orchestrator.agentView.current.screen.pointer ? true : undefined));
      const askingTurn = orchestrator.sessionManager.sendPrompt(asking, "go");
      await waitFor(() => noticeFor("Which branch?"));
      await answer(asking, askingTurn);

      // 3. The session on screen asks: its card is in front of the user —
      // no notice. The card being in state means the notice was judged.
      shown.length = 0;
      await answer(reading, orchestrator.sessionManager.sendPrompt(reading, "go"));
      assert.strictEqual(noticeFor("Which branch?"), undefined);
    } finally {
      window.showWarningMessage = original;
      await orchestrator.pool.stop(AGENT_ID);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("an ask left open when its agent stops settles — no card waits on a dead process", async function () {
    this.timeout(20000);
    const { orchestrator } = await internal();
    const extension = vscode.extensions.getExtension("solutionsunity.acp-patchbay")!;
    const fakeAgentPath = join(extension.extensionUri.fsPath, "out-test", "fake-agent.mjs");
    const cwd = await mkdtemp(join(tmpdir(), "patchbay-waiting-stop-"));
    try {
      await orchestrator.connectAgent({
        agentId: AGENT_ID,
        name: "Waiting Fake",
        command: process.execPath,
        args: [fakeAgentPath],
        env: {
          FAKE_AGENT_SCRIPT: JSON.stringify({
            turn: [{ type: "askPermission", title: "Run tests", kind: "execute", subject: "npm test" }],
          }),
        },
        cwd,
      });
      const sessionId = await orchestrator.sessionManager.createSession(AGENT_ID, "Waiting Fake", cwd);
      void orchestrator.sessionManager.sendPrompt(sessionId, "go").catch(() => {});
      const card = () => orchestrator.agentView.current.transcripts[sessionId]?.find((b) => b.kind === "permission");
      await waitFor(() => (card()?.resolution === null ? true : undefined));

      await orchestrator.pool.stop(AGENT_ID);
      await waitFor(() => (card()?.resolution != null ? true : undefined));
    } finally {
      await orchestrator.pool.stop(AGENT_ID);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
