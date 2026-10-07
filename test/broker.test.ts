// P6 gate: automated broker tests — rule precedence, audit trail.
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsksStore } from "../src/orchestrator/asks-store";
import { PermissionBroker } from "../src/orchestrator/broker";
import { sliceTextFileRead } from "../src/orchestrator/client-host";
import type { CreateTerminalParams } from "../src/orchestrator/terminal-runner";
import { parseCommandLine } from "../src/shared/command-line";
import { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { MachineRulesStore, PermissionRulesStore } from "../src/orchestrator/stores/permission-rules";
import type { AgentViewEvent, PermissionCallView, PermissionOptionView, ToolCallKind } from "../src/shared/protocol";
import type { PatchbayAgentId, PatchbayAskId, PatchbaySessionId } from "../src/shared/ids";

let dir: string;
let workspaceRoot: string;
/** The roots the session under test was granted — the workspace alone
 * unless a test hands it more. */
let granted: string[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "patchbay-broker-"));
  workspaceRoot = join(dir, "workspace");
  await mkdir(workspaceRoot);
  granted = [workspaceRoot];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A value patchbay handed an agent — masked wherever a card shows it. */
const HANDED_OUT = "sk-handed-out-token";

/** A terminal/create as the gate receives it: the command line read the
 * way a person writes it, run in the workspace, nothing set. */
function run(line: string, over: Partial<CreateTerminalParams> = {}): CreateTerminalParams {
  const parsed = parseCommandLine(line)!;
  return { ...parsed, env: {}, cwd: workspaceRoot, outputByteLimit: null, ...over };
}

function harness() {
  const rules = new PermissionRulesStore(new MemoryKV());
  const machineRules = new MachineRulesStore(new MemoryKV());
  const audit = new DecisionAuditStore(dir);
  const events: AgentViewEvent[] = [];
  const opened: string[] = [];
  let auditRefreshes = 0;
  const asks = new AsksStore(audit, {
    emit: (...evs) => events.push(...evs),
    onAuditWritten: () => auditRefreshes++,
    // every session the agent "a1" holds, under its own id for it
    pairOf: (patchbaySessionId) => ({ patchbayAgentId: "a1" as PatchbayAgentId, sessionId: `agent-${patchbaySessionId}` }),
    openLink: (href) => opened.push(href),
  });
  const broker = new PermissionBroker(rules, asks, () => granted, (text) => text.split(HANDED_OUT).join("•••"), machineRules);
  return { broker, asks, rules, machineRules, audit, events, opened, refreshCount: () => auditRefreshes };
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

describe("PermissionBroker.evaluateFileWrites", () => {
  it("allows paths under the workspace root", async () => {
    const { broker } = harness();
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, [join(workspaceRoot, "src", "a.ts")])).toBe("allow");
  });

  it("asks for paths outside the workspace by default", async () => {
    const { broker } = harness();
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, ["/etc/passwd"])).toBe("ask");
  });

  it("workspace+temp also allows the system temp dir", async () => {
    const { broker, rules } = harness();
    await rules.set({ commandRules: [], fileWriteScope: "workspace+temp" });
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, [join(tmpdir(), "scratch.txt")])).toBe("allow");
  });

  it("always-ask overrides everything, even inside the workspace", async () => {
    const { broker, rules } = harness();
    await rules.set({ commandRules: [], fileWriteScope: "always-ask" });
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, [join(workspaceRoot, "a.ts")])).toBe("ask");
  });

  // Judged where the write lands, never by the text the agent sent
  // (issue #56).
  it("a `..` that climbs out of the workspace asks — through existing folders and ones the write would create", async () => {
    const { broker } = harness();
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, [`${workspaceRoot}/../escaped.txt`])).toBe("ask");
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, [`${workspaceRoot}/new/../../escaped.txt`])).toBe("ask");
    // a `..` that stays inside is still inside
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, [`${workspaceRoot}/new/../a.ts`])).toBe("allow");
  });

  it("a symlink inside the workspace that points outside asks — and so does a link to nowhere", async () => {
    const { broker } = harness();
    await mkdir(join(dir, "elsewhere"));
    await symlink(join(dir, "elsewhere"), join(workspaceRoot, "link"));
    await symlink(join(dir, "nowhere.txt"), join(workspaceRoot, "dangling"));
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, [join(workspaceRoot, "link", "x.txt")])).toBe("ask");
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, [join(workspaceRoot, "dangling")])).toBe("ask");
  });

  it("a workspace opened through a symlink is its real folder, whichever spelling the agent uses", async () => {
    const { broker } = harness();
    await symlink(workspaceRoot, join(dir, "ws-link"));
    granted = [join(dir, "ws-link")];
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, [join(workspaceRoot, "a.ts")])).toBe("allow");
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, [join(dir, "ws-link", "a.ts")])).toBe("allow");
  });

  it("a relative path names no location — it asks", async () => {
    const { broker } = harness();
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, ["a.ts"])).toBe("ask");
  });

  it("every path must land inside: one outside, or none named, asks", async () => {
    const { broker } = harness();
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, [join(workspaceRoot, "a.ts"), "/etc/passwd"])).toBe("ask");
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, [])).toBe("ask");
  });

  it("every root the session was granted counts — not only the first", async () => {
    const { broker } = harness();
    const second = join(dir, "second");
    await mkdir(second);
    granted = [workspaceRoot, second];
    expect(await broker.evaluateFileWrites("s1" as PatchbaySessionId, [join(second, "b.ts")])).toBe("allow");
  });
});

