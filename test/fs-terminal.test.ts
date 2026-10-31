// Patchbay's gate: an agent edit arrives as a diff, a reject leaves disk
// untouched and reaches the agent as an error; terminal commands are gated
// the same way. Runs the extension's real fs/terminal handlers (ClientHost),
// minus vscode (the live-buffer read/write is covered by the vscode suite).
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAgent } from "./support/fake-agent";
import { tempDir } from "./support/teardown";
import { waitFor } from "./support/wait-for";
import { assertKind } from "./support/assert-kind";
import { formatCommandLine } from "../src/shared/command-line";
import { applyFileWrite } from "../src/orchestrator/client-host";
import { type LaunchSpec } from "../src/orchestrator/pool";
import { tailBytes } from "../src/orchestrator/terminal-runner";
import type { OrchestratorPorts } from "../src/orchestrator/orchestrator";
import type { AgentViewState } from "../src/shared/protocol";
import { orchestratorHarness } from "./support/orchestrator-harness";
import { standIn } from "./support/stand-in";
import type { FakeAgentScript } from "./fake-agent/main";
import type { PatchbayAgentId, PatchbayAskId, PatchbaySessionId } from "../src/shared/ids";

/** Node as a command line spells it — quoted where its path has a space
 * (`C:\Program Files\…` on Windows), the form a rule is matched against. */
const NODE = formatCommandLine(process.execPath, []);

