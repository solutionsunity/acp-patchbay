// Opportunistic behavior-level verification through the real orchestrator
// (architecture.md § Agent capability matrix; plan.md P5's "first fs
// success" hooks, wired in P6's handlers): an agent that genuinely routes
// fs reads/writes and terminal commands through patchbay's gates earns
// verified on those rows — which is also the only path to the
// "fully brokered" fidelity label and to auto-attach integration routing.
import * as assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

interface CapabilityCell {
  declared: boolean;
  verified: boolean;
}

interface Internal {
  orchestrator: {
    agentView: {
      current: {
        capabilities: Record<string, Record<string, CapabilityCell>>;
        transcripts: Record<string, Array<{ id: string; kind: string }>>;
      };
    };
    broker: { resolve(requestId: string, optionId: string): void };
    permissionRules: {
      get(): { commandRules: unknown[]; fileWriteScope: string };
      set(rules: { commandRules: unknown[]; fileWriteScope: string }): Promise<void>;
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
    pool: { stop(agentId: string): Promise<void> };
  };
}

async function internal(): Promise<Internal> {
  const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay");
  assert.ok(ext);
  const api = (await ext.activate()) as { internal: Internal };
  return api.internal;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

suite("opportunistic fs/terminal verification", () => {
  test("fs read+write and terminal verify when exercised; rows start declared-unverified", async function () {
    this.timeout(20000);
    const { orchestrator } = await internal();
    const extension = vscode.extensions.getExtension("solutionsunity.acp-patchbay")!;
    const fakeAgentPath = join(extension.extensionUri.fsPath, "out-test", "fake-agent.mjs");
    const cwd = await mkdtemp(join(tmpdir(), "patchbay-verify-e2e-"));
    const readTarget = join(cwd, "read-me.txt");
    const writeTarget = join(cwd, "written.txt");
    await writeFile(readTarget, "hello", "utf8");

    // The exact command the fake agent will run, pre-allowed by rule so the
    // terminal gate resolves without a user; the file write is left to
    // "ask" (no workspace root in this harness) and resolved via the broker
    // like a user click — a rejected-or-accepted write both count as
    // brokered, but accept keeps the turn simple.
    const rules = orchestrator.permissionRules.get();
    await orchestrator.permissionRules.set({
      ...rules,
      commandRules: [...rules.commandRules, { pattern: "node -e ok", verdict: "allow" }],
    });

    try {
      await orchestrator.connectAgent({
        agentId: "verify-e2e",
        name: "Verify E2E Fake",
        command: process.execPath,
        args: [fakeAgentPath],
        env: {
          FAKE_AGENT_SCRIPT: JSON.stringify({
            declare: { promptCapabilities: {} },
            turn: [
              { type: "readFile", path: readTarget },
              { type: "writeFile", path: writeTarget, content: "from agent" },
              { type: "runCommand", command: "node", args: ["-e", "ok"] },
            ],
          }),
        },
        cwd,
      });

      const matrix = () => orchestrator.agentView.current.capabilities["verify-e2e"];
      assert.deepStrictEqual(matrix()["fs.readTextFile"], { declared: true, verified: false });
      assert.deepStrictEqual(matrix()["fs.writeTextFile"], { declared: true, verified: false });
      assert.deepStrictEqual(matrix()["terminal"], { declared: true, verified: false });

      const sessionId = await orchestrator.sessionManager.createSession(
        "verify-e2e",
        "Verify E2E Fake",
        cwd,
      );
      const turnDone = orchestrator.sessionManager.sendPrompt(sessionId, "go");

      // the write arrives as a pending diff card (no workspace root → ask);
      // accept it the way the card's button would
      const diffBlock = await waitFor(() =>
        orchestrator.agentView.current.transcripts[sessionId]?.find((b) => b.kind === "diff"),
      );
      orchestrator.broker.resolve(diffBlock.id, "accept");
      await turnDone;

      assert.strictEqual(matrix()["fs.readTextFile"].verified, true, "read verifies");
      assert.strictEqual(matrix()["fs.writeTextFile"].verified, true, "write verifies");
      assert.strictEqual(matrix()["terminal"].verified, true, "terminal verifies");
    } finally {
      await orchestrator.pool.stop("verify-e2e");
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
