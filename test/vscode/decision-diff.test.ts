// Issue #90: a decision card's Open diff shows the whole change in VS Code's
// own diff editor — for patchbay's write gate and for an agent's permission
// request alike — and the tab it opened closes once the ask is answered: it
// shows a change that is no longer proposed.
import * as assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import * as vscode from "vscode";
import { fakeAgentConfig } from "./fake-agent-config";
import { fakeAgentPath, Patchbay } from "./patchbay";
import { waitFor } from "./wait-for";

/** Where one ask's diff texts live — under its own id. */
const askDir = (patchbayAskId: string) => `${sep}acp-patchbay-diffs${sep}${patchbayAskId}${sep}`;

/** The diff tabs opened for one ask. */
function askDiffTabs(patchbayAskId: string): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.fsPath.includes(askDir(patchbayAskId)));
}

/** The ask's diff is open and on screen — what a user reads before
 * answering. Answering while the editor is still attaching its texts is a
 * race VS Code logs ("Model is disposed!"), not one a reader makes. */
function askDiffShown(patchbayAskId: string): Promise<true> {
  return waitFor(
    () => (vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath.includes(askDir(patchbayAskId))) && askDiffTabs(patchbayAskId).length === 1 ? true : undefined),
    8000,
    `the diff of ${patchbayAskId} on screen`,
  );
}

suite("decision diffs open and close with their ask (issue #90)", () => {
  let dir: string;
  setup(async () => {
    dir = await mkdtemp(join(tmpdir(), "patchbay-decision-diff-"));
  });
  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await rm(dir, { recursive: true, force: true });
  });

  test("a proposed write's diff tab closes when the write is answered", async function () {
    this.timeout(30000);
    const pb = await Patchbay.open();
    const target = join(dir, "a.txt"); // outside any root: the gate asks
    await writeFile(target, "one\ntwo\n", "utf8");
    try {
      const patchbayAgentId = await pb.addAgent(
        fakeAgentConfig("decision-diff-write", "Decision Diff Fake", fakeAgentPath(), {
          turn: [{ type: "writeFile", path: target, content: "one\nTWO\n" }],
        }),
      );
      await pb.connect(patchbayAgentId);
      const patchbaySessionId = await pb.newSession(patchbayAgentId);
      const turnDone = pb.prompt(patchbaySessionId, "go");
      const card = await pb.openCard(patchbaySessionId, "diff");
      pb.act({ kind: "openProposedDiff", patchbayAskId: card.id });
      await askDiffShown(card.id);
      await pb.answerDiff(patchbaySessionId, card, false);
      await turnDone;
      await waitFor(() => (askDiffTabs(card.id).length === 0 ? true : undefined), 8000, "the write's diff tab closed");
    } finally {
      await pb.removeAdded();
    }
  });

  test("an agent's edit request opens its change from the card, and the tab closes once answered", async function () {
    this.timeout(30000);
    const pb = await Patchbay.open();
    const target = join(dir, "greet.ts");
    try {
      const patchbayAgentId = await pb.addAgent(
        fakeAgentConfig("decision-diff-ask", "Decision Diff Fake", fakeAgentPath(), {
          turn: [
            {
              type: "askPermission",
              title: `Approve edit: ${target}`,
              kind: "execute", // no locations, as Hermes sends none
              subject: target,
              toolCall: {
                toolCallId: "edit-approval-1",
                kind: "edit",
                status: "pending",
                content: [{ type: "diff", path: target, oldText: "a\n", newText: "b\n" }],
              },
            },
          ],
        }),
      );
      await pb.connect(patchbayAgentId);
      const patchbaySessionId = await pb.newSession(patchbayAgentId);
      const turnDone = pb.prompt(patchbaySessionId, "go");
      const card = await pb.openCard(patchbaySessionId, "permission");
      pb.act({ kind: "openProposedDiff", patchbayAskId: card.id });
      await askDiffShown(card.id);
      pb.act({ kind: "resolvePermission", patchbayAskId: card.id, optionId: "reject_once" });
      await turnDone;
      await waitFor(() => (askDiffTabs(card.id).length === 0 ? true : undefined), 8000, "the request's diff tab closed");
      assert.match(pb.text(patchbaySessionId), /permission: reject_once/);
    } finally {
      await pb.removeAdded();
    }
  });
});
