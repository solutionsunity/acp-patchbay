// Stores: session index over KV, permission rules defaults, decision audit
// JSONL append/tail, the generic globalState-backed record store agents/
// integrations/used-capabilities all share.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
import { GlobalRecordStore } from "../src/orchestrator/stores/global-record-store";
import { MemorySecrets } from "../src/orchestrator/stores/integration-tokens";
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
  PermissionRulesStore,
} from "../src/orchestrator/stores/permission-rules";
import { SpawnRegistryStore } from "../src/orchestrator/stores/spawn-registry";

describe("SpawnRegistryStore", () => {
  it("records spawns keyed by pid and clears them on observed exit", async () => {
    const store = new SpawnRegistryStore(new MemoryKV());
    await store.add(1234, "node agent.js", "agent");
    await store.add(5678, "npm test", "terminal");
    expect(store.list().map((r) => r.pid)).toEqual([1234, 5678]);
    expect(store.get("1234")?.kind).toBe("agent");

    await store.removePid(1234);
    expect(store.list().map((r) => r.pid)).toEqual([5678]);
  });

  it("a re-spawned pid replaces the stale record — one machine, one live pid", async () => {
    const store = new SpawnRegistryStore(new MemoryKV());
    await store.add(1234, "node old-agent.js", "agent");
    await store.add(1234, "npm run stress", "terminal");
    expect(store.list()).toHaveLength(1);
    expect(store.get("1234")?.command).toBe("npm run stress");
  });
});

describe("LastConnectedStore — reload-continuation stamp", () => {
  it("a fresh stamp yields its ids, and is spent by the read", async () => {
    const store = new LastConnectedStore(new MemoryKV());
    await store.write(["claude", "gemini"]);
    expect(await store.consume()).toEqual(["claude", "gemini"]);
    // Spent: one stamp can never drive two activations.
    expect(await store.consume()).toEqual([]);
  });

  it("a stale stamp yields nothing — quit-and-reopen-later must not resurrect agents", async () => {
    const store = new LastConnectedStore(new MemoryKV());
    await store.write(["claude"]);
    const later = new Date(Date.now() + RELOAD_GRACE_MS + 1);
    expect(await store.consume(later)).toEqual([]);
  });

  it("absent or torn stamps yield nothing, never throw", async () => {
    const kv = new MemoryKV();
    const store = new LastConnectedStore(kv);
    expect(await store.consume()).toEqual([]);
    await kv.update("acpPatchbay.lastConnected", { agentIds: "not-an-array", at: new Date().toISOString() });
    expect(await store.consume()).toEqual([]);
    await kv.update("acpPatchbay.lastConnected", { agentIds: ["ok", 42], at: "not-a-date" });
    expect(await store.consume()).toEqual([]);
  });

  it("an empty write still lands — a shutdown with nothing running clears any stale stamp", async () => {
    const store = new LastConnectedStore(new MemoryKV());
    await store.write(["claude"]);
    await store.write([]);
    expect(await store.consume()).toEqual([]);
  });
});

describe("LastActiveSessionStore — the last-open-session pointer", () => {
  it("holds the latest activation; close clears only while it still points there", async () => {
    const store = new LastActiveSessionStore(new MemoryKV());
    expect(store.get()).toBeUndefined();
    await store.set("s1");
    await store.set("s2");
    expect(store.get()).toBe("s2");
    // Closing a session the user already switched away from must not
    // erase the newer pointer.
    await store.clearIf("s1");
    expect(store.get()).toBe("s2");
    await store.clearIf("s2");
    expect(store.get()).toBeUndefined();
  });

  it("survives what a reload survives — no freshness bound, unlike the stamp", async () => {
    const kv = new MemoryKV();
    await new LastActiveSessionStore(kv).set("s1");
    // A fresh store over the same KV (the next activate) still reads it.
    expect(new LastActiveSessionStore(kv).get()).toBe("s1");
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
      commandRules: [{ pattern: "npm run *", verdict: "allow" }],
      fileWriteScope: "always-ask",
    });
    expect(store.get().commandRules).toHaveLength(1);
    expect(store.get().fileWriteScope).toBe("always-ask");
  });
});

