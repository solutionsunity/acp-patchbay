// The write scope through the real extension (issue #56): a write is judged
// by where it lands against the roots the session was given. A root added
// to the session auto-accepts; a `..` that climbs out of it asks; the
// process cwd standing in for an absent folder is never a root — this suite
// runs with no folder open, so that state is live here.
import * as assert from "node:assert";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAgentConfig } from "./fake-agent-config";
import { fakeAgentPath, Patchbay } from "./patchbay";

suite("write scope (issue #56)", () => {
  test("a root added to the session auto-accepts; a `..` out of it asks; the fallback cwd is not a root", async function () {
    this.timeout(30000);
    const pb = await Patchbay.open();
    const dir = await mkdtemp(join(tmpdir(), "patchbay-write-scope-"));
    const root = join(dir, "root");
    await mkdir(root);
    const inside = join(root, "inside.txt");
    const escaped = join(dir, "escaped.txt");
    // Rejected on its card below, so nothing ever lands there.
    const inCwd = join(process.cwd(), "patchbay-write-scope-probe.txt");
    try {
      const patchbayAgentId = await pb.addAgent(
        fakeAgentConfig("write-scope-e2e", "Write Scope Fake", fakeAgentPath(), {
          declare: { promptCapabilities: {} },
          turn: [
            { type: "writeFile", path: inside, content: "in\n" },
            { type: "writeFile", path: `${root}/../escaped.txt`, content: "out\n" },
            { type: "writeFile", path: inCwd, content: "cwd\n" },
          ],
        }),
      );
      await pb.connect(patchbayAgentId);
      const patchbaySessionId = await pb.newSession(patchbayAgentId);
      await pb.addRoot(patchbaySessionId, root);

      const turnDone = pb.prompt(patchbaySessionId, "go");
      const escape = await pb.openCard(patchbaySessionId, "diff");
      const diffs = () => (pb.view.transcripts[patchbaySessionId] ?? []).filter((b) => b.kind === "diff");
      assert.deepStrictEqual(diffs()[0]!.resolution, { accepted: true, auto: true }, "inside the root: no card to click");
      assert.strictEqual(escape.id, diffs()[1]!.id, "the `..` escape waits on the user");
      await pb.answerDiff(patchbaySessionId, escape, false);

      const fallback = await pb.openCard(patchbaySessionId, "diff");
      assert.strictEqual(fallback.id, diffs()[2]!.id, "no folder open: the process cwd was never handed to the agent");
      await pb.answerDiff(patchbaySessionId, fallback, false);
      await turnDone;

      assert.strictEqual(await readFile(inside, "utf8"), "in\n");
      await assert.rejects(readFile(escaped, "utf8"), "the rejected write never landed");
      await assert.rejects(readFile(inCwd, "utf8"), "the rejected write never landed");
    } finally {
      await pb.removeAdded();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
