// Patchbay's gate: an agent edit arrives as a diff, a reject leaves disk
// untouched and reaches the agent as an error; terminal commands are gated
// the same way. Runs the extension's real fs/terminal handlers (ClientHost),
// minus vscode (the live-buffer read/write is covered by the vscode suite).
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertKind } from "./support/assert-kind";
import { AsksStore } from "../src/orchestrator/asks-store";
import { PermissionBroker } from "../src/orchestrator/broker";
import { applyFileWrite, ClientHost, clientRequestHooks, type ClientHostDeps } from "../src/orchestrator/client-host";
import { matrixFromDeclared } from "../src/orchestrator/capabilities";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import { SessionsStore } from "../src/orchestrator/sessions-store";
import { tailBytes } from "../src/orchestrator/terminal-runner";
import { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { SessionContinuityStore } from "../src/orchestrator/stores/session-continuity";
import { SessionFilesStore } from "../src/orchestrator/stores/session-files";
import { PermissionRulesStore } from "../src/orchestrator/stores/permission-rules";
import {
  initialAgentViewState,
  reduceAgentView,
  type AgentViewEvent,
  type PermissionOptionView,
} from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { gatesFor } from "./support/session-gates";
import type { PatchbayAgentId, PatchbaySessionId } from "../src/shared/ids";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let dir: string;
let workspaceRoot: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "patchbay-fsterm-"));
  workspaceRoot = join(dir, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function spec(script: FakeAgentScript, patchbayAgentId: PatchbayAgentId): LaunchSpec {
  return {
    patchbayAgentId,
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

  const asks = new AsksStore(audit, {
    emit: (...evs) => events.push(...evs),
    onAuditWritten: () => {},
    pairOf: (patchbaySessionId) => sessions.pairOf(patchbaySessionId),
  });
  const broker = new PermissionBroker(rules, asks, (patchbaySessionId) => sessions.grantedRoots(patchbaySessionId), (text) => text);

  let sessions!: SessionsStore;
  const pool = new AgentPool({
    // A restart must reach the sessions store, or it would prompt a
    // session the new process never opened (the extension wires the same).
    onStatusChanged: (patchbayAgentId, status) => sessions.agentStatusChanged(patchbayAgentId, status),
    onDeclaredCaptured: () => {},
    onSessionUpdate: (patchbayAgentId, notification) => sessions.handleUpdate(patchbayAgentId, notification),
    onCapabilityEvidence: (_patchbayAgentId, row, ev) => evidence.push(`${row}:${ev}`),
    ...clientRequestHooks(
      () => host,
      (patchbayAgentId, sessionId) => sessions.rowFor(patchbayAgentId, sessionId),
    ),
    onPermissionRequest: async (patchbayAgentId, params) => {
      // the session the agent names its own way, as patchbay holds it
      const patchbaySessionId = sessions.rowFor(patchbayAgentId, params.sessionId);
      if (patchbaySessionId === undefined) return { outcome: { outcome: "cancelled" } };
      const result = await broker.resolveAgentPermissionRequest(
        patchbaySessionId,
        params.toolCall.title ?? "Permission request",
        params.toolCall.kind ?? "other",
        params.toolCall.locations?.map((l) => l.path) ?? [],
        optionViewsFromAcp(params.options),
      );
      return "cancelled" in result
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: result.optionId } };
    },
  });

  sessions = new SessionsStore(
    pool,
    {
      emit: (...evs) => events.push(...evs),
      workspaceRoots: () => [workspaceRoot],
      cancelAsks: (patchbaySessionId) => asks.stopSession(patchbaySessionId),
      capabilities: (patchbayAgentId) => {
        const declared = pool.get(patchbayAgentId)?.declared;
        return declared == null ? undefined : matrixFromDeclared(declared);
      },
    },
    new SessionContinuityStore(new MemoryKV()),
    new SessionFilesStore(join(dir, "session-files")),
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
    asks,
    gates: gatesFor(sessions, (event) => events.push(event)),
    rules,
    sessions,
    events,
    evidence,
    state: () => events.reduce(reduceAgentView, initialAgentViewState),
  };
}