let dir: string;
let workspaceRoot: string;
beforeEach(async () => {
  dir = await tempDir("patchbay-fsterm-");
  workspaceRoot = join(dir, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
});
// Retried: on Windows a released terminal's process holds the folder
// (EBUSY) until it has finished exiting.

const spec = (script: FakeAgentScript, patchbayAgentId: string): LaunchSpec => fakeAgent(script, patchbayAgentId, workspaceRoot);

/** The window's orchestrator, working in `workspaceRoot`, its fs/terminal
 * parts under the names these tests read. `live` replaces what an editor's
 * open buffers would answer — disk by default — to inject a fault. */
function harness(live: Partial<Pick<OrchestratorPorts, "readTextFileLive" | "writeTextFileLive">> = {}) {
  const h = orchestratorHarness(dir, { workspace: workspaceRoot, ports: live });
  const o = h.orchestrator;
  return {
    pool: o.pool,
    host: o.clientHost,
    broker: o.broker,
    asks: o.asks,
    gates: o.sessionGates,
    rules: o.permissionRules,
    sessions: o.sessions,
    events: h.agentView.events,
    state: h.agentView.state,
    notified: () => h.asked.filter((a) => a.port === "notifyAsk"),
    started: h.started,
    /** Every row the wire has proven or put under suspicion — each test
     * drives one agent. */
    evidence: (): string[] =>
      o.pool.list().flatMap((agent) =>
        Object.entries(o.capabilityTracker.matrix(agent.spec.patchbayAgentId) ?? {}).flatMap(([row, cell]) =>
          cell.used ? [`${row}:used`] : cell.suspect ? [`${row}:suspect`] : [],
        ),
      ),
  };
}

/** The text the agent streamed into the session — its text blocks, in
 * order, as the user reads them. */
function streamedText(patchbaySessionId: PatchbaySessionId, state: AgentViewState): string {
  return (state.transcripts[patchbaySessionId] ?? []).flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");
}

describe("fs/terminal — gated by the broker, same as everything else", () => {
  it("a write inside the workspace auto-accepts: diff shown, file lands on disk", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ turn: [{ type: "writeFile", path: join(workspaceRoot, "a.txt"), content: "hello\n" }] }, "w1" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.gates.create("w1" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    expect(streamedText(patchbaySessionId, h.state())).toContain("write: ok");
    expect(await readFile(join(workspaceRoot, "a.txt"), "utf8")).toBe("hello\n");

    const diff = assertKind(
      h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "diff"),
      "diff",
    );
    // "hello\n" is one line — its newline ends it (diff.test.ts holds the
    // engine's line-counting rules).
    expect(diff.additions).toBe(1);
    expect(diff.resolution).toEqual({ accepted: true, auto: true });
    expect(h.notified()).toEqual([]); // nothing was ever asked of anyone
    await h.pool.stop("w1" as PatchbayAgentId);
  });

  it("a write outside the workspace asks; reject leaves disk untouched", async () => {
    const h = harness();
    const outside = join(dir, "outside.txt");
    await h.pool.connect(spec({ turn: [{ type: "writeFile", path: outside, content: "malicious\n" }] }, "w2" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("w2" as PatchbayAgentId, "Fake Agent", workspaceRoot);

    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    // resolve the diff card as a reject once it appears
    const diffBlock = await waitFor(() => h.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "diff"));
    h.asks.answerWrite(diffBlock.id, false);
    await turn;

    // the agent hears the rejection — never a success for a write that didn't land
    expect(streamedText(patchbaySessionId, h.state())).toContain(`write: rejected (-32803 The user rejected the write to ${outside})`);
    await expect(readFile(outside, "utf8")).rejects.toThrow(); // and disk was never touched
    // a rejection is the gate working — the brokered path fired
    expect(h.evidence()).toContain("fs.writeTextFile:used");
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
    const patchbaySessionId = await h.gates.create("w2e" as PatchbayAgentId, "Fake Agent", workspaceRoot);

    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    const diffBlock = await waitFor(() => h.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "diff"));
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
    const patchbaySessionId = await h.gates.create("w3" as PatchbayAgentId, "Fake Agent", workspaceRoot);

    const turn = h.gates.prompt(patchbaySessionId, { text: "go" }).catch((err: unknown) => err);
    await waitFor(() => h.state().transcripts[patchbaySessionId]?.some((b) => b.kind === "diff"));
    await h.gates.stop(patchbaySessionId);
    expect(await turn).toMatchObject({ by: "stop" });

    expect(streamedText(patchbaySessionId, h.state())).toContain(
      `write: rejected (-32800 Request cancelled: the turn was stopped before the user decided on the write to ${outside})`,
    );
    await expect(readFile(outside, "utf8")).rejects.toThrow();
    await h.pool.stop("w3" as PatchbayAgentId);
  });

  it("a read of a missing file is -32002 for that path, never an internal error", async () => {
    const h = harness();
    const missing = join(workspaceRoot, "missing.txt");
    await h.pool.connect(spec({ turn: [{ type: "readFile", path: missing }] }, "r2" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("r2" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });
    expect(streamedText(patchbaySessionId, h.state())).toContain(`read: failed (-32002 Resource not found: ${missing})`);
    // fs answered truthfully — the path fired
    expect(h.evidence()).toContain("fs.readTextFile:used");
    await h.pool.stop("r2" as PatchbayAgentId);
  });

  // A fault is patchbay failing, not a refusal: it stays -32603 (the SDK's
  // internal error) and proves nothing. Injected rather than provoked through
  // a real fs condition — which conditions count as refusals is decided in
  // one place, and a test here must not decide it by accident.
  it("an accepted write that fails to land is a fault: internal error, nothing proven", async () => {
    const h = harness({ writeTextFileLive: () => Promise.reject(new Error("apply failed")) });
    const target = join(workspaceRoot, "c.txt");
    await h.pool.connect(spec({ turn: [{ type: "writeFile", path: target, content: "x\n" }] }, "w4" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("w4" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    expect(streamedText(patchbaySessionId, h.state())).toContain("write: rejected (-32603 Internal error)");
    expect(h.evidence()).not.toContain("fs.writeTextFile:used");
    expect(h.evidence()).not.toContain("fs.writeTextFile:suspect");
    await h.pool.stop("w4" as PatchbayAgentId);
  });

  it("a read that fails for any reason but a missing file is a fault: internal error, nothing proven", async () => {
    const h = harness({ readTextFileLive: () => Promise.reject(Object.assign(new Error("device busy"), { code: "EBUSY" })) });
    const file = join(workspaceRoot, "d.txt");
    await h.pool.connect(spec({ turn: [{ type: "readFile", path: file }] }, "r3" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("r3" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    expect(streamedText(patchbaySessionId, h.state())).toContain("read: failed (-32603 Internal error)");
    expect(h.evidence()).not.toContain("fs.readTextFile:used");
    expect(h.evidence()).not.toContain("fs.readTextFile:suspect");
    await h.pool.stop("r3" as PatchbayAgentId);
  });

  it("reads see current disk content", async () => {
    const h = harness();
    const file = join(workspaceRoot, "b.txt");
    await applyFileWrite(file, "existing content\n");
    await h.pool.connect(spec({ turn: [{ type: "readFile", path: file }] }, "r1" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("r1" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });
    expect(streamedText(patchbaySessionId, h.state())).toContain("read: existing content\n");
    await h.pool.stop("r1" as PatchbayAgentId);
  });

  it("an allowed command actually runs and captures real output", async () => {
    const h = harness();
    const { rules } = h;
    await rules.set({
      commandRules: [{ kind: "command", pattern: `${NODE} *`, verdict: "allow" }],
      writeScope: [],
    });
    await h.pool.connect(
      spec({ turn: [{ type: "runCommand", command: process.execPath, args: ["-e", "console.log('hi from child')"] }] }, "c1" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.gates.create("c1" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    const texts = streamedText(patchbaySessionId, h.state());
    expect(texts.includes("exit=0")).toBe(true);
    expect(texts.includes("hi from child")).toBe(true);
    // Its card shows settled by the rule — never an ask waiting on anyone,
    // so nothing calls for the user (no session here is on screen).
    expect(assertKind(h.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "permission"), "permission").resolution).toEqual({ label: "Allowed", auto: true });
    expect(h.notified()).toEqual([]);
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
    const patchbaySessionId = await h.gates.create("c57" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    const card = assertKind(await waitFor(() => h.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "permission")), "permission");
    expect(card.detail).toBe(formatCommandLine(process.execPath, ["-e", probe]));
    expect(card.facts).toEqual([
      { label: "cwd", value: dir },
      { label: "env", value: "PB_PROBE=set by agent" },
      { label: "asks", value: `${card.detail} — no rule matched` },
    ]);
    h.asks.answerOption(card.id, "allow_once");
    await turn;
    expect(streamedText(patchbaySessionId, h.state()).includes(`${dir}|set by agent`)).toBe(true);
    await h.pool.stop("c57" as PatchbayAgentId);
  });

  it("a command that names no cwd runs in the session's own — the directory the agent was told (issue #64)", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ turn: [{ type: "runCommand", command: process.execPath, args: ["-e", "console.log('cwd=' + process.cwd())"] }] }, "c64" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.gates.create("c64" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    const card = assertKind(await waitFor(() => h.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "permission")), "permission");
    expect(card.facts).toEqual([
      { label: "cwd", value: workspaceRoot },
      { label: "asks", value: `${card.detail} — no rule matched` },
    ]);
    h.asks.answerOption(card.id, "allow_once");
    await turn;
    expect(streamedText(patchbaySessionId, h.state()).includes(`cwd=${workspaceRoot}`)).toBe(true);
    await h.pool.stop("c64" as PatchbayAgentId);
  });

  for (const [via, declare] of [
    ["session/load", { loadSession: true }],
    ["session/resume", { sessionCapabilities: { resume: {} } }],
  ] as const) {
    it(`a session re-attached by ${via} after a restart runs a cwd-less command in its own cwd (issue #64)`, async () => {
      const h = harness();
      await h.rules.set({ commandRules: [{ kind: "command", pattern: `${NODE} *`, verdict: "allow" }], writeScope: [] });
      const probe = { type: "runCommand" as const, command: process.execPath, args: ["-e", "console.log('cwd=' + process.cwd())"] };
      const patchbayAgentId = `c64-${via.slice(8)}` as PatchbayAgentId;
      await h.pool.connect(spec({ declare, turn: [probe] }, patchbayAgentId));
      // what the agent sends the session, as it enters the orchestrator
      const updates = vi.spyOn(h.sessions, "handleUpdate");
      const patchbaySessionId = await h.gates.create(patchbayAgentId, "Fake Agent", workspaceRoot);
      await h.gates.prompt(patchbaySessionId, { text: "first turn" }); // prompted: re-attached, never re-minted

      // a fresh process: its connection has opened nothing until the re-attach
      await h.pool.restart(patchbayAgentId);
      expect(h.pool.get(patchbayAgentId)?.sessions).toEqual([]);
      await h.gates.prompt(patchbaySessionId, { text: "second turn" });

      // the connection names it the agent's way
      expect(h.pool.get(patchbayAgentId)?.sessions).toEqual([h.sessions.sessionIdOf(patchbaySessionId)]);
      const texts = streamedText(patchbaySessionId, h.state());
      expect(texts.includes("-32602")).toBe(false); // never refused as unknown
      // load replays the first turn's output before the second runs; resume restores without replay
      const outputs = updates.mock.calls.flatMap(([, , update]) => {
        const text = JSON.stringify(update);
        return text.includes("cwd=") ? [text] : [];
      });
      expect(outputs).toHaveLength(via === "session/load" ? 3 : 2);
      expect(outputs.at(-1)).toContain(`cwd=${JSON.stringify(workspaceRoot).slice(1, -1)}`);
      await h.pool.stop(patchbayAgentId);
    });
  }

  it("a denied command never spawns a process", async () => {
    const h = harness();
    await h.rules.set({
      commandRules: [{ kind: "command", pattern: "*", verdict: "deny" }],
      writeScope: [],
    });
    await h.pool.connect(
      spec({ turn: [{ type: "runCommand", command: process.execPath, args: ["-e", "1"] }] }, "c2" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.gates.create("c2" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });
    expect(streamedText(patchbaySessionId, h.state())).toContain(
      `command: rejected (-32803 The user rejected the command \`${formatCommandLine(process.execPath, ["-e", "1"])}\`)`,
    );
    expect(h.evidence()).toContain("terminal:used");
    expect(assertKind(h.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "permission"), "permission").resolution).toEqual({ label: "Rejected", auto: true });
    expect(h.notified()).toEqual([]);
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
    const patchbaySessionId = await h.gates.create("p1" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });
    expect(streamedText(patchbaySessionId, h.state())).toContain("permission: allow_once");
    // auto-resolved — the card still shows, settled by the rule
    expect(h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "permission")).toMatchObject({
      resolution: { label: "Allowed", auto: true },
    });
    expect(h.notified()).toEqual([]);
    await h.pool.stop("p1" as PatchbayAgentId);
  });

  it("the agent's own edit request asks when any location lands outside — not only the first is judged (issue #56)", async () => {
    const h = harness();
    const locations = [join(workspaceRoot, "cfg.json"), join(dir, "outside.txt")];
    await h.pool.connect(
      spec({ turn: [{ type: "askPermission", title: "Edit two", kind: "edit", subject: locations }] }, "p1m" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.gates.create("p1m" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    const card = await waitFor(() => h.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "permission"));
    h.asks.answerOption(card.id, "reject_once");
    await turn;
    expect(streamedText(patchbaySessionId, h.state())).toContain("permission: reject_once");
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
    const patchbaySessionId = await h.gates.create("p2" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    const card = await waitFor(() => h.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "permission"));
    h.asks.answerOption(card.id, "allow_once");
    await turn;
    expect(streamedText(patchbaySessionId, h.state())).toContain("permission: allow_once");
    await h.pool.stop("p2" as PatchbayAgentId);
  });

  it("the card shows the call it asks about — over what the session already showed of it — and an edit is judged by its diff's own path (#80)", async () => {
    const h = harness();
    const inside = join(workspaceRoot, "cfg.json");
    const outside = join(dir, "outside.txt");
    await h.pool.connect(
      spec(
        {
          turn: [
            {
              type: "update",
              update: { sessionUpdate: "tool_call", toolCallId: "e1", title: "Edit cfg", kind: "edit", rawInput: { file: inside } },
            },
            {
              type: "askPermission",
              title: "unused",
              kind: "edit",
              subject: inside,
              // the request names the call, its file inside, and carries a
              // diff whose own path is outside — title and kind left to the call
              toolCall: {
                toolCallId: "e1",
                title: null,
                kind: null,
                content: [{ type: "diff", path: outside, oldText: "a\n", newText: "b\n" }],
              },
            },
          ],
        },
        "p2c" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.gates.create("p2c" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    const card = await waitFor(() => h.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "permission"));
    expect(card).toMatchObject({
      title: "Edit cfg",
      call: {
        toolCallId: "e1",
        toolKind: "edit",
        locations: [{ path: inside, line: null }],
        diffs: {
          [outside]: {
            additions: 1,
            deletions: 1,
            preview: [
              { kind: "del", text: "a" },
              { kind: "add", text: "b" },
            ],
          },
        },
        input: `{\n  "file": ${JSON.stringify(inside)}\n}`,
      },
    });
    // the diff editor opens the change from the ask, while it is open
    expect(h.asks.proposals(card.id)).toEqual([{ path: outside, oldText: "a\n", newText: "b\n" }]);
    h.asks.answerOption(card.id, "reject_once");
    await turn;
    expect(streamedText(patchbaySessionId, h.state())).toContain("permission: reject_once");
    expect(h.asks.proposals(card.id)).toEqual([]);
    await h.pool.stop("p2c" as PatchbayAgentId);
  });

  // Hermes Agent's edit approval (acp_adapter/edit_approval.py, 2026-09): a
  // call of its own, never announced in the stream, no locations — the
  // change rides only in the request's diff, its raw input beside it (#90).
  it("an edit asked only by its diff shows the change itself, its raw input closed, and opens from the ask", async () => {
    const h = harness();
    const target = join(dir, "greet.ts");
    const oldText = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const newText = "a\nb\nc\nd\nE\nf\ng\nh\n";
    await h.pool.connect(
      spec(
        {
          turn: [
            {
              type: "askPermission",
              title: `Approve edit: ${target}`,
              kind: "execute", // keeps the fixture's locations off, as Hermes sends none
              subject: target,
              toolCall: {
                toolCallId: "edit-approval-1",
                title: `Approve edit: ${target}`,
                kind: "edit",
                status: "pending",
                content: [{ type: "diff", path: target, oldText, newText }],
                rawInput: { tool: "patch", arguments: { mode: "replace", path: target, old_string: "e", new_string: "E" } },
              },
            },
          ],
        },
        "p2h" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.gates.create("p2h" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    const card = await waitFor(() => h.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "permission"));
    expect(card).toMatchObject({
      call: {
        locations: [],
        diffs: {
          [target]: {
            additions: 1,
            deletions: 1,
            preview: [
              ...["b", "c", "d"].map((text) => ({ kind: "context", text })),
              { kind: "del", text: "e" },
              { kind: "add", text: "E" },
              ...["f", "g", "h"].map((text) => ({ kind: "context", text })),
            ],
          },
        },
      },
    });
    expect(h.asks.proposals(card.id)).toEqual([{ path: target, oldText, newText }]);
    h.asks.answerOption(card.id, "allow_once");
    await turn;
    expect(h.asks.proposals(card.id)).toEqual([]);
    await h.pool.stop("p2h" as PatchbayAgentId);
  });

  it("a request the agent takes back is withdrawn on its card, and the agent gets request-cancelled (#80)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "askPermission", title: "Run tests", kind: "execute", subject: "npm test", withdrawAfterMs: 150 }] },
        "p2w" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.gates.create("p2w" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });
    const card = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "permission");
    expect(card).toMatchObject({ resolution: { label: "Withdrawn by the agent", auto: true } });
    expect(streamedText(patchbaySessionId, h.state())).toContain("permission: withdrawn -32800");
    await h.pool.stop("p2w" as PatchbayAgentId);
  });

  it("a request the turn left open is answered cancelled when the turn ends on its own — no card stays clickable (#81)", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ turn: [{ type: "askPermission", title: "Run tests", kind: "execute", subject: "npm test", leaveOpen: true }] }, "p2o" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.gates.create("p2o" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    const blocks = h.state().transcripts[patchbaySessionId]!;
    const card = blocks.find((b) => b.kind === "permission");
    expect(card).toMatchObject({ resolution: { label: "Cancelled — turn stopped", auto: true } });
    // answered before the turn's end lands, never a render apart
    expect(blocks.indexOf(card!)).toBeLessThan(blocks.findIndex((b) => b.kind === "turnEnd"));
    await waitFor(() => streamedText(patchbaySessionId, h.state()).includes("permission: cancelled"));
    // a late click answers nothing
    h.asks.answerOption(card!.id as PatchbayAskId, "allow_once");
    expect(h.events().filter((e) => e.kind === "permissionResolved")).toHaveLength(1);
    await h.pool.stop("p2o" as PatchbayAgentId);
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
    const patchbaySessionId = await h.gates.create("p3" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" }).catch((err: unknown) => err);
    await waitFor(() => h.state().transcripts[patchbaySessionId]?.some((b) => b.kind === "permission"));
    await h.gates.reload(patchbaySessionId);
    expect(streamedText(patchbaySessionId, h.state())).toContain("permission: cancelled");
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
    const patchbaySessionId = await h.gates.create("p4" as PatchbayAgentId, "Fake Agent", workspaceRoot);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" }).catch((err: unknown) => err);
    await waitFor(() => h.state().transcripts[patchbaySessionId]?.some((b) => b.kind === "permission"));
    await h.gates.close(patchbaySessionId);
    // A close waits on nothing the agent does, so the agent's own echo of
    // the answer may come after the session has gone — the answer itself
    // is patchbay's, given before the session goes.
    const kinds = h.events().map((e) => e.kind);
    expect(kinds).toContain("permissionResolved");
    expect(kinds.indexOf("permissionResolved")).toBeLessThan(kinds.indexOf("sessionClosed"));
    expect(h.events().find((e) => e.kind === "permissionResolved")).toMatchObject({ label: "Cancelled — turn stopped" });
    expect(await turn).toMatchObject({ by: "close" });
    await h.pool.stop("p4" as PatchbayAgentId);
  });
});

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
    await h.rules.set({ commandRules: [{ kind: "command", pattern: `${NODE} *`, verdict: "allow" }], writeScope: [] });
    const { terminalId } = await h.host.createTerminal(
      { sessionId: "agent-a", command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"], env: {} },
      { id: A, cwd: workspaceRoot },
    );
    const fromB = { sessionId: "agent-b", terminalId };
    await expect(h.host.terminalOutput(B, fromB)).rejects.toMatchObject({ code: -32602, message: expect.stringContaining(terminalId) });
    await expect(h.host.waitForTerminalExit(B, fromB)).rejects.toMatchObject({ code: -32602 });
    // nor a kill or a release — never an untrue "killed" (#80)
    await expect(h.host.killTerminal(B, fromB)).rejects.toMatchObject({ code: -32602 });
    await expect(h.host.releaseTerminal(B, fromB)).rejects.toMatchObject({ code: -32602 });
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
    const { host, events, started } = harness();
    await started;
    const before = events().length;
    await expect(host.createTerminal({ sessionId: "never-opened", command: "true", args: [], env: {} }, null)).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("never-opened"),
    });
    expect(events().slice(before)).toEqual([]);
  });

  it("a relative file path is the agent's bad params — read or write, nothing asked, nothing touched (#80)", async () => {
    const { host, events, started } = harness();
    await started;
    const before = events().length;
    const S = "s" as PatchbaySessionId;
    await expect(host.readTextFile(S, { sessionId: "s", path: "rel/x.txt" })).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("rel/x.txt") });
    await expect(host.writeTextFile(S, { sessionId: "s", path: "rel/x.txt", content: "x" })).rejects.toMatchObject({ code: -32602 });
    expect(events().slice(before)).toEqual([]);
  });

  // #116: on Windows a tool is most often a .cmd shim (npm, npx, tsc) — a
  // shell-less spawn finds only .exe, and refuses a .cmd outright.
  it("a tool that is a .cmd shim on Windows runs — named in full, or by its bare name on PATH", async () => {
    const h = harness();
    await h.rules.set({ commandRules: [{ kind: "command", pattern: "*", verdict: "allow" }], writeScope: [] });
    const bin = join(dir, "bin");
    await mkdir(bin);
    const tool = await standIn(bin, "pb-tool", "console.log('tool ran with ' + process.argv.slice(2).join('|'));");
    const S = "s" as PatchbaySessionId;
    for (const [command, env] of [
      [tool, {}],
      ["pb-tool", { PATH: bin }],
    ] as const) {
      const { terminalId } = await h.host.createTerminal({ sessionId: "s", command, args: ["a", "b"], env }, { id: S, cwd: workspaceRoot });
      const ref = { sessionId: "s", terminalId };
      expect(await h.host.waitForTerminalExit(S, ref)).toEqual({ exitCode: 0, signal: null });
      expect((await h.host.terminalOutput(S, ref)).output).toContain("tool ran with a|b");
    }
  });

  // Windows looks for a bare name in the spawn's own directory before PATH:
  // an opened repo carrying `git.exe` (or `git.cmd`) at its root would run
  // in place of the real one, under whatever rule trusts `git`.
  it("a bare name runs the program PATH names — never one planted in the command's directory", async () => {
    const h = harness();
    await h.rules.set({ commandRules: [{ kind: "command", pattern: "*", verdict: "allow" }], writeScope: [] });
    const bin = join(dir, "real-bin");
    await mkdir(bin);
    await standIn(bin, "pb-shadow", "console.log('the real one');");
    await standIn(workspaceRoot, "pb-shadow", "console.log('PLANTED');");
    const S = "s" as PatchbaySessionId;
    const { terminalId } = await h.host.createTerminal({ sessionId: "s", command: "pb-shadow", args: [], env: { PATH: bin } }, { id: S, cwd: workspaceRoot });
    const ref = { sessionId: "s", terminalId };
    await h.host.waitForTerminalExit(S, ref);
    const { output } = await h.host.terminalOutput(S, ref);
    expect(output).toContain("the real one");
    expect(output).not.toContain("PLANTED");
  });

  it("an argument a Windows shell would act on never reaches one: refused there with the reason, passed as given elsewhere", async () => {
    const h = harness();
    await h.rules.set({ commandRules: [{ kind: "command", pattern: "*", verdict: "allow" }], writeScope: [] });
    const tool = await standIn(dir, "pb-echo", "console.log('got ' + process.argv[2]);");
    const S = "s" as PatchbaySessionId;
    const { terminalId } = await h.host.createTerminal({ sessionId: "s", command: tool, args: ["x & del y"], env: {} }, { id: S, cwd: workspaceRoot });
    const ref = { sessionId: "s", terminalId };
    const expected =
      process.platform === "win32"
        ? { exit: { exitCode: null, signal: null }, says: "is shell-active" }
        : { exit: { exitCode: 0, signal: null }, says: "got x & del y" };
    expect(await h.host.waitForTerminalExit(S, ref)).toEqual(expected.exit);
    expect((await h.host.terminalOutput(S, ref)).output).toContain(expected.says);
  });

  it("a command the system won't even take says why in its own output — never an internal error", async () => {
    const h = harness();
    await h.rules.set({ commandRules: [{ kind: "command", pattern: "*", verdict: "allow" }], writeScope: [] });
    const S = "s" as PatchbaySessionId;
    // A NUL in a program's name is refused before any process exists.
    const { terminalId } = await h.host.createTerminal({ sessionId: "s", command: "bad\0name", args: [], env: {} }, { id: S, cwd: workspaceRoot });
    const ref = { sessionId: "s", terminalId };
    expect(await h.host.waitForTerminalExit(S, ref)).toEqual({ exitCode: null, signal: null });
    expect((await h.host.terminalOutput(S, ref)).output).not.toBe("");
  });

  it("a command that never starts says why in its own output, and terminal ids never repeat (#80)", async () => {
    const h = harness();
    await h.rules.set({ commandRules: [{ kind: "command", pattern: "*", verdict: "allow" }], writeScope: [] });
    const S = "s" as PatchbaySessionId;
    const create = () =>
      h.host.createTerminal({ sessionId: "s", command: join(dir, "no-such-command"), args: [], env: {} }, { id: S, cwd: workspaceRoot });
    const { terminalId } = await create();
    const ref = { sessionId: "s", terminalId };
    expect(await h.host.waitForTerminalExit(S, ref)).toEqual({ exitCode: null, signal: null });
    // Elsewhere the system says so; on Windows the PATHEXT walk does first.
    expect((await h.host.terminalOutput(S, ref)).output).toMatch(/ENOENT|does not exist/);
    const again = await create();
    expect(again.terminalId).not.toBe(terminalId);
    expect(terminalId).toMatch(/^term-[0-9a-f-]{36}$/);
  });

  it("a relative cwd is the agent's bad params — the spec requires an absolute path", async () => {
    const { host, events, started } = harness();
    await started;
    const before = events().length;
    await expect(
      host.createTerminal({ sessionId: "s", command: "true", args: [], env: {}, cwd: "sub/dir" }, { id: "s" as PatchbaySessionId, cwd: workspaceRoot }),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("sub/dir") });
    expect(events().slice(before)).toEqual([]);
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
