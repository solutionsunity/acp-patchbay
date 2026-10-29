// Stores: session index over KV, permission rules defaults, decision audit
// JSONL append/tail, the generic globalState-backed record store agents/
// MCP servers/used-capabilities all share.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "./support/teardown";
import { ATTACHMENTS_DIR } from "../src/orchestrator/attachments";
import { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
import { GlobalRecordStore } from "../src/orchestrator/stores/global-record-store";
import { MemorySecrets } from "../src/orchestrator/stores/mcp-server-tokens";
import { SecretEnvStore } from "../src/orchestrator/stores/secret-env";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { SessionContinuityStore } from "../src/orchestrator/stores/session-continuity";
import { UsedCapabilityStore } from "../src/orchestrator/stores/used-capabilities";
import { matrixFromDeclared } from "../src/orchestrator/capabilities";
import type { DeclaredCapabilities } from "../src/shared/protocol";
import { LastActiveSessionStore } from "../src/orchestrator/stores/last-active-session";
import { LastConnectedStore, RELOAD_GRACE_MS } from "../src/orchestrator/stores/last-connected";
import { ComposerKnobsStore } from "../src/orchestrator/stores/composer-knobs";
import { PreferencesStore } from "../src/orchestrator/stores/preferences";
import { DEFAULT_PREFERENCES } from "../src/shared/protocol";
import {
  DEFAULT_PERMISSION_RULES,
  MachineRulesStore,
  PermissionRulesStore,
  withRule,
} from "../src/orchestrator/stores/permission-rules";
import { SavedRootsStore } from "../src/orchestrator/stores/saved-roots";
import { MachineWriteScopeStore, withWriteEntry, writeScopeRows } from "../src/orchestrator/stores/write-scope";
import type { PatchbayAgentId } from "../src/shared/ids";
import { STORAGE_KEYS, SECRET_FAMILIES } from "../src/orchestrator/stores/storage-keys";

describe("LastConnectedStore — reload-continuation stamp", () => {
  it("a fresh stamp yields its ids, and is spent by the read", async () => {
    const store = new LastConnectedStore(new MemoryKV());
    await store.write(["claude" as PatchbayAgentId, "gemini" as PatchbayAgentId]);
    expect(await store.consume()).toEqual(["claude", "gemini"]);
    // Spent: one stamp can never drive two activations.
    expect(await store.consume()).toEqual([]);
  });

  it("a stale stamp yields nothing — quit-and-reopen-later must not resurrect agents", async () => {
    const store = new LastConnectedStore(new MemoryKV());
    await store.write(["claude" as PatchbayAgentId]);
    const later = new Date(Date.now() + RELOAD_GRACE_MS + 1);
    expect(await store.consume(later)).toEqual([]);
  });

  it("absent or torn stamps yield nothing, never throw", async () => {
    const kv = new MemoryKV();
    const store = new LastConnectedStore(kv);
    expect(await store.consume()).toEqual([]);
    await kv.update(STORAGE_KEYS.lastConnected, { patchbayAgentIds: "not-an-array", at: new Date().toISOString() });
    expect(await store.consume()).toEqual([]);
    await kv.update(STORAGE_KEYS.lastConnected, { patchbayAgentIds: ["ok", 42], at: "not-a-date" });
    expect(await store.consume()).toEqual([]);
  });

  it("an empty write still lands — a shutdown with nothing running clears any stale stamp", async () => {
    const store = new LastConnectedStore(new MemoryKV());
    await store.write(["claude" as PatchbayAgentId]);
    await store.write([]);
    expect(await store.consume()).toEqual([]);
  });

  it("a stamp written under the old field name still restores what ran — the reload that installs this version", async () => {
    const kv = new MemoryKV();
    await kv.update(STORAGE_KEYS.lastConnected, { agentIds: ["claude"], at: new Date().toISOString() });
    const store = new LastConnectedStore(kv);
    expect(kv.get(STORAGE_KEYS.lastConnected)).not.toHaveProperty("agentIds");
    expect(await store.consume()).toEqual(["claude"]);
  });
});

describe("LastActiveSessionStore — the last-open-session pointer", () => {
  it("holds the latest activation, by agent and the agent's own id; wipe clears it", async () => {
    const store = new LastActiveSessionStore(new MemoryKV());
    expect(store.get()).toBeUndefined();
    await store.set({ patchbayAgentId: "a" as PatchbayAgentId, sessionId: "s1" });
    await store.set({ patchbayAgentId: "b" as PatchbayAgentId, sessionId: "s1" });
    expect(store.get()).toEqual({ patchbayAgentId: "b", sessionId: "s1" });
    await store.wipe();
    expect(store.get()).toBeUndefined();
  });

  it("survives what a reload survives — no freshness bound, unlike the stamp", async () => {
    const kv = new MemoryKV();
    await new LastActiveSessionStore(kv).set({ patchbayAgentId: "a" as PatchbayAgentId, sessionId: "s1" });
    // A fresh store over the same KV (the next activate) still reads it.
    expect(new LastActiveSessionStore(kv).get()).toEqual({ patchbayAgentId: "a", sessionId: "s1" });
  });

  it("a pointer written under the old field name still points — the window that installs this version returns", async () => {
    const kv = new MemoryKV();
    await kv.update(STORAGE_KEYS.lastActiveSession, { agentId: "a", sessionId: "s1" });
    expect(new LastActiveSessionStore(kv).get()).toEqual({ patchbayAgentId: "a", sessionId: "s1" });
    expect(kv.get(STORAGE_KEYS.lastActiveSession)).not.toHaveProperty("agentId");
  });

  it("a value of another shape — the bare id an older version stored — is no pointer", async () => {
    const kv = new MemoryKV();
    await kv.update(STORAGE_KEYS.lastActiveSession, "s1");
    expect(new LastActiveSessionStore(kv).get()).toBeUndefined();
  });

  describe("the bare id 0.84.1 stored, folded once the startup lists are in", () => {
    const pair = (agent: string, sessionId: string) => ({ patchbayAgentId: agent as PatchbayAgentId, sessionId });

    it("one session answering to it becomes the pointer, kept as the pair", async () => {
      const kv = new MemoryKV();
      await kv.update(STORAGE_KEYS.lastActiveSession, "s1");
      const store = new LastActiveSessionStore(kv);
      expect(store.stored()).toBe(true);
      expect(await store.resolve(() => [pair("claude", "s1")])).toEqual(pair("claude", "s1"));
      expect(kv.get(STORAGE_KEYS.lastActiveSession)).toEqual({ patchbayAgentId: "claude", sessionId: "s1" });
    });

    it("several are ambiguous for good — the pointer goes", async () => {
      const kv = new MemoryKV();
      await kv.update(STORAGE_KEYS.lastActiveSession, "s1");
      const store = new LastActiveSessionStore(kv);
      expect(await store.resolve(() => [pair("claude", "s1"), pair("auggie", "s1")])).toBeUndefined();
      expect(store.stored()).toBe(false);
    });

    it("none may be an agent that hasn't connected yet — the id stays for a later window", async () => {
      const kv = new MemoryKV();
      await kv.update(STORAGE_KEYS.lastActiveSession, "s1");
      const store = new LastActiveSessionStore(kv);
      expect(await store.resolve(() => [])).toBeUndefined();
      expect(kv.get(STORAGE_KEYS.lastActiveSession)).toBe("s1");
    });
  });
});

describe("PermissionRulesStore", () => {
  it("returns built-in defaults when nothing is stored", () => {
    const store = new PermissionRulesStore(new MemoryKV());
    expect(store.get()).toEqual(DEFAULT_PERMISSION_RULES);
  });

  it("stored rules override defaults", async () => {
    const store = new PermissionRulesStore(new MemoryKV());
    await store.set({
      commandRules: [{ kind: "command", pattern: "npm run *", verdict: "allow" }],
      writeScope: [{ location: { kind: "alwaysAsk" }, on: true }],
    });
    expect(store.get().commandRules).toHaveLength(1);
    expect(store.get().writeScope).toEqual([{ location: { kind: "alwaysAsk" }, on: true }]);
  });

  // The one choice a released version stored per workspace becomes this
  // workspace's overrides of the machine's defaults — nothing it chose is
  // lost, and nothing it never chose is set.
  it("migrates the stored one-choice scope to this workspace's overrides, once, keeping the command rules", () => {
    const cases: [string, unknown][] = [
      ["workspace", []],
      ["workspace+temp", [{ location: { kind: "temp" }, on: true }]],
      ["always-ask", [{ location: { kind: "alwaysAsk" }, on: true }]],
      ["anywhere", []],
      ["toString", []],
    ];
    for (const [fileWriteScope, writeScope] of cases) {
      const kv = new MemoryKV();
      const commandRules = [{ kind: "command", pattern: "npm test", verdict: "allow" }];
      void kv.update(STORAGE_KEYS.permissionRules, { commandRules, fileWriteScope });
      expect(new PermissionRulesStore(kv).get()).toEqual({ commandRules, writeScope });
      expect(kv.get(STORAGE_KEYS.permissionRules)).toEqual({ commandRules, writeScope });
    }
  });

  it("each half stored in a shape this version doesn't take reads as its default; a stray rule is skipped", () => {
    const kv = new MemoryKV();
    void kv.update(STORAGE_KEYS.permissionRules, {
      commandRules: [{ kind: "command", pattern: "npm test", verdict: "allow" }, { kind: "command", pattern: "x", verdict: "maybe" }],
      writeScope: "anywhere",
    });
    expect(new PermissionRulesStore(kv).get()).toEqual({
      commandRules: [{ kind: "command", pattern: "npm test", verdict: "allow" }],
      writeScope: DEFAULT_PERMISSION_RULES.writeScope,
    });
    void kv.update(STORAGE_KEYS.permissionRules, "always-ask");
    expect(new PermissionRulesStore(kv).get()).toEqual(DEFAULT_PERMISSION_RULES);
  });
});

// The stores an import reads through: a file can hold anything, so what
// isn't a stored shape is skipped piece by piece, never trusted blind.
describe("MachineRulesStore", () => {
  it("a stored rule that isn't one is skipped; the rest hold", () => {
    const kv = new MemoryKV();
    void kv.update(STORAGE_KEYS.machineCommandRules, [
      { kind: "command", pattern: "git status", verdict: "allow" },
      { kind: "command", pattern: "", verdict: "allow" },
      { kind: "command", pattern: "rm *", verdict: "maybe" },
      "npm test",
      null,
    ]);
    expect(new MachineRulesStore(kv).get().commandRules).toEqual([{ kind: "command", pattern: "git status", verdict: "allow" }]);
  });

  it("a word rule is one word that denies or asks — an allow, or a space, is no word rule", () => {
    const kv = new MemoryKV();
    void kv.update(STORAGE_KEYS.machineCommandRules, [
      { kind: "word", pattern: "sudo", verdict: "deny" },
      { kind: "word", pattern: "--watch", verdict: "ask" },
      { kind: "word", pattern: "logs", verdict: "allow" },
      { kind: "word", pattern: "rm -rf", verdict: "deny" },
      { kind: "word", pattern: "", verdict: "deny" },
    ]);
    expect(new MachineRulesStore(kv).get().commandRules).toEqual([
      { kind: "word", pattern: "sudo", verdict: "deny" },
      { kind: "word", pattern: "--watch", verdict: "ask" },
    ]);
  });

  // Every rule stored before rules had kinds matched the whole command.
  it("rules stored without a kind become command rules, once, in both layers", () => {
    const machineKv = new MemoryKV();
    void machineKv.update(STORAGE_KEYS.machineCommandRules, [{ pattern: "git status", verdict: "allow" }, "junk"]);
    new MachineRulesStore(machineKv);
    expect(machineKv.get(STORAGE_KEYS.machineCommandRules)).toEqual([{ kind: "command", pattern: "git status", verdict: "allow" }, "junk"]);
    const workspaceKv = new MemoryKV();
    void workspaceKv.update(STORAGE_KEYS.permissionRules, { commandRules: [{ pattern: "npm *", verdict: "deny" }], writeScope: [] });
    expect(new PermissionRulesStore(workspaceKv).get().commandRules).toEqual([{ kind: "command", pattern: "npm *", verdict: "deny" }]);
    expect(workspaceKv.get(STORAGE_KEYS.permissionRules)).toEqual({ commandRules: [{ kind: "command", pattern: "npm *", verdict: "deny" }], writeScope: [] });
  });

  it("a rule is named by its kind and pattern: the same one replaces its verdict, the other kind joins", () => {
    const rules = withRule([{ kind: "command", pattern: "sudo", verdict: "allow" }], { kind: "word", pattern: "sudo", verdict: "deny" });
    expect(withRule(rules, { kind: "command", pattern: "sudo", verdict: "ask" })).toEqual([
      { kind: "command", pattern: "sudo", verdict: "ask" },
      { kind: "word", pattern: "sudo", verdict: "deny" },
    ]);
  });

  it("a stored value that isn't a list holds no rules", () => {
    for (const junk of ["git status", 42, { kind: "command", pattern: "x", verdict: "allow" }, null]) {
      const kv = new MemoryKV();
      void kv.update(STORAGE_KEYS.machineCommandRules, junk);
      expect(new MachineRulesStore(kv).get().commandRules).toEqual([]);
    }
  });
});

describe("MachineWriteScopeStore", () => {
  it("a stored entry that isn't one is skipped — a relative folder too — and a place held twice keeps its first", () => {
    const kv = new MemoryKV();
    void kv.update(STORAGE_KEYS.machineWriteScope, [
      { location: { kind: "temp" }, on: true },
      { location: { kind: "path", path: "/home/me/.hermes" }, on: true },
      { location: { kind: "path", path: "relative/dir" }, on: true },
      { location: { kind: "home" }, on: true },
      { location: { kind: "temp" }, on: false },
      { location: { kind: "workspace" }, on: "yes" },
      { location: { kind: "roots" }, on: true },
      "temp",
      null,
    ]);
    expect(new MachineWriteScopeStore(kv).get()).toEqual([
      { location: { kind: "temp" }, on: true },
      { location: { kind: "path", path: "/home/me/.hermes" }, on: true },
    ]);
    void kv.update(STORAGE_KEYS.machineWriteScope, { temp: true });
    expect(new MachineWriteScopeStore(kv).get()).toEqual([]);
  });
});

describe("writeScopeRows", () => {
  const hermes = { kind: "path", path: "/home/me/.hermes" } as const;
  const infra = { kind: "path", path: "/srv/infra" } as const;

  it("nothing set: the mute off, the workspace on, session roots and temp off — no folders", () => {
    expect(writeScopeRows([], [])).toEqual([
      { location: { kind: "alwaysAsk" }, machine: false, workspace: null, on: false },
      { location: { kind: "workspace" }, machine: true, workspace: null, on: true },
      { location: { kind: "sessionRoots" }, machine: false, workspace: null, on: false },
      { location: { kind: "temp" }, machine: false, workspace: null, on: false },
    ]);
  });

  it("this workspace's answer holds over the machine's, either way; a folder only it added has no machine answer", () => {
    const rows = writeScopeRows(
      [{ location: { kind: "temp" }, on: true }, { location: hermes, on: true }],
      [{ location: { kind: "workspace" }, on: false }, { location: hermes, on: false }, { location: infra, on: true }],
    );
    expect(rows.map((r) => [r.location, r.machine, r.workspace, r.on])).toEqual([
      [{ kind: "alwaysAsk" }, false, null, false],
      [{ kind: "workspace" }, true, false, false],
      [{ kind: "sessionRoots" }, false, null, false],
      [{ kind: "temp" }, true, null, true],
      [hermes, true, false, false],
      [infra, null, true, true],
    ]);
  });

  it("an answer set in place, appended when new, dropped by null", () => {
    const entries = [{ location: { kind: "temp" }, on: true }, { location: hermes, on: true }] as const;
    expect(withWriteEntry(entries, { kind: "temp" }, false)).toEqual([{ location: { kind: "temp" }, on: false }, { location: hermes, on: true }]);
    expect(withWriteEntry(entries, infra, true)).toEqual([...entries, { location: infra, on: true }]);
    expect(withWriteEntry(entries, hermes, null)).toEqual([{ location: { kind: "temp" }, on: true }]);
  });
});

describe("ComposerKnobsStore", () => {
  it("an agent's stored combination that isn't one reads as none; the others hold", async () => {
    const kv = new MemoryKV();
    void kv.update(STORAGE_KEYS.lastKnobs, { a: { mode: "plan", thinking: true }, b: "plan", c: { mode: 3 }, d: null });
    const store = new ComposerKnobsStore(kv);
    expect(store.get("a" as PatchbayAgentId)).toEqual({ mode: "plan", thinking: true });
    expect(["b", "c", "d"].map((id) => store.get(id as PatchbayAgentId))).toEqual([undefined, undefined, undefined]);
    expect(store.count()).toBe(1);
    // The next write keeps only what read as a combination.
    await store.record("e" as PatchbayAgentId, { model: "opus" });
    expect(kv.get(STORAGE_KEYS.lastKnobs)).toEqual({ a: { mode: "plan", thinking: true }, e: { model: "opus" } });
  });

  it("a stored value that isn't a record holds no combinations", () => {
    for (const junk of ["plan", 42, [{ mode: "plan" }], null]) {
      const kv = new MemoryKV();
      void kv.update(STORAGE_KEYS.lastKnobs, junk);
      expect(new ComposerKnobsStore(kv).count()).toBe(0);
    }
  });
});

describe("SavedRootsStore — the roots every new session starts with", () => {
  it("adds a path once, removes it, and keeps each scope apart even over one store", async () => {
    const kv = new MemoryKV();
    const workspace = new SavedRootsStore(kv, "workspace");
    const machine = new SavedRootsStore(kv, "machine");
    await workspace.add("/src/lib");
    await workspace.add("/src/lib");
    await machine.add("/src/odoo");
    expect(workspace.list()).toEqual(["/src/lib"]);
    expect(machine.list()).toEqual(["/src/odoo"]);
    await workspace.remove("/src/lib");
    expect(workspace.list()).toEqual([]);
    expect(machine.list()).toEqual(["/src/odoo"]);
    await machine.wipe();
    expect(machine.list()).toEqual([]);
  });

  it("replace keeps the saved order; a replacement already saved just drops the old entry", async () => {
    const store = new SavedRootsStore(new MemoryKV(), "workspace");
    await store.add("/a");
    await store.add("/b");
    await store.add("/c");
    await store.replace("/b", "/b2");
    expect(store.list()).toEqual(["/a", "/b2", "/c"]);
    await store.replace("/a", "/c");
    expect(store.list()).toEqual(["/b2", "/c"]);
  });

  it("a stored entry that isn't a path is skipped; a stored value that isn't a list holds none", () => {
    const kv = new MemoryKV();
    void kv.update(STORAGE_KEYS.machineSavedRoots, ["/a", 3, "", null, "/b"]);
    expect(new SavedRootsStore(kv, "machine").list()).toEqual(["/a", "/b"]);
    for (const junk of ["/a", 42, { path: "/a" }, null]) {
      void kv.update(STORAGE_KEYS.machineSavedRoots, junk);
      expect(new SavedRootsStore(kv, "machine").list()).toEqual([]);
    }
  });
});

describe("DecisionAuditStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir("patchbay-audit-");
  });

  it("appends JSONL in order and tails", async () => {
    const store = new DecisionAuditStore(dir);
    await store.append({ kind: "allow-once", tool: "terminal", cmd: "npm run build" });
    await store.append({ kind: "rule-add", pattern: "npm run *" });
    const tail = await store.tail(10);
    expect(tail.map((e) => e.kind)).toEqual(["allow-once", "rule-add"]);
    expect(tail[0]?.ts).toBeTruthy();
  });

  it("tail skips torn lines instead of failing", async () => {
    const store = new DecisionAuditStore(dir);
    await store.append({ kind: "a" });
    await writeFile(join(dir, "decision-audit.jsonl"), '{"kind":"a","ts":"x"}\n{broken\n', "utf8");
    const tail = await store.tail(10);
    expect(tail.map((e) => e.kind)).toEqual(["a"]);
  });

  it("is a no-op without a workspace", async () => {
    const store = new DecisionAuditStore(null);
    await store.append({ kind: "a" });
    expect(await store.tail(5)).toEqual([]);
  });
});

