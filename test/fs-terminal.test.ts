// P6 gate: agent edit arrives as a diff, reject leaves disk untouched;
// terminal commands are gated the same way. Wires the pool's fs/terminal
// hooks the way Orchestrator does, minus vscode (live-buffer reads and the
// visible-pty wrapper are vscode-only and covered by manual smoke instead).
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertKind } from "./support/assert-kind";
import { applyFileWrite, PermissionBroker } from "../src/orchestrator/broker";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import { SessionManager } from "../src/orchestrator/session-manager";
import { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { PermissionRulesStore } from "../src/orchestrator/stores/permission-rules";
import { SessionIndexStore } from "../src/orchestrator/stores/session-index";
import {
  initialAgentViewState,
  reduceAgentView,
  type AgentViewEvent,
  type PermissionOptionView,
} from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { stubFsTerminalHooks } from "./support/stub-hooks";

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

/** Mirrors orchestrator.ts's fs/terminal wiring without vscode. */
function harness() {
  const rules = new PermissionRulesStore(new MemoryKV());
  const audit = new DecisionAuditStore(dir);
  const events: AgentViewEvent[] = [];
  const terminals = new Map<string, ReturnType<PermissionBroker["runner"]["create"]>>();
  let terminalCounter = 0;

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
    ...stubFsTerminalHooks(),
    onReadTextFile: async (_agentId, params) => ({ content: await readFile(params.path, "utf8") }),
    onWriteTextFile: async (_agentId, params) => {
      const { accepted } = await broker.gateFileWrite(params.sessionId, params.path, params.content);
      if (accepted) await applyFileWrite(params.path, params.content);
      return {};
    },
    onCreateTerminal: async (_agentId, params) => {
      const command = [params.command, ...(params.args ?? [])].join(" ");
      const { accepted } = await broker.gateCommand(params.sessionId, command);
      if (!accepted) throw new Error("command rejected by permission rules");
      const handle = broker.runner.create({
        command: params.command,
        args: params.args ?? [],
        env: {},
        cwd: params.cwd ?? null,
        outputByteLimit: params.outputByteLimit ?? null,
      });
      const terminalId = `term-${++terminalCounter}`;
      terminals.set(terminalId, handle);
      return { terminalId };
    },
    onTerminalOutput: async (_agentId, params) => {
      const handle = terminals.get(params.terminalId)!;
      const { output, truncated } = handle.currentOutput();
      const exit = handle.exitStatus();
      return { output, truncated, exitStatus: exit ? { exitCode: exit.exitCode, signal: exit.signal } : null };
    },
    onWaitForTerminalExit: async (_agentId, params) => terminals.get(params.terminalId)!.waitForExit(),
    onKillTerminal: async (_agentId, params) => {
      terminals.get(params.terminalId)?.kill();
      return {};
    },
    onReleaseTerminal: async (_agentId, params) => {
      terminals.delete(params.terminalId);
      return {};
    },
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
    new SessionIndexStore(new MemoryKV()),
    { emit: (...evs) => events.push(...evs) },
    () => workspaceRoot,
  );

  return {
    pool,
    broker,
    rules,
    sessionManager,
    events,
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
    // "hello\n".split("\n") is ["hello", ""] — the trailing empty line is
    // a real line in the diff, not a quirk; see diff.test.ts for the
    // dedicated engine coverage.
    expect(diff.additions).toBe(2);
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

    expect(textOf(sessionId, h.events)).toContain("write: ok"); // fs/write_text_file itself doesn't error on reject
    await expect(readFile(outside, "utf8")).rejects.toThrow(); // but disk was never touched
    const resolvedDiff = h.state().transcripts[sessionId]!.find((b) => b.kind === "diff")!;
    expect(resolvedDiff.kind === "diff" && resolvedDiff.resolution).toEqual({
      accepted: false,
      auto: false,
    });
    await h.pool.stop("w2");
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
    expect(textOf(sessionId, h.events).some((t) => t.startsWith("command: rejected"))).toBe(true);
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