/** An agent's permission request as the broker gets it: the call it asks
 * about, naming `paths` as locations (and `diffs` as its diffs' paths). */
function request(
  title: string,
  toolKind: ToolCallKind,
  paths: readonly string[],
  options: readonly PermissionOptionView[],
  more: Partial<PermissionCallView> = {},
): { title: string; call: PermissionCallView; options: readonly PermissionOptionView[] } {
  return {
    title,
    call: { toolCallId: "t1", toolKind, locations: paths.map((path) => ({ path, line: null })), content: [], diffs: {}, input: null, ...more },
    options,
  };
}

async function cardOf(events: readonly AgentViewEvent[]): Promise<Extract<AgentViewEvent, { kind: "permissionRequested" }>> {
  await new Promise((r) => setTimeout(r, 20));
  const asked = events.find((e) => e.kind === "permissionRequested");
  if (asked?.kind !== "permissionRequested") throw new Error("no card — the request was auto-allowed");
  return asked;
}

describe("PermissionBroker.resolveAgentPermissionRequest — an edit is judged by every file it names", () => {
  const options = [
    { optionId: "y", label: "Allow", kind: "allow_once" as const },
    { optionId: "n", label: "Reject", kind: "reject_once" as const },
  ];

  it("auto-allows only when every location lands inside", async () => {
    const { broker, events } = harness();
    const inside = [join(workspaceRoot, "a.ts"), join(workspaceRoot, "b.ts")];
    await expect(broker.resolveAgentPermissionRequest("s1" as PatchbaySessionId, request("Edit", "edit", inside, options))).resolves.toEqual({
      optionId: "y",
    });
    expect(events.some((e) => e.kind === "permissionRequested")).toBe(false);
  });

  it("only an edit is judged by its locations — any other kind asks, even when every one is inside", async () => {
    const { broker, asks, events } = harness();
    const pending = broker.resolveAgentPermissionRequest("s1" as PatchbaySessionId, request("Delete", "delete", [join(workspaceRoot, "a.ts")], options));
    const asked = await cardOf(events);
    expect(asked.title).toBe("Delete");
    // the card names the file, whatever the kind
    expect(asked.call?.locations.map((l) => l.path)).toEqual([join(workspaceRoot, "a.ts")]);
    asks.answerOption(asked.patchbayAskId, "n");
    await expect(pending).resolves.toEqual({ optionId: "n" });
  });

  it("a first location inside never carries a later one outside — it asks, naming both", async () => {
    const { broker, asks, events } = harness();
    const mixed = [join(workspaceRoot, "a.ts"), `${workspaceRoot}/../escaped.txt`];
    const pending = broker.resolveAgentPermissionRequest("s1" as PatchbaySessionId, request("Edit", "edit", mixed, options));
    const asked = await cardOf(events);
    expect(asked.call?.locations.map((l) => l.path)).toEqual(mixed);
    asks.answerOption(asked.patchbayAskId, "n");
    await expect(pending).resolves.toEqual({ optionId: "n" });
  });

  it("a diff writing outside is judged by its own path, whatever the locations say (#80)", async () => {
    const { broker, asks, events } = harness();
    const pending = broker.resolveAgentPermissionRequest(
      "s1" as PatchbaySessionId,
      request("Edit", "edit", [join(workspaceRoot, "a.ts")], options, { diffs: { "/etc/hosts": { additions: 1, deletions: 0 } } }),
    );
    const asked = await cardOf(events);
    expect(asked.call?.diffs).toEqual({ "/etc/hosts": { additions: 1, deletions: 0 } });
    asks.answerOption(asked.patchbayAskId, "n");
    await expect(pending).resolves.toEqual({ optionId: "n" });
  });

  it("the card shows what the call will do — its content and input, handed-out values masked (#80)", async () => {
    const { broker, asks, events } = harness();
    const pending = broker.resolveAgentPermissionRequest(
      "s1" as PatchbaySessionId,
      request(`curl -H ${HANDED_OUT}`, "execute", [], options, {
        content: [{ kind: "text", text: `will send ${HANDED_OUT}` }],
        input: `{ "command": "curl -H ${HANDED_OUT}" }`,
      }),
    );
    const asked = await cardOf(events);
    expect(JSON.stringify(asked)).not.toContain(HANDED_OUT);
    expect(asked.title).toBe("curl -H •••");
    expect(asked.call).toMatchObject({ content: [{ kind: "text", text: "will send •••" }], input: '{ "command": "curl -H •••" }' });
    asks.answerOption(asked.patchbayAskId, "y");
    await expect(pending).resolves.toEqual({ optionId: "y" });
  });

  it("a request the agent takes back settles its card as withdrawn — no later click answers it (#80)", async () => {
    const { broker, asks, events, audit } = harness();
    const withdraw = new AbortController();
    const pending = broker.resolveAgentPermissionRequest("s1" as PatchbaySessionId, request("Run", "execute", [], options), withdraw.signal);
    const asked = await cardOf(events);
    withdraw.abort();
    await expect(pending).resolves.toEqual({ cancelled: true });
    expect(events.find((e) => e.kind === "permissionResolved")).toMatchObject({ label: "Withdrawn by the agent", auto: true });
    asks.answerOption(asked.patchbayAskId, "y"); // too late: nothing moves
    expect(events.filter((e) => e.kind === "permissionResolved")).toHaveLength(1);
    expect((await audit.tail(5)).some((e) => e.kind === "withdraw")).toBe(true);
  });
});