describe("GlobalRecordStore", () => {
  const schema = z.object({ id: z.string().min(1), label: z.string().default("") });
  type Rec = z.infer<typeof schema>;

  it("upserts by id — appends new, replaces existing, never duplicates", async () => {
    const store = new GlobalRecordStore<Rec>(new MemoryKV(), "test.records", schema);
    await store.upsert({ id: "a", label: "first" });
    await store.upsert({ id: "b", label: "second" });
    expect(store.list().map((r) => r.id)).toEqual(["a", "b"]);

    await store.upsert({ id: "a", label: "updated" });
    expect(store.list()).toHaveLength(2);
    expect(store.get("a")?.label).toBe("updated");
  });

  it("removes by id", async () => {
    const store = new GlobalRecordStore<Rec>(new MemoryKV(), "test.records", schema);
    await store.upsert({ id: "a", label: "x" });
    await store.remove("a");
    expect(store.list()).toEqual([]);
  });

  it("drops a malformed stored record instead of trusting it blind — a trust boundary, not undefined behavior", async () => {
    const kv = new MemoryKV();
    await kv.update("test.records", [{ id: "ok", label: "fine" }, { label: "no id" }, "not even an object"]);
    const store = new GlobalRecordStore<Rec>(kv, "test.records", schema);
    expect(store.list()).toEqual([{ id: "ok", label: "fine" }]);
  });

  it("two stores over the same underlying key see each other's writes", async () => {
    const kv = new MemoryKV();
    const a = new GlobalRecordStore<Rec>(kv, "shared", schema);
    const b = new GlobalRecordStore<Rec>(kv, "shared", schema);
    expect(a.list()).toEqual([]);
    await b.upsert({ id: "x", label: "" });
    expect(a.list().map((r) => r.id)).toEqual(["x"]);
  });
});

