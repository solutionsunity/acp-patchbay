// The names patchbay keeps data under are the on-disk contract: every other
// test reads a key through the table, so this one spells them out — a key
// renamed by accident fails here, before a user's data is read as nothing.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECRET_FAMILIES, STORAGE_KEYS } from "../src/orchestrator/stores/storage-keys";

describe("storage keys", () => {
  it("every state key is spelled as it is stored", () => {
    expect(STORAGE_KEYS).toEqual({
      agents: "acpPatchbay.agentConfigs",
      agentsBefore090: "acpPatchbay.agents",
      lastKnobs: "acpPatchbay.lastKnobs",
      mcpServers: "acpPatchbay.integrations",
      preferences: "acpPatchbay.preferences",
      machineCommandRules: "acpPatchbay.machineCommandRules",
      machineWriteScope: "acpPatchbay.machineWriteScope",
      machineSavedRoots: "acpPatchbay.machineSavedRoots",
      usedCapabilities: "acpPatchbay.usedCapabilities",
      authLocks: "acpPatchbay.authLocks",
      sessionContinuity: "acpPatchbay.sessionContinuity",
      spawnRegistry: "acpPatchbay.spawnRegistry",
      defaultAgentFolded: "acpPatchbay.defaultAgentFolded",
      legacyStateRecovery: "acpPatchbay.legacyStateRecovery",
      permissionRules: "acpPatchbay.permissionRules",
      savedRoots: "acpPatchbay.savedRoots",
      lastConnected: "acpPatchbay.lastConnected",
      lastActiveSession: "acpPatchbay.lastActiveSession",
    });
  });

  it("every secret family is spelled as it is stored", () => {
    expect(SECRET_FAMILIES).toEqual({ agent: "acpPatchbay.agent", mcpServer: "acpPatchbay.integration" });
  });

  // The export's table is typed over the key table, so a key there without
  // a fate does not build; this keeps a store from naming a key of its own
  // beside it.
  it("no store spells a key of its own", async () => {
    const dir = fileURLToPath(new URL("../src/orchestrator/stores/", import.meta.url));
    const spelled: string[] = [];
    for (const name of await readdir(dir)) {
      if (name === "storage-keys.ts") continue;
      for (const [i, line] of (await readFile(join(dir, name), "utf8")).split("\n").entries()) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (/["`]acpPatchbay\.[A-Za-z]/.test(line)) spelled.push(`${name}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(spelled).toEqual([]);
  });
});
