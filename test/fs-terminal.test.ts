// Patchbay's gate: an agent edit arrives as a diff, a reject leaves disk
// untouched and reaches the agent as an error; terminal commands are gated
// the same way. Runs the extension's real fs/terminal handlers (ClientHost),
// minus vscode (the live-buffer read/write is covered by the vscode suite).
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertKind } from "./support/assert-kind";
import { applyFileWrite, PermissionBroker } from "../src/orchestrator/broker";
import { ClientHost, clientRequestHooks, type ClientHostDeps } from "../src/orchestrator/client-host";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import { SessionManager } from "../src/orchestrator/session-manager";
import { tailBytes } from "../src/orchestrator/terminal-runner";
import { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { PermissionRulesStore } from "../src/orchestrator/stores/permission-rules";
import {
  initialAgentViewState,
  reduceAgentView,
  type AgentViewEvent,
  type PermissionOptionView,
} from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let dir: string;
let workspaceRoot: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "patchbay-fsterm-"));
  workspaceRoot = join(dir, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function spec(script: FakeAgentScript, agentId: string): LaunchSpec {
  return {
    agentId,
    name: "Fake Agent",
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    cwd: workspaceRoot,
  };
}

function optionViewsFromAcp(
  options: readonly { optionId: string; name: string; kind: string }[],
): PermissionOptionView[] {
  return options.map((o) => ({ optionId: o.optionId, label: o.name, kind: o.kind as PermissionOptionView["kind"] }));
}

/** orchestrator.ts's fs/terminal wiring without vscode. `live` swaps the
 * live-buffer read/write — plain disk by default — to inject a fault. */
function harness(live: Partial<Pick<ClientHostDeps, "readLive" | "writeLive">> = {}) {
  const rules = new PermissionRulesStore(new MemoryKV());
  const audit = new DecisionAuditStore(dir);
  const events: AgentViewEvent[] = [];
  const evidence: string[] = [];

  const broker = new PermissionBroker(
    rules,
    audit,
    { emit: (...evs) => events.push(...evs), onAuditWritten: () => {} },
    () => workspaceRoot,
  );

  let sessionManager!: SessionManager;
  const pool = new AgentPool({
    onStatusChanged: () => {},
    onDeclaredCaptured: () => {},
    onSessionUpdate: (agentId, notification) => sessionManager.handleUpdate(agentId, notification),
    onCapabilityEvidence: (_agentId, row, ev) => evidence.push(`${row}:${ev}`),
    ...clientRequestHooks(() => host),
    onPermissionRequest: async (_agentId, params) => {
      const subject =
        params.toolCall.kind === "edit" ? (params.toolCall.locations?.[0]?.path ?? null) : null;
      const result = await broker.resolveAgentPermissionRequest(
        params.sessionId,
        params.toolCall.title ?? "Permission request",
        params.toolCall.kind ?? "other",
        subject,
        optionViewsFromAcp(params.options),
      );
      return "cancelled" in result
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: result.optionId } };
    },
  });

  sessionManager = new SessionManager(
    pool,
    { emit: (...evs) => events.push(...evs) },
    () => workspaceRoot,
  );
  // The extension's own handlers; only the live-buffer read/write differ
  // (plain disk here — there is no editor to hold a buffer).
  const host = new ClientHost({
    broker,
    readLive: (path) => readFile(path, "utf8"),
    writeLive: applyFileWrite,
    ...live,
    emit: (ev) => events.push(ev),
    trackProcess: () => {},
  });

  return {
    pool,
    host,
    broker,
    rules,
    sessionManager,
    events,
    evidence,
    state: () => events.reduce(reduceAgentView, initialAgentViewState),
  };
}

function textOf(sessionId: string, events: AgentViewEvent[]): string[] {
  return events
    .filter(
      (e): e is Extract<AgentViewEvent, { kind: "agentTextDelta" }> =>
        e.kind === "agentTextDelta" && e.sessionId === sessionId,
    )
    .map((e) => e.text);
}