describe("SecretEnvStore — env values live in SecretStorage, never globalState", () => {
  it("round-trips a record per id and deletes on empty set", async () => {
    const secrets = new MemorySecrets();
    const store = new SecretEnvStore(secrets, SECRET_FAMILIES.agent);
    await store.set("a1", { FOO_API_KEY: "sk-123", DEBUG: "1" });
    expect(await store.get("a1")).toEqual({ FOO_API_KEY: "sk-123", DEBUG: "1" });
    expect(await store.get("other")).toEqual({});

    await store.set("a1", {}); // writing empty is a delete, not an empty blob
    expect(await secrets.get(`${SECRET_FAMILIES.agent}.a1.env`)).toBeUndefined();
  });

  it("two prefixes over one SecretStorage never collide", async () => {
    const secrets = new MemorySecrets();
    const agents = new SecretEnvStore(secrets, SECRET_FAMILIES.agent);
    const mcpServers = new SecretEnvStore(secrets, SECRET_FAMILIES.mcpServer);
    await agents.set("x", { A: "1" });
    await mcpServers.set("x", { B: "2" });
    expect(await agents.get("x")).toEqual({ A: "1" });
    expect(await mcpServers.get("x")).toEqual({ B: "2" });
  });

  it("remove purges the record", async () => {
    const secrets = new MemorySecrets();
    const store = new SecretEnvStore(secrets, SECRET_FAMILIES.agent);
    await store.set("a1", { K: "v" });
    await store.remove("a1");
    expect(await store.get("a1")).toEqual({});
  });

  it("a malformed stored record reads as empty and is logged by its id — never with its value", async () => {
    const secrets = new MemorySecrets();
    const logged: string[] = [];
    const store = new SecretEnvStore(secrets, SECRET_FAMILIES.agent, (message) => logged.push(message));
    await secrets.store(`${SECRET_FAMILIES.agent}.bad.env`, "{not json sk-secret");
    await secrets.store(`${SECRET_FAMILIES.agent}.list.env`, '["sk-secret"]');
    await secrets.store(`${SECRET_FAMILIES.agent}.num.env`, '{"K": 1}');
    expect(await store.get("bad")).toEqual({});
    expect(await store.get("list")).toEqual({});
    expect(await store.get("num")).toEqual({});
    expect(logged).toHaveLength(3);
    expect(logged.join("\n")).toContain("bad");
    expect(logged.join("\n")).not.toContain("sk-secret");
  });
});