function textOf(patchbaySessionId: PatchbaySessionId, events: AgentViewEvent[]): string[] {
  return events
    .filter(
      (e): e is Extract<AgentViewEvent, { kind: "agentTextDelta" }> =>
        e.kind === "agentTextDelta" && e.patchbaySessionId === patchbaySessionId,
    )
    .map((e) => e.text);
}

describe("fs/terminal — gated by the broker, same as everything else", () => {
  it("a write inside the workspace auto-accepts: diff shown, file lands on disk", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ turn: [{ type: "writeFile", path: join(workspaceRoot, "a.txt"), content: "hello\n" }] }, "w1" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.sessions.createSession("w1" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    expect(textOf(patchbaySessionId, h.events)).toContain("write: ok");
    expect(await readFile(join(workspaceRoot, "a.txt"), "utf8")).toBe("hello\n");

    const diff = assertKind(
      h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "diff"),
      "diff",
    );
    // "hello\n" is one line — its newline ends it (diff.test.ts holds the
    // engine's line-counting rules).
    expect(diff.additions).toBe(1);
    expect(diff.resolution).toEqual({ accepted: true, auto: true });
    await h.pool.stop("w1" as PatchbayAgentId);
  });

  it("a write outside the workspace asks; reject leaves disk untouched", async () => {
    const h = harness();
    const outside = join(dir, "outside.txt");
    await h.pool.connect(spec({ turn: [{ type: "writeFile", path: outside, content: "malicious\n" }] }, "w2" as PatchbayAgentId));
    const patchbaySessionId = await h.sessions.createSession("w2" as PatchbayAgentId, "Fake Agent", workspaceRoot);

    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    // resolve the diff card as a reject once it appears
    await waitFor(() => h.state().transcripts[patchbaySessionId]?.some((b) => b.kind === "diff"));
    const diffBlock = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "diff")!;
    h.asks.answerWrite(diffBlock.id, false);
    await turn;

    // the agent hears the rejection — never a success for a write that didn't land
    expect(textOf(patchbaySessionId, h.events)).toContain(`write: rejected (-32803 The user rejected the write to ${outside})`);
    await expect(readFile(outside, "utf8")).rejects.toThrow(); // and disk was never touched
    // a rejection is the gate working — the brokered path fired
    expect(h.evidence).toContain("fs.writeTextFile:used");
    const resolvedDiff = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "diff")!;
    expect(resolvedDiff.kind === "diff" && resolvedDiff.resolution).toEqual({
      accepted: false,
      auto: false,
    });
    await h.pool.stop("w2" as PatchbayAgentId);
  });

  it("a write whose path climbs out of the workspace with `..` asks — judged where it lands (issue #56)", async () => {
    const h = harness();
    const escaping = `${workspaceRoot}/../escaped.txt`;
    await h.pool.connect(spec({ turn: [{ type: "writeFile", path: escaping, content: "x\n" }] }, "w2e" as PatchbayAgentId));
    const patchbaySessionId = await h.sessions.createSession("w2e" as PatchbayAgentId, "Fake Agent", workspaceRoot);

    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    await waitFor(() => h.state().transcripts[patchbaySessionId]?.some((b) => b.kind === "diff"));
    const diffBlock = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "diff")!;
    expect(diffBlock.kind === "diff" && diffBlock.resolution).toBeNull(); // waiting on the user, not auto-accepted
    h.asks.answerWrite(diffBlock.id, false);
    await turn;
    await expect(readFile(join(dir, "escaped.txt"), "utf8")).rejects.toThrow();
    await h.pool.stop("w2e" as PatchbayAgentId);
  });

  it("a write whose turn stops before the user decides is answered cancelled, not rejected", async () => {
    const h = harness();
    const outside = join(dir, "outside.txt");
    await h.pool.connect(spec({ turn: [{ type: "writeFile", path: outside, content: "x\n" }] }, "w3" as PatchbayAgentId));
    const patchbaySessionId = await h.sessions.createSession("w3" as PatchbayAgentId, "Fake Agent", workspaceRoot);

    const turn = h.gates.prompt(patchbaySessionId, { text: "go" }).catch((err: unknown) => err);
    await waitFor(() => h.state().transcripts[patchbaySessionId]?.some((b) => b.kind === "diff"));
    await h.gates.stop(patchbaySessionId);
    expect(await turn).toMatchObject({ by: "stop" });

    expect(textOf(patchbaySessionId, h.events)).toContain(
      `write: rejected (-32800 Request cancelled: the turn was stopped before the user decided on the write to ${outside})`,
    );
    await expect(readFile(outside, "utf8")).rejects.toThrow();
    await h.pool.stop("w3" as PatchbayAgentId);
  });

  it("a read of a missing file is -32002 for that path, never an internal error", async () => {
    const h = harness();
    const missing = join(workspaceRoot, "missing.txt");
    await h.pool.connect(spec({ turn: [{ type: "readFile", path: missing }] }, "r2" as PatchbayAgentId));
    const patchbaySessionId = await h.sessions.createSession("r2" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });
    expect(textOf(patchbaySessionId, h.events)).toContain(`read: failed (-32002 Resource not found: ${missing})`);
    // fs answered truthfully — the path fired
    expect(h.evidence).toContain("fs.readTextFile:used");
    await h.pool.stop("r2" as PatchbayAgentId);
  });

  // A fault is patchbay failing, not a refusal: it stays -32603 (the SDK's
  // internal error) and proves nothing. Injected rather than provoked through
  // a real fs condition — which conditions count as refusals is decided in
  // one place, and a test here must not decide it by accident.
  it("an accepted write that fails to land is a fault: internal error, nothing proven", async () => {
    const h = harness({ writeLive: () => Promise.reject(new Error("apply failed")) });
    const target = join(workspaceRoot, "c.txt");
    await h.pool.connect(spec({ turn: [{ type: "writeFile", path: target, content: "x\n" }] }, "w4" as PatchbayAgentId));
    const patchbaySessionId = await h.sessions.createSession("w4" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    expect(textOf(patchbaySessionId, h.events)).toContain("write: rejected (-32603 Internal error)");
    expect(h.evidence).not.toContain("fs.writeTextFile:used");
    expect(h.evidence).not.toContain("fs.writeTextFile:suspect");
    await h.pool.stop("w4" as PatchbayAgentId);
  });

  it("a read that fails for any reason but a missing file is a fault: internal error, nothing proven", async () => {
    const h = harness({ readLive: () => Promise.reject(Object.assign(new Error("device busy"), { code: "EBUSY" })) });
    const file = join(workspaceRoot, "d.txt");
    await h.pool.connect(spec({ turn: [{ type: "readFile", path: file }] }, "r3" as PatchbayAgentId));
    const patchbaySessionId = await h.sessions.createSession("r3" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    expect(textOf(patchbaySessionId, h.events)).toContain("read: failed (-32603 Internal error)");
    expect(h.evidence).not.toContain("fs.readTextFile:used");
    expect(h.evidence).not.toContain("fs.readTextFile:suspect");
    await h.pool.stop("r3" as PatchbayAgentId);
  });

  it("reads see current disk content", async () => {
    const h = harness();
    const file = join(workspaceRoot, "b.txt");
    await applyFileWrite(file, "existing content\n");
    await h.pool.connect(spec({ turn: [{ type: "readFile", path: file }] }, "r1" as PatchbayAgentId));
    const patchbaySessionId = await h.sessions.createSession("r1" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });
    expect(textOf(patchbaySessionId, h.events)).toContain("read: existing content\n");
    await h.pool.stop("r1" as PatchbayAgentId);
  });

  it("an allowed command actually runs and captures real output", async () => {
    const h = harness();
    const { rules } = h;
    await rules.set({
      commandRules: [{ pattern: `${process.execPath} *`, verdict: "allow" }],
      fileWriteScope: "workspace",
    });
    await h.pool.connect(
      spec({ turn: [{ type: "runCommand", command: process.execPath, args: ["-e", "console.log('hi from child')"] }] }, "c1" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.sessions.createSession("c1" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    const texts = textOf(patchbaySessionId, h.events);
    expect(texts.some((t) => t.includes("exit=0"))).toBe(true);
    expect(texts.some((t) => t.includes("hi from child"))).toBe(true);
    await h.pool.stop("c1" as PatchbayAgentId);
  });

  it("the card shows the directory and environment the command then really runs with (issue #57)", async () => {
    const h = harness();
    const probe = "console.log(process.cwd() + '|' + process.env.PB_PROBE)";
    await h.pool.connect(
      spec(
        { turn: [{ type: "runCommand", command: process.execPath, args: ["-e", probe], env: { PB_PROBE: "set by agent" }, cwd: dir }] },
        "c57" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("c57" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    await waitFor(() => h.state().transcripts[patchbaySessionId]?.some((b) => b.kind === "permission"));
    const card = assertKind(h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "permission"), "permission");
    expect(card.detail).toBe(`${process.execPath} -e "${probe}"`);
    expect(card.facts).toEqual([
      { label: "cwd", value: dir },
      { label: "env", value: "PB_PROBE=set by agent" },
    ]);
    h.asks.answerOption(card.id, "allow_once");
    await turn;
    expect(textOf(patchbaySessionId, h.events).some((t) => t.includes(`${dir}|set by agent`))).toBe(true);
    await h.pool.stop("c57" as PatchbayAgentId);
  });

  it("a command that names no cwd runs in the session's own — the directory the agent was told (issue #64)", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ turn: [{ type: "runCommand", command: process.execPath, args: ["-e", "console.log('cwd=' + process.cwd())"] }] }, "c64" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.sessions.createSession("c64" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    await waitFor(() => h.state().transcripts[patchbaySessionId]?.some((b) => b.kind === "permission"));
    const card = assertKind(h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "permission"), "permission");
    expect(card.facts).toEqual([{ label: "cwd", value: workspaceRoot }]);
    h.asks.answerOption(card.id, "allow_once");
    await turn;
    expect(textOf(patchbaySessionId, h.events).some((t) => t.includes(`cwd=${workspaceRoot}`))).toBe(true);
    await h.pool.stop("c64" as PatchbayAgentId);
  });

  for (const [via, declare] of [
    ["session/load", { loadSession: true }],
    ["session/resume", { sessionCapabilities: { resume: {} } }],
  ] as const) {
    it(`a session re-attached by ${via} after a restart runs a cwd-less command in its own cwd (issue #64)`, async () => {
      const h = harness();
      await h.rules.set({ commandRules: [{ pattern: `${process.execPath} *`, verdict: "allow" }], fileWriteScope: "workspace" });
      const probe = { type: "runCommand" as const, command: process.execPath, args: ["-e", "console.log('cwd=' + process.cwd())"] };
      const patchbayAgentId = `c64-${via.slice(8)}` as PatchbayAgentId;
      await h.pool.connect(spec({ declare, turn: [probe] }, patchbayAgentId));
      const patchbaySessionId = await h.sessions.createSession(patchbayAgentId, "Fake Agent", workspaceRoot);
      await h.gates.prompt(patchbaySessionId, { text: "first turn" }); // prompted: re-attached, never re-minted

      // a fresh process: its connection has opened nothing until the re-attach
      await h.pool.restart(patchbayAgentId);
      expect(h.pool.get(patchbayAgentId)?.sessions).toEqual([]);
      await h.gates.prompt(patchbaySessionId, { text: "second turn" });

      // the connection names it the agent's way
      expect(h.pool.get(patchbayAgentId)?.sessions).toEqual([h.sessions.sessionIdOf(patchbaySessionId)]);
      const texts = textOf(patchbaySessionId, h.events);
      expect(texts.some((t) => t.includes("-32602"))).toBe(false); // never refused as unknown
      // load replays the first turn's output before the second runs; resume restores without replay
      const outputs = texts.filter((t) => t.includes("cwd="));
      expect(outputs).toHaveLength(via === "session/load" ? 3 : 2);
      expect(outputs.at(-1)).toContain(`cwd=${workspaceRoot}`);
      await h.pool.stop(patchbayAgentId);
    });
  }

  it("a denied command never spawns a process", async () => {
    const h = harness();
    await h.rules.set({
      commandRules: [{ pattern: "*", verdict: "deny" }],
      fileWriteScope: "workspace",
    });
    await h.pool.connect(
      spec({ turn: [{ type: "runCommand", command: process.execPath, args: ["-e", "1"] }] }, "c2" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.sessions.createSession("c2" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });
    expect(textOf(patchbaySessionId, h.events)).toContain(
      `command: rejected (-32803 The user rejected the command \`${process.execPath} -e 1\`)`,
    );
    expect(h.evidence).toContain("terminal:used");
    await h.pool.stop("c2" as PatchbayAgentId);
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
        "p1" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("p1" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });
    expect(textOf(patchbaySessionId, h.events)).toContain("permission: allow_once");
    // auto-resolved — no card should have been shown
    expect(h.state().transcripts[patchbaySessionId]!.some((b) => b.kind === "permission")).toBe(false);
    await h.pool.stop("p1" as PatchbayAgentId);
  });

  it("the agent's own edit request asks when any location lands outside — not only the first is judged (issue #56)", async () => {
    const h = harness();
    const locations = [join(workspaceRoot, "cfg.json"), join(dir, "outside.txt")];
    await h.pool.connect(
      spec({ turn: [{ type: "askPermission", title: "Edit two", kind: "edit", subject: locations }] }, "p1m" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.sessions.createSession("p1m" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    await waitFor(() => h.state().transcripts[patchbaySessionId]?.some((b) => b.kind === "permission"));
    const card = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "permission")!;
    h.asks.answerOption(card.id, "reject_once");
    await turn;
    expect(textOf(patchbaySessionId, h.events)).toContain("permission: reject_once");
    await h.pool.stop("p1m" as PatchbayAgentId);
  });

  it("the agent's own session/request_permission for execute always asks (no reliable subject)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "askPermission", title: "Run tests", kind: "execute", subject: "npm test" }] },
        "p2" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("p2" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    await waitFor(() => h.state().transcripts[patchbaySessionId]?.some((b) => b.kind === "permission"));
    const card = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "permission")!;
    h.asks.answerOption(card.id, "allow_once");
    await turn;
    expect(textOf(patchbaySessionId, h.events)).toContain("permission: allow_once");
    await h.pool.stop("p2" as PatchbayAgentId);
  });

  // ACP: a client that cancels a turn MUST answer its pending permission
  // requests as cancelled. Every way a turn is told to stop owes it — the
  // composer's Stop, and the cancel a Reload sends before it re-reads.
  it("a Reload answers the turn's open ask as cancelled — the agent is never left waiting", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true },
          turn: [{ type: "askPermission", title: "Run tests", kind: "execute", subject: "npm test" }],
        },
        "p3" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("p3" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" }).catch((err: unknown) => err);
    await waitFor(() => h.state().transcripts[patchbaySessionId]?.some((b) => b.kind === "permission"));
    await h.gates.reload(patchbaySessionId);
    expect(textOf(patchbaySessionId, h.events)).toContain("permission: cancelled");
    expect(await turn).toMatchObject({ by: "reload" });
    await h.pool.stop("p3" as PatchbayAgentId);
  });

  it("a Close answers the turn's open ask as cancelled before the session goes", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [{ type: "askPermission", title: "Run tests", kind: "execute", subject: "npm test" }],
          declare: { sessionCapabilities: { close: {} } },
        },
        "p4" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("p4" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" }).catch((err: unknown) => err);
    await waitFor(() => h.state().transcripts[patchbaySessionId]?.some((b) => b.kind === "permission"));
    await h.gates.close(patchbaySessionId);
    expect(textOf(patchbaySessionId, h.events)).toContain("permission: cancelled");
    expect(await turn).toMatchObject({ by: "close" });
    await h.pool.stop("p4" as PatchbayAgentId);
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
      () => host.terminalOutput("s" as PatchbaySessionId, { sessionId: "s", terminalId: "term-404" }),
      () => host.waitForTerminalExit("s" as PatchbaySessionId, { sessionId: "s", terminalId: "term-404" }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("term-404") });
    }
  });
});