describe("fs/terminal — gated by the broker, same as everything else", () => {
  it("a write inside the workspace auto-accepts: diff shown, file lands on disk", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ turn: [{ type: "writeFile", path: join(workspaceRoot, "a.txt"), content: "hello\n" }] }, "w1"),
    );
    const sessionId = await h.sessionManager.createSession("w1", "Fake Agent", workspaceRoot);
    await h.sessionManager.sendPrompt(sessionId, "go");

    expect(textOf(sessionId, h.events)).toContain("write: ok");
    expect(await readFile(join(workspaceRoot, "a.txt"), "utf8")).toBe("hello\n");

    const diff = assertKind(
      h.state().transcripts[sessionId]!.find((b) => b.kind === "diff"),
      "diff",
    );
    // "hello\n" is one line — its newline ends it (diff.test.ts holds the
    // engine's line-counting rules).
    expect(diff.additions).toBe(1);
    expect(diff.resolution).toEqual({ accepted: true, auto: true });
    await h.pool.stop("w1");
  });

  it("a write outside the workspace asks; reject leaves disk untouched", async () => {
    const h = harness();
    const outside = join(dir, "outside.txt");
    await h.pool.connect(spec({ turn: [{ type: "writeFile", path: outside, content: "malicious\n" }] }, "w2"));
    const sessionId = await h.sessionManager.createSession("w2", "Fake Agent", workspaceRoot);

    const turn = h.sessionManager.sendPrompt(sessionId, "go");
    // resolve the diff card as a reject once it appears
    await waitFor(() => h.state().transcripts[sessionId]?.some((b) => b.kind === "diff"));
    const diffBlock = h.state().transcripts[sessionId]!.find((b) => b.kind === "diff")!;
    h.broker.resolve(diffBlock.id, "reject");
    await turn;

    // the agent hears the rejection — never a success for a write that didn't land
    expect(textOf(sessionId, h.events)).toContain(`write: rejected (-32803 The user rejected the write to ${outside})`);
    await expect(readFile(outside, "utf8")).rejects.toThrow(); // and disk was never touched
    // a rejection is the gate working — the brokered path fired
    expect(h.evidence).toContain("fs.writeTextFile:used");
    const resolvedDiff = h.state().transcripts[sessionId]!.find((b) => b.kind === "diff")!;
    expect(resolvedDiff.kind === "diff" && resolvedDiff.resolution).toEqual({
      accepted: false,
      auto: false,
    });
    await h.pool.stop("w2");
  });

  it("a write whose turn stops before the user decides is answered cancelled, not rejected", async () => {
    const h = harness();
    const outside = join(dir, "outside.txt");
    await h.pool.connect(spec({ turn: [{ type: "writeFile", path: outside, content: "x\n" }] }, "w3"));
    const sessionId = await h.sessionManager.createSession("w3", "Fake Agent", workspaceRoot);

    const turn = h.sessionManager.sendPrompt(sessionId, "go");
    await waitFor(() => h.state().transcripts[sessionId]?.some((b) => b.kind === "diff"));
    h.broker.cancelPending(sessionId);
    await turn;

    expect(textOf(sessionId, h.events)).toContain(
      `write: rejected (-32800 Request cancelled: the turn was stopped before the user decided on the write to ${outside})`,
    );
    await expect(readFile(outside, "utf8")).rejects.toThrow();
    await h.pool.stop("w3");
  });

  it("a read of a missing file is -32002 for that path, never an internal error", async () => {
    const h = harness();
    const missing = join(workspaceRoot, "missing.txt");
    await h.pool.connect(spec({ turn: [{ type: "readFile", path: missing }] }, "r2"));
    const sessionId = await h.sessionManager.createSession("r2", "Fake Agent", workspaceRoot);
    await h.sessionManager.sendPrompt(sessionId, "go");
    expect(textOf(sessionId, h.events)).toContain(`read: failed (-32002 Resource not found: ${missing})`);
    // fs answered truthfully — the path fired
    expect(h.evidence).toContain("fs.readTextFile:used");
    await h.pool.stop("r2");
  });

  // A fault is patchbay failing, not a refusal: it stays -32603 (the SDK's
  // internal error) and proves nothing. Injected rather than provoked through
  // a real fs condition — which conditions count as refusals is decided in
  // one place, and a test here must not decide it by accident.
  it("an accepted write that fails to land is a fault: internal error, nothing proven", async () => {
    const h = harness({ writeLive: () => Promise.reject(new Error("apply failed")) });
    const target = join(workspaceRoot, "c.txt");
    await h.pool.connect(spec({ turn: [{ type: "writeFile", path: target, content: "x\n" }] }, "w4"));
    const sessionId = await h.sessionManager.createSession("w4", "Fake Agent", workspaceRoot);
    await h.sessionManager.sendPrompt(sessionId, "go");

    expect(textOf(sessionId, h.events)).toContain("write: rejected (-32603 Internal error)");
    expect(h.evidence).not.toContain("fs.writeTextFile:used");
    expect(h.evidence).not.toContain("fs.writeTextFile:suspect");
    await h.pool.stop("w4");
  });

  it("a read that fails for any reason but a missing file is a fault: internal error, nothing proven", async () => {
    const h = harness({ readLive: () => Promise.reject(Object.assign(new Error("device busy"), { code: "EBUSY" })) });
    const file = join(workspaceRoot, "d.txt");
    await h.pool.connect(spec({ turn: [{ type: "readFile", path: file }] }, "r3"));
    const sessionId = await h.sessionManager.createSession("r3", "Fake Agent", workspaceRoot);
    await h.sessionManager.sendPrompt(sessionId, "go");

    expect(textOf(sessionId, h.events)).toContain("read: failed (-32603 Internal error)");
    expect(h.evidence).not.toContain("fs.readTextFile:used");
    expect(h.evidence).not.toContain("fs.readTextFile:suspect");
    await h.pool.stop("r3");
  });

  it("reads see current disk content", async () => {
    const h = harness();
    const file = join(workspaceRoot, "b.txt");
    await applyFileWrite(file, "existing content\n");
    await h.pool.connect(spec({ turn: [{ type: "readFile", path: file }] }, "r1"));
    const sessionId = await h.sessionManager.createSession("r1", "Fake Agent", workspaceRoot);
    await h.sessionManager.sendPrompt(sessionId, "go");
    expect(textOf(sessionId, h.events)).toContain("read: existing content\n");
    await h.pool.stop("r1");
  });

  it("an allowed command actually runs and captures real output", async () => {
    const h = harness();
    const { rules } = h;
    await rules.set({
      commandRules: [{ pattern: `${process.execPath} *`, verdict: "allow" }],
      fileWriteScope: "workspace",
    });
    await h.pool.connect(
      spec({ turn: [{ type: "runCommand", command: process.execPath, args: ["-e", "console.log('hi from child')"] }] }, "c1"),
    );
    const sessionId = await h.sessionManager.createSession("c1", "Fake Agent", workspaceRoot);
    await h.sessionManager.sendPrompt(sessionId, "go");

    const texts = textOf(sessionId, h.events);
    expect(texts.some((t) => t.includes("exit=0"))).toBe(true);
    expect(texts.some((t) => t.includes("hi from child"))).toBe(true);
    await h.pool.stop("c1");
  });

  it("a denied command never spawns a process", async () => {
    const h = harness();
    await h.rules.set({
      commandRules: [{ pattern: "*", verdict: "deny" }],
      fileWriteScope: "workspace",
    });
    await h.pool.connect(
      spec({ turn: [{ type: "runCommand", command: process.execPath, args: ["-e", "1"] }] }, "c2"),
    );
    const sessionId = await h.sessionManager.createSession("c2", "Fake Agent", workspaceRoot);
    await h.sessionManager.sendPrompt(sessionId, "go");
    expect(textOf(sessionId, h.events)).toContain(
      `command: rejected (-32803 The user rejected the command \`${process.execPath} -e 1\`)`,
    );
    expect(h.evidence).toContain("terminal:used");
    await h.pool.stop("c2");
  });

  it("the agent's own session/request_permission for an edit auto-allows inside the workspace", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "askPermission", title: "Edit config", kind: "edit", subject: join(workspaceRoot, "cfg.json") },
          ],
        },
        "p1",
      ),
    );
    const sessionId = await h.sessionManager.createSession("p1", "Fake Agent", workspaceRoot);
    await h.sessionManager.sendPrompt(sessionId, "go");
    expect(textOf(sessionId, h.events)).toContain("permission: allow_once");
    // auto-resolved — no card should have been shown
    expect(h.state().transcripts[sessionId]!.some((b) => b.kind === "permission")).toBe(false);
    await h.pool.stop("p1");
  });

  it("the agent's own session/request_permission for execute always asks (no reliable subject)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "askPermission", title: "Run tests", kind: "execute", subject: "npm test" }] },
        "p2",
      ),
    );
    const sessionId = await h.sessionManager.createSession("p2", "Fake Agent", workspaceRoot);
    const turn = h.sessionManager.sendPrompt(sessionId, "go");
    await waitFor(() => h.state().transcripts[sessionId]?.some((b) => b.kind === "permission"));
    const card = h.state().transcripts[sessionId]!.find((b) => b.kind === "permission")!;
    h.broker.resolve(card.id, "allow_once");
    await turn;
    expect(textOf(sessionId, h.events)).toContain("permission: allow_once");
    await h.pool.stop("p2");
  });
});