describe("PermissionBroker audit trail", () => {
  it("auto-allow via rule writes an audit entry immediately", async () => {
    const { broker, rules, audit, refreshCount } = harness();
    await rules.set({
      commandRules: [{ pattern: "npm run *", verdict: "allow" }],
      fileWriteScope: "workspace",
    });
    const result = await broker.gateCommand("s1" as PatchbaySessionId, run("npm run build"));
    expect(result).toBe("accepted");
    expect(refreshCount()).toBe(1);
    const tail = await audit.tail(10);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ kind: "auto-allow", command: "npm run build" });
    // named by the pair a later window can match, never this window's id
    expect(tail[0]).toMatchObject({ patchbayAgentId: "a1", sessionId: "agent-s1" });
    expect(tail[0]).not.toHaveProperty("patchbaySessionId");
  });

  it("auto-deny via rule writes an audit entry and rejects", async () => {
    const { broker, rules, audit } = harness();
    await rules.set({
      commandRules: [{ pattern: "rm -rf *", verdict: "deny" }],
      fileWriteScope: "workspace",
    });
    const result = await broker.gateCommand("s1" as PatchbaySessionId, run("rm -rf /"));
    expect(result).toBe("rejected");
    const tail = await audit.tail(10);
    expect(tail[0]).toMatchObject({ kind: "auto-deny", command: "rm -rf /" });
  });

  it("an ask that the user resolves also writes an audit entry", async () => {
    const { broker, asks, events, audit } = harness();
    const pending = broker.gateCommand("s1" as PatchbaySessionId, run("curl example.com"));
    // the permission card was emitted with a patchbayAskId — resolve it
    const requested = events.find((e) => e.kind === "permissionRequested");
    expect(requested).toBeDefined();
    if (requested?.kind !== "permissionRequested") throw new Error("unreachable");
    asks.answerOption(requested.patchbayAskId, "allow_once");
    const result = await pending;
    expect(result).toBe("accepted");
    const tail = await audit.tail(10);
    expect(tail[0]).toMatchObject({ kind: "user-allow", command: "curl example.com" });
  });

  it("a command the user rejects on its card settles rejected", async () => {
    const { broker, asks, events, audit } = harness();
    const pending = broker.gateCommand("s1" as PatchbaySessionId, run("curl example.com"));
    const requested = events.find((e) => e.kind === "permissionRequested");
    if (requested?.kind !== "permissionRequested") throw new Error("unreachable");
    asks.answerOption(requested.patchbayAskId, "reject_once");
    await expect(pending).resolves.toBe("rejected");
    const tail = await audit.tail(10);
    expect(tail[0]).toMatchObject({ kind: "user-reject", command: "curl example.com" });
  });

  it("a stop resolves every pending request of the session as cancelled (spec § Cancellation)", async () => {
    const { broker, asks, events, audit } = harness();
    // an agent permission request and a command gate, both pending on s1;
    // an unrelated session's request must survive the sweep
    const agentReq = broker.resolveAgentPermissionRequest(
      "s1" as PatchbaySessionId,
      request("Edit file", "edit", [], [
        { optionId: "y", label: "Allow", kind: "allow_once" },
        { optionId: "n", label: "Reject", kind: "reject_once" },
      ]),
    );
    const commandGate = broker.gateCommand("s1" as PatchbaySessionId, run("curl example.com"));
    const otherSession = broker.gateCommand("s2" as PatchbaySessionId, run("npm run lint"));
    // the agent's request is judged before its card shows
    for (let i = 0; i < 50 && events.filter((e) => e.kind === "permissionRequested").length < 3; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    asks.stopSession("s1" as PatchbaySessionId);
    await expect(agentReq).resolves.toEqual({ cancelled: true });
    // the user never decided — cancelled, never passed off as a reject
    await expect(commandGate).resolves.toBe("cancelled");

    // cards resolved visibly, honestly labeled — never left looking open
    const resolved = events.filter((e) => e.kind === "permissionResolved");
    expect(resolved).toHaveLength(2);
    expect(resolved.every((e) => e.kind === "permissionResolved" && e.label.includes("Cancelled"))).toBe(true);
    const tail = await audit.tail(10);
    expect(tail.filter((e) => e.kind === "turn-cancelled")).toHaveLength(2);

    // s2 is untouched and still answerable
    const requested = events.filter((e) => e.kind === "permissionRequested");
    const s2Req = requested.find((e) => e.kind === "permissionRequested" && e.patchbaySessionId === "s2");
    if (s2Req?.kind !== "permissionRequested") throw new Error("unreachable");
    asks.answerOption(s2Req.patchbayAskId, "allow_once");
    await expect(otherSession).resolves.toBe("accepted");
  });

  it("a turn stopped while a request is still being judged answers it cancelled — no card, never a dangling request", async () => {
    const { broker, asks, events, audit } = harness();
    const options = [{ optionId: "y", label: "Allow", kind: "allow_once" as const }];
    const agentReq = broker.resolveAgentPermissionRequest("s1" as PatchbaySessionId, request("Edit", "edit", [join(workspaceRoot, "a.ts")], options));
    const write = broker.gateFileWrite("s1" as PatchbaySessionId, join(workspaceRoot, "b.ts"), "x");
    asks.stopSession("s1" as PatchbaySessionId); // before either judge has read the disk
    await expect(agentReq).resolves.toEqual({ cancelled: true });
    await expect(write).resolves.toBe("cancelled");
    expect(events).toEqual([]);
    const tail = await audit.tail(10);
    expect(tail.filter((e) => e.kind === "turn-cancelled")).toHaveLength(2);
  });

  it("allow_always persists a new rule so the next call auto-allows", async () => {
    const { broker, asks, events, rules } = harness();
    const pending = broker.gateCommand("s1" as PatchbaySessionId, run("npm run lint"));
    const requested = events.find((e) => e.kind === "permissionRequested");
    if (requested?.kind !== "permissionRequested") throw new Error("unreachable");
    asks.answerOption(requested.patchbayAskId, "allow_always");
    await pending;
    expect(rules.get().commandRules).toContainEqual({ pattern: "npm run lint", verdict: "allow" });

    // second call for the same command now auto-allows, no card
    const events2Before = events.length;
    const second = await broker.gateCommand("s1" as PatchbaySessionId, run("npm run lint"));
    expect(second).toBe("accepted");
    expect(events.slice(events2Before).some((e) => e.kind === "permissionRequested")).toBe(false);
  });
});

