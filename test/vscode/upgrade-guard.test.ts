// Upgrade restarts the agent, so it must never end open conversations
// unasked (issue #47): with a prompted session attached and a newer version
// in the registry, Upgrade asks first, and declining leaves the agent
// running.
import { waitFor } from "./wait-for";
import { fakeAgentConfig, type AgentsDoor, type GatesDoor } from "./fake-agent-config";
import * as assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { answeringYes } from "./modal";

const AGENT_ID = "upgrade-guard";

interface Internal {
  orchestrator: {
    handleAction(action: { kind: "upgradeAgent"; agentId: string }): void;
    agents: AgentsDoor;
    gates: GatesDoor;
    acpRegistry: { current(): { agents: unknown[] }; refresh(moment: "manual"): Promise<{ ok: boolean }> };
    sessions: {
      createSession(agentId: string, agentName: string, cwd: string): Promise<string>;
      sendPrompt(sessionId: string, text: string): Promise<void>;
    };
    pool: { get(agentId: string): { status: string } | undefined };
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
    // The registry serves the agent's newer version, through the store's
    // real read — an upgrade has nowhere to go without one.
    await orchestrator.acpRegistry.refresh("manual"); // settle the startup read before serving our own
    const registryBefore = orchestrator.acpRegistry.current();
    const realFetch = globalThis.fetch;
    const land = async (...agents: unknown[]) => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ version: "1.0.0", agents }), { headers: { "content-type": "application/json" } });
      assert.strictEqual((await orchestrator.acpRegistry.refresh("manual")).ok, true);
    };
    await land({
      id: AGENT_ID,
      name: AGENT_ID,
      version: "2.0.0",
      description: "",
      authors: [],
      license: "",
      distribution: { npx: { package: `${AGENT_ID}@2.0.0`, args: [], env: {} } },
    });
    const window = vscode.window as { showWarningMessage: (...args: unknown[]) => Thenable<unknown> };
    const original = window.showWarningMessage;
    const asked: unknown[][] = [];
    window.showWarningMessage = (...args: unknown[]) => {
      asked.push(args);
      return Promise.resolve(undefined); // the user dismisses the dialog
    };

    try {
      await orchestrator.agents.save(
        fakeAgentConfig(
          AGENT_ID,
          "Upgrade Guard Fake",
          fakeAgentPath,
          { turn: [{ type: "chunk", text: "ok" }] },
          { registryId: AGENT_ID, distributionKind: "npx", pinnedVersion: "1.0.0" },
        ),
      );
      await orchestrator.gates.connect(AGENT_ID);
      const sessionId = await orchestrator.sessions.createSession(AGENT_ID, "Upgrade Guard Fake", cwd);
      await orchestrator.sessions.sendPrompt(sessionId, "go");

      orchestrator.handleAction({ kind: "upgradeAgent", agentId: AGENT_ID });
      const [message, options] = await waitFor(() => asked[0]);
      assert.match(String(message), /1 open conversation/);
      assert.deepStrictEqual(options, { modal: true });
      // Let a stop that ignored the answer land before looking.
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(orchestrator.pool.get(AGENT_ID)?.status, "running");
    } finally {
      window.showWarningMessage = original;
      await answeringYes(() => orchestrator.gates.remove(AGENT_ID));
      await land(...registryBefore.agents);
      globalThis.fetch = realFetch;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
