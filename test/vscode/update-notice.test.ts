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
    agentConfigs: {
      upsert(config: Record<string, unknown>): Promise<void>;
      remove(id: string): Promise<void>;
    };
    acpRegistry: { current(): RegistryData; onUpdated(data: RegistryData): void };
    agentView: { current: { updates: Record<string, { from: string; to: string }> } };
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

const config = (id: string, pinnedVersion: string) => ({
  id,
  name: `Agent ${id}`,
  command: "npx",
  args: [],
  processPolicy: "auto",
  autoConnect: false,
  defaults: {},
  registrySource: { registryId: id, distributionKind: "npx", pinnedVersion },
  lastSeenVersion: null,
});

suite("update notice", () => {
  test("a fetched newer version is announced once, with Upgrade; several share one notice", async () => {
    const { orchestrator } = await internal();
    const original = orchestrator.acpRegistry.current();
    const window = vscode.window as { showInformationMessage: (...args: unknown[]) => Thenable<unknown> };
    const show = window.showInformationMessage;
    const shown: unknown[][] = [];
    window.showInformationMessage = (...args: unknown[]) => {
      shown.push(args);
      return Promise.resolve(undefined); // the user lets it go
    };
    const land = (...agents: unknown[]) =>
      orchestrator.acpRegistry.onUpdated({ fetchedAt: new Date().toISOString(), agents, icons: {} });

    try {
      await orchestrator.agentConfigs.upsert(config("upd-a", "1.0.0"));
      await orchestrator.agentConfigs.upsert(config("upd-b", "2.0.0"));
      await orchestrator.agentConfigs.upsert(config("upd-c", "3.0.0"));

      land(registryAgent("upd-a", "1.1.0"), registryAgent("upd-b", "2.0.0"), registryAgent("upd-c", "3.0.0"));
      assert.deepStrictEqual(orchestrator.agentView.current.updates["upd-a"], { from: "1.0.0", to: "1.1.0" });
      assert.deepStrictEqual(shown, [["Agent upd-a 1.1.0 is available — you run 1.0.0.", "Upgrade"]]);

      // the next fetch with nothing newer says nothing again
      land(registryAgent("upd-a", "1.1.0"), registryAgent("upd-b", "2.0.0"), registryAgent("upd-c", "3.0.0"));
      assert.strictEqual(shown.length, 1);

      // two newer at once: one notice, the pick behind it
      land(registryAgent("upd-a", "1.1.0"), registryAgent("upd-b", "2.1.0"), registryAgent("upd-c", "3.1.0"));
      assert.deepStrictEqual(shown[1], ["Updates are available for 2 agents.", "Upgrade…"]);
    } finally {
      window.showInformationMessage = show;
      for (const id of ["upd-a", "upd-b", "upd-c"]) await orchestrator.agentConfigs.remove(id);
      orchestrator.acpRegistry.onUpdated(original);
    }
  });
});
