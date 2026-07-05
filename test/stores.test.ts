// Stores: session index over KV, permission rules defaults, decision audit
// JSONL append/tail, config JSONC round-trip preserving human edits.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigFileStore, parseWorkspaceConfig } from "../src/orchestrator/stores/config-file";
import { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
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

describe("workspace config", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "patchbay-config-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("parses JSONC with comments and applies zod defaults", () => {
    const r = parseWorkspaceConfig(`{
      // the backend agent
      "agents": [{ "id": "claude", "name": "Claude Code", "command": "npx" }]
    }`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.agents[0]?.args).toEqual([]);
      expect(r.config.agents[0]?.processPolicy).toBe("auto");
    }
  });

  it("returns typed errors for malformed input, not undefined behavior", () => {
    expect(parseWorkspaceConfig("{ nope").ok).toBe(false);
    const bad = parseWorkspaceConfig(`{ "agents": [{ "id": "x" }] }`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("agents");
  });

  it("absent file reads as empty config", async () => {
    const store = new ConfigFileStore(join(dir, "acp-patchbay.json"));
    const r = await store.read();
    expect(r).toEqual({ ok: true, config: { agents: [] } });
  });

  it("upsert preserves comments and unknown keys (surgical JSONC edits)", async () => {
    const file = join(dir, "acp-patchbay.json");
    await writeFile(
      file,
      `{
  // team note: keep this
  "futureKey": { "kept": true },
  "agents": []
}`,
      "utf8",
    );
    const store = new ConfigFileStore(file);
    await store.upsertAgent({
      id: "claude",
      name: "Claude Code",
      command: "npx",
      args: ["@agentclientprotocol/claude-agent-acp@latest"],
      env: {},
      processPolicy: "auto",
      defaults: {},
    });

    const text = await readFile(file, "utf8");
    expect(text).toContain("// team note: keep this");
    expect(text).toContain("futureKey");

    const r = await store.read();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.agents[0]?.id).toBe("claude");

    // upsert same id replaces, not duplicates
    await store.upsertAgent({
      id: "claude",
      name: "Claude Code",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@latest"],
      env: {},
      processPolicy: "isolated",
      defaults: {},
    });
    const r2 = await store.read();
    if (r2.ok) {
      expect(r2.config.agents).toHaveLength(1);
      expect(r2.config.agents[0]?.processPolicy).toBe("isolated");
    }

    await store.removeAgent("claude");
    const r3 = await store.read();
    if (r3.ok) expect(r3.config.agents).toHaveLength(0);
    const text3 = await readFile(file, "utf8");
    expect(text3).toContain("futureKey");
  });

  it("creates .vscode/acp-patchbay.json on first upsert", async () => {
    const file = join(dir, ".vscode", "acp-patchbay.json");
    const store = new ConfigFileStore(file);
    await store.upsertAgent({
      id: "a",
      name: "A",
      command: "a-cmd",
      args: [],
      env: {},
      processPolicy: "auto",
      defaults: {},
    });
    const r = await store.read();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.agents).toHaveLength(1);
  });
});