describe("PreferencesStore — machine-scoped behavior defaults", () => {
  it("reads complete defaults from an empty store, merges patches over them", async () => {
    const store = new PreferencesStore(new MemoryKV());
    expect(store.get()).toEqual(DEFAULT_PREFERENCES);

    await store.set({ soundOnDone: false });
    expect(store.get()).toEqual({ ...DEFAULT_PREFERENCES, soundOnDone: false });

    // A later patch never clobbers an earlier one.
    await store.set({ idleCloseMinutes: 0 });
    expect(store.get()).toEqual({ ...DEFAULT_PREFERENCES, soundOnDone: false, idleCloseMinutes: 0 });
  });

  it("an older stored object missing newer keys reads as defaults for them", () => {
    const kv = new MemoryKV();
    void kv.update(STORAGE_KEYS.preferences, { soundOnDone: false });
    const store = new PreferencesStore(kv);
    expect(store.get()).toEqual({ ...DEFAULT_PREFERENCES, soundOnDone: false });
  });

  it("a stored one-switch composerStats splits into a switch per read-out, then is gone", () => {
    const hidden = new MemoryKV();
    void hidden.update(STORAGE_KEYS.preferences, { composerStats: false, soundOnDone: false });
    expect(new PreferencesStore(hidden).get()).toEqual({
      ...DEFAULT_PREFERENCES,
      soundOnDone: false,
      statsToolCalls: false,
      statsContext: false,
      statsPlanUsage: false,
    });
    expect(hidden.get(STORAGE_KEYS.preferences)).not.toHaveProperty("composerStats");

    expect(hidden.get(STORAGE_KEYS.preferences)).not.toHaveProperty("statsPrompts");

    // "shown" was the default — it maps to nothing but the key's removal.
    const shown = new MemoryKV();
    void shown.update(STORAGE_KEYS.preferences, { composerStats: true });
    expect(new PreferencesStore(shown).get()).toEqual(DEFAULT_PREFERENCES);
    expect(shown.get(STORAGE_KEYS.preferences)).toEqual({});
  });

  it("a stored statsPrompts is retired — the prompt count moved to the prompts chip", () => {
    const kv = new MemoryKV();
    void kv.update(STORAGE_KEYS.preferences, { statsPrompts: false, statsContext: false });
    expect(new PreferencesStore(kv).get()).toEqual({ ...DEFAULT_PREFERENCES, statsContext: false });
    expect(kv.get(STORAGE_KEYS.preferences)).toEqual({ statsContext: false });
  });

  it("a stored doneSound is retired — the chime has no sound to pick; the switch keeps its word", () => {
    const kv = new MemoryKV();
    void kv.update(STORAGE_KEYS.preferences, { soundOnDone: false, doneSound: "Glass" });
    expect(new PreferencesStore(kv).get()).toEqual({ ...DEFAULT_PREFERENCES, soundOnDone: false });
    expect(kv.get(STORAGE_KEYS.preferences)).toEqual({ soundOnDone: false });
  });

  it("a stored value that isn't an object never throws, and reads as the defaults", () => {
    for (const junk of ["composerStats", 42, null]) {
      const kv = new MemoryKV();
      void kv.update(STORAGE_KEYS.preferences, junk);
      expect(new PreferencesStore(kv).get()).toEqual(DEFAULT_PREFERENCES);
    }
  });

  it("a stored preference in a shape this version doesn't take reads as its default; the others keep theirs", () => {
    const kv = new MemoryKV();
    void kv.update(STORAGE_KEYS.preferences, {
      soundOnDone: "yes",
      knobSource: "sometimes",
      idleCloseMinutes: "5",
      executeCalls: "uncollapsed",
      openThinking: true,
      unknownLater: true,
    });
    expect(new PreferencesStore(kv).get()).toEqual({ ...DEFAULT_PREFERENCES, executeCalls: "uncollapsed", openThinking: true });
  });

  it("wipe returns to factory defaults", async () => {
    const store = new PreferencesStore(new MemoryKV());
    await store.set({ knobSource: "last-session" });
    await store.wipe();
    expect(store.get()).toEqual(DEFAULT_PREFERENCES);
  });
});