describe("PermissionBroker.gateCommand — the card shows what will run (issue #57)", () => {
  const card = (events: AgentViewEvent[]) => {
    const asked = events.find((e) => e.kind === "permissionRequested");
    if (asked?.kind !== "permissionRequested") throw new Error("no card");
    return asked;
  };

  it("lists the directory and every variable the agent sets, a handed-out value masked", async () => {
    const { broker, asks, events } = harness();
    const gated = broker.gateCommand(
      "s1" as PatchbaySessionId,
      run("npm test", { cwd: "/elsewhere", env: { NODE_OPTIONS: "--require ./x.js", API_KEY: HANDED_OUT } }),
    );
    expect(card(events)).toMatchObject({
      detail: "npm test",
      facts: [
        { label: "cwd", value: "/elsewhere" },
        { label: "env", value: "NODE_OPTIONS=--require ./x.js" },
        { label: "env", value: "API_KEY=•••" },
      ],
    });
    asks.stopSession("s1" as PatchbaySessionId);
    // The cancel is audited into the test's directory: it lands before the
    // directory goes.
    await gated;
  });

  it("keeps argument boundaries: `rm \"a b\"` is never `rm a b`, on the card or to a rule", async () => {
    const { broker, asks, events, rules } = harness();
    const pending = broker.gateCommand("s1" as PatchbaySessionId, run('rm "a b"'));
    expect(card(events).detail).toBe('rm "a b"');
    asks.answerOption(card(events).patchbayAskId, "allow_always");
    await pending;
    expect(rules.get().commandRules).toContainEqual({ pattern: 'rm "a b"', verdict: "allow" });
    expect(broker.evaluateCommand('rm "a b"')).toBe("allow");
    expect(broker.evaluateCommand("rm a b")).toBe("ask");
  });

  it("a rule speaks for the command line alone — its directory and environment ride the trust", async () => {
    const { broker, rules, events } = harness();
    await rules.set({ commandRules: [{ pattern: "npm test", verdict: "allow" }], fileWriteScope: "workspace" });
    const other = run("npm test", { cwd: "/elsewhere", env: { NODE_OPTIONS: "--require ./x.js" } });
    await expect(broker.gateCommand("s1" as PatchbaySessionId, other)).resolves.toBe("accepted");
    expect(events.some((e) => e.kind === "permissionRequested")).toBe(false);
  });

  it("the audit names the variables, never their values", async () => {
    const { broker, rules, audit } = harness();
    await rules.set({ commandRules: [{ pattern: "npm test", verdict: "allow" }], fileWriteScope: "workspace" });
    await broker.gateCommand("s1" as PatchbaySessionId, run("npm test", { env: { API_KEY: HANDED_OUT } }));
    const [entry] = await audit.tail(1);
    expect(entry).toMatchObject({ kind: "auto-allow", command: "npm test", cwd: workspaceRoot, env: ["API_KEY"] });
    expect(JSON.stringify(entry)).not.toContain(HANDED_OUT);
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
      "a1" as PatchbayAgentId,
      "probe-1",
      "Workspace Indexing Permission",
      options(["allow_always", "reject_always", "allow_once", "reject_once"]),
    );
    expect(result).toEqual({ optionId: "o3" });
  });

  it("falls back to reject_always, then the cancelled outcome", async () => {
    const { broker } = harness();
    expect(
      await broker.resolveProbePermissionRequest("a1" as PatchbayAgentId, "p", "t", options(["allow_once", "reject_always"])),
    ).toEqual({ optionId: "o1" });
    expect(
      await broker.resolveProbePermissionRequest("a1" as PatchbayAgentId, "p", "t", options(["allow_once", "allow_always"])),
    ).toEqual({ cancelled: true });
  });

  it("audits the automatic decision and never emits a card", async () => {
    const { broker, audit, events } = harness();
    await broker.resolveProbePermissionRequest("a1" as PatchbayAgentId, "probe-1", "Indexing", options(["reject_once"]));
    const tail = await audit.tail(10);
    expect(tail.at(-1)).toMatchObject({ kind: "probe-auto-deny", patchbayAgentId: "a1", sessionId: "probe-1", tool: "Indexing" });
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
    const { broker, asks, events } = harness();
    const path = join(dir, "outside.txt"); // outside the workspace → asks
    const pending = broker.gateFileWrite("s1" as PatchbaySessionId, path, "new content\n");
    const proposed = await proposedEvent(events);
    expect(asks.proposal(proposed.patchbayAskId)).toEqual({ path, oldText: "", newText: "new content\n" });
    asks.answerWrite(proposed.patchbayAskId, true);
    await expect(pending).resolves.toBe("accepted");
    expect(asks.proposal(proposed.patchbayAskId)).toBeNull();
  });

  it("a cancelled turn drops them too; an unknown id is null, never a throw", async () => {
    const { broker, asks, events } = harness();
    const pending = broker.gateFileWrite("s1" as PatchbaySessionId, join(dir, "outside.txt"), "x");
    const proposed = await proposedEvent(events);
    asks.stopSession("s1" as PatchbaySessionId);
    await expect(pending).resolves.toBe("cancelled");
    expect(asks.proposal(proposed.patchbayAskId)).toBeNull();
    expect(asks.proposal("never-existed" as PatchbayAskId)).toBeNull();
  });

  it("an auto-allowed write never holds anything — there is no decision to inform", async () => {
    const { broker, asks, events } = harness();
    await broker.gateFileWrite("s1" as PatchbaySessionId, join(workspaceRoot, "inside.txt"), "x");
    const proposed = events.find((e) => e.kind === "diffProposed");
    if (proposed?.kind !== "diffProposed") throw new Error("unreachable");
    expect(asks.proposal(proposed.patchbayAskId)).toBeNull();
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
    const { broker, asks, events } = harness();
    const answer = broker.askElicitation("s1" as PatchbaySessionId, form);
    const asked = events.find((e) => e.kind === "elicitationRequested");
    expect(asked).toMatchObject({ patchbaySessionId: "s1", message: "Which database?" });
    const patchbayAskId = (asked as { patchbayAskId: PatchbayAskId }).patchbayAskId;

    asks.answerQuestion(patchbayAskId, { action: "accept", content: { db: "prod" } });
    expect(await answer).toEqual({ action: "accept", content: { db: "prod" } });
    expect(events.at(-1)).toMatchObject({
      kind: "elicitationResolved",
      patchbayAskId,
      outcome: "accepted",
    });
  });

  it("declining and cancelling are different answers — the agent learns which", async () => {
    const { broker, asks, events } = harness();
    const declined = broker.askElicitation("s1" as PatchbaySessionId, form);
    asks.answerQuestion((events.at(-1) as { patchbayAskId: PatchbayAskId }).patchbayAskId, { action: "decline" });
    expect(await declined).toEqual({ action: "decline" });
    expect(events.at(-1)).toMatchObject({ kind: "elicitationResolved", outcome: "declined" });

    const cancelled = broker.askElicitation("s1" as PatchbaySessionId, form);
    asks.answerQuestion(
      (events.filter((e) => e.kind === "elicitationRequested").at(-1) as { patchbayAskId: PatchbayAskId }).patchbayAskId,
      { action: "cancel" },
    );
    expect(await cancelled).toEqual({ action: "cancel" });
    expect(events.at(-1)).toMatchObject({ kind: "elicitationResolved", outcome: "cancelled" });
  });

  it("a stopped turn answers every elicitation it left open — never a dangling request", async () => {
    const { broker, asks, events } = harness();
    const answer = broker.askElicitation("s1" as PatchbaySessionId, form);
    const other = broker.askElicitation("s2" as PatchbaySessionId, form);
    asks.stopSession("s1" as PatchbaySessionId);
    expect(await answer).toEqual({ action: "cancel" });
    expect(events.some((e) => e.kind === "elicitationResolved" && e.patchbaySessionId === "s1")).toBe(true);
    // s2's ask belongs to another session's turn and stays open
    let settled = false;
    void other.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    asks.stopSession("s2" as PatchbaySessionId);
    await other;
  });

  it("a question the agent withdraws settles as withdrawn and answers cancel", async () => {
    const { broker, asks, events } = harness();
    const withdraw = new AbortController();
    const answer = broker.askElicitation("s1" as PatchbaySessionId, form, withdraw.signal);
    withdraw.abort();
    expect(await answer).toEqual({ action: "cancel" });
    expect(events.at(-1)).toMatchObject({ kind: "elicitationResolved", outcome: "withdrawn" });
    // the user's late click is a no-op, never a second answer
    asks.answerQuestion((events.at(-1) as { patchbayAskId: PatchbayAskId }).patchbayAskId, { action: "decline" });
    expect(events.filter((e) => e.kind === "elicitationResolved")).toHaveLength(1);
  });
});

