// Upgrade restarts the agent, so it must never end open conversations
// unasked (issue #47): with a prompted session attached, Upgrade asks first,
// and declining leaves the agent running.
import { waitFor } from "./wait-for";
import * as assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

const AGENT_ID = "upgrade-guard";

interface Internal {
  orchestrator: {
    handleAction(action: { kind: "upgradeAgent"; agentId: string }): void;
    agentConfigs: {
      upsert(config: Record<string, unknown>): Promise<void>;
      remove(id: string): Promise<void>;
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
    pool: {
      get(agentId: string): { status: string } | undefined;
      stop(agentId: string): Promise<void>;
    };
  };
}

async function internal(): Promise<Internal> {
  const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay");
  assert.ok(ext);
  const api = (await ext.activate()) as { internal: Internal };
  return api.internal;
}

suite("upgrade guard", () => {
  test("Upgrade asks before ending an open conversation; declining keeps the agent running", async function () {
    this.timeout(20000);
    const { orchestrator } = await internal();
    const extension = vscode.extensions.getExtension("solutionsunity.acp-patchbay")!;
    const fakeAgentPath = join(extension.extensionUri.fsPath, "out-test", "fake-agent.mjs");
    const cwd = await mkdtemp(join(tmpdir(), "patchbay-upgrade-guard-"));
    const window = vscode.window as { showWarningMessage: (...args: unknown[]) => Thenable<unknown> };
    const original = window.showWarningMessage;
    const asked: unknown[][] = [];
    window.showWarningMessage = (...args: unknown[]) => {
      asked.push(args);
      return Promise.resolve(undefined); // the user dismisses the dialog
    };

    try {
      await orchestrator.agentConfigs.upsert({
        id: AGENT_ID,
        name: "Upgrade Guard Fake",
        command: process.execPath,
        args: [fakeAgentPath],
        processPolicy: "shared",
        autoConnect: false,
        defaults: {},
        registrySource: { registryId: AGENT_ID, distributionKind: "npx", pinnedVersion: "1.0.0" },
        lastSeenVersion: null,
      });
      await orchestrator.connectAgent({
        agentId: AGENT_ID,
        name: "Upgrade Guard Fake",
        command: process.execPath,
        args: [fakeAgentPath],
        env: { FAKE_AGENT_SCRIPT: JSON.stringify({ turn: [{ type: "chunk", text: "ok" }] }) },
        cwd,
      });
      const sessionId = await orchestrator.sessionManager.createSession(AGENT_ID, "Upgrade Guard Fake", cwd);
      await orchestrator.sessionManager.sendPrompt(sessionId, "go");

      orchestrator.handleAction({ kind: "upgradeAgent", agentId: AGENT_ID });
      const [message, options] = await waitFor(() => asked[0]);
      assert.match(String(message), /1 open conversation/);
      assert.deepStrictEqual(options, { modal: true });
      // Let a stop that ignored the answer land before looking.
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(orchestrator.pool.get(AGENT_ID)?.status, "running");
    } finally {
      window.showWarningMessage = original;
      await orchestrator.pool.stop(AGENT_ID);
      await orchestrator.agentConfigs.remove(AGENT_ID);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
