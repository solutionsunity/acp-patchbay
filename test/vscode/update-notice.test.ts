// An agent update must reach a user who never opens Settings (issue #37):
// when a registry fetch lands with a newer version than a config pins, a
// notification says so with the upgrade one click away — once per version,
// and one notification for several agents.
import * as assert from "node:assert";
import * as vscode from "vscode";

interface RegistryData {
  fetchedAt: string;
  agents: unknown[];
  icons: Record<string, string>;
}

interface Internal {
  orchestrator: {
    agents: { save(config: SavedConfig): Promise<void> };
    gates: { remove(id: string): Promise<void> };
    acpRegistry: { current(): RegistryData; refresh(moment: "manual"): Promise<{ ok: boolean }> };
    agentView: { current: { agents: Array<{ id: string; update?: { from: string; to: string } }> } };
  };
}

async function internal(): Promise<Internal> {
  const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay");
  assert.ok(ext);
  const api = (await ext.activate()) as { internal: Internal };
  return api.internal;
}

const registryAgent = (id: string, version: string) => ({
  id,
  name: id,
  version,
  description: "",
  authors: [],
  license: "",
  distribution: { npx: { package: `${id}@${version}`, args: [], env: {} } },
});

/** The record a Settings save writes — the agents store's own path in. */
interface SavedConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  autoConnect: boolean;
  defaults: Record<string, never>;
  registrySource: { registryId: string; distributionKind: "npx"; pinnedVersion: string };
  lastSeenVersion: null;
}

const config = (id: string, pinnedVersion: string): SavedConfig => ({
  id,
  name: `Agent ${id}`,
  command: "npx",
  args: [],
  env: {},
  autoConnect: false,
  defaults: {},
  registrySource: { registryId: id, distributionKind: "npx", pinnedVersion },
  lastSeenVersion: null,
});

suite("update notice", () => {
  test("a fetched newer version is announced once, with Upgrade; several share one notice", async () => {
    const { orchestrator } = await internal();
    await orchestrator.acpRegistry.refresh("manual"); // settle the startup read before serving our own
    const original = orchestrator.acpRegistry.current();
    const realFetch = globalThis.fetch;
    const window = vscode.window as { showInformationMessage: (...args: unknown[]) => Thenable<unknown> };
    const show = window.showInformationMessage;
    const shown: unknown[][] = [];
    window.showInformationMessage = (...args: unknown[]) => {
      shown.push(args);
      return Promise.resolve(undefined); // the user lets it go
    };
    // A registry fetch landing, through the store's real read: the CDN
    // serves these agents, the store takes them, the views and the notice
    // hear it — the store is the one holder, so nothing is pushed around it.
    const land = async (...agents: unknown[]) => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ version: "1.0.0", agents }), { headers: { "content-type": "application/json" } });
      assert.strictEqual((await orchestrator.acpRegistry.refresh("manual")).ok, true);
    };

    try {
      await orchestrator.agents.save(config("upd-a", "1.0.0"));
      await orchestrator.agents.save(config("upd-b", "2.0.0"));
      await orchestrator.agents.save(config("upd-c", "3.0.0"));

      await land(registryAgent("upd-a", "1.1.0"), registryAgent("upd-b", "2.0.0"), registryAgent("upd-c", "3.0.0"));
      assert.deepStrictEqual(
        orchestrator.agentView.current.agents.find((a) => a.id === "upd-a")?.update,
        { from: "1.0.0", to: "1.1.0" },
      );
      assert.deepStrictEqual(shown, [["Agent upd-a 1.1.0 is available — you run 1.0.0.", "Upgrade"]]);

      // the next fetch with nothing newer says nothing again
      await land(registryAgent("upd-a", "1.1.0"), registryAgent("upd-b", "2.0.0"), registryAgent("upd-c", "3.0.0"));
      assert.strictEqual(shown.length, 1);

      // two newer at once: one notice, the pick behind it
      await land(registryAgent("upd-a", "1.1.0"), registryAgent("upd-b", "2.1.0"), registryAgent("upd-c", "3.1.0"));
      assert.deepStrictEqual(shown[1], ["Updates are available for 2 agents.", "Upgrade…"]);
    } finally {
      window.showInformationMessage = show;
      for (const id of ["upd-a", "upd-b", "upd-c"]) await orchestrator.gates.remove(id);
      await land(...original.agents);
      globalThis.fetch = realFetch;
    }
  });
});