describe("DecisionAuditStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "patchbay-audit-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

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
    const store = new SecretEnvStore(secrets, "acpPatchbay.agent");
    await store.set("a1", { FOO_API_KEY: "sk-123", DEBUG: "1" });
    expect(await store.get("a1")).toEqual({ FOO_API_KEY: "sk-123", DEBUG: "1" });
    expect(await store.get("other")).toEqual({});

    await store.set("a1", {}); // writing empty is a delete, not an empty blob
    expect(await secrets.get("acpPatchbay.agent.a1.env")).toBeUndefined();
  });

  it("two prefixes over one SecretStorage never collide", async () => {
    const secrets = new MemorySecrets();
    const agents = new SecretEnvStore(secrets, "acpPatchbay.agent");
    const integrations = new SecretEnvStore(secrets, "acpPatchbay.integration");
    await agents.set("x", { A: "1" });
    await integrations.set("x", { B: "2" });
    expect(await agents.get("x")).toEqual({ A: "1" });
    expect(await integrations.get("x")).toEqual({ B: "2" });
  });

  it("remove purges the record; malformed stored JSON reads as empty, never throws", async () => {
    const secrets = new MemorySecrets();
    const store = new SecretEnvStore(secrets, "acpPatchbay.agent");
    await store.set("a1", { K: "v" });
    await store.remove("a1");
    expect(await store.get("a1")).toEqual({});

    await secrets.store("acpPatchbay.agent.bad.env", "{not json");
    expect(await store.get("bad")).toEqual({});
  });
});

describe("PreferencesStore — machine-scoped behavior defaults", () => {
  it("reads complete defaults from an empty store, merges patches over them", async () => {
    const store = new PreferencesStore(new MemoryKV());
    expect(store.get()).toEqual(DEFAULT_PREFERENCES);

    await store.set({ soundOnDone: true });
    expect(store.get()).toEqual({ ...DEFAULT_PREFERENCES, soundOnDone: true });

    // A later patch never clobbers an earlier one.
    await store.set({ idleCloseMinutes: 0 });
    expect(store.get()).toEqual({ ...DEFAULT_PREFERENCES, soundOnDone: true, idleCloseMinutes: 0 });
  });

  it("an older stored object missing newer keys reads as defaults for them", () => {
    const kv = new MemoryKV();
    void kv.update("acpPatchbay.preferences", { soundOnDone: true });
    const store = new PreferencesStore(kv);
    expect(store.get()).toEqual({ ...DEFAULT_PREFERENCES, soundOnDone: true });
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
    expect(store.get("claude")).toBeUndefined();
    expect(store.count()).toBe(0);

    await store.record("claude", { mode: "code", effort: "high" });
    await store.record("gemini", { mode: "chat" });
    expect(store.get("claude")).toEqual({ mode: "code", effort: "high" });
    expect(store.count()).toBe(2);

    // Each record is the whole combination — no merge with the previous.
    await store.record("claude", { mode: "plan" });
    expect(store.get("claude")).toEqual({ mode: "plan" });
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
    await store.save("a", "1.0", { ...earned, "session.fork": { declared: true, used: true } });
    const stillClaimed = store.seed("a", "1.0", matrixFromDeclared(declared({ sessionFork: true })));
    expect(stillClaimed["session.fork"]).toEqual({ declared: true, used: true });
    // Claim withdrawn: a restored used=true would light a feature the spec
    // now forbids calling.
    const withdrawn = store.seed("a", "1.0", matrixFromDeclared(declared({})));
    expect(withdrawn["session.fork"]).toEqual({ declared: false, used: false });
  });

  it("suspect restores regardless of the fresh claim — a declaration flicker at the same version must not launder the warning", async () => {
    const store = new UsedCapabilityStore(new MemoryKV());
    const base = matrixFromDeclared(declared({ loadSession: true }));
    await store.save("a", "1.0", {
      ...base,
      "session.load": { declared: true, used: false, suspect: true },
    });
    const stillClaimed = store.seed("a", "1.0", matrixFromDeclared(declared({ loadSession: true })));
    expect(stillClaimed["session.load"]).toEqual({ declared: true, used: false, suspect: true });
    // Claim withdrawn at the SAME version: the warning stands — only an
    // actual version change resets it honestly (suspect gates nothing).
    const withdrawn = store.seed("a", "1.0", matrixFromDeclared(declared({})));
    expect(withdrawn["session.load"]).toEqual({ declared: true, used: false, suspect: true });
  });

  it("claimless-provable rows (usage, concurrentSessions, auth) restore regardless — the mark carried the claim", async () => {
    const store = new UsedCapabilityStore(new MemoryKV());
    const base = matrixFromDeclared(declared({}));
    await store.save("a", "1.0", {
      ...base,
      usage: { declared: true, used: true },
      auth: { declared: true, used: true },
    });
    const seeded = store.seed("a", "1.0", matrixFromDeclared(declared({})));
    expect(seeded.usage).toEqual({ declared: true, used: true });
    expect(seeded.auth).toEqual({ declared: true, used: true });
  });
});

