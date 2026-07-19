// Opportunistic behavior-level marking through the real orchestrator
// (architecture.md § Agent capability matrix; plan.md P5's "first fs
// success" hooks, wired in P6's handlers): an agent that genuinely routes
// fs reads/writes and terminal commands through patchbay's gates earns
// used on those rows — the matrix's honest data-plane record (the fidelity
// aggregate that once hung off these rows is removed, 2026-07-12).
import { waitFor } from "./wait-for";
import * as assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

interface CapabilityCell {
  declared: boolean;
  used: boolean;
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
    usedCapabilities: { remove(id: string): Promise<void> };
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

suite("opportunistic fs/terminal verification", () => {
  test("fs read+write and terminal get used when exercised; rows start declared-not-used", async function () {
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

    // A previous suite run in this user-data dir leaves its version-keyed
    // used-capability record behind, and the connect would honestly restore
    // used:true from it — this test asserts the pre-restore state, so its
    // agent starts from a clean slate.
    await orchestrator.usedCapabilities.remove("verify-e2e");

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
      assert.deepStrictEqual(matrix()["fs.readTextFile"], { declared: true, used: false });
      assert.deepStrictEqual(matrix()["fs.writeTextFile"], { declared: true, used: false });
      assert.deepStrictEqual(matrix()["terminal"], { declared: true, used: false });

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

      assert.strictEqual(matrix()["fs.readTextFile"].used, true, "read gets used");
      assert.strictEqual(matrix()["fs.writeTextFile"].used, true, "write gets used");
      assert.strictEqual(matrix()["terminal"].used, true, "terminal gets used");
    } finally {
      await orchestrator.pool.stop("verify-e2e");
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