describe("ClientHost — a terminal answers only the session that made it (#76)", () => {
  const A = "s-a" as PatchbaySessionId;
  const B = "s-b" as PatchbaySessionId;

  it("another session — its agent's or another's — finds no such terminal: no output, no wait, no kill, no release", async () => {
    const h = harness();
    await h.rules.set({ commandRules: [{ pattern: `${process.execPath} *`, verdict: "allow" }], fileWriteScope: "workspace" });
    const { terminalId } = await h.host.createTerminal(
      { sessionId: "agent-a", command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"] },
      { id: A, cwd: workspaceRoot },
    );
    const fromB = { sessionId: "agent-b", terminalId };
    await expect(h.host.terminalOutput(B, fromB)).rejects.toMatchObject({ code: -32602, message: expect.stringContaining(terminalId) });
    await expect(h.host.waitForTerminalExit(B, fromB)).rejects.toMatchObject({ code: -32602 });
    await h.host.killTerminal(B, fromB);
    await h.host.releaseTerminal(B, fromB);
    // still its own session's, still running
    const fromA = { sessionId: "agent-a", terminalId };
    expect((await h.host.terminalOutput(A, fromA)).exitStatus).toBeNull();
    await h.host.releaseTerminal(A, fromA); // its own release kills it
    await expect(h.host.terminalOutput(A, fromA)).rejects.toMatchObject({ code: -32602 });
  });

  it("a request naming a session patchbay doesn't hold is refused — a read, and every terminal call", async () => {
    const h = harness();
    const ghost = { sessionId: "ghost", terminalId: "term-1" };
    for (const call of [
      () => h.host.readTextFile(undefined, { sessionId: "ghost", path: join(workspaceRoot, "x.txt") }),
      () => h.host.terminalOutput(undefined, ghost),
      () => h.host.waitForTerminalExit(undefined, ghost),
      () => h.host.killTerminal(undefined, ghost),
      () => h.host.releaseTerminal(undefined, ghost),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("ghost") });
    }
  });
});

describe("ClientHost — a terminal's session and cwd (issue #64)", () => {
  it("a session the connection never opened is the agent's bad params — nothing asked, nothing spawned", async () => {
    const { host, events } = harness();
    await expect(host.createTerminal({ sessionId: "never-opened", command: "true" }, null)).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("never-opened"),
    });
    expect(events).toEqual([]);
  });

  it("a relative cwd is the agent's bad params — the spec requires an absolute path", async () => {
    const { host, events } = harness();
    await expect(
      host.createTerminal({ sessionId: "s", command: "true", cwd: "sub/dir" }, { id: "s" as PatchbaySessionId, cwd: workspaceRoot }),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("sub/dir") });
    expect(events).toEqual([]);
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
