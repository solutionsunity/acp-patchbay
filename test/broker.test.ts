// P6 gate: automated broker tests — rule precedence, audit trail.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionBroker, sliceTextFileRead } from "../src/orchestrator/broker";
import { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { MachineRulesStore, PermissionRulesStore } from "../src/orchestrator/stores/permission-rules";
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
  const machineRules = new MachineRulesStore(new MemoryKV());
  const audit = new DecisionAuditStore(dir);
  const events: AgentViewEvent[] = [];
  const opened: string[] = [];
  let auditRefreshes = 0;
  const broker = new PermissionBroker(
    rules,
    audit,
    {
      emit: (...evs) => events.push(...evs),
      onAuditWritten: () => auditRefreshes++,
      openLink: (href) => opened.push(href),
    },
    () => workspaceRoot,
    undefined,
    machineRules,
  );
  return { broker, rules, machineRules, audit, events, opened, refreshCount: () => auditRefreshes };
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

  it("machine layer answers only where the workspace layer stays silent", async () => {
    const { broker, machineRules } = harness();
    await machineRules.set([{ pattern: "npm test", verdict: "allow" }]);
    // no workspace rule matches → the machine floor answers
    expect(broker.evaluateCommand("npm test")).toBe("allow");
    // machine layer silent too → ask
    expect(broker.evaluateCommand("rm -rf /")).toBe("ask");
  });

  it("a workspace rule beats the machine floor wherever both match — tighten or loosen", async () => {
    const { broker, rules, machineRules } = harness();
    await machineRules.set([
      { pattern: "npm *", verdict: "allow" },
      { pattern: "./deploy.sh", verdict: "deny" },
    ]);
    await rules.set({
      commandRules: [
        { pattern: "npm publish*", verdict: "deny" }, // tighten the machine allow
        { pattern: "./deploy.sh", verdict: "allow" }, // loosen the machine deny, this repo only
      ],
      fileWriteScope: "workspace",
    });
    expect(broker.evaluateCommand("npm publish --tag next")).toBe("deny");
    expect(broker.evaluateCommand("npm run build")).toBe("allow"); // machine floor still covers the rest
    expect(broker.evaluateCommand("./deploy.sh")).toBe("allow");
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

  it("cancelPending resolves every pending request of the session as cancelled (spec § Cancellation)", async () => {
    const { broker, events, audit } = harness();
    // an agent permission request and a command gate, both pending on s1;
    // an unrelated session's request must survive the sweep
    const agentReq = broker.resolveAgentPermissionRequest("s1", "Edit file", "edit", null, [
      { optionId: "y", label: "Allow", kind: "allow_once" },
      { optionId: "n", label: "Reject", kind: "reject_once" },
    ]);
    const commandGate = broker.gateCommand("s1", "curl example.com");
    const otherSession = broker.gateCommand("s2", "npm run lint");

    broker.cancelPending("s1");
    await expect(agentReq).resolves.toEqual({ cancelled: true });
    await expect(commandGate).resolves.toEqual({ accepted: false });

    // cards resolved visibly, honestly labeled — never left looking open
    const resolved = events.filter((e) => e.kind === "permissionResolved");
    expect(resolved).toHaveLength(2);
    expect(resolved.every((e) => e.kind === "permissionResolved" && e.label.includes("Cancelled"))).toBe(true);
    const tail = await audit.tail(10);
    expect(tail.filter((e) => e.kind === "turn-cancelled")).toHaveLength(2);

    // s2 is untouched and still answerable
    const requested = events.filter((e) => e.kind === "permissionRequested");
    const s2Req = requested.find((e) => e.kind === "permissionRequested" && e.sessionId === "s2");
    if (s2Req?.kind !== "permissionRequested") throw new Error("unreachable");
    broker.resolve(s2Req.blockId, "allow_once");
    await expect(otherSession).resolves.toEqual({ accepted: true });
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

describe("sliceTextFileRead (fs/read_text_file line/limit — acp-compliance.md G3)", () => {
  const content = "one\ntwo\nthree\nfour\nfive";

  it("returns the whole content when neither param is given", () => {
    expect(sliceTextFileRead(content)).toBe(content);
  });

  it("line is 1-based, reading to the end", () => {
    expect(sliceTextFileRead(content, 3)).toBe("three\nfour\nfive");
  });

  it("limit caps the line count from the start line", () => {
    expect(sliceTextFileRead(content, 2, 2)).toBe("two\nthree");
  });

  it("limit alone reads from the top", () => {
    expect(sliceTextFileRead(content, null, 2)).toBe("one\ntwo");
  });

  it("out-of-range requests degrade to empty, never throw", () => {
    expect(sliceTextFileRead(content, 99)).toBe("");
  });
});

describe("resolveProbePermissionRequest — probe sessions answer, never dangle", () => {
  const options = (kinds: string[]) =>
    kinds.map((kind, i) => ({ optionId: `o${i}`, label: kind, kind }) as never);

  it("picks reject_once over everything, whatever the agent's ordering", async () => {
    const { broker } = harness();
    const result = await broker.resolveProbePermissionRequest(
      "probe-1",
      "Workspace Indexing Permission",
      options(["allow_always", "reject_always", "allow_once", "reject_once"]),
    );
    expect(result).toEqual({ optionId: "o3" });
  });

  it("falls back to reject_always, then the cancelled outcome", async () => {
    const { broker } = harness();
    expect(
      await broker.resolveProbePermissionRequest("p", "t", options(["allow_once", "reject_always"])),
    ).toEqual({ optionId: "o1" });
    expect(
      await broker.resolveProbePermissionRequest("p", "t", options(["allow_once", "allow_always"])),
    ).toEqual({ cancelled: true });
  });

  it("audits the automatic decision and never emits a card", async () => {
    const { broker, audit, events } = harness();
    await broker.resolveProbePermissionRequest("probe-1", "Indexing", options(["reject_once"]));
    const tail = await audit.tail(10);
    expect(tail.at(-1)).toMatchObject({ kind: "probe-auto-deny", tool: "Indexing" });
    expect(events.some((e) => e.kind === "permissionRequested")).toBe(false);
  });
});

/** The gate reads the file before it proposes, so the card's event lands a
 * tick after the call — wait for it rather than assume it. */
async function proposedEvent(events: AgentViewEvent[]) {
  for (let i = 0; i < 50; i++) {
    const e = events.find((e) => e.kind === "diffProposed");
    if (e?.kind === "diffProposed") return e;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("diffProposed never emitted");
}

describe("PermissionBroker.gateFileWrite — the proposal's full texts", () => {
  // The diff card is a bounded preview; the full change opens in VS Code's
  // own diff editor from the texts the gate is already holding while the
  // decision is pending. Held exactly as long as the decision is open —
  // never persisted, never kept once resolved (issue #27).
  it("holds old and new text while the proposal is pending, and drops them on resolution", async () => {
    const { broker, events } = harness();
    const path = join(dir, "outside.txt"); // outside the workspace → asks
    const pending = broker.gateFileWrite("s1", path, "new content\n");
    const proposed = await proposedEvent(events);
    expect(broker.proposedDiff(proposed.blockId)).toEqual({ path, oldText: "", newText: "new content\n" });
    broker.resolve(proposed.blockId, "accept");
    await expect(pending).resolves.toEqual({ accepted: true });
    expect(broker.proposedDiff(proposed.blockId)).toBeNull();
  });

  it("a cancelled turn drops them too; an unknown id is null, never a throw", async () => {
    const { broker, events } = harness();
    const pending = broker.gateFileWrite("s1", join(dir, "outside.txt"), "x");
    const proposed = await proposedEvent(events);
    broker.cancelPending("s1");
    await pending;
    expect(broker.proposedDiff(proposed.blockId)).toBeNull();
    expect(broker.proposedDiff("never-existed")).toBeNull();
  });

  it("an auto-allowed write never holds anything — there is no decision to inform", async () => {
    const { broker, events } = harness();
    await broker.gateFileWrite("s1", join(workspaceRoot, "inside.txt"), "x");
    const proposed = events.find((e) => e.kind === "diffProposed");
    if (proposed?.kind !== "diffProposed") throw new Error("unreachable");
    expect(broker.proposedDiff(proposed.blockId)).toBeNull();
  });
});

// Elicitation rides the same broker path as every other gated ask (one
// card language): the block goes out, the user's answer comes back in the
// wire's own vocabulary, and a cancelled turn answers it like any other
// pending request.
describe("PermissionBroker.askElicitation — the agent asks the user", () => {
  const form = {
    message: "Which database?",
    ask: { mode: "form" as const, fields: [{ name: "db", type: "string" as const, required: true }] },
  };

  it("emits the card and answers with what the user typed", async () => {
    const { broker, events } = harness();
    const answer = broker.askElicitation("s1", form);
    const asked = events.find((e) => e.kind === "elicitationRequested");
    expect(asked).toMatchObject({ sessionId: "s1", message: "Which database?" });
    const blockId = (asked as { blockId: string }).blockId;

    broker.resolveElicitation(blockId, { action: "accept", content: { db: "prod" } });
    expect(await answer).toEqual({ action: "accept", content: { db: "prod" } });
    expect(events.at(-1)).toMatchObject({
      kind: "elicitationResolved",
      blockId,
      outcome: "accepted",
    });
  });

  it("declining and cancelling are different answers — the agent learns which", async () => {
    const { broker, events } = harness();
    const declined = broker.askElicitation("s1", form);
    broker.resolveElicitation((events.at(-1) as { blockId: string }).blockId, { action: "decline" });
    expect(await declined).toEqual({ action: "decline" });
    expect(events.at(-1)).toMatchObject({ kind: "elicitationResolved", outcome: "declined" });

    const cancelled = broker.askElicitation("s1", form);
    broker.resolveElicitation(
      (events.filter((e) => e.kind === "elicitationRequested").at(-1) as { blockId: string }).blockId,
      { action: "cancel" },
    );
    expect(await cancelled).toEqual({ action: "cancel" });
    expect(events.at(-1)).toMatchObject({ kind: "elicitationResolved", outcome: "cancelled" });
  });

  it("a stopped turn answers every elicitation it left open — never a dangling request", async () => {
    const { broker, events } = harness();
    const answer = broker.askElicitation("s1", form);
    const other = broker.askElicitation("s2", form);
    broker.cancelPending("s1");
    expect(await answer).toEqual({ action: "cancel" });
    expect(events.some((e) => e.kind === "elicitationResolved" && e.sessionId === "s1")).toBe(true);
    // s2's ask belongs to another session's turn and stays open
    let settled = false;
    void other.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    broker.cancelPending("s2");
    await other;
  });

  it("a question the agent withdraws settles as withdrawn and answers cancel", async () => {
    const { broker, events } = harness();
    const withdraw = new AbortController();
    const answer = broker.askElicitation("s1", form, withdraw.signal);
    withdraw.abort();
    expect(await answer).toEqual({ action: "cancel" });
    expect(events.at(-1)).toMatchObject({ kind: "elicitationResolved", outcome: "withdrawn" });
    // the user's late click is a no-op, never a second answer
    broker.resolveElicitation((events.at(-1) as { blockId: string }).blockId, { action: "decline" });
    expect(events.filter((e) => e.kind === "elicitationResolved")).toHaveLength(1);
  });
});

describe("PermissionBroker url asks — a page the user opens", () => {
  const signIn = {
    message: "Sign in",
    ask: { mode: "url" as const, link: { href: "https://auth.example.com/", host: "auth.example.com", warnings: [] } },
    completion: { agentId: "a1", elicitationId: "e1" },
  };
  const blockOf = (events: AgentViewEvent[]) =>
    (events.find((e) => e.kind === "elicitationRequested") as { blockId: string }).blockId;

  it("opens only on accept, re-opens while the agent waits, and stops once the agent completes it", async () => {
    const { broker, events, opened } = harness();
    const answer = broker.askElicitation("s1", signIn);
    const blockId = blockOf(events);
    expect(opened).toEqual([]);
    broker.reopenLink(blockId); // not accepted yet — nothing to re-open
    expect(opened).toEqual([]);

    broker.resolveElicitation(blockId, { action: "accept", content: {} });
    expect(await answer).toEqual({ action: "accept", content: {} });
    expect(opened).toEqual(["https://auth.example.com/"]);
    broker.reopenLink(blockId);
    expect(opened).toHaveLength(2);

    broker.completeLink("a1", "e1");
    expect(events.at(-1)).toEqual({ kind: "elicitationLinkSettled", sessionId: "s1", blockId, state: "completed" });
    broker.reopenLink(blockId);
    expect(opened).toHaveLength(2);
  });

  it("a declined link never opens", async () => {
    const { broker, events, opened } = harness();
    const answer = broker.askElicitation("s1", signIn);
    broker.resolveElicitation(blockOf(events), { action: "decline" });
    expect(await answer).toEqual({ action: "decline" });
    expect(opened).toEqual([]);
  });

  it("completion ids are matched per agent; an unknown or repeated one is ignored", async () => {
    const { broker, events } = harness();
    void broker.askElicitation("s1", signIn);
    broker.resolveElicitation(blockOf(events), { action: "accept", content: {} });
    const before = events.length;
    broker.completeLink("a2", "e1"); // another agent's id space
    broker.completeLink("a1", "nope");
    expect(events).toHaveLength(before);
    broker.completeLink("a1", "e1");
    broker.completeLink("a1", "e1");
    expect(events.filter((e) => e.kind === "elicitationLinkSettled")).toHaveLength(1);
  });

  it("a completion before the user answers settles the card as completed and answers cancel — the user chose nothing", async () => {
    const { broker, events, opened } = harness();
    const answer = broker.askElicitation("s1", signIn);
    broker.completeLink("a1", "e1");
    expect(await answer).toEqual({ action: "cancel" });
    expect(events.at(-1)).toMatchObject({ kind: "elicitationResolved", outcome: "completed" });
    expect(opened).toEqual([]);
  });

  it("a completion that overtakes its question is held, and the question settles completed the moment it arrives", async () => {
    const { broker, events, opened } = harness();
    broker.completeLink("a1", "e1");
    expect(events).toEqual([]);
    const answer = broker.askElicitation("s1", signIn);
    expect(await answer).toEqual({ action: "cancel" });
    expect(events.map((e) => e.kind)).toEqual(["elicitationRequested", "elicitationResolved"]);
    expect(events.at(-1)).toMatchObject({ outcome: "completed" });
    expect(opened).toEqual([]);
  });

  it("a repeated completion is never held — a later question may reuse a finished id", async () => {
    const { broker, events } = harness();
    void broker.askElicitation("s1", signIn);
    broker.resolveElicitation(blockOf(events), { action: "accept", content: {} });
    broker.completeLink("a1", "e1");
    broker.completeLink("a1", "e1"); // a repeat, after the link finished
    const reused = broker.askElicitation("s1", signIn);
    let settled = false;
    void reused.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // waits for the user like any new question
  });

  it("a withdrawal that overtakes the completion still ends as completed — the finished flow is the fact that stands", async () => {
    const { broker, events } = harness();
    const withdraw = new AbortController();
    const answer = broker.askElicitation("s1", signIn, withdraw.signal);
    withdraw.abort();
    expect(await answer).toEqual({ action: "cancel" });
    broker.completeLink("a1", "e1");
    expect(events.filter((e) => e.kind === "elicitationResolved").map((e) => (e as { outcome: string }).outcome)).toEqual(
      ["withdrawn", "completed"],
    );
  });

  it("a declined link the agent later finishes keeps the user's answer and is marked done", async () => {
    const { broker, events } = harness();
    void broker.askElicitation("s1", signIn);
    broker.resolveElicitation(blockOf(events), { action: "decline" });
    broker.completeLink("a1", "e1");
    expect(events.at(-1)).toMatchObject({ kind: "elicitationLinkSettled", state: "completed" });
    expect(events.filter((e) => e.kind === "elicitationResolved")).toHaveLength(1);
  });

  it("held completions die with the agent's connection", async () => {
    const { broker } = harness();
    broker.completeLink("a1", "e1");
    broker.forgetAgent("a1");
    const answer = broker.askElicitation("s1", signIn);
    let settled = false;
    void answer.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("the address alone decides what opens — a link nobody will report done still opens and re-opens", async () => {
    const { broker, events, opened } = harness();
    void broker.askElicitation("s1", { message: signIn.message, ask: signIn.ask });
    const blockId = blockOf(events);
    broker.resolveElicitation(blockId, { action: "accept", content: {} });
    broker.reopenLink(blockId);
    expect(opened).toEqual(["https://auth.example.com/", "https://auth.example.com/"]);
  });

  it("a stopped turn ends the wait on an opened page", async () => {
    const { broker, events, opened } = harness();
    void broker.askElicitation("s1", signIn);
    const blockId = blockOf(events);
    broker.resolveElicitation(blockId, { action: "accept", content: {} });
    broker.cancelPending("s1");
    expect(events.at(-1)).toEqual({ kind: "elicitationLinkSettled", sessionId: "s1", blockId, state: "ended" });
    broker.reopenLink(blockId);
    expect(opened).toHaveLength(1);
  });
});
