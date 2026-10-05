// Upgrade restarts the agent, so it must never end open conversations
// unasked (issue #47): with a prompted session attached and a newer version
// in the registry, Upgrade asks first, and declining leaves the agent
// running.
import * as assert from "node:assert";
import * as vscode from "vscode";
import { fakeAgentConfig } from "./fake-agent-config";
import { fakeAgentPath, Patchbay } from "./patchbay";
import { waitFor } from "./wait-for";

const AGENT_ID = "upgrade-guard";

suite("upgrade guard", () => {
  test("Upgrade asks before ending an open conversation; declining keeps the agent running", async function () {
    this.timeout(40000);
    const pb = await Patchbay.open();
    const realFetch = globalThis.fetch;
    const window = vscode.window as { showWarningMessage: (...args: unknown[]) => Thenable<unknown> };
    const original = window.showWarningMessage;
    const asked: unknown[][] = [];

    try {
      // The registry serves the agent's newer version — an upgrade has
      // nowhere to go without one.
      await pb.landRegistry({
        id: AGENT_ID,
        name: AGENT_ID,
        version: "2.0.0",
        description: "",
        authors: [],
        license: "",
        distribution: { npx: { package: `${AGENT_ID}@2.0.0`, args: [], env: {} } },
      });
      await pb.addAgent(
        fakeAgentConfig(
          AGENT_ID,
          "Upgrade Guard Fake",
          fakeAgentPath(),
          { turn: [{ type: "chunk", text: "ok" }] },
          { registryId: AGENT_ID, distributionKind: "npx", pinnedVersion: "1.0.0" },
        ),
      );
      await pb.connect(AGENT_ID);
      const sessionId = await pb.newSession(AGENT_ID);
      await pb.prompt(sessionId, "go");

      window.showWarningMessage = (...args: unknown[]) => {
        asked.push(args);
        return Promise.resolve(undefined); // the user dismisses the dialog
      };
      pb.act({ kind: "upgradeAgent", agentId: AGENT_ID });
      const [message, options] = await waitFor(() => asked[0]);
      assert.match(String(message), /1 open conversation/);
      assert.deepStrictEqual(options, { modal: true });
      // Let a stop that ignored the answer land before looking.
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(pb.agent(AGENT_ID)?.status, "running");
    } finally {
      window.showWarningMessage = original;
      await pb.remove(AGENT_ID);
      globalThis.fetch = realFetch;
    }
  });
});
