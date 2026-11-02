// Sub-agents: sessions an agent's session starts and owns. Each hangs under
// its parent — never a row of the list — and what the agent sends or asks
// on its behalf is attributed to it there: its transcript, its requests
// judged by its session's rules over its own root set. What arrives before
// a load answers is history; the one thing the user may do to one is the
// cancel its agent granted; and it goes with its session.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeAgent } from "./support/fake-agent";
import { tempDir } from "./support/teardown";
import { orchestratorHarness, type OrchestratorHarness } from "./support/orchestrator-harness";
import { waitFor } from "./support/wait-for";
import type { FakeAgentScript, TurnStep } from "./fake-agent/main";
import type { SessionUpdate } from "../src/orchestrator/acp";
import type { AgentViewState, ChatBlock } from "../src/shared/protocol";
import type { PatchbayAgentId, PatchbayAskId, PatchbaySessionId } from "../src/shared/ids";

let cwd: string;
beforeEach(async () => {
  cwd = await tempDir("patchbay-subagent-");
});

const AGENT = "fake" as PatchbayAgentId;

const announce = (name: string, over: Partial<Extract<SessionUpdate, { sessionUpdate: "subagent_update" }>> = {}, as?: string): TurnStep => ({
  type: "update",
  ...(as !== undefined ? { as } : {}),
  update: { sessionUpdate: "subagent_update", sessionId: `$${name}`, title: name, state: { state: "running" }, capabilities: { cancel: {} }, ...over },
});
const say = (text: string, as?: string): TurnStep => ({
  type: "update",
  ...(as !== undefined ? { as } : {}),
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});

async function open(script: FakeAgentScript): Promise<{ h: OrchestratorHarness; id: PatchbaySessionId; state: () => AgentViewState }> {
  const h = orchestratorHarness(cwd);
  await h.orchestrator.pool.connect(fakeAgent(script, AGENT, cwd));
  const id = await h.orchestrator.sessionGates.create(AGENT, "Fake Agent", cwd);
  return { h, id, state: () => h.agentView.state() };
}

const roster = (state: AgentViewState, id: PatchbaySessionId) => state.subagents[id] ?? [];
const child = (state: AgentViewState, id: PatchbaySessionId, title: string) => roster(state, id).find((s) => s.title === title);
const texts = (blocks: readonly ChatBlock[] | undefined) => (blocks ?? []).flatMap((b) => (b.kind === "text" ? [b.text] : []));

describe("sub-agents hang under their parent", () => {
  it("never a row of the list; nested ones under their own parent; their updates in their own transcript", async () => {
    const { h, id, state } = await open({
      turn: [announce("a"), announce("b", {}, "a"), say("from a", "a"), say("from b", "b"), say("from the session")],
    });
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    expect(state().sessions.map((s) => s.id)).toEqual([id]);
    const a = child(state(), id, "a")!;
    const b = child(state(), id, "b")!;
    expect(a.parentId).toBe(id);
    expect(b.parentId).toBe(a.id);
    expect(texts(state().transcripts[a.id])).toEqual(["from a"]);
    expect(texts(state().transcripts[b.id])).toEqual(["from b"]);
    expect(texts(state().transcripts[id])).toEqual(["from the session"]);
  });

  it("a sub-agent's commands are never offered — not to it, not to its session", async () => {
    const { h, id, state } = await open({
      turn: [announce("a"), { type: "update", as: "a", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "x", description: "x" }] } }],
    });
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    const a = child(state(), id, "a")!;
    expect(state().commandsBySession[a.id]).toBeUndefined();
    expect(state().commandsBySession[id]).toEqual([]);
  });

  it("the parent's own label is the roster's; the sub-agent's own title is its conversation's", async () => {
    const { h, id, state } = await open({
      turn: [announce("a"), { type: "update", as: "a", update: { sessionUpdate: "session_info_update", title: "Its own" } }],
    });
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    expect(child(state(), id, "a")).toMatchObject({ title: "a", conversationTitle: "Its own" });
    expect(state().sessions[0]!.title).not.toBe("Its own");
  });

  it("unknown keeps the last state it knew; null clears to unconfirmed", async () => {
    const { h, id, state } = await open({
      turn: [
        announce("a"),
        { type: "update", update: { sessionUpdate: "subagent_update", sessionId: "$a", state: { state: "unknown" } } },
        announce("b"),
        { type: "update", update: { sessionUpdate: "subagent_update", sessionId: "$b", state: null } },
      ],
    });
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    expect(child(state(), id, "a")).toMatchObject({ state: { state: "unknown" }, lastKnown: { state: "running" } });
    expect(child(state(), id, "b")).toMatchObject({ state: null, lastKnown: { state: "running" } });
  });
});