describe("ComposerKnobsStore — the composer combination per agent", () => {
  it("records per agent, replaces wholesale, counts records", async () => {
    const store = new ComposerKnobsStore(new MemoryKV());
    expect(store.get("claude" as PatchbayAgentId)).toBeUndefined();
    expect(store.count()).toBe(0);

    await store.record("claude" as PatchbayAgentId, { mode: "code", effort: "high" });
    await store.record("gemini" as PatchbayAgentId, { mode: "chat" });
    expect(store.get("claude" as PatchbayAgentId)).toEqual({ mode: "code", effort: "high" });
    expect(store.count()).toBe(2);

    // Each record is the whole combination — no merge with the previous.
    await store.record("claude" as PatchbayAgentId, { mode: "plan" });
    expect(store.get("claude" as PatchbayAgentId)).toEqual({ mode: "plan" });
    expect(store.count()).toBe(2);
  });
});

describe("UsedCapabilityStore.seed — the fresh claim outranks the cache", () => {
  const declared = (over: Partial<DeclaredCapabilities>): DeclaredCapabilities => ({
    loadSession: false, sessionFork: false, sessionResume: false, sessionList: false,
    sessionDelete: false, sessionClose: false, sessionAdditionalDirectories: false,
    promptImage: false, promptAudio: false, promptEmbeddedContext: false,
    mcpHttp: false, mcpSse: false, authMethods: [], authLogout: false,
    ...over,
  });

  it("used restores only while the new connect still makes the claim", async () => {
    const store = new UsedCapabilityStore(new MemoryKV());
    const earned = matrixFromDeclared(declared({ sessionFork: true }));
    await store.save("a" as PatchbayAgentId, "1.0", { ...earned, "session.fork": { declared: true, used: true } });
    const stillClaimed = store.seed("a" as PatchbayAgentId, "1.0", matrixFromDeclared(declared({ sessionFork: true })));
    expect(stillClaimed["session.fork"]).toEqual({ declared: true, used: true });
    // Claim withdrawn: a restored used=true would light a feature the spec
    // now forbids calling.
    const withdrawn = store.seed("a" as PatchbayAgentId, "1.0", matrixFromDeclared(declared({})));
    expect(withdrawn["session.fork"]).toEqual({ declared: false, used: false });
  });

  it("suspect restores regardless of the fresh claim — a declaration flicker at the same version must not launder the warning", async () => {
    const store = new UsedCapabilityStore(new MemoryKV());
    const base = matrixFromDeclared(declared({ loadSession: true }));
    await store.save("a" as PatchbayAgentId, "1.0", {
      ...base,
      "session.load": { declared: true, used: false, suspect: true },
    });
    const stillClaimed = store.seed("a" as PatchbayAgentId, "1.0", matrixFromDeclared(declared({ loadSession: true })));
    expect(stillClaimed["session.load"]).toEqual({ declared: true, used: false, suspect: true });
    // Claim withdrawn at the SAME version: the warning stands — only an
    // actual version change resets it honestly (suspect gates nothing).
    const withdrawn = store.seed("a" as PatchbayAgentId, "1.0", matrixFromDeclared(declared({})));
    expect(withdrawn["session.load"]).toEqual({ declared: true, used: false, suspect: true });
  });

  it("claimless-provable rows (usage, concurrentSessions, auth) restore regardless — the mark carried the claim", async () => {
    const store = new UsedCapabilityStore(new MemoryKV());
    const base = matrixFromDeclared(declared({}));
    await store.save("a" as PatchbayAgentId, "1.0", {
      ...base,
      usage: { declared: true, used: true },
      auth: { declared: true, used: true },
    });
    const seeded = store.seed("a" as PatchbayAgentId, "1.0", matrixFromDeclared(declared({})));
    expect(seeded.usage).toEqual({ declared: true, used: true });
    expect(seeded.auth).toEqual({ declared: true, used: true });
  });
});

