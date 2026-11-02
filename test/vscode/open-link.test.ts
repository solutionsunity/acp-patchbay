// Issue #138: a page patchbay opens reaches VS Code's opener exactly as it
// was built. A link handed over as a `Uri` is re-encoded on the way out —
// its query decoded and encoded again — so an encoded `? # & = +` inside a
// query value arrives changed (an OAuth redirect_uri a server matches
// exactly, rejected). The opener is VS Code's own: the suite records what
// it is handed and opens nothing.
import * as assert from "node:assert";
import * as vscode from "vscode";
import { fakeAgentConfig } from "./fake-agent-config";
import { fakeAgentPath, Patchbay } from "./patchbay";
import { WINDOW_SETTLE, waitFor } from "../support/wait-for";

const LABEL = "open-link";

/** Each of `? # & = +` encoded in a query value — as an OAuth authorize
 * link carries its redirect_uri. */
const SIGN_IN =
  "https://sign-in.example/authorize?redirect_uri=vscode%3A%2F%2Fpatchbay%2Foauth-callback%3FwindowId%3D1%26a%3Db%23top&scope=read%2Bwrite";

suite("open link", () => {
  test("a link the user accepts reaches the opener as built — its encoded query untouched", async function () {
    this.timeout(30000);
    const pb = await Patchbay.open();
    const env = vscode.env as { openExternal: (target: unknown) => Thenable<boolean> };
    const original = env.openExternal;
    const opened: unknown[] = [];
    env.openExternal = (target: unknown) => (opened.push(target), Promise.resolve(true));
    try {
      const patchbayAgentId = await pb.addAgent(
        fakeAgentConfig(LABEL, "Link Fake", fakeAgentPath(), {
          turn: [{ type: "elicitUrl", url: SIGN_IN, elicitationId: "sign-in-1" }],
        }),
      );
      await pb.connect(patchbayAgentId);
      const patchbaySessionId = await pb.newSession(patchbayAgentId);
      const turn = pb.prompt(patchbaySessionId, "go");
      const card = await pb.openCard(patchbaySessionId, "elicitation");
      pb.act({ kind: "resolveElicitation", patchbayAskId: card.id, answer: { action: "accept", content: {} } });
      await waitFor(() => opened.length > 0, WINDOW_SETTLE, "the link handed to the opener");
      await turn;

      assert.deepStrictEqual(opened, [SIGN_IN]);
    } finally {
      env.openExternal = original;
      await pb.removeAdded();
    }
  });
});
