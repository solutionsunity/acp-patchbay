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
import {
  DEFAULT_PERMISSION_RULES,
  PermissionRulesStore,
} from "../src/orchestrator/stores/permission-rules";
import { SessionIndexStore } from "../src/orchestrator/stores/session-index";

describe("SessionIndexStore", () => {
  it("upserts, renames, removes", async () => {
    const store = new SessionIndexStore(new MemoryKV());
    const ts = new Date().toISOString();
    await store.upsert({ id: "s1", agentId: "claude", title: "first", createdAt: ts, updatedAt: ts });
    await store.upsert({ id: "s2", agentId: "gemini", title: "second", createdAt: ts, updatedAt: ts });
    expect(store.list().map((e) => e.id)).toEqual(["s1", "s2"]);

    await store.rename("s1", "renamed");
    expect(store.get("s1")?.title).toBe("renamed");

    await store.remove("s2");
    expect(store.list().map((e) => e.id)).toEqual(["s1"]);
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