describe("an association the spec rules out is ignored, never guessed at", () => {
  it("a session of the list is never a sub-agent; a sub-agent never moves to another parent", async () => {
    const { h, id, state } = await open({
      turn: [
        { type: "update", update: { sessionUpdate: "subagent_update", sessionId: "$P", title: "itself" } },
        announce("a"),
        announce("b"),
        announce("b", { title: "moved" }, "a"),
      ],
    });
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    expect(roster(state(), id).map((s) => [s.title, s.parentId])).toEqual([
      ["a", id],
      ["b", id],
    ]);
  });
});

describe("a sub-agent's work outlives its parent's turn", () => {
  it("still running after the turn ends; the reaper leaves its session open, and a stop of its agent would cut it off", async () => {
    const { h, id, state } = await open({ declare: { loadSession: true, sessionCapabilities: { close: {} } }, turn: [announce("a"), { type: "endTurn" }] });
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    expect(state().activeTurn[id]).toBeUndefined();
    expect(child(state(), id, "a")?.state).toEqual({ state: "running" });
    expect(h.orchestrator.sessions.idle(0)).not.toContain(id);
    expect(h.orchestrator.sessions.openWork(AGENT)).toEqual({ conversations: 1, turns: 1 });
  });
});

describe("history is history", () => {
  const replayed: FakeAgentScript = {
    declare: { loadSession: true },
    turn: [say("hello")],
    loadReplay: {
      replay: [
        { update: { sessionUpdate: "subagent_update", sessionId: "$a", title: "a", state: { state: "running" }, capabilities: { cancel: {} } } },
        { as: "a", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier work" } } },
      ],
      after: [],
    },
  };

  it("before the load answers, nothing is confirmed and nothing granted — the transcript stays", async () => {
    const { h, id, state } = await open(replayed);
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    await h.orchestrator.sessionGates.reload(id);
    const a = child(state(), id, "a")!;
    expect(a).toMatchObject({ state: null, lastKnown: { state: "running" }, cancel: false });
    expect(texts(state().transcripts[a.id])).toEqual(["earlier work"]);
    expect(() => h.orchestrator.sessions.cancelSubagent(id, a.id)).toThrow();
  });

  it("what comes after the answer is current: the agent's fresh grant holds", async () => {
    const { h, id, state } = await open({
      ...replayed,
      loadReplay: { ...replayed.loadReplay!, after: [{ update: { sessionUpdate: "subagent_update", sessionId: "$a", state: { state: "running" }, capabilities: { cancel: {} } } }] },
    });
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    await h.orchestrator.sessionGates.reload(id);
    const a = await waitFor(() => child(state(), id, "a")?.cancel === true && child(state(), id, "a"));
    expect(a.state).toEqual({ state: "running" });
  });

  it("the connection going leaves the roster as history: none at work, none to cancel", async () => {
    const { h, id, state } = await open({ turn: [announce("a"), { type: "endTurn" }] });
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    await h.orchestrator.pool.stop(AGENT);
    await waitFor(() => child(state(), id, "a")?.state === null);
    expect(child(state(), id, "a")).toMatchObject({ state: null, lastKnown: { state: "running" }, cancel: false });
  });
});

describe("the one mutation: a granted cancel", () => {
  it("refused where the agent granted none; nothing reaches the agent", async () => {
    const { h, id, state } = await open({ turn: [announce("a", { capabilities: null }), { type: "endTurn" }] });
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    const a = child(state(), id, "a")!;
    expect(a.cancel).toBe(false);
    expect(() => h.orchestrator.sessions.cancelSubagent(id, a.id)).toThrow("doesn't offer");
  });

  it("a sub-agent is no session of the list: every session operation on it finds nothing", async () => {
    const { h, id, state } = await open({ declare: { loadSession: true, sessionCapabilities: { close: {}, delete: {}, fork: {} } }, turn: [announce("a"), { type: "endTurn" }] });
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    const a = child(state(), id, "a")!;
    const sessions = h.orchestrator.sessions;
    expect(sessions.isLive(a.id)).toBe(false);
    expect(sessions.sessionIdOf(a.id)).toBeUndefined();
    await expect(h.orchestrator.sessionGates.prompt(a.id, { text: "hi" })).rejects.toThrow();
    expect(child(state(), id, "a")?.state).toEqual({ state: "running" });
  });
});

describe("a sub-agent's asks", () => {
  it("its permission stands through its parent's Stop, and is answered cancelled once it reports cancelled", async () => {
    const { h, id, state } = await open({
      turn: [announce("a"), { type: "askPermission", as: "a", title: "Write x", kind: "edit", subject: "/elsewhere/x", leaveOpen: true }, { type: "chunk", text: "waiting" }],
      stepDelayMs: 200,
    });
    // a stopped turn's words end it by stop
    const turn = h.orchestrator.sessionGates.prompt(id, { text: "go" }).catch(() => {});
    const card = await waitFor(() => state().transcripts[id]?.find((b) => b.kind === "permission"));
    expect(card).toMatchObject({ subagent: { title: "a" }, resolution: null });
    // the waiting mark is the session's
    const { sessionMark } = await import("../src/shared/attention");
    expect(sessionMark(state(), state().sessions[0]!)).toBe("waiting");
    await h.orchestrator.sessionGates.stop(id);
    await turn;
    expect(state().transcripts[id]?.find((b) => b.id === card.id)).toMatchObject({ resolution: null });
    const a = child(state(), id, "a")!;
    h.orchestrator.sessions.cancelSubagent(id, a.id);
    await waitFor(() => texts(state().transcripts[a.id]).includes("permission: cancelled"));
    expect(state().transcripts[id]?.find((b) => b.id === card.id)).toMatchObject({ resolution: { label: "Cancelled — turn stopped" } });
  });

  it("closing the session answers them, and its sub-agents go with it", async () => {
    const { h, id, state } = await open({
      declare: { loadSession: true, sessionCapabilities: { close: {} } },
      turn: [announce("a"), { type: "askPermission", as: "a", title: "Write x", kind: "edit", subject: "/elsewhere/x", leaveOpen: true }, { type: "endTurn" }],
    });
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    const a = child(state(), id, "a")!;
    await waitFor(() => state().transcripts[id]?.find((b) => b.kind === "permission"));
    const agentSessionId = h.orchestrator.sessions.sessionIdOf(id)!;
    expect(h.orchestrator.sessions.subagentFor(AGENT, `${agentSessionId}.a`)).toMatchObject({ patchbaySessionId: id });
    await h.orchestrator.sessionGates.close(id);
    expect(state().subagents[id]).toBeUndefined();
    expect(state().transcripts[a.id]).toBeUndefined();
    expect(h.orchestrator.sessions.subagentFor(AGENT, `${agentSessionId}.a`)).toBeUndefined();
  });
});

describe("a sub-agent's root set", () => {
  it("inherited until reported: writes in the parent's workspace pass while the sub-agent works there", async () => {
    const { h, id, state } = await open({ turn: [announce("a"), { type: "writeFile", as: "a", path: join(cwd, "in.txt"), content: "x" }] });
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    const a = child(state(), id, "a")!;
    expect(texts(state().transcripts[a.id])).toEqual(["write: ok"]);
    expect(state().transcripts[id]?.find((b) => b.kind === "diff")).toMatchObject({ subagent: { id: a.id }, resolution: { accepted: true, auto: true } });
  });

  it("its own worktree, and no more: a write there passes, one in the parent's workspace outside it asks", async () => {
    const worktree = join(cwd, ".worktrees", "a");
    await mkdir(worktree, { recursive: true });
    const { h, id, state } = await open({
      turn: [
        announce("a", { cwd: worktree, additionalDirectories: [] }),
        { type: "writeFile", as: "a", path: join(worktree, "in.txt"), content: "x" },
        { type: "writeFile", as: "a", path: join(cwd, "out.txt"), content: "x" },
      ],
    });
    const turn = h.orchestrator.sessionGates.prompt(id, { text: "go" });
    const asked = await waitFor(() => state().transcripts[id]?.find((b) => b.kind === "diff" && b.resolution === null));
    expect(asked).toMatchObject({ file: join(cwd, "out.txt") });
    h.orchestrator.asks.answerWrite(asked.id as PatchbayAskId, false);
    await turn;
    const a = child(state(), id, "a")!;
    expect(texts(state().transcripts[a.id])[0]).toMatch(/^write: okwrite: rejected/);
    expect(h.orchestrator.sessions.subagentRoots(id, a.id)).toEqual([worktree]);
  });

  it("a command that names no directory runs where the sub-agent works", async () => {
    const worktree = join(cwd, ".worktrees", "b");
    await mkdir(worktree, { recursive: true });
    const { h, id, state } = await open({
      turn: [announce("b", { cwd: worktree }), { type: "runCommand", as: "b", command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"] }],
    });
    await h.orchestrator.permissionRules.set({ commandRules: [{ kind: "command", pattern: "*", verdict: "allow" }], writeScope: [] });
    await h.orchestrator.sessionGates.prompt(id, { text: "go" });
    const b = child(state(), id, "b")!;
    expect(texts(state().transcripts[b.id])[0]).toContain(`output=${worktree}`);
    // the terminal is the sub-agent's, shown in its transcript
    expect(state().transcripts[b.id]?.some((block) => block.kind === "terminal")).toBe(true);
  });
});