describe("SessionContinuityStore", () => {
  it("reads are agentId-checked — a colliding session id under another agent reads absent", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    await store.patch("s1", "claude", { knobs: { model: "sonnet", thinking: true } });
    expect(store.read("s1", "claude")?.knobs).toEqual({ model: "sonnet", thinking: true });
    // session ids are agent-minted: the same string under a different agent
    // is a different session, never the other agent's state
    expect(store.read("s1", "auggie")).toBeUndefined();
    expect(store.read("s2", "claude")).toBeUndefined();
    await store.forget("s1", "claude");
    expect(store.read("s1", "claude")).toBeUndefined();
  });

  it("patch merges fields; empty values delete them; a fieldless row leaves the store", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    await store.patch("s1", "claude", { knobs: { model: "sonnet" } });
    await store.patch("s1", "claude", { queue: [{ id: "q1", text: "held" }], draft: "typing…" });
    expect(store.read("s1", "claude")).toEqual({
      knobs: { model: "sonnet" },
      queue: [{ id: "q1", text: "held" }],
      draft: "typing…",
    });
    // drained queue and cleared draft drop their fields, knobs stand
    await store.patch("s1", "claude", { queue: [], draft: "" });
    expect(store.read("s1", "claude")).toEqual({ knobs: { model: "sonnet" } });
    // last field emptied → the row itself leaves
    await store.patch("s1", "claude", { knobs: undefined });
    expect(store.list()).toEqual([]);
  });

  it("two agents' colliding session ids keep separate rows — one can never destroy the other's", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    await store.patch("1", "claude", { knobs: { model: "sonnet" } });
    await store.patch("1", "auggie", { draft: "other agent, same id" });
    expect(store.read("1", "claude")).toEqual({ knobs: { model: "sonnet" } });
    expect(store.read("1", "auggie")).toEqual({ draft: "other agent, same id" });
    // an empty-draft save under one agent removes only that agent's row
    await store.patch("1", "auggie", { draft: "" });
    expect(store.read("1", "auggie")).toBeUndefined();
    expect(store.read("1", "claude")).toEqual({ knobs: { model: "sonnet" } });
  });

  it("an empty knobs object is a deletion, not a husk field", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    await store.patch("s1", "claude", { knobs: {} });
    expect(store.list()).toEqual([]);
  });

  it("folds the legacy knob rows in once and drops the old key", async () => {
    const kv = new MemoryKV();
    await kv.update("acpPatchbay.sessionKnobs", [{ id: "s1", agentId: "claude", seed: { mode: "code" } }]);
    const store = new SessionContinuityStore(kv);
    expect(store.read("s1", "claude")?.knobs).toEqual({ mode: "code" });
    expect(kv.get("acpPatchbay.sessionKnobs")).toBeUndefined();
  });
});
