// An agent update must reach a user who never opens Settings (issue #37):
// when a registry fetch lands with a newer version than a config pins, a
// notification says so with the upgrade one click away — once per version,
// and one notification for several agents.
import * as assert from "node:assert";
import * as vscode from "vscode";
import type { AgentConfig } from "./fake-agent-config";
import { Patchbay } from "./patchbay";

const registryAgent = (id: string, version: string) => ({
  id,
  name: id,
  version,
  description: "",
  authors: [],
  license: "",
  distribution: { npx: { package: `${id}@${version}`, args: [], env: {} } },
});

/** An agent added from the registry, pinned at `pinnedVersion` — never
 * connected here. */
const config = (registryId: string, pinnedVersion: string): AgentConfig => ({
  id: "",
  name: `Agent ${registryId}`,
  command: "npx",
  args: [],
  env: {},
  autoConnect: false,
  defaults: {},
  registrySource: { registryId, distributionKind: "npx", pinnedVersion },
  lastSeenVersion: null,
});

suite("update notice", () => {
  test("a fetched newer version is announced once, with Upgrade; several share one notice", async function () {
    this.timeout(40000);
    const pb = await Patchbay.open();
    const realFetch = globalThis.fetch;
    const window = vscode.window as { showInformationMessage: (...args: unknown[]) => Thenable<unknown> };
    const show = window.showInformationMessage;
    const shown: unknown[][] = [];
    window.showInformationMessage = (...args: unknown[]) => {
      shown.push(args);
      return Promise.resolve(undefined); // the user lets it go
    };

    try {
      const updA = await pb.addAgent(config("upd-a", "1.0.0"));
      await pb.addAgent(config("upd-b", "2.0.0"));
      await pb.addAgent(config("upd-c", "3.0.0"));

      await pb.landRegistry(registryAgent("upd-a", "1.1.0"), registryAgent("upd-b", "2.0.0"), registryAgent("upd-c", "3.0.0"));
      assert.deepStrictEqual(pb.agent(updA)?.update, { from: "1.0.0", to: "1.1.0" });
      assert.deepStrictEqual(shown, [["Agent upd-a 1.1.0 is available — you run 1.0.0.", "Upgrade"]]);

      // the next fetch with nothing newer says nothing again
      await pb.landRegistry(registryAgent("upd-a", "1.1.0"), registryAgent("upd-b", "2.0.0"), registryAgent("upd-c", "3.0.0"));
      assert.strictEqual(shown.length, 1);

      // two newer at once: one notice, the pick behind it
      await pb.landRegistry(registryAgent("upd-a", "1.1.0"), registryAgent("upd-b", "2.1.0"), registryAgent("upd-c", "3.1.0"));
      assert.deepStrictEqual(shown[1], ["Updates are available for 2 agents.", "Upgrade…"]);
    } finally {
      window.showInformationMessage = show;
      await pb.removeAdded();
      globalThis.fetch = realFetch;
    }
  });
});