describe("PermissionBroker url asks — a page the user opens", () => {
  const signIn = {
    message: "Sign in",
    ask: { mode: "url" as const, link: { href: "https://auth.example.com/", host: "auth.example.com", warnings: [] } },
    completion: { patchbayAgentId: "a1" as PatchbayAgentId, elicitationId: "e1" },
  };
  const blockOf = (events: AgentViewEvent[]) =>
    (events.find((e) => e.kind === "elicitationRequested") as { patchbayAskId: PatchbayAskId }).patchbayAskId;

  it("opens only on accept, re-opens while the agent waits, and stops once the agent completes it", async () => {
    const { broker, asks, events, opened } = harness();
    const answer = broker.askElicitation("s1" as PatchbaySessionId, signIn);
    const patchbayAskId = blockOf(events);
    expect(opened).toEqual([]);
    asks.reopenLink(patchbayAskId); // not accepted yet — nothing to re-open
    expect(opened).toEqual([]);

    asks.answerQuestion(patchbayAskId, { action: "accept", content: {} });
    expect(await answer).toEqual({ action: "accept", content: {} });
    expect(opened).toEqual(["https://auth.example.com/"]);
    asks.reopenLink(patchbayAskId);
    expect(opened).toHaveLength(2);

    asks.completeLink("a1" as PatchbayAgentId, "e1");
    expect(events.at(-1)).toEqual({ kind: "elicitationLinkSettled", patchbaySessionId: "s1", patchbayAskId, state: "completed" });
    asks.reopenLink(patchbayAskId);
    expect(opened).toHaveLength(2);
  });

  it("a declined link never opens", async () => {
    const { broker, asks, events, opened } = harness();
    const answer = broker.askElicitation("s1" as PatchbaySessionId, signIn);
    asks.answerQuestion(blockOf(events), { action: "decline" });
    expect(await answer).toEqual({ action: "decline" });
    expect(opened).toEqual([]);
  });

  it("completion ids are matched per agent; an unknown or repeated one is ignored", async () => {
    const { broker, asks, events } = harness();
    void broker.askElicitation("s1" as PatchbaySessionId, signIn);
    asks.answerQuestion(blockOf(events), { action: "accept", content: {} });
    const before = events.length;
    asks.completeLink("a2" as PatchbayAgentId, "e1"); // another agent's id space
    asks.completeLink("a1" as PatchbayAgentId, "nope");
    expect(events).toHaveLength(before);
    asks.completeLink("a1" as PatchbayAgentId, "e1");
    asks.completeLink("a1" as PatchbayAgentId, "e1");
    expect(events.filter((e) => e.kind === "elicitationLinkSettled")).toHaveLength(1);
  });

  it("a completion before the user answers settles the card as completed and answers cancel — the user chose nothing", async () => {
    const { broker, asks, events, opened } = harness();
    const answer = broker.askElicitation("s1" as PatchbaySessionId, signIn);
    asks.completeLink("a1" as PatchbayAgentId, "e1");
    expect(await answer).toEqual({ action: "cancel" });
    expect(events.at(-1)).toMatchObject({ kind: "elicitationResolved", outcome: "completed" });
    expect(opened).toEqual([]);
  });

  it("a completion that overtakes its question is held, and the question settles completed the moment it arrives", async () => {
    const { broker, asks, events, opened } = harness();
    asks.completeLink("a1" as PatchbayAgentId, "e1");
    expect(events).toEqual([]);
    const answer = broker.askElicitation("s1" as PatchbaySessionId, signIn);
    expect(await answer).toEqual({ action: "cancel" });
    expect(events.map((e) => e.kind)).toEqual(["elicitationRequested", "elicitationResolved"]);
    expect(events.at(-1)).toMatchObject({ outcome: "completed" });
    expect(opened).toEqual([]);
  });

  it("a repeated completion is never held — a later question may reuse a finished id", async () => {
    const { broker, asks, events } = harness();
    void broker.askElicitation("s1" as PatchbaySessionId, signIn);
    asks.answerQuestion(blockOf(events), { action: "accept", content: {} });
    asks.completeLink("a1" as PatchbayAgentId, "e1");
    asks.completeLink("a1" as PatchbayAgentId, "e1"); // a repeat, after the link finished
    const reused = broker.askElicitation("s1" as PatchbaySessionId, signIn);
    let settled = false;
    void reused.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // waits for the user like any new question
  });

  it("a withdrawal that overtakes the completion still ends as completed — the finished flow is the fact that stands", async () => {
    const { broker, asks, events } = harness();
    const withdraw = new AbortController();
    const answer = broker.askElicitation("s1" as PatchbaySessionId, signIn, withdraw.signal);
    withdraw.abort();
    expect(await answer).toEqual({ action: "cancel" });
    asks.completeLink("a1" as PatchbayAgentId, "e1");
    expect(events.filter((e) => e.kind === "elicitationResolved").map((e) => (e as { outcome: string }).outcome)).toEqual(
      ["withdrawn", "completed"],
    );
  });

  it("a declined link the agent later finishes keeps the user's answer and is marked done", async () => {
    const { broker, asks, events } = harness();
    void broker.askElicitation("s1" as PatchbaySessionId, signIn);
    asks.answerQuestion(blockOf(events), { action: "decline" });
    asks.completeLink("a1" as PatchbayAgentId, "e1");
    expect(events.at(-1)).toMatchObject({ kind: "elicitationLinkSettled", state: "completed" });
    expect(events.filter((e) => e.kind === "elicitationResolved")).toHaveLength(1);
  });

  it("held completions die with the agent's connection", async () => {
    const { broker, asks } = harness();
    asks.completeLink("a1" as PatchbayAgentId, "e1");
    asks.forgetAgent("a1" as PatchbayAgentId);
    const answer = broker.askElicitation("s1" as PatchbaySessionId, signIn);
    let settled = false;
    void answer.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("the address alone decides what opens — a link nobody will report done still opens and re-opens", async () => {
    const { broker, asks, events, opened } = harness();
    void broker.askElicitation("s1" as PatchbaySessionId, { message: signIn.message, ask: signIn.ask });
    const patchbayAskId = blockOf(events);
    asks.answerQuestion(patchbayAskId, { action: "accept", content: {} });
    asks.reopenLink(patchbayAskId);
    expect(opened).toEqual(["https://auth.example.com/", "https://auth.example.com/"]);
  });

  it("a stopped turn ends the wait on an opened page", async () => {
    const { broker, asks, events, opened } = harness();
    void broker.askElicitation("s1" as PatchbaySessionId, signIn);
    const patchbayAskId = blockOf(events);
    asks.answerQuestion(patchbayAskId, { action: "accept", content: {} });
    asks.stopSession("s1" as PatchbaySessionId);
    expect(events.at(-1)).toEqual({ kind: "elicitationLinkSettled", patchbaySessionId: "s1", patchbayAskId, state: "ended" });
    asks.reopenLink(patchbayAskId);
    expect(opened).toHaveLength(1);
  });
});