describe("SessionContinuityStore", () => {
  it("a row stored under one composite id reads by its pair — nothing dropped, nothing left to fold", async () => {
    const kv = new MemoryKV();
    await kv.update(STORAGE_KEYS.sessionContinuity, [
      { id: "claude\u0000s1", agentId: "claude", cwd: "/ws", draft: "kept words" },
      { patchbayAgentId: "auggie", sessionId: "s2", draft: "already paired" },
    ]);
    const store = new SessionContinuityStore(kv);
    expect(store.read("claude" as PatchbayAgentId, "s1")).toEqual({ draft: "kept words" });
    expect(store.read("auggie" as PatchbayAgentId, "s2")).toEqual({ draft: "already paired" });
    expect(JSON.stringify(kv.get(STORAGE_KEYS.sessionContinuity))).not.toContain("agentId\"");
  });

  it("an image chip stored by its name in the temp stash reads by that file's path — nothing dropped, nothing left to fold", async () => {
    const kv = new MemoryKV();
    await kv.update(STORAGE_KEYS.sessionContinuity, [
      {
        patchbayAgentId: "claude",
        sessionId: "s1",
        cwd: "/ws",
        chips: [
          { kind: "image", id: "chip-1", label: "Image", mimeType: "image/png", file: "chip-1.png" },
          { kind: "attachment", id: "chip-2", label: "File: a.txt", path: "/home/u/a.txt" },
        ],
      },
      // both older shapes in one row: each is rewritten
      { id: "auggie\u0000s2", agentId: "auggie", chips: [{ kind: "image", id: "chip-3", label: "Image", mimeType: "image/png", file: "chip-3.png" }] },
    ]);
    const store = new SessionContinuityStore(kv);
    expect(store.read("claude" as PatchbayAgentId, "s1")?.chips).toEqual([
      { kind: "image", id: "chip-1", label: "Image", mimeType: "image/png", path: join(ATTACHMENTS_DIR, "chip-1.png") },
      { kind: "attachment", id: "chip-2", label: "File: a.txt", name: "a.txt", path: "/home/u/a.txt" },
    ]);
    expect(store.read("auggie" as PatchbayAgentId, "s2")?.chips).toEqual([
      { kind: "image", id: "chip-3", label: "Image", mimeType: "image/png", path: join(ATTACHMENTS_DIR, "chip-3.png") },
    ]);
    expect(JSON.stringify(kv.get(STORAGE_KEYS.sessionContinuity))).not.toContain("\"file\"");
  });

  it("an attached file stored without its own name takes it from its label — staged or held, nothing dropped", async () => {
    const kv = new MemoryKV();
    const unnamed = (id: string, label: string, path: string) => ({ kind: "attachment", id, label, path });
    await kv.update(STORAGE_KEYS.sessionContinuity, [
      {
        patchbayAgentId: "claude",
        sessionId: "s1",
        chips: [unnamed("chip-1", "File: my notes.txt", "/s/chip-1-my_notes.txt")],
        queue: [
          { id: "q1", text: "held", chips: [unnamed("chip-2", "File: report.pdf", "/s/chip-2-report.pdf")] },
          { id: "q2", text: "no chips" },
        ],
      },
      // a label some other hand spelled: the path's own name, the one left
      { patchbayAgentId: "claude", sessionId: "s2", chips: [unnamed("chip-3", "Picked", "/home/u/plan.md")] },
    ]);
    const store = new SessionContinuityStore(kv);
    const s1 = store.read("claude" as PatchbayAgentId, "s1");
    expect(s1?.chips).toEqual([{ ...unnamed("chip-1", "File: my notes.txt", "/s/chip-1-my_notes.txt"), name: "my notes.txt" }]);
    expect(s1?.queue).toEqual([
      { id: "q1", text: "held", chips: [{ ...unnamed("chip-2", "File: report.pdf", "/s/chip-2-report.pdf"), name: "report.pdf" }] },
      { id: "q2", text: "no chips" },
    ]);
    expect(store.read("claude" as PatchbayAgentId, "s2")?.chips).toEqual([{ ...unnamed("chip-3", "Picked", "/home/u/plan.md"), name: "plan.md" }]);
  });

  const ws = "/ws/a";

  it("reads are checked by agent — a colliding session id under another agent reads absent", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    await store.patch("claude" as PatchbayAgentId, "s1", ws, { knobs: { model: "sonnet", thinking: true } });
    expect(store.read("claude" as PatchbayAgentId, "s1")?.knobs).toEqual({ model: "sonnet", thinking: true });
    // session ids are agent-minted: the same string under a different agent
    // is a different session, never the other agent's state
    expect(store.read("auggie" as PatchbayAgentId, "s1")).toBeUndefined();
    expect(store.read("claude" as PatchbayAgentId, "s2")).toBeUndefined();
    await store.forget("claude" as PatchbayAgentId, "s1");
    expect(store.read("claude" as PatchbayAgentId, "s1")).toBeUndefined();
  });

  it("patch merges fields; empty values delete them; a fieldless row leaves the store", async () => {
    const kv = new MemoryKV();
    const store = new SessionContinuityStore(kv);
    await store.patch("claude" as PatchbayAgentId, "s1", ws, { knobs: { model: "sonnet" } });
    await store.patch("claude" as PatchbayAgentId, "s1", ws, {
      queue: [{ id: "q1", text: "held", draft: '{"editor":"held"}' }],
      draft: "typing…",
    });
    expect(store.read("claude" as PatchbayAgentId, "s1")).toEqual({
      knobs: { model: "sonnet" },
      queue: [{ id: "q1", text: "held", draft: '{"editor":"held"}' }],
      draft: "typing…",
    });
    // a held row's editor state survives the next window's load — the
    // schema must carry it, not strip it as an unknown key
    expect(new SessionContinuityStore(kv).read("claude" as PatchbayAgentId, "s1")?.queue).toEqual([
      { id: "q1", text: "held", draft: '{"editor":"held"}' },
    ]);
    // drained queue and cleared draft drop their fields, knobs stand
    await store.patch("claude" as PatchbayAgentId, "s1", ws, { queue: [], draft: "" });
    expect(store.read("claude" as PatchbayAgentId, "s1")).toEqual({ knobs: { model: "sonnet" } });
    // last field emptied → the row itself leaves
    await store.patch("claude" as PatchbayAgentId, "s1", ws, { knobs: undefined });
    expect(store.list()).toEqual([]);
  });

  it("two agents' colliding session ids keep separate rows — one can never destroy the other's", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    await store.patch("claude" as PatchbayAgentId, "1", ws, { knobs: { model: "sonnet" } });
    await store.patch("auggie" as PatchbayAgentId, "1", ws, { draft: "other agent, same id" });
    expect(store.read("claude" as PatchbayAgentId, "1")).toEqual({ knobs: { model: "sonnet" } });
    expect(store.read("auggie" as PatchbayAgentId, "1")).toEqual({ draft: "other agent, same id" });
    // an empty-draft save under one agent removes only that agent's row
    await store.patch("auggie" as PatchbayAgentId, "1", ws, { draft: "" });
    expect(store.read("auggie" as PatchbayAgentId, "1")).toBeUndefined();
    expect(store.read("claude" as PatchbayAgentId, "1")).toEqual({ knobs: { model: "sonnet" } });
  });

  it("an empty knobs object is a deletion, not a husk field", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    await store.patch("claude" as PatchbayAgentId, "s1", ws, { knobs: {} });
    expect(store.list()).toEqual([]);
  });

  // A row exists to be read back after a reload, and that read has two
  // preconditions: the agent's own list names the session again, and the
  // open ladder has a rung to bring it back. Either missing, the row is
  // written for nobody.

  it("reconcile: this workspace's unreported rows leave, rows without a cwd are stamped when reported and dropped otherwise, other workspaces untouched", async () => {
    const kv = new MemoryKV();
    const store = new SessionContinuityStore(kv);
    await store.patch("claude" as PatchbayAgentId, "kept", ws, { draft: "a" });
    await store.patch("claude" as PatchbayAgentId, "gone", ws, { draft: "b" });
    await store.patch("claude" as PatchbayAgentId, "elsewhere", "/ws/b", { draft: "c" });
    await store.patch("auggie" as PatchbayAgentId, "other-agent", ws, { draft: "d" });
    // rows written before the cwd field existed
    const raw = kv.get<unknown[]>(STORAGE_KEYS.sessionContinuity) ?? [];
    await kv.update(STORAGE_KEYS.sessionContinuity, [
      ...raw,
      { patchbayAgentId: "claude", sessionId: "legacy-kept", draft: "e" },
      { patchbayAgentId: "claude", sessionId: "legacy-gone", draft: "f" },
    ]);
    await store.reconcile("claude" as PatchbayAgentId, ws, (id) => id === "kept" || id === "legacy-kept");
    expect(store.read("claude" as PatchbayAgentId, "kept")).toEqual({ draft: "a" });
    expect(store.read("claude" as PatchbayAgentId, "gone")).toBeUndefined();
    expect(store.read("claude" as PatchbayAgentId, "elsewhere")).toEqual({ draft: "c" });
    expect(store.read("auggie" as PatchbayAgentId, "other-agent")).toEqual({ draft: "d" });
    expect(store.read("claude" as PatchbayAgentId, "legacy-kept")).toEqual({ draft: "e" });
    expect(store.list().find((r) => r.patchbayAgentId === "claude" && r.sessionId === "legacy-kept")?.cwd).toBe(ws);
    expect(store.read("claude" as PatchbayAgentId, "legacy-gone")).toBeUndefined();
  });

  it("forgetAgent drops the agent's rows in every workspace — no index required", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    await store.patch("claude" as PatchbayAgentId, "s1", ws, { draft: "a" });
    await store.patch("claude" as PatchbayAgentId, "s2", "/ws/b", { draft: "b" });
    await store.patch("auggie" as PatchbayAgentId, "s1", ws, { draft: "c" });
    await store.forgetAgent("claude" as PatchbayAgentId);
    expect(store.list().map((r) => r.patchbayAgentId)).toEqual(["auggie"]);
  });
});
