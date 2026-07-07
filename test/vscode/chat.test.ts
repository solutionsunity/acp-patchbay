// P4 gate: a full turn streams end-to-end against the fake agent through the
// real orchestrator and a real webview, and a webview kill/reopen mid-turn
// recovers to the accumulated chat state. (The Claude-Code-over-ACP half of
// this gate is a manual smoke test outside this harness — no live agent
// credentials are available in this sandboxed run.)
import { waitFor } from "./wait-for";
import * as assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

interface ChatBlockLike {
  id: string;
  kind: string;
  text?: string;
}

interface Internal {
  orchestrator: {
    isAgentViewVisible(): boolean;
    agentView: {
      revision: number;
      waitForApplied(rev?: number): Promise<number>;
      current: {
        transcripts: Record<string, ChatBlockLike[]>;
        sessions: Array<{ id: string; live: boolean }>;
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
    };
  };
}

async function internal(): Promise<Internal> {
  const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay");
  assert.ok(ext);
  const api = (await ext.activate()) as { internal: Internal };
  return api.internal;
}

function textOf(blocks: ChatBlockLike[]): string {
  return blocks
    .filter((b) => b.kind === "text")
    .map((b) => b.text ?? "")
    .join("");
}

suite("chat vertical slice", () => {
  test("full turn streams end-to-end; webview kill/reopen mid-turn recovers", async function () {
    this.timeout(20000);
    const { orchestrator } = await internal();
    const extension = vscode.extensions.getExtension("solutionsunity.acp-patchbay")!;
    const fakeAgentPath = join(extension.extensionUri.fsPath, "out-test", "fake-agent.mjs");
    const cwd = await mkdtemp(join(tmpdir(), "patchbay-chat-e2e-"));

    try {
      await orchestrator.connectAgent({
        agentId: "chat-e2e",
        name: "Chat E2E Fake",
        command: process.execPath,
        args: [fakeAgentPath],
        env: {
          FAKE_AGENT_SCRIPT: JSON.stringify({
            turn: [
              { type: "chunk", text: "part one " },
              { type: "chunk", text: "part two " },
              { type: "chunk", text: "part three" },
            ],
            stepDelayMs: 250,
          }),
        },
        cwd,
      });

      const sessionId = await orchestrator.sessionManager.createSession(
        "chat-e2e",
        "Chat E2E Fake",
        cwd,
      );

      // mount the real webview and let it hydrate at the session-created snapshot
      await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
      await orchestrator.agentView.waitForApplied(orchestrator.agentView.revision);

      // fire the turn without awaiting completion — we want to interrupt mid-stream
      const turnDone = orchestrator.sessionManager.sendPrompt(sessionId, "go");

      // wait for the first chunk to land, then kill the webview mid-turn
      await waitFor(() => {
        const text = textOf(orchestrator.agentView.current.transcripts[sessionId] ?? []);
        return text.length > 0 ? text : undefined;
      });
      const midTurnSession = orchestrator.agentView.current.sessions.find(
        (s) => s.id === sessionId,
      );
      assert.strictEqual(midTurnSession?.live, true, "turn should still be in flight");

      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await waitFor(() => (orchestrator.isAgentViewVisible() ? undefined : true));

      // reopen mid-turn — the webview must resync to whatever canonical state
      // has accumulated by now (render cache lives in the orchestrator, not
      // the disposed webview)
      await vscode.commands.executeCommand("acpPatchbay.agentView.focus");
      const revAtReopen = orchestrator.agentView.revision;
      const acked = await orchestrator.agentView.waitForApplied(revAtReopen);
      assert.ok(acked >= revAtReopen, `webview acked ${acked}, wanted ${revAtReopen}`);

      // let the turn finish, then verify the complete, correctly-ordered transcript
      await turnDone;
      const finalState = orchestrator.agentView.current;
      assert.strictEqual(
        textOf(finalState.transcripts[sessionId] ?? []),
        "part one part two part three",
      );
      assert.strictEqual(
        finalState.sessions.find((s) => s.id === sessionId)?.live,
        false,
      );

      // and the final state reached the webview too
      await orchestrator.agentView.waitForApplied(orchestrator.agentView.revision);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