async function waitFor(probe: () => boolean | undefined, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (probe()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("ClientHost — replies for a terminal id it never issued", () => {
  it("is the agent's bad params (-32602), never the client breaking (-32603)", async () => {
    const { host } = harness();
    for (const call of [
      () => host.terminalOutput({ sessionId: "s", terminalId: "term-404" }),
      () => host.waitForTerminalExit({ sessionId: "s", terminalId: "term-404" }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("term-404") });
    }
  });
});

describe("tailBytes (ACP outputByteLimit — bytes, character-boundary cut)", () => {
  it("under the limit passes through untouched", () => {
    expect(tailBytes("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  it("truncates from the beginning, keeping the tail", () => {
    expect(tailBytes("0123456789", 4)).toEqual({ text: "6789", truncated: true });
  });

  it("counts bytes, not UTF-16 units", () => {
    // "é" is 2 bytes in UTF-8 — 5 chars = 10 bytes; a 4-byte tail is 2 chars
    expect(tailBytes("ééééé", 4)).toEqual({ text: "éé", truncated: true });
  });

  it("never splits a code point — cut lands on the next boundary", () => {
    // "😀" is 4 bytes; a 6-byte budget over two emoji can hold only one whole
    expect(tailBytes("😀😀", 6)).toEqual({ text: "😀", truncated: true });
  });
});
