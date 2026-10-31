// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The Data page's inventory of what patchbay keeps in VS Code's storage —
// built from the key table, so every key has its row (the type holds that),
// read from where each key lives (this test holds that), counted, never
// shown.
import { describe, expect, it } from "vitest";
import { storedRows } from "../src/orchestrator/stores/inventory";
import { STORAGE_KEYS } from "../src/orchestrator/stores/storage-keys";

describe("storedRows", () => {
  it("has a row for every key, each read where it lives — counts, never values", () => {
    const machine = new Map<string, unknown>([
      [STORAGE_KEYS.agents, [{ id: "a" }, { id: "b" }]],
      [STORAGE_KEYS.authLocks, [{ id: "a" }]],
      [STORAGE_KEYS.defaultAgentFolded, "claude-acp"],
    ]);
    const workspace = new Map<string, unknown>([
      [STORAGE_KEYS.permissionRules, { commandRules: [{ pattern: "npm *" }], writeScope: [] }],
      [STORAGE_KEYS.lastActiveSession, { patchbayAgentId: "a", sessionId: "s1" }],
    ]);
    const rows = storedRows({ machine: (k) => machine.get(k), workspace: (k) => workspace.get(k) });
    expect(rows.map((r) => r.id).sort()).toEqual(Object.values(STORAGE_KEYS).sort());
    const of = (key: string) => rows.find((r) => r.id === key);
    expect(of(STORAGE_KEYS.agents)).toMatchObject({ placement: "globalStorage file", detail: "2 agents" });
    expect(of(STORAGE_KEYS.authLocks)?.detail).toBe("1 agent");
    expect(of(STORAGE_KEYS.defaultAgentFolded)?.detail).toBe("folded into auto-connect");
    expect(of(STORAGE_KEYS.legacyStateRecovery)?.detail).toBe("not run");
    expect(of(STORAGE_KEYS.permissionRules)).toMatchObject({ placement: "workspaceState", detail: "1 rule · 0 file-write overrides" });
    expect(of(STORAGE_KEYS.lastActiveSession)?.detail).toBe("one");
    expect(of(STORAGE_KEYS.lastConnected)?.detail).toBe("0 agents");
  });
});
