// Opportunistic behavior-level marking through the real orchestrator: an
// agent that genuinely routes fs reads/writes and terminal commands through
// patchbay's gates earns used on those rows — the matrix's honest
// data-plane record.
import * as assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAgentConfig } from "./fake-agent-config";
import { fakeAgentPath, Patchbay } from "./patchbay";

suite("opportunistic fs/terminal verification", () => {
  test("fs read+write and terminal get used when exercised; rows start declared-not-used", async function () {
    this.timeout(30000);
    const pb = await Patchbay.open();
    const dir = await mkdtemp(join(tmpdir(), "patchbay-verify-e2e-"));
    const readTarget = join(dir, "read-me.txt");
    const writeTarget = join(dir, "written.txt");
    await writeFile(readTarget, "hello", "utf8");
    // The exact command the fake agent will run, allowed by a rule so the
    // terminal gate resolves without a user; the file write is left to
    // "ask" (no workspace root in this harness) and accepted on its card.
    await pb.addMachineRule("node -e ok", "allow");
    try {
      // Used marks are kept per agent and version across windows; the agent
      // this run adds has an id of its own, so it starts with none.
      const patchbayAgentId = await pb.addAgent(
        fakeAgentConfig("verify-e2e", "Verify E2E Fake", fakeAgentPath(), {
          declare: { promptCapabilities: {} },
          turn: [
            { type: "readFile", path: readTarget },
            { type: "writeFile", path: writeTarget, content: "from agent" },
            { type: "runCommand", command: "node", args: ["-e", "ok"] },
          ],
        }),
      );
      await pb.connect(patchbayAgentId);

      const matrix = () => pb.agent(patchbayAgentId)!.capabilities!;
      assert.deepStrictEqual(matrix()["fs.readTextFile"], { declared: true, used: false });
      assert.deepStrictEqual(matrix()["fs.writeTextFile"], { declared: true, used: false });
      assert.deepStrictEqual(matrix()["terminal"], { declared: true, used: false });

      const sessionId = await pb.newSession(patchbayAgentId);
      const turnDone = pb.prompt(sessionId, "go");
      const diff = await pb.openCard(sessionId, "diff");
      await pb.answerDiff(sessionId, diff, true);
      await turnDone;

      assert.strictEqual(matrix()["fs.readTextFile"].used, true, "read gets used");
      assert.strictEqual(matrix()["fs.writeTextFile"].used, true, "write gets used");
      assert.strictEqual(matrix()["terminal"].used, true, "terminal gets used");
    } finally {
      await pb.removeAdded();
      await pb.removeMachineRule("node -e ok");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
