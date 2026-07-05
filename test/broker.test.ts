// P6 gate: automated broker tests — rule precedence, audit trail.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionBroker } from "../src/orchestrator/broker";
import { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { PermissionRulesStore } from "../src/orchestrator/stores/permission-rules";
import type { AgentViewEvent } from "../src/shared/protocol";

let dir: string;
let workspaceRoot: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "patchbay-broker-"));
  workspaceRoot = join(dir, "workspace");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function harness() {
  const rules = new PermissionRulesStore(new MemoryKV());
  const audit = new DecisionAuditStore(dir);
  const events: AgentViewEvent[] = [];
  let auditRefreshes = 0;
  const broker = new PermissionBroker(
    rules,
    audit,
    {
      emit: (...evs) => events.push(...evs),
      onAuditWritten: () => auditRefreshes++,
    },
    () => workspaceRoot,
  );
  return { broker, rules, audit, events, refreshCount: () => auditRefreshes };
}

describe("PermissionBroker.evaluateCommand", () => {
  it("returns ask when no rule matches — never a silent allow", () => {
    const { broker } = harness();
    expect(broker.evaluateCommand("rm -rf /")).toBe("ask");
  });

  it("matches glob patterns", async () => {
    const { broker, rules } = harness();
    await rules.set({
      commandRules: [{ pattern: "npm run *", verdict: "allow" }],
      fileWriteScope: "workspace",
    });
    expect(broker.evaluateCommand("npm run build")).toBe("allow");
    expect(broker.evaluateCommand("npm test")).toBe("ask");
  });

  it("rule precedence: first matching rule wins, in list order", async () => {
    const { broker, rules } = harness();
    await rules.set({
      commandRules: [
        { pattern: "git push *", verdict: "ask" },
        { pattern: "git *", verdict: "allow" },
      ],
      fileWriteScope: "workspace",
    });
    expect(broker.evaluateCommand("git push origin main")).toBe("ask");
    expect(broker.evaluateCommand("git status")).toBe("allow");
  });

  it("deny rules are honored", async () => {
    const { broker, rules } = harness();
    await rules.set({
      commandRules: [{ pattern: "rm -rf *", verdict: "deny" }],
      fileWriteScope: "workspace",
    });
    expect(broker.evaluateCommand("rm -rf /tmp/x")).toBe("deny");
  });
});

describe("PermissionBroker.evaluateFileWrite", () => {
  it("allows paths under the workspace root", () => {
    const { broker } = harness();
    expect(broker.evaluateFileWrite(join(workspaceRoot, "src", "a.ts"))).toBe("allow");
  });

  it("asks for paths outside the workspace by default", () => {
    const { broker } = harness();
    expect(broker.evaluateFileWrite("/etc/passwd")).toBe("ask");
  });

  it("workspace+temp also allows the system temp dir", async () => {
    const { broker, rules } = harness();
    await rules.set({ commandRules: [], fileWriteScope: "workspace+temp" });
    expect(broker.evaluateFileWrite(join(tmpdir(), "scratch.txt"))).toBe("allow");
  });

  it("always-ask overrides everything, even inside the workspace", async () => {
    const { broker, rules } = harness();
    await rules.set({ commandRules: [], fileWriteScope: "always-ask" });
    expect(broker.evaluateFileWrite(join(workspaceRoot, "a.ts"))).toBe("ask");
  });
});

describe("PermissionBroker audit trail", () => {
  it("auto-allow via rule writes an audit entry immediately", async () => {
    const { broker, rules, audit, refreshCount } = harness();
    await rules.set({
      commandRules: [{ pattern: "npm run *", verdict: "allow" }],
      fileWriteScope: "workspace",
    });
    const result = await broker.gateCommand("s1", "npm run build");
    expect(result.accepted).toBe(true);
    expect(refreshCount()).toBe(1);
    const tail = await audit.tail(10);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ kind: "auto-allow", command: "npm run build" });
  });

  it("auto-deny via rule writes an audit entry and rejects", async () => {
    const { broker, rules, audit } = harness();
    await rules.set({
      commandRules: [{ pattern: "rm -rf *", verdict: "deny" }],
      fileWriteScope: "workspace",
    });
    const result = await broker.gateCommand("s1", "rm -rf /");
    expect(result.accepted).toBe(false);
    const tail = await audit.tail(10);
    expect(tail[0]).toMatchObject({ kind: "auto-deny", command: "rm -rf /" });
  });

  it("an ask that the user resolves also writes an audit entry", async () => {
    const { broker, events, audit } = harness();
    const pending = broker.gateCommand("s1", "curl example.com");
    // the permission card was emitted with a blockId — resolve it
    const requested = events.find((e) => e.kind === "permissionRequested");
    expect(requested).toBeDefined();
    if (requested?.kind !== "permissionRequested") throw new Error("unreachable");
    broker.resolve(requested.blockId, "allow_once");
    const result = await pending;
    expect(result.accepted).toBe(true);
    const tail = await audit.tail(10);
    expect(tail[0]).toMatchObject({ kind: "user-allow", command: "curl example.com" });
  });

  it("allow_always persists a new rule so the next call auto-allows", async () => {
    const { broker, events, rules } = harness();
    const pending = broker.gateCommand("s1", "npm run lint");
    const requested = events.find((e) => e.kind === "permissionRequested");
    if (requested?.kind !== "permissionRequested") throw new Error("unreachable");
    broker.resolve(requested.blockId, "allow_always");
    await pending;
    expect(rules.get().commandRules).toContainEqual({ pattern: "npm run lint", verdict: "allow" });

    // second call for the same command now auto-allows, no card
    const events2Before = events.length;
    const second = await broker.gateCommand("s1", "npm run lint");
    expect(second.accepted).toBe(true);
    expect(events.slice(events2Before).some((e) => e.kind === "permissionRequested")).toBe(false);
  });
});
