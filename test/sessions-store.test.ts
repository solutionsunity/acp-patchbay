// P4 gate: session/new → prompt → streamed session/update → transcript;
// stop turn; close; slash-command advertisement; render cache rebuilt
// wholesale from session/load replay after a crash. Sessions are the
// agent's truth: patchbay persists no index and no transcripts.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertKind } from "./support/assert-kind";
import { ATTACHMENTS_DIR, imageFileName } from "../src/orchestrator/attachments";
import type { LaunchSpec } from "../src/orchestrator/pool";
import { harnessEnvelopeTag } from "../src/orchestrator/session-stream";
import { Queue } from "../src/orchestrator/queue";
import { sessionsActiveToday } from "../src/orchestrator/session-stats";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { SessionContinuityStore } from "../src/orchestrator/stores/session-continuity";
import {
  attaching,
  type ChatBlock,
  userPartsText,
} from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { readUpdate, sessionsHarness } from "./support/sessions-harness";
import type { PatchbayAgentId, PatchbayMcpServerId, PatchbaySessionId } from "../src/shared/ids";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

// A fresh cwd per test: the fake agent's session ids restart at "fake-1" on
// every spawn, so a shared cwd would let unrelated tests' persisted replay
// files collide on disk.
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "patchbay-sm-"));
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

function spec(script: FakeAgentScript, patchbayAgentId = "fake"): LaunchSpec {
  return {
    patchbayAgentId: patchbayAgentId as PatchbayAgentId,
    name: "Fake Agent",
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    cwd,
  };
}

/** The shared harness (support/sessions-harness.ts) over this file's cwd. */
function harness(opts?: Parameters<typeof sessionsHarness>[1]): ReturnType<typeof sessionsHarness> {
  return sessionsHarness(cwd, opts);
}

function textOf(block: ChatBlock | undefined): string {
  return block !== undefined && (block.kind === "text" || block.kind === "thought")
    ? block.text
    : "";
}

/** An agent on which roots work end to end: it advertises
 * `additionalDirectories` (the spec forbids sending the field otherwise)
 * and `session/resume` (the one re-apply rung after a turn). */
const ROOTS_CAPS = { sessionCapabilities: { additionalDirectories: {}, resume: {} } } as const;

describe("SessionsStore", () => {
  it("streams a full turn into the transcript and clears live on completion", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "hi " }, { type: "chunk", text: "there" }] }, "sm1"));
    const patchbaySessionId = await h.sessions.createSession("sm1" as PatchbayAgentId, "Fake Agent", cwd);

    const state1 = h.state();
    expect(state1.sessions).toHaveLength(1);
    expect(state1.activePatchbaySessionId).toBe(patchbaySessionId);
    expect(state1.transcripts[patchbaySessionId]).toEqual([]);

    await h.gates.prompt(patchbaySessionId, { text: "go go go" });

    const state2 = h.state();
    const blocks = state2.transcripts[patchbaySessionId]!;
    expect(blocks[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "go go go" }] });
    expect(textOf(blocks[1])).toBe("hi there");
    expect(state2.sessions[0]?.busy).toEqual([]);
    // first prompt on an untitled session derives its title
    expect(state2.sessions[0]?.title).toBe("go go go");

    await h.pool.stop("sm1" as PatchbayAgentId);
  });

  // A chat started twice before the first lands (a double click, the
  // palette and "+") is one new session, not two blank shells.
  it("a second new session asked for while the first is on the wire is the same session", async () => {
    const h = harness();
    await h.pool.connect(spec({}, "sm-join"));
    const newSessions = vi.spyOn(h.pool, "newSession");
    const [first, second] = await Promise.all([
      h.sessions.createSession("sm-join" as PatchbayAgentId, "Fake Agent", cwd),
      h.sessions.createSession("sm-join" as PatchbayAgentId, "Fake Agent", cwd),
    ]);
    expect(second).toBe(first);
    expect(newSessions).toHaveBeenCalledTimes(1);
    expect(h.state().sessions.map((s) => s.id)).toEqual([first]);
    await h.pool.stop("sm-join" as PatchbayAgentId);
  });

  it("renders tool calls, plans, and advertised commands", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "t1", title: "Reading file" },
            { type: "toolDone", id: "t1" },
            { type: "plan", entries: [{ content: "step one", status: "completed" }, { content: "step two", status: "in_progress" }] },
            { type: "commands", names: ["review", "deploy"] },
          ],
        },
        "sm2",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm2" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "do the thing" });

    const state = h.state();
    const blocks = state.transcripts[patchbaySessionId]!;
    const toolBlock = blocks.find((b) => b.kind === "toolCall");
    expect(toolBlock).toMatchObject({ title: "Reading file", status: "completed" });

    // A plan is session-level state (ui-rendering-strategy § Plans): it
    // updates the pinned widget's snapshot and never enters the transcript.
    expect(state.activePlan[patchbaySessionId]).toEqual([
      { content: "step one", status: "completed", priority: "medium" },
      { content: "step two", status: "in_progress", priority: "medium" },
    ]);
    expect(state.commandsBySession[patchbaySessionId]).toEqual([
      { name: "review", description: "fake review" },
      { name: "deploy", description: "fake deploy" },
    ]);

    await h.pool.stop("sm2" as PatchbayAgentId);
  });

  it("stop turn cancels and reports live=false with no crash", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }, { type: "chunk", text: "c" }], stepDelayMs: 150 },
        "sm3",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm3" as PatchbayAgentId, "Fake Agent", cwd);

    const promptDone = h.gates.prompt(patchbaySessionId, { text: "long turn" }).catch((err: unknown) => err);
    await new Promise((r) => setTimeout(r, 80));
    await h.gates.stop(patchbaySessionId);
    expect(await promptDone).toMatchObject({ by: "stop" });

    expect(h.state().sessions[0]?.busy).toEqual([]);
    await h.pool.stop("sm3" as PatchbayAgentId);
  });

  // ACP is one prompt per turn: a send landing mid-turn queues (removable
  // row), drains one per turn end, and Stop clears the whole queue.
  it("a prompt sent mid-turn queues and fires when the turn ends", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }], stepDelayMs: 150 },
        "smq1",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("smq1" as PatchbayAgentId, "Fake Agent", cwd);

    const promptDone = h.gates.prompt(patchbaySessionId, { text: "first" });
    await new Promise((r) => setTimeout(r, 80));
    await h.gates.prompt(patchbaySessionId, { text: "second" }); // resolves immediately: queued
    expect(h.state().promptQueue[patchbaySessionId]).toMatchObject([{ text: "second" }]);
    await promptDone;

    // the drain fired the queued prompt as a real turn
    await new Promise((r) => setTimeout(r, 500));
    expect(h.state().promptQueue[patchbaySessionId] ?? []).toEqual([]);
    const users = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "user");
    expect(users.map((b) => b.kind === "user" && userPartsText(b.parts))).toEqual(["first", "second"]);
    await h.pool.stop("smq1" as PatchbayAgentId);
  });

  it("a held prompt carries the composer's draft; take-back is tail-only, draft-only, and leaves the rest in order", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }], stepDelayMs: 150 },
        "smq4",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("smq4" as PatchbayAgentId, "Fake Agent", cwd);

    const promptDone = h.gates.prompt(patchbaySessionId, { text: "first" });
    await new Promise((r) => setTimeout(r, 80));
    await h.gates.prompt(patchbaySessionId, { text: "second", draft: '{"editor":"second"}' });
    await h.gates.prompt(patchbaySessionId, { text: "third" }); // held before the composer sent drafts
    await h.gates.prompt(patchbaySessionId, { text: "fourth", draft: '{"editor":"fourth"}' });
    const [a, b, c] = h.state().promptQueue[patchbaySessionId]!;
    expect([a, b, c]).toMatchObject([
      { text: "second", draft: '{"editor":"second"}' },
      { text: "third" },
      { text: "fourth", draft: '{"editor":"fourth"}' },
    ]);

    // not the tail — refused, nothing moves
    h.sessions.takeBack(patchbaySessionId, a!.id);
    expect(h.state().promptQueue[patchbaySessionId]).toHaveLength(3);
    // the tail, into a composer already holding words — refused: merging
    // two messages is the user's call, made with Copy
    h.sessions.saveDraft(patchbaySessionId, '{"editor":"typing"}');
    h.sessions.takeBack(patchbaySessionId, c!.id);
    expect(h.state().promptQueue[patchbaySessionId]).toHaveLength(3);
    // into an empty one — it comes back as the draft, the rest keep their order
    h.sessions.saveDraft(patchbaySessionId, "");
    h.sessions.takeBack(patchbaySessionId, c!.id);
    expect(h.state().drafts[patchbaySessionId]).toBe('{"editor":"fourth"}');
    expect(h.state().promptQueue[patchbaySessionId]!.map((q) => q.text)).toEqual(["second", "third"]);
    // the new tail has nothing to come back as — refused, it copies and fires
    h.sessions.saveDraft(patchbaySessionId, "");
    h.sessions.takeBack(patchbaySessionId, b!.id);
    expect(h.state().promptQueue[patchbaySessionId]).toHaveLength(2);

    await promptDone;
    await new Promise((r) => setTimeout(r, 900));
    const users = h.state().transcripts[patchbaySessionId]!.filter((x) => x.kind === "user");
    expect(users.map((x) => x.kind === "user" && userPartsText(x.parts))).toEqual(["first", "second", "third"]);
    await h.pool.stop("smq4" as PatchbayAgentId);
  });

  it("stop clears the queue — a deliberate stop never restarts from it", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }], stepDelayMs: 150 },
        "smq2",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("smq2" as PatchbayAgentId, "Fake Agent", cwd);

    const promptDone = h.gates.prompt(patchbaySessionId, { text: "first" }).catch((err: unknown) => err);
    await new Promise((r) => setTimeout(r, 80));
    await h.gates.prompt(patchbaySessionId, { text: "second" });
    await h.gates.stop(patchbaySessionId);
    expect(await promptDone).toMatchObject({ by: "stop" });

    await new Promise((r) => setTimeout(r, 200));
    expect(h.state().promptQueue[patchbaySessionId] ?? []).toEqual([]);
    const users = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "user");
    expect(users).toHaveLength(1); // "second" never fired
    await h.pool.stop("smq2" as PatchbayAgentId);
  });

  // The turn-start door: a standing auth lock is inFlight's peer — words
  // sent into a locked agent hold as visible queue rows (no fabricated
  // user message, nothing on the wire) and fire when the lock's clearing
  // releases them. The live-caught shape: prompting a reconnected-but-
  // logged-out agent fabricated a phantom "Hi" plus an error turn.
  it("a prompt into a locked agent holds at the door and fires on release", async () => {
    let locked = true;
    const h = harness({ authLocked: () => locked });
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "served" }] }, "smq3"));
    const patchbaySessionId = await h.sessions.createSession("smq3" as PatchbayAgentId, "Fake Agent", cwd);

    await h.gates.prompt(patchbaySessionId, { text: "held words" }); // resolves immediately: held
    expect(h.state().promptQueue[patchbaySessionId]).toMatchObject([{ text: "held words" }]);
    // nothing fabricated: no user message, no turn
    expect(h.state().transcripts[patchbaySessionId]).toEqual([]);

    locked = false;
    h.gates.lockCleared("smq3" as PatchbayAgentId);
    await new Promise((r) => setTimeout(r, 500));
    expect(h.state().promptQueue[patchbaySessionId] ?? []).toEqual([]);
    const users = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "user");
    expect(users.map((b) => b.kind === "user" && userPartsText(b.parts))).toEqual(["held words"]);
    await h.pool.stop("smq3" as PatchbayAgentId);
  });

  it("the turn-end drain holds queued words under a lock that landed mid-turn", async () => {
    let locked = false;
    const h = harness({ authLocked: () => locked });
    await h.pool.connect(
      spec(
        { turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }], stepDelayMs: 150 },
        "smq4",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("smq4" as PatchbayAgentId, "Fake Agent", cwd);

    const promptDone = h.gates.prompt(patchbaySessionId, { text: "first" });
    await new Promise((r) => setTimeout(r, 80));
    await h.gates.prompt(patchbaySessionId, { text: "second" }); // queued mid-turn
    locked = true; // logout witnessed while the turn streamed
    await promptDone;
    await new Promise((r) => setTimeout(r, 300));

    // held, not fired — and not dropped
    expect(h.state().promptQueue[patchbaySessionId]).toMatchObject([{ text: "second" }]);
    expect(h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "user")).toHaveLength(1);

    // login clears the lock: the release valve fires the held words
    locked = false;
    h.gates.lockCleared("smq4" as PatchbayAgentId);
    await new Promise((r) => setTimeout(r, 600));
    expect(h.state().promptQueue[patchbaySessionId] ?? []).toEqual([]);
    expect(h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "user")).toHaveLength(2);
    await h.pool.stop("smq4" as PatchbayAgentId);
  });

  // Closing mid-stream stops the turn (spec cancel) and lets it settle —
  // turnEnded lands before sessionClosed: a session never leaves, and a
  // delete never goes, under a live turn.
  it("closing mid-turn cancels first — turnEnded lands before sessionClosed", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }, { type: "chunk", text: "c" }],
          stepDelayMs: 150,
          declare: { sessionCapabilities: { close: {} } },
        },
        "sm3c",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm3c" as PatchbayAgentId, "Fake Agent", cwd);

    const promptDone = h.gates.prompt(patchbaySessionId, { text: "long turn" }).catch((err: unknown) => err);
    await new Promise((r) => setTimeout(r, 80));
    await h.gates.close(patchbaySessionId);
    expect(await promptDone).toMatchObject({ by: "close" });

    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain("turnEnded");
    expect(kinds.indexOf("turnEnded")).toBeLessThan(kinds.indexOf("sessionClosed"));
    await h.pool.stop("sm3c" as PatchbayAgentId);
  });

  it("reloading mid-turn cancels first — the replay never interleaves a live stream", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true },
          turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }, { type: "chunk", text: "c" }],
          stepDelayMs: 150,
        },
        "sm3d",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm3d" as PatchbayAgentId, "Fake Agent", cwd);

    const promptDone = h.gates.prompt(patchbaySessionId, { text: "long turn" }).catch((err: unknown) => err);
    await new Promise((r) => setTimeout(r, 80));
    await h.gates.reload(patchbaySessionId);
    expect(await promptDone).toMatchObject({ by: "reload" });

    // The cancelled turn ended before the replay's transcriptReset — nothing
    // streamed into the rebuilt cache.
    const kinds = h.events.map((e) => e.kind);
    expect(kinds.indexOf("turnEnded")).toBeLessThan(kinds.indexOf("transcriptReset"));
    expect(h.state().sessions[0]?.busy).toEqual([]);
    await h.pool.stop("sm3d" as PatchbayAgentId);
  });

  it("marks a tool call left open by a cancelled turn interrupted, once, at turn end", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          // No toolDone: the call is still pending/in_progress when the
          // cancel lands mid-turn.
          turn: [{ type: "toolCall", id: "t1", title: "Write" }, { type: "chunk", text: "a" }, { type: "chunk", text: "b" }],
          stepDelayMs: 150,
        },
        "sm3b",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm3b" as PatchbayAgentId, "Fake Agent", cwd);

    // Each step sleeps stepDelayMs *before* acting, so the wait here must
    // clear the first step's own delay (the toolCall landing) but not the
    // second's — otherwise there's nothing yet to strand.
    const promptDone = h.gates.prompt(patchbaySessionId, { text: "long turn" }).catch((err: unknown) => err);
    await new Promise((r) => setTimeout(r, 220));
    await h.gates.stop(patchbaySessionId);
    expect(await promptDone).toMatchObject({ by: "stop" });

    const toolBlock = assertKind(
      h.state().transcripts[patchbaySessionId]!.find((b) => b.id === "t1")!,
      "toolCall",
    );
    expect(toolBlock.interrupted).toBe(true);
    expect(toolBlock.status).toBe("in_progress");

    await h.pool.stop("sm3b" as PatchbayAgentId);
  });

  it("closes sessions — row and transcript leave the view", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: { sessionCapabilities: { close: {} } } }, "sm4"));
    const patchbaySessionId = await h.sessions.createSession("sm4" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "some words" });

    await h.gates.close(patchbaySessionId);
    expect(h.state().sessions).toHaveLength(0);
    expect(h.state().transcripts[patchbaySessionId]).toBeUndefined();
    expect(h.sessions.sessionIdOf(patchbaySessionId)).toBeUndefined();

    await h.pool.stop("sm4" as PatchbayAgentId);
  });

  // Issue #48: agents send whole files (Gemini, Codex) or just the changed
  // regions (Claude, OpenCode's edit input). Each diff is counted against
  // its own counterpart — a region measured against the file on disk, or
  // against another edit's region, counted lines nobody touched (+41 −1 for
  // two one-line edits to a 40-line file).
  it("an edit counts its own diff — regions against their counterparts, never the file (#48)", async () => {
    const h = harness();
    const target = "/ws/forty.txt";
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "e1", title: "Edit", kind: "edit" },
            { type: "toolDone", id: "e1", diff: { path: target, oldText: "line 10", newText: "LINE 10" } },
            { type: "toolCall", id: "e2", title: "Edit", kind: "edit" },
            // the post-edit shape: one hunk with its unchanged context
            { type: "toolDone", id: "e2", diff: { path: target, oldText: "line 29\nline 30\nline 31", newText: "line 29\nLINE 30\nline 31" } },
          ],
        },
        "sm48a",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm48a" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "edit" });
    const tools = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "toolCall");
    expect(tools.map((t) => assertKind(t, "toolCall").diffs)).toEqual([
      { [target]: { additions: 1, deletions: 1 } },
      { [target]: { additions: 1, deletions: 1 } },
    ]);
    await h.pool.stop("sm48a" as PatchbayAgentId);
  });

  it("several regions of one file sum, and open as one diff joined by a shared marker (#48)", async () => {
    const h = harness();
    const target = "/ws/multi.ts";
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "m1", title: "Edit", kind: "edit" },
            {
              type: "toolDone",
              id: "m1",
              content: [
                { type: "diff", path: target, oldText: "a\nb", newText: "a\nB" },
                { type: "diff", path: target, oldText: "x\ny\nz", newText: "x\nz" },
                { type: "diff", path: "/ws/other.ts", oldText: "k", newText: "k\nl" },
              ],
            },
          ],
        },
        "sm48b",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm48b" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "edit" });
    const tool = assertKind(h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "toolCall"), "toolCall");
    expect(tool.diffs).toEqual({
      [target]: { additions: 1, deletions: 2 },
      "/ws/other.ts": { additions: 1, deletions: 0 },
    });
    // no region is keyed away — both open, side by side, marker on each side
    expect(h.sessions.toolCallDiff(patchbaySessionId, "m1", target)).toEqual({
      oldText: "a\nb\n⋯\nx\ny\nz",
      newText: "a\nB\n⋯\nx\nz",
    });
    await h.pool.stop("sm48b" as PatchbayAgentId);
  });

  // The overwrite shape: announced as a creation (no oldText, the whole
  // new file), then corrected by the post-edit update to the real hunk.
  // The update's content is the whole collection — its diffs replace the
  // announcement's, counts and openable texts alike.
  it("an update's diffs replace the announced ones — counts and texts (#48)", async () => {
    const h = harness();
    const target = "/ws/over.txt";
    await h.pool.connect(
      spec(
        {
          turn: [
            {
              type: "toolCall",
              id: "o1",
              title: "Write",
              kind: "edit",
              content: [{ type: "diff", path: target, oldText: null, newText: "hello\nworld\n" }],
            },
            { type: "toolDone", id: "o1", diff: { path: target, oldText: "a\nb\nc", newText: "hello\nworld" } },
          ],
          stepDelayMs: 150,
        },
        "sm48d",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm48d" as PatchbayAgentId, "Fake Agent", cwd);
    const turn = h.gates.prompt(patchbaySessionId, { text: "overwrite" });
    const card = () => h.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "toolCall");
    const start = Date.now();
    while (card() === undefined) {
      if (Date.now() - start > 2000) throw new Error("tool call never announced");
      await new Promise((r) => setTimeout(r, 10));
    }
    // announced: what the agent said — a creation
    expect(assertKind(card(), "toolCall").diffs).toEqual({ [target]: { additions: 2, deletions: 0 } });
    await turn;
    // corrected: the update's hunk, and the texts the ± opens follow it
    expect(assertKind(card(), "toolCall").diffs).toEqual({ [target]: { additions: 2, deletions: 3 } });
    expect(h.sessions.toolCallDiff(patchbaySessionId, "o1", target)).toEqual({ oldText: "a\nb\nc", newText: "hello\nworld" });
    await h.pool.stop("sm48d" as PatchbayAgentId);
  });

  // A failed edit: announced with its diff, then an update whose content is
  // only the error. The update's content is the whole collection, so the
  // count goes — a card claiming +1 −1 for an edit that never happened is
  // the lie this replaces.
  it("an update carrying only text clears the call's diffs — a failed edit counts nothing (#48)", async () => {
    const h = harness();
    const target = "/ws/failed.md";
    await h.pool.connect(
      spec(
        {
          turn: [
            {
              type: "toolCall",
              id: "f1",
              title: "Edit",
              kind: "edit",
              content: [{ type: "diff", path: target, oldText: "not there", newText: "never written" }],
            },
            {
              type: "toolDone",
              id: "f1",
              content: [{ type: "content", content: { type: "text", text: "String to replace not found in file." } }],
            },
          ],
          stepDelayMs: 150,
        },
        "sm48e",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm48e" as PatchbayAgentId, "Fake Agent", cwd);
    const turn = h.gates.prompt(patchbaySessionId, { text: "edit" });
    const card = () => h.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "toolCall");
    const start = Date.now();
    while (card() === undefined) {
      if (Date.now() - start > 2000) throw new Error("tool call never announced");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(assertKind(card(), "toolCall").diffs).toEqual({ [target]: { additions: 1, deletions: 1 } });
    await turn;
    expect(assertKind(card(), "toolCall").diffs).toEqual({});
    expect(h.sessions.toolCallDiff(patchbaySessionId, "f1", target)).toBeNull();
    await h.pool.stop("sm48e" as PatchbayAgentId);
  });

  it("a diff with no oldText counts every new line as added — what the agent said (#48)", async () => {
    const h = harness();
    const target = "/ws/written.txt";
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "w1", title: "Write", kind: "edit" },
            { type: "toolDone", id: "w1", diff: { path: target, newText: "one\ntwo\nthree" } },
          ],
        },
        "sm48c",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm48c" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "write" });
    const tool = assertKind(h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "toolCall"), "toolCall");
    expect(tool.diffs).toEqual({ [target]: { additions: 3, deletions: 0 } });
    expect(h.sessions.toolCallDiff(patchbaySessionId, "w1", target)).toEqual({ oldText: "", newText: "one\ntwo\nthree" });
    await h.pool.stop("sm48c" as PatchbayAgentId);
  });

  it("held words survive an agent crash and fire after reconnect — only the user discards", async () => {
    const h = harness();
    // The dying script serves one chunk then exits mid-turn; the reconnect
    // uses a healthy one — a crash is an event, not a personality trait.
    const dying: FakeAgentScript = {
      declare: { loadSession: true },
      turn: [{ type: "chunk", text: "a" }, { type: "crash" }],
      stepDelayMs: 200,
    };
    const healthy: FakeAgentScript = {
      declare: { loadSession: true },
      turn: [{ type: "chunk", text: "ok" }],
    };
    await h.pool.connect(spec(dying, "smc1"));
    const patchbaySessionId = await h.sessions.createSession("smc1" as PatchbayAgentId, "Fake Agent", cwd);
    const promptDone = h.gates.prompt(patchbaySessionId, { text: "first" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    await h.gates.prompt(patchbaySessionId, { text: "held words" }); // queued mid-turn
    await promptDone; // the crash step kills the process under the live turn
    await new Promise((r) => setTimeout(r, 250)); // exit handler + deferred drain settle

    // the crash dropped the live session — but the words held, visibly
    expect(h.sessions.isLive(patchbaySessionId)).toBe(false);
    expect(h.state().promptQueue[patchbaySessionId]).toMatchObject([{ text: "held words" }]);

    // reconnect: the next prompt joins BEHIND the held words, which fire first
    await h.pool.connect(spec(healthy, "smc1"));
    await h.gates.prompt(patchbaySessionId, { text: "after reconnect" });
    const start = Date.now();
    let users: string[] = [];
    for (;;) {
      users = (h.state().transcripts[patchbaySessionId] ?? [])
        .filter((b) => b.kind === "user")
        .map((b) => (b.kind === "user" ? userPartsText(b.parts) : ""));
      if ((h.state().promptQueue[patchbaySessionId]?.length ?? 0) === 0 && users.length >= 2) break;
      if (Date.now() - start > 3500) {
        throw new Error(
          `held words never fired — users: ${JSON.stringify(users)} queue: ${JSON.stringify(h.state().promptQueue[patchbaySessionId])} live: ${h.sessions.isLive(patchbaySessionId)} status: ${h.pool.get("smc1" as PatchbayAgentId)?.status}`,
        );
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(users.slice(-2)).toEqual(["held words", "after reconnect"]);
    await h.pool.stop("smc1" as PatchbayAgentId);
  }, 15000);

  // A Stop ends the agent's connection as a crash does, and the session
  // keeps what it holds as it does after a crash: detached, its held words
  // and roots still there, and on reconnect its own knob combination
  // re-seeded over the agent's load-time reset while the words fire.
  it("a Stop detaches a session like a crash — held words, roots and knobs come back after reconnect", async () => {
    const h = harness();
    const script: FakeAgentScript = {
      declare: { loadSession: true },
      turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }],
      stepDelayMs: 200,
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default",
          options: [
            { value: "default", name: "Default" },
            { value: "sonnet", name: "Sonnet" },
          ],
        },
      ],
    };
    await h.pool.connect(spec(script, "sms1"));
    const patchbaySessionId = await h.sessions.createSession("sms1" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.setKnob(patchbaySessionId, "model", "sonnet");
    await h.gates.addRoot(patchbaySessionId, "/repo/extra");
    const promptDone = h.gates.prompt(patchbaySessionId, { text: "first" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    await h.gates.prompt(patchbaySessionId, { text: "held words" }); // queued mid-turn
    await h.pool.stop("sms1" as PatchbayAgentId); // the agent's Stop, under the live turn
    await promptDone;

    expect(h.sessions.isLive(patchbaySessionId)).toBe(false);
    expect(h.state().promptQueue[patchbaySessionId]).toMatchObject([{ text: "held words" }]);
    expect(h.state().contextRoots[patchbaySessionId]).toEqual(["/repo/extra"]);

    await h.pool.connect(spec({ ...script, stepDelayMs: 0 }, "sms1"));
    await h.gates.prompt(patchbaySessionId, { text: "after reconnect" });
    const start = Date.now();
    let users: string[] = [];
    for (;;) {
      users = (h.state().transcripts[patchbaySessionId] ?? [])
        .filter((b) => b.kind === "user")
        .map((b) => (b.kind === "user" ? userPartsText(b.parts) : ""));
      if ((h.state().promptQueue[patchbaySessionId]?.length ?? 0) === 0 && users.length >= 3) break;
      if (Date.now() - start > 3500) {
        throw new Error(`held words never fired — users: ${JSON.stringify(users)} queue: ${JSON.stringify(h.state().promptQueue[patchbaySessionId])}`);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(users.slice(-2)).toEqual(["held words", "after reconnect"]);
    expect(h.state().sessionKnobs[patchbaySessionId]?.find((k) => k.id === "model")?.currentValue).toBe("sonnet");
    expect(h.state().contextRoots[patchbaySessionId]).toEqual(["/repo/extra"]);
    await h.pool.stop("sms1" as PatchbayAgentId);
  }, 15000);

  it("rebuilds the render cache wholesale from session/load replay after a crash", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true },
          turn: [{ type: "chunk", text: "before " }, { type: "chunk", text: "crash" }],
        },
        "sm5",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm5" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "first turn" });
    expect(textOf(h.state().transcripts[patchbaySessionId]?.[1])).toBe("before crash");

    // simulate the agent process dying and being restarted
    await h.pool.restart("sm5" as PatchbayAgentId);
    expect(h.pool.get("sm5" as PatchbayAgentId)?.declared?.loadSession).toBe(true);

    // sending a prompt on the old sessionId must reopen via session/load first
    await h.gates.prompt(patchbaySessionId, { text: "second turn" });

    const blocks = h.state().transcripts[patchbaySessionId]!;
    // replay rebuilt the whole first turn — user message included (the spec
    // replays the *entire* conversation) — then the new user message, then
    // the new turn's text — never merged, always reset
    expect(blocks[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "first turn" }] });
    expect(textOf(blocks[1])).toBe("before crash");
    // the replayed turn keeps its boundary — synthesized, since the replay
    // wire carries no turn resolution: structure recovered, timing/stop/usage
    // honestly absent (never re-attached from a patchbay-side store)
    expect(blocks[2]).toMatchObject({
      kind: "turnEnd",
      startedAt: null,
      endedAt: null,
      stopReason: null,
      usage: null,
    });
    expect(blocks[3]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "second turn" }] });
    expect(textOf(blocks[4])).toBe("before crash"); // second turn uses the same script

    await h.pool.stop("sm5" as PatchbayAgentId);
  });

  it("session/load replay is delivered silently and closed by one resync — never a patch flood", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "hello" }] }, "sm5s"),
    );
    const patchbaySessionId = await h.sessions.createSession("sm5s" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "first turn" });
    expect(h.silentEvents).toHaveLength(0); // live streaming patches normally
    expect(h.resyncCount()).toBe(0);

    await h.pool.restart("sm5s" as PatchbayAgentId);
    await h.gates.prompt(patchbaySessionId, { text: "second turn" });

    // The replay window went silent — reset + the whole replayed first turn,
    // closed by its synthesized boundary — and one wholesale resync; the
    // live second turn streamed as patches again.
    expect(h.silentEvents.map((e) => e.kind)).toEqual([
      "transcriptReset",
      "userPartAppended",
      "agentTextDelta",
      "turnEnded",
    ]);
    expect(h.resyncCount()).toBe(1);
    // canonical state is complete regardless of delivery path
    const blocks = h.state().transcripts[patchbaySessionId]!;
    expect(blocks[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "first turn" }] });
    expect(textOf(blocks[1])).toBe("hello");
    expect(blocks[2]).toMatchObject({ kind: "turnEnd", startedAt: null });
    expect(blocks[3]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "second turn" }] });
    await h.pool.stop("sm5s" as PatchbayAgentId);
  });

  it("a multi-turn replay gets a synthesized boundary per turn — the next user message flushes one, the end of the replay flushes the last", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "reply" }] }, "sm5m"),
    );
    const patchbaySessionId = await h.sessions.createSession("sm5m" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "one" });
    await h.gates.prompt(patchbaySessionId, { text: "two" });

    await h.pool.restart("sm5m" as PatchbayAgentId);
    await h.gates.prompt(patchbaySessionId, { text: "three" });

    // two replayed turns, each closed by a synthesized boundary (nullable
    // timing), then the live third turn closed by its real one
    const shape = h.state().transcripts[patchbaySessionId]!.map((b) =>
      b.kind === "turnEnd" ? `turnEnd:${b.startedAt === null ? "synthesized" : "real"}` : b.kind,
    );
    expect(shape).toEqual([
      "user", "text", "turnEnd:synthesized",
      "user", "text", "turnEnd:synthesized",
      "user", "text", "turnEnd:real",
    ]);

    await h.pool.stop("sm5m" as PatchbayAgentId);
  });

  it("session/load replay ending on a still-open tool call marks it interrupted — live cancel and its replay render identically", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true },
          turn: [{ type: "toolCall", id: "t1", title: "Write" }, { type: "chunk", text: "a" }, { type: "chunk", text: "b" }],
          stepDelayMs: 150,
        },
        "sm5i",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm5i" as PatchbayAgentId, "Fake Agent", cwd);
    const promptDone = h.gates.prompt(patchbaySessionId, { text: "long turn" }).catch((err: unknown) => err);
    await new Promise((r) => setTimeout(r, 220));
    await h.gates.stop(patchbaySessionId);
    expect(await promptDone).toMatchObject({ by: "stop" });

    // Reload: the recorded history replays and ends on the never-completed
    // call — no turn end follows, so only the replay-end sweep can mark it.
    await h.pool.restart("sm5i" as PatchbayAgentId);
    await h.gates.revive(patchbaySessionId);

    const t1 = assertKind(
      h.state().transcripts[patchbaySessionId]!.find((b) => b.id === "t1")!,
      "toolCall",
    );
    expect(t1.interrupted).toBe(true);
    expect(t1.status).toBe("in_progress");
    await h.pool.stop("sm5i" as PatchbayAgentId);
  });

  it("a live user_message_chunk echo never duplicates the sent prompt", async () => {
    // Some agents echo the in-flight prompt back (slash-command expansion);
    // the turn already appended the user block, so the echo must drop.
    const h = harness();
    await h.pool.connect(
      spec(
        { turn: [{ type: "userEcho", text: "/cmd expanded" }, { type: "chunk", text: "ok" }] },
        "sm5e",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm5e" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "/cmd" });
    const blocks = h.state().transcripts[patchbaySessionId]!;
    expect(blocks.filter((b) => b.kind === "user")).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "/cmd" }] });
    expect(textOf(blocks[1])).toBe("ok");
    await h.pool.stop("sm5e" as PatchbayAgentId);
  });

  it("without load or resume declared, a prompt on a dead session fails honestly — never a minted continuation", async () => {
    // A sessionId is connection-scoped; without replay there is no
    // protocol-legal way to continue it on the new connection. Patchbay
    // never mints a session and calls it a continuation: the prompt
    // rejects, the transcript stands untouched, no sibling appears.
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "only turn" }] }, "sm6"));
    const deadPatchbaySessionId = await h.sessions.createSession("sm6" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(deadPatchbaySessionId, { text: "hello" });
    const before = h.state().transcripts[deadPatchbaySessionId]!;
    expect(before.length).toBeGreaterThan(0);

    await h.pool.restart("sm6" as PatchbayAgentId);
    expect(h.pool.get("sm6" as PatchbayAgentId)?.declared?.loadSession).toBe(false);

    await expect(h.gates.prompt(deadPatchbaySessionId, { text: "after restart" })).rejects.toThrow(
      /neither session\/load nor session\/resume/,
    );

    expect(h.state().transcripts[deadPatchbaySessionId]).toEqual(before);
    expect(h.state().sessions.map((s) => s.id)).toEqual([deadPatchbaySessionId]);
    // the words that never reached a turn are still the user's
    expect(h.state().promptQueue[deadPatchbaySessionId]).toMatchObject([{ text: "after restart" }]);

    await h.pool.stop("sm6" as PatchbayAgentId);
  });

  it("interleaved text/thought/tool updates render ordered, merged, and updated in place (P13b gate)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "chunk", text: "let me " },
            { type: "chunk", text: "look. " },
            { type: "thought", text: "hmm, " },
            { type: "thought", text: "grep first" },
            { type: "chunk", text: "searching now" },
            { type: "toolCall", id: "t1", title: "Grep pattern", kind: "search", rawInput: { pattern: "foo" } },
            { type: "toolDone", id: "t1", rawOutput: "3 matches" },
            { type: "chunk", text: "found it" },
          ],
        },
        "sm13b",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm13b" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "find foo" });

    const blocks = h.state().transcripts[patchbaySessionId]!;
    // Literal arrival order, chunks merged per run, interruptions split runs:
    // user · text · thought · text · one tool block · text — never re-bucketed
    // — then the turn's own metadata block (P13c) closing it.
    expect(blocks.map((b) => b.kind)).toEqual(["user", "text", "thought", "text", "toolCall", "text", "turnEnd"]);
    expect(textOf(blocks[1])).toBe("let me look. ");
    expect(textOf(blocks[2])).toBe("hmm, grep first");
    expect(textOf(blocks[3])).toBe("searching now");
    expect(textOf(blocks[5])).toBe("found it");
    // tool_call + tool_call_update landed on ONE block, updated in place,
    // with kind and raw input/output carried through.
    const search = assertKind(blocks[4], "toolCall");
    expect(search).toMatchObject({
      id: "t1",
      status: "completed",
      toolKind: "search",
      denied: false,
    });
    expect(search.input).toContain('"pattern": "foo"');
    expect(search.output).toBe("3 matches");

    await h.pool.stop("sm13b" as PatchbayAgentId);
  });

  it("oversized tool rawOutput is bounded with an honest truncation marker (P13b)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "big", title: "Read file", kind: "read" },
            { type: "toolDone", id: "big", rawOutput: "x".repeat(10_000) },
          ],
        },
        "sm13c",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm13c" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "read it" });

    const tool = assertKind(
      h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "toolCall"),
      "toolCall",
    );
    expect(tool.output).not.toBeNull();
    expect(tool.output!.length).toBeLessThan(4_200);
    expect(tool.output).toContain("… truncated (10,000 chars total)");

    await h.pool.stop("sm13c" as PatchbayAgentId);
  });

  it("a resolved turn appends a turnEnd block: send→stop duration, stop reason, usage when reported (P13c gate)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "chunk", text: "done" },
            { type: "toolCall", id: "e1", title: "Edit a.ts", kind: "edit", locations: [{ path: "/ws/a.ts" }] },
            { type: "toolDone", id: "e1" },
          ],
          usage: { totalTokens: 1200, inputTokens: 1000, outputTokens: 200, cachedReadTokens: 800 },
        },
        "sm13d",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm13d" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "edit it" });

    const state = h.state();
    const blocks = state.transcripts[patchbaySessionId]!;
    const end = assertKind(blocks[blocks.length - 1], "turnEnd");
    expect(end.stopReason).toBe("end_turn");
    expect(Date.parse(end.endedAt!)).toBeGreaterThanOrEqual(Date.parse(end.startedAt!));
    expect(end.usage).toEqual({ total: 1200, input: 1000, output: 200, cached: 800 });
    // the ticker's basis is cleared the moment the turn resolves
    expect(state.activeTurn[patchbaySessionId]).toBeUndefined();
    // locations rode in for the rollup's distinct-files count
    const tool = assertKind(blocks.find((b) => b.kind === "toolCall"), "toolCall");
    expect(tool.locations).toEqual([{ path: "/ws/a.ts", line: null }]);

    await h.pool.stop("sm13d" as PatchbayAgentId);
  });

  it("an agent's non-text chunks become parts between its prose, never a placeholder (issue #45)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "chunk", text: "Here is the screenshot:" },
            { type: "agentContent", content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } },
            { type: "chunk", text: "and the notes:" },
            { type: "agentContent", content: { type: "resource", resource: { uri: "file:///ws/n.md", text: "note" } } },
            { type: "agentContent", content: { type: "audio", data: "AAAA", mimeType: "audio/wav" }, thought: true },
          ],
        },
        "sm45",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm45" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "show me" });

    const blocks = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind !== "user" && b.kind !== "turnEnd");
    const shape = blocks.map((b) =>
      b.kind === "text" ? `text:${b.text}` : b.kind === "agentPart" ? `part:${b.part.kind}:${b.thought}` : b.kind,
    );
    expect(shape).toEqual([
      "text:Here is the screenshot:",
      "part:image:false",
      "text:and the notes:",
      "part:context:false",
      "part:unrendered:true",
    ]);
    const image = assertKind(blocks[1], "agentPart").part;
    // the bytes went to the attachments stash for the preview
    expect(image.kind === "image" && image.file !== undefined).toBe(true);
    await h.pool.stop("sm45" as PatchbayAgentId);
  });

  it("a tool call's content rides the block in the agent's order — text bounded, diffs left to the file rows (issue #44)", async () => {
    const h = harness();
    const long = "x".repeat(5_000);
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "b1", title: "Run build", kind: "execute" },
            {
              type: "toolDone",
              id: "b1",
              rawOutput: { stdout: "ok" },
              content: [
                { type: "content", content: { type: "text", text: "```console\nok\n```" } },
                { type: "terminal", terminalId: "term-7" },
                { type: "diff", path: "/ws/a.ts", oldText: "a", newText: "b" },
                { type: "content", content: { type: "resource_link", name: "a.ts", uri: "file:///ws/a.ts" } },
                { type: "content", content: { type: "resource", resource: { uri: "file:///ws/n.md", text: "note" } } },
                { type: "content", content: { type: "audio", data: "AAAA", mimeType: "audio/wav" } },
                { type: "content", content: { type: "text", text: long } },
              ],
            },
          ],
        },
        "sm44",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm44" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "build" });

    const tool = assertKind(h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "toolCall"), "toolCall");
    expect(tool.content.slice(0, 5)).toEqual([
      { kind: "text", text: "```console\nok\n```" },
      { kind: "terminal", terminalId: "term-7" },
      { kind: "mention", name: "a.ts", uri: "file:///ws/a.ts" },
      { kind: "context", label: "file:///ws/n.md", text: "note" },
      { kind: "unrendered", type: "audio" },
    ]);
    const last = tool.content[5]!;
    expect(last.kind === "text" && last.text.endsWith("… truncated (5,000 chars total)")).toBe(true);
    expect(tool.diffs).toEqual({ "/ws/a.ts": { additions: 1, deletions: 1 } });
    // the raw payload stays on the block for the Raw section
    expect(tool.output).toContain('"stdout": "ok"');
    await h.pool.stop("sm44" as PatchbayAgentId);
  });

  it("a location's line rides the block, read 1-based: 0 is the first line, no line stays none (issue #41)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            {
              type: "toolCall",
              id: "r1",
              title: "Read a.ts",
              kind: "read",
              locations: [{ path: "/ws/a.ts", line: 42 }, { path: "/ws/b.ts", line: 0 }, { path: "/ws/c.ts" }],
            },
            { type: "toolDone", id: "r1" },
          ],
        },
        "sm41",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm41" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "read it" });

    const tool = assertKind(h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "toolCall"), "toolCall");
    expect(tool.locations).toEqual([
      { path: "/ws/a.ts", line: 42 },
      { path: "/ws/b.ts", line: 1 },
      { path: "/ws/c.ts", line: null },
    ]);
    await h.pool.stop("sm41" as PatchbayAgentId);
  });

  it("agent-reported diff content: counts ride the block, texts stay orchestrator-side for the native diff editor", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          turn: [
            { type: "toolCall", id: "d1", title: "Edit a.ts", kind: "edit" },
            { type: "toolDone", id: "d1", diff: { path: "/ws/a.ts", oldText: "old\n", newText: "new\n" } },
          ],
        },
        "sm13f",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm13f" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "edit" });

    const tool = assertKind(
      h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "toolCall"),
      "toolCall",
    );
    expect(tool.diffs).toEqual({ "/ws/a.ts": { additions: 1, deletions: 1 } });
    // texts never enter webview state — they come back through the stash
    expect(h.sessions.toolCallDiff(patchbaySessionId, "d1", "/ws/a.ts")).toEqual({
      oldText: "old\n",
      newText: "new\n",
    });
    expect(h.sessions.toolCallDiff(patchbaySessionId, "d1", "/nope")).toBeNull();

    await h.pool.stop("sm13f" as PatchbayAgentId);
  });

  it("a turn without reported usage gets usage: null — absence over fake (P13c)", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "hi" }] }, "sm13e"));
    const patchbaySessionId = await h.sessions.createSession("sm13e" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    const blocks = h.state().transcripts[patchbaySessionId]!;
    const end = assertKind(blocks[blocks.length - 1], "turnEnd");
    expect(end.usage).toBeNull();

    await h.pool.stop("sm13e" as PatchbayAgentId);
  });

  it("usage reporting is marked used opportunistically the moment it's first observed (P5)", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ turn: [{ type: "usage", used: 42, size: 200 }, { type: "chunk", text: "hi" }] }, "sm7"),
    );
    expect(h.capabilityTracker.matrix("sm7" as PatchbayAgentId)!.usage).toEqual({ declared: false, used: false });

    const patchbaySessionId = await h.sessions.createSession("sm7" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    expect(h.state().sessionUsage[patchbaySessionId]).toEqual({ used: 42, size: 200, cost: undefined });
    expect(h.capabilityTracker.matrix("sm7" as PatchbayAgentId)!.usage).toEqual({ declared: true, used: true });

    await h.pool.stop("sm7" as PatchbayAgentId);
  });

  it("session.load reopening marks the session.load row used (P5)", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "hi" }] }, "sm8"),
    );
    const patchbaySessionId = await h.sessions.createSession("sm8" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "first" });
    expect(h.capabilityTracker.matrix("sm8" as PatchbayAgentId)!["session.load"]).toEqual({ declared: true, used: false });

    await h.pool.restart("sm8" as PatchbayAgentId);
    await h.gates.prompt(patchbaySessionId, { text: "second" });

    expect(h.capabilityTracker.matrix("sm8" as PatchbayAgentId)!["session.load"]).toEqual({ declared: true, used: true });
    await h.pool.stop("sm8" as PatchbayAgentId);
  });

  it("attached context rides in as its own labeled blocks, ahead of the user's words, then clears (P7)", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "echoBlocks" }] }, "sm9"));
    const patchbaySessionId = await h.sessions.createSession("sm9" as PatchbayAgentId, "Fake Agent", cwd);

    await h.sessions.addContext(patchbaySessionId, {
      id: "chip-1",
      kind: "selection",
      label: "Selection: a.ts:1-2",
      content: "const x = 1;",
    });
    expect(h.state().contextChips[patchbaySessionId]).toEqual([
      { id: "chip-1", kind: "selection", label: "Selection: a.ts:1-2", content: "const x = 1;" },
    ]);

    await h.gates.prompt(patchbaySessionId, { text: "what does this do?" });

    // chip cleared from state after being consumed by the prompt
    expect(h.state().contextChips[patchbaySessionId]).toEqual([]);

    const echoed = h
      .state()
      .transcripts[patchbaySessionId]!.find((b) => b.kind === "text");
    expect(echoed?.kind === "text" && echoed.text.split("\n---BLOCK---\n")).toEqual([
      "[Selection: a.ts:1-2]\nconst x = 1;",
      "what does this do?",
    ]);

    await h.pool.stop("sm9" as PatchbayAgentId);
  });

  it("image chips ride as ImageContent when promptCapabilities.image is declared", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { promptCapabilities: { image: true } }, turn: [{ type: "echoBlockKinds" }] },
        "img1",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("img1" as PatchbayAgentId, "Fake Agent", cwd);
    await h.sessions.addContext(patchbaySessionId, {
      id: "chip-img",
      kind: "image",
      label: "Image (image/png)",
      content: Buffer.from("fake-png-bytes").toString("base64"),
      mimeType: "image/png",
    });
    await h.gates.prompt(patchbaySessionId, { text: "what is this?" });

    const echoed = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "text");
    const kinds = JSON.parse(echoed?.kind === "text" ? echoed.text : "[]") as Array<Record<string, string>>;
    expect(kinds).toEqual([{ type: "image", mimeType: "image/png" }, { type: "text" }]);
    await h.pool.stop("img1" as PatchbayAgentId);
  });

  it("text chips ride as embedded resources when promptCapabilities.embeddedContext is declared", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { promptCapabilities: { embeddedContext: true } }, turn: [{ type: "echoBlockKinds" }] },
        "emb1",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("emb1" as PatchbayAgentId, "Fake Agent", cwd);
    await h.sessions.addContext(patchbaySessionId, {
      id: "chip-sel",
      kind: "selection",
      label: "Selection: a.ts:1-2",
      content: "const x = 1;",
      sourceUri: "file:///ws/a.ts#L1-2",
    });
    await h.sessions.addContext(patchbaySessionId, {
      id: "chip-diag",
      kind: "diagnostics",
      label: "Problems (1)",
      content: "a.ts:3 [error] boom",
      // no single source — the chip itself is named (uri is wire-required)
    });
    await h.gates.prompt(patchbaySessionId, { text: "context please" });

    const echoed = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "text");
    const kinds = JSON.parse(echoed?.kind === "text" ? echoed.text : "[]") as Array<Record<string, string>>;
    expect(kinds).toEqual([
      { type: "resource", uri: "file:///ws/a.ts#L1-2" },
      { type: "resource", uri: "patchbay://context/diagnostics/chip-diag" },
      { type: "text" },
    ]);
    await h.pool.stop("emb1" as PatchbayAgentId);
  });

  it("image chips fall back to a temp-file ResourceLink when image support is undeclared — paste is never disabled", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "echoBlockKinds" }] }, "img2"));
    const patchbaySessionId = await h.sessions.createSession("img2" as PatchbayAgentId, "Fake Agent", cwd);
    const bytes = Buffer.from("fake-jpeg-bytes");
    await h.sessions.addContext(patchbaySessionId, {
      id: "chip-img-fb",
      kind: "image",
      label: "Image (image/jpeg)",
      content: bytes.toString("base64"),
      mimeType: "image/jpeg",
    });
    await h.gates.prompt(patchbaySessionId, { text: "and this?" });

    const echoed = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "text");
    const kinds = JSON.parse(echoed?.kind === "text" ? echoed.text : "[]") as Array<Record<string, string>>;
    expect(kinds).toHaveLength(2);
    expect(kinds[0]).toMatchObject({ type: "resource_link", mimeType: "image/jpeg" });
    expect(kinds[0]!.uri).toMatch(/^file:\/\/.*chip-img-fb\.jpg$/);
    // the link points at real bytes on disk, not a dangling uri
    const { fileURLToPath } = await import("node:url");
    const written = await readFile(fileURLToPath(kinds[0]!.uri!), null);
    expect(Buffer.from(written).equals(bytes)).toBe(true);
    await h.pool.stop("img2" as PatchbayAgentId);
  });

  it("attachment chips ride as resource_link to their real path — baseline, no capability consulted", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "echoBlockKinds" }] }, "att1"));
    const patchbaySessionId = await h.sessions.createSession("att1" as PatchbayAgentId, "Fake Agent", cwd);
    await h.sessions.addContext(patchbaySessionId, {
      id: "chip-att",
      kind: "attachment",
      label: "File: report.pdf",
      path: "/ws/docs/report.pdf",
      mimeType: "application/pdf",
    });
    await h.sessions.addContext(patchbaySessionId, {
      id: "chip-att-2",
      kind: "attachment",
      label: "File: blob.bin",
      path: "/ws/blob.bin",
      // no mimeType: the producer didn't know one — absent stays absent
    });
    await h.gates.prompt(patchbaySessionId, { text: "what are these?" });

    const echoed = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "text");
    const kinds = JSON.parse(echoed?.kind === "text" ? echoed.text : "[]") as Array<Record<string, string>>;
    expect(kinds).toEqual([
      { type: "resource_link", uri: "file:///ws/docs/report.pdf", name: "report.pdf", mimeType: "application/pdf" },
      { type: "resource_link", uri: "file:///ws/blob.bin", name: "blob.bin" },
      { type: "text" },
    ]);
    await h.pool.stop("att1" as PatchbayAgentId);
  });

  // A chip is the session's, not its connection's: staged while the session
  // is detached, it waits on the session's row and rides the next prompt.
  it("a chip staged while the session is detached waits on its row — and rides the next prompt", async () => {
    const h = harness();
    const script: FakeAgentScript = { declare: { loadSession: true }, turn: [{ type: "echoBlocks" }] };
    await h.pool.connect(spec(script, "sm-late-chip"));
    const patchbaySessionId = await h.sessions.createSession("sm-late-chip" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "first" }); // prompted: the load rung reopens it
    await h.pool.stop("sm-late-chip" as PatchbayAgentId);
    expect(h.sessions.isLive(patchbaySessionId)).toBe(false);

    await h.sessions.addContext(patchbaySessionId, { kind: "selection", id: "late-chip", label: "a.ts:1", content: "const late = 1;" });
    expect(h.state().contextChips[patchbaySessionId]).toMatchObject([{ id: "late-chip" }]);

    await h.pool.connect(spec(script, "sm-late-chip"));
    await h.gates.prompt(patchbaySessionId, { text: "with the chip" });
    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(textOf(echoed)).toContain("const late = 1;");
    expect(h.state().contextChips[patchbaySessionId]).toEqual([]);
    await h.pool.stop("sm-late-chip" as PatchbayAgentId);
  });

  it("removeContext drops a chip before it's ever sent", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "echoBlocks" }] }, "sm10"));
    const patchbaySessionId = await h.sessions.createSession("sm10" as PatchbayAgentId, "Fake Agent", cwd);

    await h.sessions.addContext(patchbaySessionId, {
      id: "chip-1",
      kind: "file",
      label: "File: a.ts",
      content: "export const a = 1;",
    });
    h.sessions.removeContext(patchbaySessionId, "chip-1");
    expect(h.state().contextChips[patchbaySessionId]).toEqual([]);

    await h.gates.prompt(patchbaySessionId, { text: "hello" });
    const echoed = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "text");
    expect(echoed?.kind === "text" && echoed.text).toBe("hello"); // the removed chip never appears
    await h.pool.stop("sm10" as PatchbayAgentId);
  });

  it("context roots on a zero-turn session: minted again with the new list — the same session, path normalized", async () => {
    const h = harness();
    // Deliberately no load/resume declared: the zero-turn rung is session/new.
    await h.pool.connect(spec({ declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] }, "sm11"));
    const patchbaySessionId = await h.sessions.createSession("sm11" as PatchbayAgentId, "Fake Agent", cwd);
    const before = h.sessions.sessionIdOf(patchbaySessionId);

    await h.gates.addRoot(patchbaySessionId, "/repo/backend/"); // trailing slash normalized away
    // a fresh id on the agent's side; on patchbay's, the same session
    expect(h.sessions.sessionIdOf(patchbaySessionId)).not.toBe(before);
    expect(h.state().sessions.map((s) => s.id)).toEqual([patchbaySessionId]);
    expect(h.state().activePatchbaySessionId).toBe(patchbaySessionId);
    expect(h.state().contextRoots[patchbaySessionId]).toEqual(["/repo/backend"]);
    // each birth tells its servers once the session exists: at creation,
    // on the add, and at the re-mint
    expect(h.rootsChanged).toEqual([patchbaySessionId, patchbaySessionId, patchbaySessionId]);

    await h.gates.prompt(patchbaySessionId, { text: "roots?" });
    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/backend"]);

    await h.pool.stop("sm11" as PatchbayAgentId);
  });

  // A root has two readers (issue #34): the session's MCP servers, told at
  // once through the orchestrator, and the agent, told only on a lifecycle
  // request. So an add is always recorded; what the agent's rung decides
  // is when — or whether — the agent's own list moves.
  it("after a turn, an agent that advertises the field but not session/resume: the root is recorded and the servers told; the agent takes it at the next open (issue #34)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { additionalDirectories: {} } }, turn: [{ type: "echoRoots" }] },
        "sm11l",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm11l" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "first turn" });

    // load would replay the whole session for one root — never used for a
    // re-apply; without resume the agent's copy waits, but the list is the
    // session's and the servers read it now
    await h.gates.addRoot(patchbaySessionId, "/repo/backend");
    expect(h.state().contextRoots[patchbaySessionId]).toEqual(["/repo/backend"]);
    expect(h.rootsChanged).toEqual([patchbaySessionId, patchbaySessionId]); // birth, then the add
    expect(h.sessions.rootsOf(patchbaySessionId)).toEqual([cwd, "/repo/backend"]);
    expect(h.state().activePatchbaySessionId).toBe(patchbaySessionId);
    await h.gates.prompt(patchbaySessionId, { text: "roots?" });
    const before = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(before?.kind === "text" && JSON.parse(before.text)).toEqual([]);

    // the next open — the reload the chip's note offers — carries the whole list
    await h.gates.reload(patchbaySessionId);
    await h.gates.prompt(patchbaySessionId, { text: "roots?" });
    const after = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(after?.kind === "text" && JSON.parse(after.text)).toEqual(["/repo/backend"]);

    await h.pool.stop("sm11l" as PatchbayAgentId);
  });

  it("multi-root workspace: every folder beyond the cwd rides as an additional directory — at session/new, on a root change, and on a folder change (issue #28)", async () => {
    const h = harness({ workspaceRoots: [cwd, "/repo/second", "/repo/third"] });
    await h.pool.connect(
      spec({ declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] }, "sm28"),
    );
    const patchbaySessionId = await h.sessions.createSession("sm28" as PatchbayAgentId, "Fake Agent", cwd);
    const wireRoots = async () => {
      await h.gates.prompt(patchbaySessionId, { text: "roots?" });
      const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
      return echoed?.kind === "text" ? (JSON.parse(echoed.text) as string[]) : null;
    };
    // session/new: the folders the chip already counts — minus the cwd,
    // which travels as cwd — reached the agent
    expect(await wireRoots()).toEqual(["/repo/second", "/repo/third"]);
    // a user-added external root joins the same list, never replaces it
    await h.gates.addRoot(patchbaySessionId, "/repo/backend");
    expect(await wireRoots()).toEqual(["/repo/second", "/repo/third", "/repo/backend"]);
    // a workspace folder removed at runtime: the chip would update — the
    // wire must too, or the two lists diverge again by a rarer path
    h.workspaceRoots.splice(2, 1); // drop /repo/third
    await h.gates.reapplyWorkspaceRoots();
    expect(await wireRoots()).toEqual(["/repo/second", "/repo/backend"]);
    // the durable row carries only the user-added root — folders are read
    // from reality, never stored
    expect(h.state().contextRoots[patchbaySessionId]).toEqual(["/repo/backend"]);
    await h.pool.stop("sm28" as PatchbayAgentId);
  });

  it("an agent that does not advertise additionalDirectories never receives the field (spec MUST) — folders and adds alike", async () => {
    const h = harness({ workspaceRoots: [cwd, "/repo/second"] });
    await h.pool.connect(
      spec({ declare: { sessionCapabilities: { resume: {} } }, turn: [{ type: "echoRoots" }] }, "sm28n"),
    );
    const patchbaySessionId = await h.sessions.createSession("sm28n" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "roots?" });
    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual([]);
    // an add is recorded for the servers (issue #34) and never re-applied
    // on the agent: no field to send, so no re-attach is made for it
    await h.gates.addRoot(patchbaySessionId, "/repo/backend");
    expect(h.state().contextRoots[patchbaySessionId]).toEqual(["/repo/backend"]);
    expect(h.rootsChanged).toEqual([patchbaySessionId, patchbaySessionId]); // birth, then the add
    expect(h.sessions.rootsOf(patchbaySessionId)).toEqual([cwd, "/repo/second", "/repo/backend"]);
    await h.gates.prompt(patchbaySessionId, { text: "roots?" });
    const again = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(again?.kind === "text" && JSON.parse(again.text)).toEqual([]);
    // one session/new, one prompt, one prompt: nothing re-attached
    expect(h.state().sessions.map((s) => s.id)).toEqual([patchbaySessionId]);
    await h.pool.stop("sm28n" as PatchbayAgentId);
  });

  // The write scope's "inside the workspace" (issue #56): the session's own
  // root list, minus a cwd no folder backs.
  it("granted roots: every workspace folder and the session's own roots — a cwd no folder backs is not one", async () => {
    const h = harness({ workspaceRoots: [cwd, "/repo/second"] });
    await h.pool.connect(spec({ declare: ROOTS_CAPS }, "sm56"));
    const patchbaySessionId = await h.sessions.createSession("sm56" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.addRoot(patchbaySessionId, "/repo/backend");
    const current = h.state().activePatchbaySessionId!;
    expect(h.sessions.grantedRoots(current)).toEqual([cwd, "/repo/second", "/repo/backend"]);

    // no folder open: the session still runs somewhere, but nobody handed
    // the agent that place
    h.workspaceRoots.splice(0);
    expect(h.sessions.grantedRoots(current)).toEqual(["/repo/backend"]);
    await h.pool.stop("sm56" as PatchbayAgentId);
  });

  // Saved roots (issue #32): a preference that shapes a session's birth and
  // nothing after — the session owns its list from then on.
  it("saved roots seed a new session: sent at session/new, then the session's own list — each once, never what it already has (issue #32)", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    const h = harness({
      continuityStore: store,
      workspaceRoots: [cwd, "/repo/second"],
      savedRoots: ["/src/odoo", cwd, "/repo/second", "/src/lib", "/src/odoo"],
    });
    // Resume deliberately not declared: nothing after birth re-applies in
    // place, so an echo that carries them proves session/new did. List +
    // load make the session's row durable.
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true, sessionCapabilities: { list: {}, additionalDirectories: {} } },
          turn: [{ type: "echoRoots" }],
        },
        "sm32",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm32" as PatchbayAgentId, "Fake Agent", cwd);

    expect(h.state().contextRoots[patchbaySessionId]).toEqual(["/src/odoo", "/src/lib"]);
    expect(store.read("sm32" as PatchbayAgentId, h.sessions.sessionIdOf(patchbaySessionId)!)?.roots).toEqual(["/src/odoo", "/src/lib"]);
    // servers spawned during session/new could only ask before the id was
    // known — they are told once the session and its list exist
    expect(h.rootsChanged).toEqual([patchbaySessionId]);
    expect(h.sessions.rootsOf(patchbaySessionId)).toEqual([cwd, "/repo/second", "/src/odoo", "/src/lib"]);
    await h.gates.prompt(patchbaySessionId, { text: "roots?" });
    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/second", "/src/odoo", "/src/lib"]);
    expect(h.state().sessions.map((s) => s.id)).toEqual([patchbaySessionId]); // no re-attach

    // the session's own act from here: removing one leaves the others
    await h.gates.removeRoot(patchbaySessionId, "/src/odoo");
    expect(h.state().contextRoots[patchbaySessionId]).toEqual(["/src/lib"]);
    await h.pool.stop("sm32" as PatchbayAgentId);
  });

  it("saved roots reach the servers of an agent that does not advertise the field — the field itself is never sent (issue #32)", async () => {
    const h = harness({ savedRoots: ["/src/odoo"] });
    await h.pool.connect(
      spec({ declare: { sessionCapabilities: { resume: {} } }, turn: [{ type: "echoRoots" }] }, "sm32n"),
    );
    const patchbaySessionId = await h.sessions.createSession("sm32n" as PatchbayAgentId, "Fake Agent", cwd);
    expect(h.state().contextRoots[patchbaySessionId]).toEqual(["/src/odoo"]);
    expect(h.sessions.rootsOf(patchbaySessionId)).toEqual([cwd, "/src/odoo"]);
    await h.gates.prompt(patchbaySessionId, { text: "roots?" });
    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual([]);
    await h.pool.stop("sm32n" as PatchbayAgentId);
  });

  // A root is a folder on disk: every lifecycle request checks, skips a
  // folder that is gone, and says so in the session (issue #32).
  it("a saved root gone from disk: not seeded, not sent, not served — the session says which, and the saved list is told (issue #32)", async () => {
    const h = harness({ savedRoots: ["/src/odoo", "/src/gone"], missingRoots: ["/src/gone"] });
    await h.pool.connect(spec({ declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] }, "sm32m"));
    const patchbaySessionId = await h.sessions.createSession("sm32m" as PatchbayAgentId, "Fake Agent", cwd);

    expect(h.state().contextRoots[patchbaySessionId]).toEqual(["/src/odoo"]);
    expect(h.sessions.rootsOf(patchbaySessionId)).toEqual([cwd, "/src/odoo"]);
    expect(h.rootsMissing).toEqual([["/src/gone"]]);
    const notice = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "notice");
    expect(notice?.kind === "notice" && notice.text).toContain("/src/gone");
    await h.gates.prompt(patchbaySessionId, { text: "roots?" });
    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/src/odoo"]);
    await h.pool.stop("sm32m" as PatchbayAgentId);
  });

  it("a session's own root gone from disk: kept on its list, skipped at the next open and by its servers, with a notice (issue #32)", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true, sessionCapabilities: { list: {}, additionalDirectories: {}, resume: {} } },
          turn: [{ type: "echoRoots" }],
        },
        "sm32g",
      ),
    );
    const firstId = await h.sessions.createSession("sm32g" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.addRoot(firstId, "/repo/backend"); // zero-turn: re-minted
    const patchbaySessionId = h.state().activePatchbaySessionId!;
    await h.gates.prompt(patchbaySessionId, { text: "first turn" });

    h.missingRoots.push("/repo/backend");
    expect(h.sessions.rootsOf(patchbaySessionId)).toEqual([cwd]);
    await h.gates.reload(patchbaySessionId);
    expect(h.state().contextRoots[patchbaySessionId]).toEqual(["/repo/backend"]); // the user's list, untouched
    expect(h.rootsMissing).toEqual([["/repo/backend"]]);
    const notice = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "notice").at(-1);
    expect(notice?.kind === "notice" && notice.text).toContain("/repo/backend");
    await h.gates.prompt(patchbaySessionId, { text: "roots?" });
    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual([]);
    await h.pool.stop("sm32g" as PatchbayAgentId);
  });

  // The agent's own roots report (issue #33): a session/list row may carry
  // the complete list the last lifecycle request set — whichever client
  // sent it. A present list replaces patchbay's intended list for a session
  // not open here (replaced, never merged), minus the workspace folders
  // patchbay composes itself, so the row keeps only what the user added.
  // An omitted field says nothing: the report is optional, and the agents
  // that declare the field omit it on every row today — the reload case
  // below ("held words, roots, chips, and draft survive") pins that the
  // row stands then.
  describe("a session/list row reporting the session's roots (issue #33)", () => {
    const REPORT_CAPS = {
      loadSession: true,
      sessionCapabilities: { list: {}, additionalDirectories: {}, resume: {} },
    } as const;
    const reportFile = () => join(cwd, "reported-roots.json");
    const report = (roots: string[]) => writeFile(reportFile(), JSON.stringify(roots));

    it("a listed session enters with the reported list, the row following it; a later report replaces again, and an empty one clears", async () => {
      const store = new SessionContinuityStore(new MemoryKV());
      const script: FakeAgentScript = {
        declare: REPORT_CAPS,
        listRootsFrom: reportFile(),
        turn: [{ type: "chunk", text: "x" }],
      };
      const h1 = harness({ continuityStore: store });
      await h1.pool.connect(spec(script, "c33"));
      const patchbaySessionId = await h1.sessions.createSession("c33" as PatchbayAgentId, "Fake Agent", cwd);
      await h1.gates.prompt(patchbaySessionId, { text: "first turn" });
      await h1.gates.addRoot(patchbaySessionId, "/repo/extra");
      const sessionId = h1.sessions.sessionIdOf(patchbaySessionId)!;
      expect(store.read("c33" as PatchbayAgentId, sessionId)?.roots).toEqual(["/repo/extra"]);
      await h1.pool.stop("c33" as PatchbayAgentId);

      // another client set the roots while no window was open: first sight
      await report(["/other/root"]);
      const h2 = harness({ continuityStore: store });
      await h2.pool.connect(spec(script, "c33"));
      await h2.sessions.syncAgentSessions("c33" as PatchbayAgentId);
      const listed = h2.sessions.rowFor("c33" as PatchbayAgentId, sessionId)!;
      expect(h2.state().contextRoots[listed]).toEqual(["/other/root"]);
      expect(store.read("c33" as PatchbayAgentId, sessionId)?.roots).toEqual(["/other/root"]);

      // a known session, still not open here: the next walk's report wins again
      await report(["/other/root", "/third"]);
      await h2.sessions.syncAgentSessions("c33" as PatchbayAgentId);
      expect(h2.state().contextRoots[listed]).toEqual(["/other/root", "/third"]);

      // an empty report is a report
      await report([]);
      await h2.sessions.syncAgentSessions("c33" as PatchbayAgentId);
      expect(h2.state().contextRoots[listed]).toEqual([]);
      expect(store.read("c33" as PatchbayAgentId, sessionId)?.roots).toBeUndefined(); // the row carries no empty list
      await h2.pool.stop("c33" as PatchbayAgentId);
    });

    it("a session open here is not adopted — patchbay is its last writer", async () => {
      const script: FakeAgentScript = {
        declare: REPORT_CAPS,
        listRootsFrom: reportFile(),
        turn: [{ type: "chunk", text: "x" }],
      };
      const h = harness();
      await h.pool.connect(spec(script, "c33o"));
      const patchbaySessionId = await h.sessions.createSession("c33o" as PatchbayAgentId, "Fake Agent", cwd);
      await h.gates.prompt(patchbaySessionId, { text: "first turn" });
      await h.gates.addRoot(patchbaySessionId, "/repo/extra");
      await report(["/stale/root"]);
      await h.sessions.syncAgentSessions("c33o" as PatchbayAgentId);
      expect(h.state().contextRoots[patchbaySessionId]).toEqual(["/repo/extra"]);
      await h.pool.stop("c33o" as PatchbayAgentId);
    });

    it("the agent reports the composed list — workspace folders are subtracted, the row keeps only the user's roots, and the wire gets the same composition back", async () => {
      const store = new SessionContinuityStore(new MemoryKV());
      const script: FakeAgentScript = {
        declare: REPORT_CAPS,
        listRootsFrom: reportFile(),
        turn: [{ type: "echoRoots" }],
      };
      const h1 = harness({ continuityStore: store, workspaceRoots: [cwd, "/repo/second"] });
      await h1.pool.connect(spec(script, "c33w"));
      const patchbaySessionId = await h1.sessions.createSession("c33w" as PatchbayAgentId, "Fake Agent", cwd);
      await h1.gates.prompt(patchbaySessionId, { text: "first turn" });
      const sessionId = h1.sessions.sessionIdOf(patchbaySessionId)!;
      await h1.pool.stop("c33w" as PatchbayAgentId);

      await report(["/repo/second", "/repo/extra"]);
      const h2 = harness({ continuityStore: store, workspaceRoots: [cwd, "/repo/second"] });
      await h2.pool.connect(spec(script, "c33w"));
      await h2.sessions.syncAgentSessions("c33w" as PatchbayAgentId);
      const listed = h2.sessions.rowFor("c33w" as PatchbayAgentId, sessionId)!;
      expect(h2.state().contextRoots[listed]).toEqual(["/repo/extra"]);
      expect(store.read("c33w" as PatchbayAgentId, sessionId)?.roots).toEqual(["/repo/extra"]);
      await h2.gates.prompt(listed, { text: "roots?" });
      const echoed = h2.state().transcripts[listed]!.filter((b) => b.kind === "text").at(-1);
      expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/second", "/repo/extra"]);
      await h2.pool.stop("c33w" as PatchbayAgentId);
    });
  });

  it("a root added during a live turn is applied before the held prompt fires — the next prompt runs on the new list", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: ROOTS_CAPS, stepDelayMs: 150, turn: [{ type: "echoRoots" }] }, "sm28t"),
    );
    const patchbaySessionId = await h.sessions.createSession("sm28t" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "warm-up" }); // everPrompted: the resume rung, not recreate
    const slow = h.gates.prompt(patchbaySessionId, { text: "slow turn" });
    await new Promise((r) => setTimeout(r, 30)); // the turn is in flight
    await h.gates.addRoot(patchbaySessionId, "/repo/backend"); // deferred to turn end
    const held = h.gates.prompt(patchbaySessionId, { text: "roots?" }); // held until the turn ends
    await Promise.all([slow, held]);
    for (let i = 0; i < 100; i++) {
      const texts = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text");
      if (texts.length >= 3) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/backend"]);
    await h.pool.stop("sm28t" as PatchbayAgentId);
  });

  it("a root added under a turn the user stops is applied once it has left — and words sent after the Stop go then, on the new list", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: ROOTS_CAPS, stepDelayMs: 150, turn: [{ type: "echoRoots" }] }, "sm28s"),
    );
    const patchbaySessionId = await h.sessions.createSession("sm28s" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "warm-up" }); // everPrompted: the resume rung, not recreate
    const slow = h.gates.prompt(patchbaySessionId, { text: "slow turn" }).catch((err: unknown) => err);
    await new Promise((r) => setTimeout(r, 30)); // the turn is in flight
    await h.gates.addRoot(patchbaySessionId, "/repo/backend"); // deferred to turn end
    const stopped = h.gates.stop(patchbaySessionId);
    // Asked after the Stop, while the stopped turn is still winding down:
    // held, and not among the words the Stop dropped.
    const after = h.gates.prompt(patchbaySessionId, { text: "roots?" });
    expect(await slow).toMatchObject({ by: "stop" });
    await Promise.all([stopped, after]);
    let echoed: ChatBlock | undefined;
    for (let i = 0; i < 100 && echoed === undefined; i++) {
      echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text")[1];
      if (echoed === undefined) await new Promise((r) => setTimeout(r, 20));
    }
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/backend"]);
    await h.pool.stop("sm28s" as PatchbayAgentId);
  });

  it("a root added under a turn that fails is still applied once it ends — the failure holds words, never the roots", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] }, "sm28f"));
    const patchbaySessionId = await h.sessions.createSession("sm28f" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "warm-up" }); // everPrompted: the resume rung, not recreate
    vi.spyOn(h.pool, "prompt").mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 100));
      throw new Error("the agent failed the turn");
    });
    const failing = h.gates.prompt(patchbaySessionId, { text: "failing turn" });
    await new Promise((r) => setTimeout(r, 30)); // the turn is on the wire
    await h.gates.addRoot(patchbaySessionId, "/repo/backend"); // deferred to turn end
    await expect(failing).rejects.toThrow("the agent failed the turn");
    await h.gates.prompt(patchbaySessionId, { text: "roots?" });
    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/backend"]);
    await h.pool.stop("sm28f" as PatchbayAgentId);
  });

  it("root re-apply retains user-steered knobs — the re-attach resets agent defaults, patchbay re-seeds", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: ROOTS_CAPS,
          turn: [{ type: "echoRoots" }],
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "default",
              options: [
                { value: "default", name: "Default" },
                { value: "sonnet", name: "Sonnet" },
              ],
            },
          ],
        },
        "sm11k",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm11k" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.setKnob(patchbaySessionId, "model", "sonnet");
    await h.gates.prompt(patchbaySessionId, { text: "first turn" });

    await h.gates.addRoot(patchbaySessionId, "/repo/backend");

    // session/resume handed back the script defaults ("default") — the
    // re-seed must have restored the user's confirmed value.
    const model = h.state().sessionKnobs[patchbaySessionId]!.find((k) => k.id === "model");
    expect(model?.currentValue).toBe("sonnet");

    await h.pool.stop("sm11k" as PatchbayAgentId);
  });

  // The durable copy behind the reattach rule: a window reload wipes the
  // in-memory snapshot, but a restored session is not a deliberate fresh
  // entry — its own combination must come back, not the entry seed. The
  // persisted copy was lost when the session index was removed; this pins
  // its return.
  it("a session's knob combination survives a window reload — restored, not reseeded", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    const script: FakeAgentScript = {
      declare: { loadSession: true, sessionCapabilities: { list: {} } },
      turn: [{ type: "chunk", text: "x" }],
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default",
          options: [
            { value: "default", name: "Default" },
            { value: "sonnet", name: "Sonnet" },
          ],
        },
      ],
    };
    // window 1: the user steers the knob, then the window goes away
    const h1 = harness({ continuityStore: store });
    await h1.pool.connect(spec(script, "smk1"));
    const patchbaySessionId = await h1.sessions.createSession("smk1" as PatchbayAgentId, "Fake Agent", cwd);
    await h1.gates.setKnob(patchbaySessionId, "model", "sonnet");
    await h1.gates.prompt(patchbaySessionId, { text: "first turn" });
    // the durable row keys on the agent's own id — what names the session
    // again after a reload
    const sessionId = h1.sessions.sessionIdOf(patchbaySessionId)!;
    expect(store.read("smk1" as PatchbayAgentId, sessionId)?.knobs).toMatchObject({ model: "sonnet" });
    await h1.pool.stop("smk1" as PatchbayAgentId);

    // window 2: fresh processes, fresh memory — only the durable copy survives
    const h2 = harness({ continuityStore: store });
    await h2.pool.connect(spec(script, "smk1"));
    await h2.sessions.syncAgentSessions("smk1" as PatchbayAgentId);
    const restored = h2.sessions.rowFor("smk1" as PatchbayAgentId, sessionId)!;
    expect(restored).toBeDefined();
    h2.gates.activate(restored);
    // session/load hands back the script default; the involuntary-arm
    // reseed must restore the session's own confirmed value
    const start = Date.now();
    for (;;) {
      const model = h2.state().sessionKnobs[restored]?.find((k) => k.id === "model");
      if (model?.currentValue === "sonnet") break;
      if (Date.now() - start > 4000) {
        throw new Error(`knob never restored — surface: ${JSON.stringify(h2.state().sessionKnobs[restored])}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    await h2.pool.stop("smk1" as PatchbayAgentId);
  });

  // The rest of the continuity row: held words, user-added roots, prepared
  // chips, and the composer draft all re-enter with the listed session —
  // and the held words release when the lock clears, exactly as they would
  // have in the window that queued them.
  it("held words, roots, chips, and draft survive a window reload", async () => {
    let locked = false;
    const store = new SessionContinuityStore(new MemoryKV());
    const script: FakeAgentScript = {
      declare: { loadSession: true, sessionCapabilities: { list: {}, additionalDirectories: {}, resume: {} } },
      turn: [{ type: "chunk", text: "x" }],
    };
    const h1 = harness({ continuityStore: store, authLocked: () => locked });
    await h1.pool.connect(spec(script, "smq6"));
    const patchbaySessionId = await h1.sessions.createSession("smq6" as PatchbayAgentId, "Fake Agent", cwd);
    await h1.gates.prompt(patchbaySessionId, { text: "real turn" }); // persists agent-side
    await h1.gates.addRoot(patchbaySessionId, "/repo/extra");
    await h1.sessions.addContext(patchbaySessionId, {
      kind: "selection",
      id: "chip-1",
      label: "main.ts:1-3",
      content: "const x = 1;",
    });
    locked = true; // logout witnessed
    await h1.gates.prompt(patchbaySessionId, { text: "held words" }); // → held row, carrying chip-1
    await h1.sessions.addContext(patchbaySessionId, {
      kind: "selection",
      id: "chip-2",
      label: "util.ts:4",
      content: "const y = 2;",
    }); // staged after: the composer's own
    h1.sessions.saveDraft(patchbaySessionId, "half-typed thought"); // the composer's debounced save
    const sessionId = h1.sessions.sessionIdOf(patchbaySessionId)!;
    await h1.pool.stop("smq6" as PatchbayAgentId);

    // window 2: fresh memory, lock still standing — the row restores everything
    const h2 = harness({ continuityStore: store, authLocked: () => locked });
    await h2.pool.connect(spec(script, "smq6"));
    await h2.sessions.syncAgentSessions("smq6" as PatchbayAgentId);
    const listed = h2.sessions.rowFor("smq6" as PatchbayAgentId, sessionId)!;
    expect(h2.state().promptQueue[listed]).toMatchObject([{ text: "held words", chips: [{ id: "chip-1" }] }]);
    expect(h2.state().contextRoots[listed]).toEqual(["/repo/extra"]);
    expect(h2.state().drafts[listed]).toBe("half-typed thought");
    {
      // chips decode async (stash read) — give the tick a moment
      const start = Date.now();
      while ((h2.state().contextChips[listed]?.length ?? 0) === 0) {
        if (Date.now() - start > 2000) throw new Error("chip never rehydrated");
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    expect(h2.state().contextChips[listed]).toMatchObject([{ id: "chip-2", label: "util.ts:4" }]);

    // login clears the lock: the held words fire with their own chip, the
    // staged one stays the composer's
    locked = false;
    h2.gates.lockCleared("smq6" as PatchbayAgentId);
    const start = Date.now();
    for (;;) {
      const users = h2.state().transcripts[listed]?.filter((b) => b.kind === "user") ?? [];
      if (users.length >= 2) break;
      if (Date.now() - start > 4000) throw new Error("held words never fired after unlock");
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(h2.state().promptQueue[listed] ?? []).toEqual([]);
    const fired = h2.state().transcripts[listed]!.filter((b) => b.kind === "user").at(-1)!;
    expect(fired.kind === "user" && fired.parts.flatMap((p) => (p.kind === "context" ? [p.label] : []))).toEqual(["main.ts:1-3"]);
    expect(h2.state().contextChips[listed]).toMatchObject([{ id: "chip-2" }]);
    await h2.pool.stop("smq6" as PatchbayAgentId);
  });

  // The row's lifetime (issue #29, refined by the sessions store): the row
  // is the one home of what the user staged, so every session has one; it
  // leaves when nothing can name its session again.
  describe("a continuity row per session, gone when nothing can name it again (issue #29)", () => {
    const CONTINUITY_KEY = "acpPatchbay.sessionContinuity";
    const MODEL_KNOB = [
      {
        id: "model",
        name: "Model",
        category: "model" as const,
        type: "select" as const,
        currentValue: "default",
        options: [
          { value: "default", name: "Default" },
          { value: "sonnet", name: "Sonnet" },
        ],
      },
    ];

    it("every session's staging lives on its row, whatever its agent declares — knobs, roots, chips, held words, draft alike", async () => {
      let locked = false;
      const kv = new MemoryKV();
      const store = new SessionContinuityStore(kv);
      const h = harness({ continuityStore: store, authLocked: () => locked });
      const script = (list: boolean): FakeAgentScript => ({
        declare: {
          sessionCapabilities: { additionalDirectories: {}, resume: {}, ...(list ? { list: {} } : {}) },
        },
        configOptions: MODEL_KNOB,
        turn: [{ type: "chunk", text: "x" }],
      });
      const stage = async (patchbayAgentId: PatchbayAgentId) => {
        const patchbaySessionId = await h.sessions.createSession(patchbayAgentId, "Fake Agent", cwd);
        await h.gates.prompt(patchbaySessionId, { text: "first turn" });
        await h.gates.setKnob(patchbaySessionId, "model", "sonnet");
        await h.gates.addRoot(patchbaySessionId, "/repo/extra");
        await h.sessions.addContext(patchbaySessionId, { kind: "selection", id: `${patchbayAgentId}-chip`, label: "a.ts:1", content: "x" });
        locked = true;
        await h.gates.prompt(patchbaySessionId, { text: "held words" }); // carries the chip staged with it
        locked = false;
        await h.sessions.addContext(patchbaySessionId, { kind: "selection", id: `${patchbayAgentId}-staged`, label: "b.ts:2", content: "y" });
        h.sessions.saveDraft(patchbaySessionId, "half a thought");
        return patchbaySessionId;
      };

      for (const [patchbayAgentId, list] of [["c29-nolist" as PatchbayAgentId, false], ["c29-list" as PatchbayAgentId, true]] as const) {
        await h.pool.connect(spec(script(list), patchbayAgentId));
        const patchbaySessionId = await stage(patchbayAgentId);
        expect(store.read(patchbayAgentId, h.sessions.sessionIdOf(patchbaySessionId)!)).toMatchObject({
          knobs: { model: "sonnet" },
          roots: ["/repo/extra"],
          chips: [{ id: `${patchbayAgentId}-staged` }],
          queue: [{ text: "held words", chips: [{ id: `${patchbayAgentId}-chip` }] }],
          draft: "half a thought",
        });
      }
      expect(store.list().map((r) => r.cwd)).toEqual([cwd, cwd]);

      await h.pool.stop("c29-nolist" as PatchbayAgentId);
      await h.pool.stop("c29-list" as PatchbayAgentId);
    });

    it("an agent that cannot list drops, at its connect, the rows of this workspace no session here holds — older builds' included; this window's stay", async () => {
      const kv = new MemoryKV();
      const store = new SessionContinuityStore(kv);
      await store.patch("c29-load" as PatchbayAgentId, "stale", cwd, { draft: "old words" });
      await store.patch("c29-load" as PatchbayAgentId, "stale-elsewhere", "/elsewhere", { draft: "old words" });
      await store.patch("c29-other" as PatchbayAgentId, "other", cwd, { draft: "stays" });
      await kv.update(CONTINUITY_KEY, [
        ...(kv.get<unknown[]>(CONTINUITY_KEY) ?? []),
        { patchbayAgentId: "c29-load", sessionId: "legacy", draft: "no cwd" },
      ]);
      const h = harness({ continuityStore: store });
      // load without list: a rung, but nothing will ever name an earlier
      // window's sessions again
      await h.pool.connect(spec({ declare: { loadSession: true } }, "c29-load"));
      await h.sessions.syncAgentSessions("c29-load" as PatchbayAgentId);
      expect(store.list().map((r) => `${r.patchbayAgentId}:${r.sessionId}`).sort()).toEqual(["c29-load:stale-elsewhere", "c29-other:other"]);

      // a session of this window keeps its row across the agent's reconnect
      const patchbaySessionId = await h.sessions.createSession("c29-load" as PatchbayAgentId, "Fake Agent", cwd);
      h.sessions.saveDraft(patchbaySessionId, "half a thought");
      await h.pool.stop("c29-load" as PatchbayAgentId);
      await h.pool.connect(spec({ declare: { loadSession: true } }, "c29-load"));
      await h.sessions.syncAgentSessions("c29-load" as PatchbayAgentId);
      expect(store.read("c29-load" as PatchbayAgentId, h.sessions.sessionIdOf(patchbaySessionId)!)).toEqual({ draft: "half a thought" });
      await h.pool.stop("c29-load" as PatchbayAgentId);
    });

    it("a complete list walk reconciles this workspace's rows: unreported rows leave, an older row the walk names is stamped and rehydrated, other workspaces untouched", async () => {
      const kv = new MemoryKV();
      const store = new SessionContinuityStore(kv);
      const script: FakeAgentScript = {
        declare: { loadSession: true, sessionCapabilities: { list: {} } },
        turn: [{ type: "chunk", text: "x" }],
      };
      const h1 = harness({ continuityStore: store });
      await h1.pool.connect(spec(script, "c29-walk"));
      const patchbaySessionId = await h1.sessions.createSession("c29-walk" as PatchbayAgentId, "Fake Agent", cwd);
      await h1.gates.prompt(patchbaySessionId, { text: "persisted agent-side" });
      const sessionId = h1.sessions.sessionIdOf(patchbaySessionId)!;
      await h1.pool.stop("c29-walk" as PatchbayAgentId);

      // while patchbay was closed: one session deleted in the agent's own
      // store, one row from a build that recorded no cwd
      await store.patch("c29-walk" as PatchbayAgentId, "deleted-while-closed", cwd, { draft: "gone" });
      await store.patch("c29-walk" as PatchbayAgentId, "other-ws", "/elsewhere", { draft: "stays" });
      await kv.update(CONTINUITY_KEY, [
        ...(kv.get<unknown[]>(CONTINUITY_KEY) ?? []),
        { patchbayAgentId: "c29-walk", sessionId, draft: "legacy draft" },
      ]);

      const h2 = harness({ continuityStore: store });
      await h2.pool.connect(spec(script, "c29-walk"));
      await h2.sessions.syncAgentSessions("c29-walk" as PatchbayAgentId);
      expect(store.read("c29-walk" as PatchbayAgentId, "deleted-while-closed")).toBeUndefined();
      expect(store.read("c29-walk" as PatchbayAgentId, "other-ws")).toEqual({ draft: "stays" });
      expect(store.read("c29-walk" as PatchbayAgentId, sessionId)).toEqual({ draft: "legacy draft" });
      expect(store.list().find((r) => r.patchbayAgentId === "c29-walk" && r.sessionId === sessionId)?.cwd).toBe(cwd);
      expect(h2.state().drafts[h2.sessions.rowFor("c29-walk" as PatchbayAgentId, sessionId)!]).toBe("legacy draft");
      await h2.pool.stop("c29-walk" as PatchbayAgentId);
    });

    it("a live zero-turn session's row survives a walk that does not report it yet", async () => {
      const store = new SessionContinuityStore(new MemoryKV());
      const h = harness({ continuityStore: store });
      await h.pool.connect(
        spec({ declare: { loadSession: true, sessionCapabilities: { list: {} } }, configOptions: MODEL_KNOB }, "c29-live"),
      );
      const patchbaySessionId = await h.sessions.createSession("c29-live" as PatchbayAgentId, "Fake Agent", cwd);
      await h.gates.setKnob(patchbaySessionId, "model", "sonnet");
      const sessionId = h.sessions.sessionIdOf(patchbaySessionId)!;
      expect(store.read("c29-live" as PatchbayAgentId, sessionId)?.knobs).toEqual({ model: "sonnet" });
      await h.sessions.syncRunningAgents(); // the agent persists nothing until the first turn
      expect(store.read("c29-live" as PatchbayAgentId, sessionId)?.knobs).toEqual({ model: "sonnet" });
      await h.pool.stop("c29-live" as PatchbayAgentId);
    });

    it("agent removal drops rows the index never saw, in every workspace", async () => {
      const store = new SessionContinuityStore(new MemoryKV());
      await store.patch("c29-rm" as PatchbayAgentId, "never-indexed", "/elsewhere", { draft: "x" });
      await store.patch("c29-keep" as PatchbayAgentId, "keep", cwd, { draft: "y" });
      const h = harness({ continuityStore: store });
      h.sessions.forgetAgentSessions("c29-rm" as PatchbayAgentId);
      expect(store.list().map((r) => r.patchbayAgentId)).toEqual(["c29-keep"]);
    });

    it("a zero-turn re-mint keeps the composer draft — an agent that writes no row still keeps the words, on the same session", async () => {
      const h = harness();
      await h.pool.connect(spec({ declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] }, "c29-draft"));
      const patchbaySessionId = await h.sessions.createSession("c29-draft" as PatchbayAgentId, "Fake Agent", cwd);
      const before = h.sessions.sessionIdOf(patchbaySessionId);
      h.sessions.saveDraft(patchbaySessionId, "typed before any turn");
      await h.gates.addRoot(patchbaySessionId, "/repo/backend");
      expect(h.sessions.sessionIdOf(patchbaySessionId)).not.toBe(before);
      expect(h.state().activePatchbaySessionId).toBe(patchbaySessionId);
      expect(h.state().drafts[patchbaySessionId]).toBe("typed before any turn");
      await h.pool.stop("c29-draft" as PatchbayAgentId);
    });
  });

  it("a failed root re-apply detaches the session — the next prompt re-enters the ladder, never a corpse", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: ROOTS_CAPS, failResume: true, turn: [{ type: "echoRoots" }] }, "sm11f"),
    );
    const patchbaySessionId = await h.sessions.createSession("sm11f" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "first turn" });
    expect(h.sessions.isLive(patchbaySessionId)).toBe(true);

    await h.gates.addRoot(patchbaySessionId, "/repo/backend");
    expect(h.state().contextRoots[patchbaySessionId]).toEqual(["/repo/backend"]); // canonical list stands
    expect(h.sessions.isLive(patchbaySessionId)).toBe(false); // detached, not a zombie

    await h.pool.stop("sm11f" as PatchbayAgentId);
  });

  it("context roots after a turn re-apply in place via session/resume — same sessionId, transcript untouched", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] },
        "sm11r",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm11r" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "first turn" });
    const before = h.state().transcripts[patchbaySessionId]!.length;

    await h.gates.addRoot(patchbaySessionId, "/repo/backend");

    // Resume rung: no replay, so the render cache must not have been reset.
    expect(h.state().transcripts[patchbaySessionId]!.length).toBeGreaterThanOrEqual(before);
    await h.gates.prompt(patchbaySessionId, { text: "roots?" });
    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual(["/repo/backend"]);

    await h.pool.stop("sm11r" as PatchbayAgentId);
  });

  it("prompt parts: inline file mentions ride as resource_link blocks at their position", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "echoBlockKinds" }] }, "sm11p"));
    const patchbaySessionId = await h.sessions.createSession("sm11p" as PatchbayAgentId, "Fake Agent", cwd);

    await h.gates.prompt(patchbaySessionId, { text: "look at @app.ts please", parts: [
      { kind: "text", text: "look at " },
      { kind: "fileRef", path: "/repo/src/app.ts" },
      { kind: "text", text: " please" },
    ] });

    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && JSON.parse(echoed.text)).toEqual([
      { type: "text" },
      { type: "resource_link", uri: "file:///repo/src/app.ts", name: "app.ts" },
      { type: "text" },
    ]);
    // the transcript records the prompt in the part vocabulary — the
    // mention is a structured part, rendered as an inline @app.ts token
    const user = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "user");
    expect(user?.kind === "user" && user.parts).toEqual([
      { kind: "text", text: "look at " },
      { kind: "mention", name: "app.ts", uri: "file:///repo/src/app.ts" },
      { kind: "text", text: " please" },
    ]);

    await h.pool.stop("sm11p" as PatchbayAgentId);
  });

  // Issue #30: a never-prompted session whose connection died is still the
  // agent's new session. The agent persisted nothing for it, so no rung can
  // bring the id back — but the row, and everything the user staged on it,
  // is patchbay's. The next use mints the session again from the row.
  describe("a never-prompted session whose connection died (issue #30)", () => {
    async function untilStatus(h: ReturnType<typeof harness>, patchbayAgentId: PatchbayAgentId, status: string): Promise<void> {
      const start = Date.now();
      while (h.pool.get(patchbayAgentId)?.status !== status) {
        if (Date.now() - start > 3000) throw new Error(`${patchbayAgentId} never reached ${status}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    it("new-session focus still finds the row, and the first prompt mints it again — the same session, its draft in place, no sibling", async () => {
      const h = harness();
      await h.pool.connect(spec({ exitAfterMs: 150 }, "c30a"));
      const patchbaySessionId = await h.sessions.createSession("c30a" as PatchbayAgentId, "Fake Agent", cwd);
      const before = h.sessions.sessionIdOf(patchbaySessionId);
      h.events.push({ kind: "sessionDraftChanged", patchbaySessionId, draft: "typed before the crash" });
      await untilStatus(h, "c30a" as PatchbayAgentId, "crashed");
      expect(h.sessions.isLive(patchbaySessionId)).toBe(false);
      expect(h.sessions.findNeverPrompted("c30a" as PatchbayAgentId)).toBe(patchbaySessionId);

      await h.pool.connect(spec({ turn: [{ type: "chunk", text: "ok" }] }, "c30a"));
      await h.gates.prompt(patchbaySessionId, { text: "first words" });
      const rows = h.state().sessions.filter((s) => s.patchbayAgentId === "c30a");
      expect(rows.map((s) => s.id)).toEqual([patchbaySessionId]);
      // minted again on the agent's side only
      expect(h.sessions.sessionIdOf(patchbaySessionId)).not.toBe(before);
      expect(h.state().transcripts[patchbaySessionId]?.some((b) => b.kind === "user")).toBe(true);
      expect(textOf(h.state().transcripts[patchbaySessionId]?.at(-2))).toBe("ok");
      expect(h.state().drafts[patchbaySessionId]).toBe("typed before the crash");
      // the first prompt ended newness, and named it
      expect(h.sessions.findNeverPrompted("c30a" as PatchbayAgentId)).toBeUndefined();
      expect(rows[0]!.title).toBe("first words");
      await h.pool.stop("c30a" as PatchbayAgentId);
    });

    it("opening the dead row mints it again — one live session, the same one, focused, chips in place", async () => {
      const h = harness();
      await h.pool.connect(spec({ exitAfterMs: 150 }, "c30b"));
      const patchbaySessionId = await h.sessions.createSession("c30b" as PatchbayAgentId, "Fake Agent", cwd);
      const before = h.sessions.sessionIdOf(patchbaySessionId);
      await h.sessions.addContext(patchbaySessionId, { kind: "selection", id: "c30-chip", label: "a.ts:1", content: "x" });
      await untilStatus(h, "c30b" as PatchbayAgentId, "crashed");

      await h.pool.connect(spec({}, "c30b"));
      h.gates.activate(patchbaySessionId);
      await vi.waitFor(() => expect(h.sessions.isLive(patchbaySessionId)).toBe(true), { timeout: 3000 });
      expect(h.sessions.sessionIdOf(patchbaySessionId)).not.toBe(before);
      expect(h.state().sessions.filter((s) => s.patchbayAgentId === "c30b").map((s) => s.id)).toEqual([patchbaySessionId]);
      expect(h.state().activePatchbaySessionId).toBe(patchbaySessionId);
      expect(h.state().contextChips[patchbaySessionId]).toMatchObject([{ id: "c30-chip" }]);
      await h.pool.stop("c30b" as PatchbayAgentId);
    });

    it("a Close while the dead row is minted again leaves it closed — the fresh session is freed, nothing comes back", async () => {
      const h = harness();
      await h.pool.connect(spec({ exitAfterMs: 150, declare: { sessionCapabilities: { close: {} } } }, "c30c"));
      const patchbaySessionId = await h.sessions.createSession("c30c" as PatchbayAgentId, "Fake Agent", cwd);
      await untilStatus(h, "c30c" as PatchbayAgentId, "crashed");

      // the agent answers a creation late, so the Close lands mid-mint
      await h.pool.connect(spec({ newSessionReplyDelayMs: 200, declare: { sessionCapabilities: { close: {} } } }, "c30c"));
      const prompt = h.gates.prompt(patchbaySessionId, { text: "first words" });
      await h.gates.close(patchbaySessionId);
      await expect(prompt).rejects.toThrow();

      expect(h.state().sessions).toEqual([]);
      expect(h.state().promptQueue[patchbaySessionId]).toBeUndefined();
      // the session the agent minted for it is let go
      expect(h.pool.get("c30c" as PatchbayAgentId)?.sessions).toEqual([]);
      await h.pool.stop("c30c" as PatchbayAgentId);
    });
  });

  it("a still-new session is findable for add-session focus; the first prompt ends that", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "ok" }] }, "sm14"));
    const patchbaySessionId = await h.sessions.createSession("sm14" as PatchbayAgentId, "Fake Agent", cwd);
    expect(h.sessions.findNeverPrompted("sm14" as PatchbayAgentId)).toBe(patchbaySessionId);
    expect(h.sessions.findNeverPrompted("other-agent" as PatchbayAgentId)).toBeUndefined();

    await h.gates.prompt(patchbaySessionId, { text: "first words" });
    expect(h.sessions.findNeverPrompted("sm14" as PatchbayAgentId)).toBeUndefined();

    await h.pool.stop("sm14" as PatchbayAgentId);
  });

  it("open work counts conversations a stop would disconnect — never-prompted ones cost nothing (issue #47)", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "ok" }], stepDelayMs: 300 }, "w47"));
    const fresh = await h.sessions.createSession("w47" as PatchbayAgentId, "Fake Agent", cwd);
    expect(h.sessions.openWork("w47" as PatchbayAgentId)).toEqual({ conversations: 0, turns: 0 });

    const turn = h.gates.prompt(fresh, { text: "go" });
    await vi.waitFor(() => expect(h.sessions.openWork("w47" as PatchbayAgentId)).toEqual({ conversations: 1, turns: 1 }));
    await turn;
    expect(h.sessions.openWork("w47" as PatchbayAgentId)).toEqual({ conversations: 1, turns: 0 });

    await h.sessions.createSession("w47" as PatchbayAgentId, "Fake Agent", cwd);
    expect(h.sessions.openWork("w47" as PatchbayAgentId)).toEqual({ conversations: 1, turns: 0 });
    expect(h.sessions.openWork("other-agent" as PatchbayAgentId)).toEqual({ conversations: 0, turns: 0 });

    await h.pool.stop("w47" as PatchbayAgentId);
  });
});

// ── session history: the agent's own session/list is the only list there
// is — patchbay persists no session records (no index, no transcripts).
// A held prompt owns the chips staged with it (#83): each held prompt sends
// what was staged when it was written, never what is staged when it fires.
describe("held prompts and their chips", () => {
  const selection = (id: string) => ({ id, kind: "selection" as const, label: `Selection ${id}`, content: `content of ${id}` });
  const contextLabels = (b: ChatBlock) =>
    b.kind === "user" ? b.parts.flatMap((p) => (p.kind === "context" ? [p.label] : [])) : [];

  it("each held prompt sends the chips staged with it — not the ones staged after", async () => {
    const h = harness();
    const agent = "hc1" as PatchbayAgentId;
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "ok" }], stepDelayMs: 150 }, "hc1"));
    const id = await h.sessions.createSession(agent, "Fake Agent", cwd);
    const first = h.gates.prompt(id, { text: "first" }); // a turn underway
    await new Promise((r) => setTimeout(r, 30));
    await h.sessions.addContext(id, selection("A"));
    await h.gates.prompt(id, { text: "second" }); // held, with A
    await h.sessions.addContext(id, selection("B"));
    await h.gates.prompt(id, { text: "third" }); // held, with B
    expect(h.state().promptQueue[id]!.map((q) => q.chips?.map((c) => c.id))).toEqual([["A"], ["B"]]);
    expect(h.state().contextChips[id]).toEqual([]);
    await first;
    await vi.waitFor(() => expect(h.state().transcripts[id]!.filter((b) => b.kind === "user")).toHaveLength(3), { timeout: 5000 });
    await vi.waitFor(() => expect(h.state().promptQueue[id] ?? []).toEqual([]), { timeout: 5000 });
    const users = h.state().transcripts[id]!.filter((b) => b.kind === "user");
    expect(users.map(contextLabels)).toEqual([[], ["Selection A"], ["Selection B"]]);
    await h.pool.stop(agent);
  });

  it("taking the tail back stages its chips again, with its words", async () => {
    const h = harness();
    const agent = "hc2" as PatchbayAgentId;
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "ok" }], stepDelayMs: 300 }, "hc2"));
    const id = await h.sessions.createSession(agent, "Fake Agent", cwd);
    const first = h.gates.prompt(id, { text: "first" });
    await new Promise((r) => setTimeout(r, 30));
    await h.sessions.addContext(id, selection("A"));
    await h.gates.prompt(id, { text: "second", draft: "the second, as typed" });
    const held = h.state().promptQueue[id]![0]!;
    h.sessions.takeBack(id, held.id);
    expect(h.state().promptQueue[id] ?? []).toEqual([]);
    expect(h.state().drafts[id]).toBe("the second, as typed");
    await vi.waitFor(() => expect(h.state().contextChips[id]!.map((c) => c.id)).toEqual(["A"]));
    await first;
    await h.pool.stop(agent);
  });
});

describe("session history (list / resume / delete)", () => {
  const LIST_CAPS = { sessionCapabilities: { list: {}, delete: {} } };

  it("surfaces externally-created sessions from session/list, without stealing focus", async () => {
    // A session that exists only in the agent's own durable store — made by
    // "another client" (here: a previous fake-agent process would have).
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "ext-1.jsonl"), "", "utf8");

    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "sh1"));
    const mine = await h.sessions.createSession("sh1" as PatchbayAgentId, "Fake Agent", cwd);
    await h.sessions.syncAgentSessions("sh1" as PatchbayAgentId);

    const state = h.state();
    const ext = h.sessions.rowFor("sh1" as PatchbayAgentId, "ext-1");
    expect(ext).toBeDefined();
    expect(state.sessions.map((s) => s.id)).toContain(ext);
    expect(state.sessions.map((s) => s.id)).toContain(mine);
    expect(state.sessions.find((s) => s.id === ext)).toMatchObject({ busy: [] });
    // the sync never activates anything — the user's focus is theirs
    expect(state.activePatchbaySessionId).toBe(mine);
    // the wire round-trip proved the row
    expect(h.capabilityTracker.matrix("sh1" as PatchbayAgentId)?.["session.list"]).toMatchObject({ declared: true, used: true });

    await h.pool.stop("sh1" as PatchbayAgentId);
  });

  it("malformed list rows degrade at the boundary: metadata to absent, identity-less rows dropped", async () => {
    // acp-matrix fixture finding: rows with epoch-seconds updatedAt used to
    // reach the drawer typed as ISO strings and blank the webview on sort.
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "ext-bad.jsonl"), "", "utf8");

    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS, lies: { malformedListRows: true } }, "shm"));
    await h.sessions.syncAgentSessions("shm" as PatchbayAgentId);

    const state = h.state();
    const row = state.sessions.find((s) => s.id === h.sessions.rowFor("shm" as PatchbayAgentId, "ext-bad"));
    // The row survives with its bad sort key degraded to a real ISO string…
    expect(row).toBeDefined();
    expect(typeof row!.updatedAt).toBe("string");
    expect(() => row!.updatedAt.localeCompare("2026-01-01T00:00:00Z")).not.toThrow();
    // …and the identity-less row never entered the snapshot.
    expect(state.sessions.some((s) => s.title === "no identity")).toBe(false);

    await h.pool.stop("shm" as PatchbayAgentId);
  });

  it("prunes rows the agent no longer reports — wire truth wins", async () => {
    const { mkdir, writeFile, rm: rmFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "gone-1.jsonl"), "", "utf8");

    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "sh2"));
    await h.sessions.syncAgentSessions("sh2" as PatchbayAgentId);
    const gone = h.sessions.rowFor("sh2" as PatchbayAgentId, "gone-1");
    expect(gone).toBeDefined();

    // deleted externally (CLI, another editor) — the next sync drops it
    await rmFile(join(cwd, ".fake-agent-sessions", "gone-1.jsonl"));
    await h.sessions.syncAgentSessions("sh2" as PatchbayAgentId);

    expect(h.sessions.rowFor("sh2" as PatchbayAgentId, "gone-1")).toBeUndefined();
    expect(h.events.some((e) => e.kind === "sessionClosed" && e.patchbaySessionId === gone)).toBe(true);

    await h.pool.stop("sh2" as PatchbayAgentId);
  });

  it("a load-declared agent that lost the session: the prompt fails honestly, nothing is minted", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "lost-1.jsonl"), "", "utf8");

    // failLoad: load 404s and drops the session — the corpse-leaving agent
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { ...LIST_CAPS, loadSession: true }, failLoad: true, turn: [{ type: "chunk", text: "ok" }] },
        "sh2c",
      ),
    );
    await h.sessions.syncAgentSessions("sh2c" as PatchbayAgentId);
    const before = h.state().sessions.map((s) => s.id);

    await expect(h.gates.prompt(h.sessions.rowFor("sh2c" as PatchbayAgentId, "lost-1")!, { text: "continue please" })).rejects.toThrow();

    // no sibling appeared, nothing activated itself
    expect(h.state().sessions.map((s) => s.id)).toEqual(before);
    expect(h.events.some((e) => e.kind === "sessionActivated")).toBe(false);

    await h.pool.stop("sh2c" as PatchbayAgentId);
  });

  // The composer lets its words go the moment it sends them — a turn that
  // never starts must not take them along: only the user discards words.
  it("a prompt whose turn never started keeps its words — held, with the editor state to take back", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "lost-2.jsonl"), "", "utf8");
    const continuityStore = new SessionContinuityStore(new MemoryKV());
    const h = harness({ continuityStore });
    await h.pool.connect(
      spec({ declare: { ...LIST_CAPS, loadSession: true }, failLoad: true }, "sh2d"),
    );
    await h.sessions.syncAgentSessions("sh2d" as PatchbayAgentId);

    const lost = h.sessions.rowFor("sh2d" as PatchbayAgentId, "lost-2")!;
    await expect(h.gates.prompt(lost, { text: "continue please", draft: "{editor}" })).rejects.toThrow();

    expect(h.state().promptQueue[lost]).toMatchObject([{ text: "continue please", draft: "{editor}" }]);
    expect(continuityStore.read("sh2d" as PatchbayAgentId, "lost-2")?.queue).toMatchObject([{ text: "continue please" }]);
    // nothing reached the transcript — no user message for a turn that never was
    expect(h.state().transcripts[lost]).toEqual([]);

    await h.pool.stop("sh2d" as PatchbayAgentId);
  });

  it("held words drained into a turn that never started go back to the front — the order is the firing order", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "lost-3.jsonl"), "", "utf8");
    // words held in an earlier window, waiting on the session's row
    const continuityStore = new SessionContinuityStore(new MemoryKV());
    await continuityStore.patch("sh2e" as PatchbayAgentId, "lost-3", cwd, { queue: [{ id: "q-earlier", text: "first" }] });
    const h = harness({ continuityStore });
    await h.pool.connect(
      spec({ declare: { ...LIST_CAPS, loadSession: true }, failLoad: true }, "sh2e"),
    );
    await h.sessions.syncAgentSessions("sh2e" as PatchbayAgentId);

    // a prompt behind held words releases the front — whose load then fails
    const lost = h.sessions.rowFor("sh2e" as PatchbayAgentId, "lost-3")!;
    await h.gates.prompt(lost, { text: "second" });
    await vi.waitFor(() =>
      expect(h.events.filter((e) => e.kind === "promptQueueCleared" && e.patchbaySessionId === lost)).toHaveLength(1),
    );

    expect(h.state().promptQueue[lost]?.map((q) => q.text)).toEqual(["first", "second"]);
    expect(continuityStore.read("sh2e" as PatchbayAgentId, "lost-3")?.queue?.map((q) => q.text)).toEqual(["first", "second"]);

    await h.pool.stop("sh2e" as PatchbayAgentId);
  });

  it("the agent's title always wins — patchbay-side rename is gone", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS, listWithTitles: true }, "sh3"));
    const patchbaySessionId = await h.sessions.createSession("sh3" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "derive me a title" });
    expect(h.state().sessions[0]?.title).toBe("derive me a title");

    await h.sessions.syncAgentSessions("sh3" as PatchbayAgentId);
    // the fake agent titles a row after its own id for the session
    expect(h.state().sessions.find((s) => s.id === patchbaySessionId)?.title).toBe(`fake:${h.sessions.sessionIdOf(patchbaySessionId)}`);

    await h.pool.stop("sh3" as PatchbayAgentId);
  });

  it("a listed session the agent gave no title takes its first prompt's, like one made here (#80)", async () => {
    const first = harness();
    await first.pool.connect(spec({ declare: { ...LIST_CAPS, loadSession: true } }, "sh3u"));
    const made = await first.sessions.createSession("sh3u" as PatchbayAgentId, "Fake Agent", cwd);
    await first.gates.prompt(made, { text: "first" });
    const wireId = first.sessions.sessionIdOf(made)!;
    await first.pool.stop("sh3u" as PatchbayAgentId);

    // another window: the agent lists the session, with no title
    const h = harness();
    await h.pool.connect(spec({ declare: { ...LIST_CAPS, loadSession: true } }, "sh3u"));
    await h.sessions.syncAgentSessions("sh3u" as PatchbayAgentId);
    const listed = h.sessions.rowFor("sh3u" as PatchbayAgentId, wireId)!;
    expect(h.state().sessions.find((s) => s.id === listed)?.title).toBe("Untitled session");
    await h.gates.prompt(listed, { text: "name me after this" });
    expect(h.state().sessions.find((s) => s.id === listed)?.title).toBe("name me after this");
    await h.pool.stop("sh3u" as PatchbayAgentId);
  });

  it("session_info_update retitles live", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: LIST_CAPS, turn: [{ type: "infoUpdate", title: "agent named me" }] }, "sh4"),
    );
    const patchbaySessionId = await h.sessions.createSession("sh4" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "hello" });
    // noteInfoUpdate is fire-and-forget off the notification — settle it
    await new Promise((r) => setTimeout(r, 50));
    expect(h.state().sessions[0]?.title).toBe("agent named me");

    await h.pool.stop("sh4" as PatchbayAgentId);
  });

  it("resume rung: same session continues without replay, behind a seam notice", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { sessionCapabilities: { resume: {} } }, turn: [{ type: "chunk", text: "turn done" }] },
        "sh5",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sh5" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "first" });
    const before = h.state().transcripts[patchbaySessionId]!.length;
    expect(before).toBeGreaterThan(0);

    // the connection died from patchbay's perspective; the agent still has it
    h.sessions.invalidateAgent("sh5" as PatchbayAgentId);
    await h.gates.prompt(patchbaySessionId, { text: "second" });

    const state = h.state();
    // same id — a real continuation, not an emulated sibling
    expect(state.sessions.map((s) => s.id)).toEqual([patchbaySessionId]);
    const blocks = state.transcripts[patchbaySessionId]!;
    // cached view kept, seam notice marks where the unreplayed memory begins
    const noticeAt = blocks.findIndex((b) => b.kind === "notice");
    expect(noticeAt).toBeGreaterThanOrEqual(before);
    expect(blocks.filter((b) => b.kind === "user").map((b) => b.kind === "user" && userPartsText(b.parts))).toEqual([
      "first",
      "second",
    ]);
    expect(h.capabilityTracker.matrix("sh5" as PatchbayAgentId)?.["session.resume"]).toMatchObject({ declared: true, used: true });

    await h.pool.stop("sh5" as PatchbayAgentId);
  });

  it("opening a dead session hydrates via load replay — no prompt, no reload needed", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "remembered" }] }, "sh7"),
    );
    const patchbaySessionId = await h.sessions.createSession("sh7" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "first" });
    h.sessions.invalidateAgent("sh7" as PatchbayAgentId);
    const resetsBefore = h.events.filter((e) => e.kind === "transcriptReset").length;

    h.gates.activate(patchbaySessionId); // a click, nothing more
    const start = Date.now();
    while (h.events.filter((e) => e.kind === "transcriptReset").length === resetsBefore) {
      if (Date.now() - start > 3000) throw new Error("hydrate never replayed");
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 100)); // let the replay stream settle

    // The fake agent's durable record replays its own updates (its store
    // holds no user_message_chunk) — the agent prose coming back is the proof.
    const blocks = h.state().transcripts[patchbaySessionId]!;
    expect(blocks.some((b) => b.kind === "text" && b.text.includes("remembered"))).toBe(true);
    expect(h.sessions.isLive(patchbaySessionId)).toBe(true);

    await h.pool.stop("sh7" as PatchbayAgentId);
  });

  it("opening a session neither load nor resume can reach says so — a notice, never faked content", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "dead-1.jsonl"), "", "utf8");

    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "sh8")); // list only — no load, no resume
    await h.sessions.syncAgentSessions("sh8" as PatchbayAgentId);

    const dead = h.sessions.rowFor("sh8" as PatchbayAgentId, "dead-1")!;
    h.gates.activate(dead);
    const start = Date.now();
    while (!h.events.some((e) => e.kind === "transcriptSeeded" && e.patchbaySessionId === dead)) {
      if (Date.now() - start > 3000) throw new Error("notice never seeded");
      await new Promise((r) => setTimeout(r, 20));
    }
    const blocks = h.state().transcripts[dead]!;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind === "notice" && blocks[0].text).toContain("can't be reopened");
    expect(h.sessions.isLive(dead)).toBe(false);

    await h.pool.stop("sh8" as PatchbayAgentId);
  });

  it("opening a resume-only session attaches it, saying load isn't supported", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { sessionCapabilities: { resume: {} } }, turn: [{ type: "chunk", text: "ok" }] }, "sh9"),
    );
    const patchbaySessionId = await h.sessions.createSession("sh9" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "before" });
    h.sessions.invalidateAgent("sh9" as PatchbayAgentId);

    h.gates.activate(patchbaySessionId); // a click
    // The open's own end, not isLive: a rung claims the session before its
    // wire call, so isLive turns true while the resume is still in flight.
    const start = Date.now();
    while (attaching(h.state().sessions.find((s) => s.id === patchbaySessionId)!)) {
      if (Date.now() - start > 3000) throw new Error("open never resumed");
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(h.sessions.isLive(patchbaySessionId)).toBe(true);
    const blocks = h.state().transcripts[patchbaySessionId]!;
    const notice = blocks.find((b) => b.kind === "notice");
    expect(notice?.kind === "notice" && notice.text).toContain("doesn't support replaying history");
    // ready to prompt straight away — same session, context attached
    await h.gates.prompt(patchbaySessionId, { text: "after" });
    expect(h.state().sessions.map((s) => s.id)).toEqual([patchbaySessionId]);

    await h.pool.stop("sh9" as PatchbayAgentId);
  });

  it("release frees an attached session on the wire; the next open re-attaches", async () => {
    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { close: {} } }, turn: [{ type: "chunk", text: "x" }] },
        "sh10",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sh10" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "work" });

    await h.sessions.release(patchbaySessionId, "idle");
    expect(h.sessions.isLive(patchbaySessionId)).toBe(false);
    expect(h.capabilityTracker.matrix("sh10" as PatchbayAgentId)?.["session.close"]).toMatchObject({ declared: true, used: true });
    // the row survives — release frees resources, it never closes the chat
    expect(h.state().sessions.map((s) => s.id)).toEqual([patchbaySessionId]);

    h.gates.activate(patchbaySessionId);
    const start = Date.now();
    while (!h.sessions.isLive(patchbaySessionId)) {
      if (Date.now() - start > 3000) throw new Error("re-open never re-attached");
      await new Promise((r) => setTimeout(r, 20));
    }

    await h.pool.stop("sh10" as PatchbayAgentId);
  });

  it("release requires declared session/load — resume alone is not enough (no saved history to fall back on)", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ declare: { sessionCapabilities: { close: {}, resume: {} } } }, "sh11"),
    );
    const patchbaySessionId = await h.sessions.createSession("sh11" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "irreplaceable transcript" });

    // resume would bring back the context but not the visible history —
    // and patchbay persists none, so closing would destroy the only copy.
    await h.sessions.release(patchbaySessionId, "idle");
    expect(h.sessions.isLive(patchbaySessionId)).toBe(true);

    await h.pool.stop("sh11" as PatchbayAgentId);
  });

  it("the idle reaper releases idle sessions — but never the one open in the view", async () => {
    const h = harness({ idleCloseMs: 150 });
    await h.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { close: {} } }, turn: [{ type: "chunk", text: "x" }] },
        "sh12",
      ),
    );
    const idle = await h.sessions.createSession("sh12" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(idle, { text: "then silence" });
    const active = await h.sessions.createSession("sh12" as PatchbayAgentId, "Fake Agent", cwd); // activates itself
    await h.gates.prompt(active, { text: "also silent, but visible" });
    expect(h.state().activePatchbaySessionId).toBe(active);

    const start = Date.now();
    while (h.sessions.isLive(idle)) {
      if (Date.now() - start > 3000) throw new Error("reaper never fired");
      await new Promise((r) => setTimeout(r, 25));
    }
    // long past its own idle threshold, the visible session is still attached
    expect(h.sessions.isLive(active)).toBe(true);
    // the reaped row survives in the list — released, not closed
    expect(h.state().sessions.map((s) => s.id)).toEqual([idle, active]);

    h.gates.dispose();
    await h.pool.stop("sh12" as PatchbayAgentId);
  });

  it("the reaper spares a session holding words — held prompts are unfinished user work", async () => {
    let locked = false;
    const h = harness({ idleCloseMs: 150, authLocked: () => locked });
    await h.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { close: {} } }, turn: [{ type: "chunk", text: "x" }] },
        "smq5",
      ),
    );
    const victim = await h.sessions.createSession("smq5" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(victim, { text: "reapable" });
    const holding = await h.sessions.createSession("smq5" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(holding, { text: "prompted once" });
    locked = true;
    await h.gates.prompt(holding, { text: "held words" }); // auth-held row
    const active = await h.sessions.createSession("smq5" as PatchbayAgentId, "Fake Agent", cwd); // takes the view

    // the reaper proves it ran by releasing the queue-less idle session…
    const start = Date.now();
    while (h.sessions.isLive(victim)) {
      if (Date.now() - start > 3000) throw new Error("reaper never fired");
      await new Promise((r) => setTimeout(r, 25));
    }
    // …while the one holding words stays attached, words intact
    expect(h.sessions.isLive(holding)).toBe(true);
    expect(h.state().promptQueue[holding]).toMatchObject([{ text: "held words" }]);
    expect(h.state().sessions.map((s) => s.id)).toEqual([victim, holding, active]);

    h.gates.dispose();
    await h.pool.stop("smq5" as PatchbayAgentId);
  });

  it("the reaper never touches a still-new session — new sessions never close, period", async () => {
    const h = harness({ idleCloseMs: 100 });
    await h.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { close: {} } }, turn: [{ type: "chunk", text: "x" }] },
        "sh13",
      ),
    );
    const fresh = await h.sessions.createSession("sh13" as PatchbayAgentId, "Fake Agent", cwd);
    const active = await h.sessions.createSession("sh13" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(active, { text: "make this one the visible, prompted one" });
    expect(h.state().activePatchbaySessionId).toBe(active);

    // well past the idle threshold: the never-prompted session is untouched
    await new Promise((r) => setTimeout(r, 400));
    expect(h.sessions.isLive(fresh)).toBe(true);

    h.gates.dispose();
    await h.pool.stop("sh13" as PatchbayAgentId);
  });

  it("the reaper never closes under an unseen result — the blue mark blocks it", async () => {
    let unseenId: string | null = null;
    const h = harness({ idleCloseMs: 100, isUnseen: (id) => id === unseenId });
    await h.pool.connect(
      spec(
        { declare: { loadSession: true, sessionCapabilities: { close: {} } }, turn: [{ type: "chunk", text: "x" }] },
        "sh14",
      ),
    );
    const idle = await h.sessions.createSession("sh14" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(idle, { text: "finished while looking away" });
    unseenId = idle;
    const active = await h.sessions.createSession("sh14" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(active, { text: "the visible one" });

    await new Promise((r) => setTimeout(r, 400));
    expect(h.sessions.isLive(idle)).toBe(true); // blue mark holds it open

    unseenId = null; // the user looked — first reap after that may release it
    const start = Date.now();
    while (h.sessions.isLive(idle)) {
      if (Date.now() - start > 3000) throw new Error("reaper never fired after unseen cleared");
      await new Promise((r) => setTimeout(r, 25));
    }

    h.gates.dispose();
    await h.pool.stop("sh14" as PatchbayAgentId);
  });

  it("delete removes the session from the agent's own list where the agent declares it — no resurrection on resync", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "sh6"));

    const patchbaySessionId = await h.sessions.createSession("sh6" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "leave a durable record" });
    const sessionId = h.sessions.sessionIdOf(patchbaySessionId);
    expect((await h.pool.listSessions("sh6" as PatchbayAgentId, { cwd })).sessions.map((s) => s.sessionId)).toContain(sessionId);
    await h.gates.delete(patchbaySessionId);

    // the agent's own list must no longer report it — else the next sync
    // would resurrect a session the user asked to remove
    const listed = await h.pool.listSessions("sh6" as PatchbayAgentId, { cwd });
    expect(listed.sessions.map((s) => s.sessionId)).not.toContain(sessionId);
    await h.sessions.syncAgentSessions("sh6" as PatchbayAgentId);
    expect(h.state().sessions.map((s) => s.id)).not.toContain(patchbaySessionId);

    await h.pool.stop("sh6" as PatchbayAgentId);
  });

  it("close, where the agent lists its sessions: the session leaves the list and the agent frees it, patchbay keeps what it saved, and the next read brings it back", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    const h = harness({ continuityStore: store });
    const agent = "sh7" as PatchbayAgentId;
    await h.pool.connect(spec({ declare: { loadSession: true, sessionCapabilities: { list: {}, close: {} } } }, "sh7"));
    const patchbaySessionId = await h.sessions.createSession(agent, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "keep me" });
    h.sessions.saveDraft(patchbaySessionId, "half-typed thought");
    await h.sessions.addDroppedFile(patchbaySessionId, { chipId: "chip-1", name: "notes.txt", mimeType: "text/plain", base64: "aGk=" });
    const sessionId = h.sessions.sessionIdOf(patchbaySessionId)!;
    expect(h.pool.get(agent)?.sessions).toContain(sessionId);

    await h.gates.close(patchbaySessionId);

    expect(h.state().sessions.map((s) => s.id)).not.toContain(patchbaySessionId);
    expect(h.pool.get(agent)?.sessions).not.toContain(sessionId); // session/close freed the agent's side
    expect(store.read(agent, sessionId)?.draft).toBe("half-typed thought");
    expect(existsSync(h.files.dirOf(agent, sessionId, cwd))).toBe(true);
    // the agent still lists it: the next read of its history brings it back
    expect((await h.pool.listSessions(agent, { cwd })).sessions.map((s) => s.sessionId)).toContain(sessionId);
    await h.sessions.syncAgentSessions(agent);
    const back = h.sessions.rowFor(agent, sessionId)!;
    expect(back).toBeDefined();
    expect(h.state().drafts[back]).toBe("half-typed thought");
    await h.pool.stop(agent);
  });

  it("close is refused where the agent doesn't offer it — nothing of the session ends", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "sh7b"));
    const patchbaySessionId = await h.sessions.createSession("sh7b" as PatchbayAgentId, "Fake Agent", cwd);

    await expect(h.gates.close(patchbaySessionId)).rejects.toThrow(/doesn't offer session\/close/);
    expect(h.state().sessions.map((s) => s.id)).toContain(patchbaySessionId);
    expect(h.sessions.isLive(patchbaySessionId)).toBe(true);
    await h.pool.stop("sh7b" as PatchbayAgentId);
  });

  it("fork, where the agent declares it: a new session carrying the original's history and roots opens — the original stays as it is", async () => {
    const h = harness();
    const agent = "sf1" as PatchbayAgentId;
    await h.pool.connect(
      spec({ declare: { loadSession: true, sessionCapabilities: { fork: {}, list: {}, additionalDirectories: {} } }, turn: [{ type: "chunk", text: "an answer" }] }, "sf1"),
    );
    const original = await h.sessions.createSession(agent, "Fake Agent", cwd);
    await h.gates.addRoot(original, "/repo/extra");
    await h.gates.prompt(original, { text: "the first question" });
    const originalId = h.sessions.sessionIdOf(original);
    const before = h.state().transcripts[original];

    const forked = await h.gates.fork(original, "find foo");

    expect(forked).not.toBe(original);
    expect(h.sessions.sessionIdOf(forked)).toMatch(/-fork-/);
    expect(h.state().sessions.find((s) => s.id === forked)?.title).toBe("find foo (fork)");
    expect(h.state().activePatchbaySessionId).toBe(forked);
    expect(h.state().contextRoots[forked]).toEqual(["/repo/extra"]);
    // its earlier messages, read back from the agent
    const users = (h.state().transcripts[forked] ?? []).filter((b) => b.kind === "user");
    expect(users.map((b) => b.kind === "user" && userPartsText(b.parts))).toEqual(["the first question"]);
    // the original, untouched
    expect(h.sessions.sessionIdOf(original)).toBe(originalId);
    expect(h.state().transcripts[original]).toEqual(before);
    expect(h.pool.get(agent)?.sessions).toEqual(expect.arrayContaining([originalId, h.sessions.sessionIdOf(forked)]));
    await h.pool.stop(agent);
  });

  it("a fork keeps the link to its original — saved, and named to the original's row again after a later window's list read", async () => {
    const store = new SessionContinuityStore(new MemoryKV());
    const agent = "sf5" as PatchbayAgentId;
    const script: FakeAgentScript = {
      declare: { loadSession: true, sessionCapabilities: { fork: {}, list: {} } },
      turn: [{ type: "chunk", text: "an answer" }],
    };
    const h1 = harness({ continuityStore: store });
    await h1.pool.connect(spec(script, "sf5"));
    const original = await h1.sessions.createSession(agent, "Fake Agent", cwd);
    await h1.gates.prompt(original, { text: "the first question" });
    const forked = await h1.gates.fork(original, "first");
    expect(h1.state().sessions.find((s) => s.id === forked)?.forkedFrom).toBe(original);
    const originalId = h1.sessions.sessionIdOf(original)!;
    expect(store.read(agent, h1.sessions.sessionIdOf(forked)!)?.forkedFrom).toBe(originalId);
    const forkId = h1.sessions.sessionIdOf(forked)!;
    await h1.pool.stop(agent);

    // a later window: both rows minted again from the agent's own list
    const h2 = harness({ continuityStore: store });
    await h2.pool.connect(spec(script, "sf5"));
    await h2.sessions.syncAgentSessions(agent);
    const fork2 = h2.sessions.rowFor(agent, forkId)!;
    const original2 = h2.sessions.rowFor(agent, originalId)!;
    expect(h2.state().sessions.find((s) => s.id === fork2)?.forkedFrom).toBe(original2);
    expect(h2.state().sessions.find((s) => s.id === original2)?.forkedFrom).toBeUndefined();
    await h2.pool.stop(agent);
  });

  it("a fork waits for a running turn to end, and never ends it", async () => {
    const h = harness();
    const agent = "sf2" as PatchbayAgentId;
    await h.pool.connect(
      spec({ declare: { loadSession: true, sessionCapabilities: { fork: {} } }, turn: [{ type: "chunk", text: "a" }, { type: "chunk", text: "b" }], stepDelayMs: 150 }, "sf2"),
    );
    const original = await h.sessions.createSession(agent, "Fake Agent", cwd);
    const turn = h.gates.prompt(original, { text: "go" }).then(() => "finished", (err: unknown) => err);
    await new Promise((r) => setTimeout(r, 50)); // the turn is underway
    const forked = await h.gates.fork(original, "go");
    expect(await turn).toBe("finished");
    expect(h.state().sessions.map((s) => s.id)).toContain(forked);
    await h.pool.stop(agent);
  });

  it("a fork where the agent can't replay a session says so — patchbay copies no transcript", async () => {
    const h = harness();
    const agent = "sf3" as PatchbayAgentId;
    await h.pool.connect(spec({ declare: { sessionCapabilities: { fork: {} } }, turn: [{ type: "chunk", text: "x" }] }, "sf3"));
    const original = await h.sessions.createSession(agent, "Fake Agent", cwd);
    await h.gates.prompt(original, { text: "go" });
    const forked = await h.gates.fork(original, "go");
    const blocks = h.state().transcripts[forked] ?? [];
    expect(blocks.filter((b) => b.kind === "user")).toEqual([]);
    expect(blocks.some((b) => b.kind === "notice" && b.text.includes("can't replay a session"))).toBe(true);
    await h.pool.stop(agent);
  });

  it("fork is refused where the agent doesn't offer it — nothing moves", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: { sessionCapabilities: { list: {} } } }, "sf4"));
    const original = await h.sessions.createSession("sf4" as PatchbayAgentId, "Fake Agent", cwd);
    const sessionsBefore = h.state().sessions.length;
    await expect(h.gates.fork(original, "x")).rejects.toThrow(/doesn't offer session\/fork/);
    expect(h.state().sessions).toHaveLength(sessionsBefore);
    await h.pool.stop("sf4" as PatchbayAgentId);
  });

  it("delete is refused where the agent never offered it — nothing of the session ends", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: { sessionCapabilities: { list: {} } } }, "sh8"));
    const patchbaySessionId = await h.sessions.createSession("sh8" as PatchbayAgentId, "Fake Agent", cwd);

    await expect(h.gates.delete(patchbaySessionId)).rejects.toThrow(/doesn't offer session\/delete/);
    expect(h.state().sessions.map((s) => s.id)).toContain(patchbaySessionId);
    expect(h.sessions.isLive(patchbaySessionId)).toBe(true);
    await h.pool.stop("sh8" as PatchbayAgentId);
  });

  it("a delete that fails leaves the session where it was — the agent goes first", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "sh9"));
    const patchbaySessionId = await h.sessions.createSession("sh9" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "still mine" });
    await h.pool.stop("sh9" as PatchbayAgentId);

    // its agent is gone: the wire can't take the delete
    await expect(h.sessions.delete(patchbaySessionId)).rejects.toThrow();
    expect(h.state().sessions.map((s) => s.id)).toContain(patchbaySessionId);
    expect(h.sessions.sessionIdOf(patchbaySessionId)).toBeDefined();
  });

  it("close, where the agent lists no sessions: the session leaves, and session/close frees the agent's side", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: { sessionCapabilities: { close: {} } } }, "sh10"));
    const patchbaySessionId = await h.sessions.createSession("sh10" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "done here" });
    const sessionId = h.sessions.sessionIdOf(patchbaySessionId)!;
    expect(h.pool.get("sh10" as PatchbayAgentId)?.sessions).toContain(sessionId);

    await h.gates.close(patchbaySessionId);

    expect(h.state().sessions.map((s) => s.id)).not.toContain(patchbaySessionId);
    expect(h.pool.get("sh10" as PatchbayAgentId)?.sessions).not.toContain(sessionId);
    await h.pool.stop("sh10" as PatchbayAgentId);
  });
});

// ── the activity stamp has one home: the view's canonical row. The
// sessions-store reports evidence (prompt send, turn end, a wire stamp);
// the reducer judges (newest wins); the Settings tile projects it.
describe("session activity stamp — one home", () => {
  const LIST_CAPS = { sessionCapabilities: { list: {}, delete: {} } };
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  it("a wire row stamped yesterday, prompted today: active today — and a re-read cannot move it back", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "old-1.jsonl"), "", "utf8");

    const h = harness();
    await h.pool.connect(
      spec(
        { declare: { ...LIST_CAPS, loadSession: true }, listUpdatedAt: yesterday, turn: [{ type: "chunk", text: "hi" }] },
        "st1",
      ),
    );
    await h.sessions.syncAgentSessions("st1" as PatchbayAgentId);
    const old = h.sessions.rowFor("st1" as PatchbayAgentId, "old-1")!;
    const before = h.state().sessions.find((s) => s.id === old);
    expect(before?.updatedAt).toBe(yesterday);
    expect(sessionsActiveToday(h.state().sessions)).toBe(0);

    await h.gates.prompt(old, { text: "wake up" }); // attaches on demand, then prompts
    const prompted = h.state().sessions.find((s) => s.id === old)!;
    expect(prompted.updatedAt > yesterday).toBe(true);
    // creation-day counting would still say 0 here — the row was born yesterday
    expect(sessionsActiveToday(h.state().sessions)).toBe(1);

    // the wire still says yesterday; newest wins, in the one place it is judged
    await h.sessions.syncAgentSessions("st1" as PatchbayAgentId);
    expect(h.state().sessions.find((s) => s.id === old)!.updatedAt).toBe(prompted.updatedAt);

    await h.pool.stop("st1" as PatchbayAgentId);
  });

  it("a wire row without a stamp: the re-read says nothing, the row keeps its own", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS, turn: [{ type: "chunk", text: "hi" }] }, "st2"));
    const patchbaySessionId = await h.sessions.createSession("st2" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "go" });
    const after = h.state().sessions.find((s) => s.id === patchbaySessionId)!.updatedAt;

    const before = h.events.length;
    await h.sessions.syncAgentSessions("st2" as PatchbayAgentId);
    expect(h.state().sessions.find((s) => s.id === patchbaySessionId)!.updatedAt).toBe(after);
    // silence is no event at all — neither a second listing nor an empty refresh
    const during = h.events.slice(before);
    expect(during.some((e) => e.kind === "sessionListed" && e.session.id === patchbaySessionId)).toBe(false);
    expect(during.some((e) => e.kind === "sessionRefreshed" && e.patchbaySessionId === patchbaySessionId)).toBe(false);

    await h.pool.stop("st2" as PatchbayAgentId);
  });

  it("session_info_update with a null title and no stamp is a clear, not a rename — nothing moves", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "hi" }] }, "st2n"));
    const patchbaySessionId = await h.sessions.createSession("st2n" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "derive me" });
    const before = h.events.length;
    h.sessions.handleUpdate(
      "st2n" as PatchbayAgentId,
      h.sessions.sessionIdOf(patchbaySessionId)!,
      readUpdate({ sessionUpdate: "session_info_update", title: null }),
    );
    expect(h.events.slice(before).some((e) => e.kind === "sessionRefreshed")).toBe(false);
    expect(h.state().sessions.find((s) => s.id === patchbaySessionId)?.title).toBe("derive me");

    await h.pool.stop("st2n" as PatchbayAgentId);
  });

  it("walks coalesce per agent: a re-read asked mid-walk joins it — one session/list on the wire", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "st6"));
    const listSessions = vi.spyOn(h.pool, "listSessions");
    await Promise.all([h.sessions.syncAgentSessions("st6" as PatchbayAgentId), h.sessions.syncRunningAgents()]);
    expect(listSessions).toHaveBeenCalledTimes(1);
    // …and a later read walks again
    await h.sessions.syncRunningAgents();
    expect(listSessions).toHaveBeenCalledTimes(2);

    await h.pool.stop("st6" as PatchbayAgentId);
  });

  it("a wire list without titles leaves the derived title alone — the refresh carries no title", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS, turn: [{ type: "chunk", text: "hi" }] }, "st4"));
    const patchbaySessionId = await h.sessions.createSession("st4" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "derive me" });
    expect(h.state().sessions.find((s) => s.id === patchbaySessionId)?.title).toBe("derive me");

    const before = h.events.length;
    await h.sessions.syncAgentSessions("st4" as PatchbayAgentId);
    expect(h.state().sessions.find((s) => s.id === patchbaySessionId)?.title).toBe("derive me");
    // the wire said nothing about this row — no refresh rode at all
    expect(h.events.slice(before).some((e) => e.kind === "sessionRefreshed" && e.patchbaySessionId === patchbaySessionId)).toBe(false);

    await h.pool.stop("st4" as PatchbayAgentId);
  });

  it("a zero-turn re-mint keeps the session's title — the row stays, the store keeps no copy", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] }, "st5"));
    const patchbaySessionId = await h.sessions.createSession("st5" as PatchbayAgentId, "Fake Agent", cwd);
    const before = h.sessions.sessionIdOf(patchbaySessionId);
    // an agent-pushed title lands on the row only (session_info_update path)
    h.sessions.handleUpdate(
      "st5" as PatchbayAgentId,
      before!,
      readUpdate({ sessionUpdate: "session_info_update", title: "agent named me" }),
    );
    await vi.waitFor(() =>
      expect(h.state().sessions.find((s) => s.id === patchbaySessionId)?.title).toBe("agent named me"),
    );

    await h.gates.addRoot(patchbaySessionId, "/repo/backend");
    expect(h.sessions.sessionIdOf(patchbaySessionId)).not.toBe(before);
    expect(h.state().sessions.find((s) => s.id === patchbaySessionId)?.title).toBe("agent named me");

    await h.pool.stop("st5" as PatchbayAgentId);
  });

  it("syncRunningAgents re-reads every running list-capable agent — another window's session appears", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "st3"));
    await h.pool.connect(spec({}, "st3-nolist")); // no session/list: skipped, not an error
    await h.sessions.syncAgentSessions("st3" as PatchbayAgentId);
    expect(h.sessions.rowFor("st3" as PatchbayAgentId, "other-window-1")).toBeUndefined();

    // "another window" writes into the agent's own store after our connect
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "other-window-1.jsonl"), "", "utf8");
    await h.sessions.syncRunningAgents();
    const other = h.sessions.rowFor("st3" as PatchbayAgentId, "other-window-1");
    expect(other).toBeDefined();
    expect(h.state().sessions.some((s) => s.id === other)).toBe(true);

    await h.pool.stop("st3" as PatchbayAgentId);
    await h.pool.stop("st3-nolist" as PatchbayAgentId);
  });

  it("a list page naming a new session before its creation lands is that session — one row, the created one", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "st-cross"));
    // An agent that persists at creation can name the session in a list
    // page that overtakes the creation's own reply — replayed here at the
    // pool, between the reply's arrival and the store reading it.
    let listedFirst: string | undefined;
    const createOnWire = h.pool.newSession.bind(h.pool);
    vi.spyOn(h.pool, "newSession").mockImplementation(async (...args) => {
      const reply = await createOnWire(...args);
      vi.spyOn(h.pool, "listSessions").mockResolvedValueOnce({ sessions: [{ sessionId: reply.sessionId, cwd }], next: { kind: "end" } });
      await h.sessions.syncAgentSessions("st-cross" as PatchbayAgentId);
      listedFirst = h.state().sessions[0]?.id;
      return reply;
    });
    const patchbaySessionId = await h.sessions.createSession("st-cross" as PatchbayAgentId, "Fake Agent", cwd);

    expect(listedFirst).toBeDefined();
    expect(patchbaySessionId).not.toBe(listedFirst);
    expect(h.state().sessions.map((s) => s.id)).toEqual([patchbaySessionId]);
    expect(h.sessions.rowFor("st-cross" as PatchbayAgentId, h.sessions.sessionIdOf(patchbaySessionId)!)).toBe(patchbaySessionId);
    expect(h.state().activePatchbaySessionId).toBe(patchbaySessionId);
    await h.pool.stop("st-cross" as PatchbayAgentId);
  });

  it("two agents naming their sessions by one id are two rows — an id is only unique per agent", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".fake-agent-sessions"), { recursive: true });
    await writeFile(join(cwd, ".fake-agent-sessions", "same-1.jsonl"), "", "utf8");
    const h = harness();
    await h.pool.connect(spec({ declare: LIST_CAPS }, "twin-a"));
    await h.pool.connect(spec({ declare: LIST_CAPS }, "twin-b"));
    await h.sessions.syncAgentSessions("twin-a" as PatchbayAgentId);
    await h.sessions.syncAgentSessions("twin-b" as PatchbayAgentId);

    const a = h.sessions.rowFor("twin-a" as PatchbayAgentId, "same-1");
    const b = h.sessions.rowFor("twin-b" as PatchbayAgentId, "same-1");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    expect(h.state().sessions.find((s) => s.id === a)?.patchbayAgentId).toBe("twin-a");
    expect(h.state().sessions.find((s) => s.id === b)?.patchbayAgentId).toBe("twin-b");
    await h.pool.stop("twin-a" as PatchbayAgentId);
    await h.pool.stop("twin-b" as PatchbayAgentId);
  });
});

describe("context tokens — what the IPC socket admits (#72)", () => {
  /** An attach's composition that records each token it is handed, giving
   * one server through the bridge and one handed through. */
  function composer() {
    const minted: string[] = [];
    return {
      minted,
      mcpServersFor: async (contextToken: string) => {
        minted.push(contextToken);
        return {
          servers: [],
          given: [
            { id: "remote" as PatchbayMcpServerId, delivery: "bridge" as const },
            { id: "local" as PatchbayMcpServerId, delivery: "stdio" as const },
          ],
        };
      },
    };
  }
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("an attach's token is unguessable, admitted from the mint, and names its session once it has a row", async () => {
    const c = composer();
    const h = harness({ mcpServersFor: c.mcpServersFor });
    await h.pool.connect(spec({ newSessionReplyDelayMs: 200 }, "ct1"));
    const born = h.sessions.createSession("ct1" as PatchbayAgentId, "Fake Agent", cwd);
    await new Promise((r) => setTimeout(r, 80)); // session/new is on the wire
    const [token] = c.minted;
    expect(token).toMatch(UUID);
    // the agent may start the session's servers before it answers
    expect(h.sessions.admits(token!)).toBe(true);
    expect(h.sessions.sessionOfToken(token!)).toBeUndefined();
    const patchbaySessionId = await born;
    expect(h.sessions.sessionOfToken(token!)).toBe(patchbaySessionId);
    expect(h.sessions.tokensOf(patchbaySessionId)).toEqual([token]);
    expect(h.sessions.admits("ctx-1")).toBe(false);
    await h.pool.stop("ct1" as PatchbayAgentId);
  });

  it("a credential's bridge is the server's: only a server given through the bridge under that token names the agent", async () => {
    const c = composer();
    const h = harness({ mcpServersFor: c.mcpServersFor });
    await h.pool.connect(spec({}, "ct2"));
    await h.sessions.createSession("ct2" as PatchbayAgentId, "Fake Agent", cwd);
    const [token] = c.minted;
    expect(h.sessions.bridgedTo(token!, "remote" as PatchbayMcpServerId)).toBe("ct2");
    expect(h.sessions.bridgedTo(token!, "local" as PatchbayMcpServerId)).toBeUndefined(); // handed through: asks for nothing
    expect(h.sessions.bridgedTo(token!, "never-given" as PatchbayMcpServerId)).toBeUndefined();
    expect(h.sessions.bridgedTo("forged", "remote" as PatchbayMcpServerId)).toBeUndefined();
    await h.pool.stop("ct2" as PatchbayAgentId);
  });

  it("a token outlives its session's close while the connection is up, and ends with the connection", async () => {
    const c = composer();
    const h = harness({ mcpServersFor: c.mcpServersFor });
    await h.pool.connect(spec({ declare: { sessionCapabilities: { close: {} } } }, "ct3"));
    const patchbaySessionId = await h.sessions.createSession("ct3" as PatchbayAgentId, "Fake Agent", cwd);
    const [token] = c.minted;
    await h.gates.close(patchbaySessionId);
    // an agent that keeps one server for all its sessions still calls with
    // it — but the closed session has no roots or transcript to answer from
    expect(h.sessions.admits(token!)).toBe(true);
    expect(h.sessions.sessionOfToken(token!)).toBeUndefined();
    await h.pool.stop("ct3" as PatchbayAgentId);
    expect(h.sessions.admits(token!)).toBe(false);
  });

  it("every attach mints its own token, each naming the session; erase drops them all", async () => {
    const c = composer();
    const h = harness({ mcpServersFor: c.mcpServersFor });
    await h.pool.connect(spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "hi" }] }, "ct4"));
    const patchbaySessionId = await h.sessions.createSession("ct4" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "first" });
    await h.gates.reload(patchbaySessionId);
    expect(c.minted).toHaveLength(2);
    expect(new Set(c.minted).size).toBe(2);
    expect(h.sessions.tokensOf(patchbaySessionId).sort()).toEqual([...c.minted].sort());
    h.sessions.reset();
    expect(c.minted.some((t) => h.sessions.admits(t))).toBe(false);
    await h.pool.stop("ct4" as PatchbayAgentId);
  });
});

describe("a session's work enters behind its agent's", () => {
  /** A stand-in for the agents' queue: `hold` puts one operation on an
   * agent's row — a restart, say — that runs until the test finishes it. */
  function agentsQueue() {
    const line = new Queue<"restart">(() => {});
    return {
      settled: (patchbayAgentId: PatchbayAgentId) => line.settled(patchbayAgentId),
      hold(patchbayAgentId: PatchbayAgentId): { finish(): Promise<void> } {
        let end!: () => void;
        const running = new Promise<void>((started) => {
          void line.run(patchbayAgentId, "restart", () => new Promise<void>((r) => ((end = r), started())));
        });
        return { finish: () => running.then(() => end()) };
      },
    };
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a reload asked while the agent's row holds work runs after it — never against a connection being replaced", async () => {
    const agents = agentsQueue();
    const h = harness({ agentSettled: agents.settled });
    await h.pool.connect(spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "hi" }] }, "sw1"));
    const patchbaySessionId = await h.sessions.createSession("sw1" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "first" });
    const restart = agents.hold("sw1" as PatchbayAgentId);
    const reloaded = h.gates.reload(patchbaySessionId);
    await sleep(50);
    expect(h.events.some((e) => e.kind === "transcriptReset")).toBe(false);
    expect(h.state().sessions[0]!.busy).toEqual(["reload"]);
    await restart.finish();
    await reloaded;
    expect(h.events.some((e) => e.kind === "transcriptReset")).toBe(true);
    expect(h.state().sessions[0]!.busy).toEqual([]);
    await h.pool.stop("sw1" as PatchbayAgentId);
  });

  it("a prompt sent meanwhile is underway at once and reaches the wire after it; a close waits on nothing", async () => {
    const agents = agentsQueue();
    const h = harness({ agentSettled: agents.settled });
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "hi" }], declare: { sessionCapabilities: { close: {} } } }, "sw2"));
    const patchbaySessionId = await h.sessions.createSession("sw2" as PatchbayAgentId, "Fake Agent", cwd);
    const restart = agents.hold("sw2" as PatchbayAgentId);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    await sleep(50);
    expect(h.state().transcripts[patchbaySessionId]).toEqual([]);
    expect(h.state().sessions[0]!.busy).toEqual(["prompt"]);
    await restart.finish();
    await turn;
    expect(textOf(h.state().transcripts[patchbaySessionId]![1])).toBe("hi");

    const stuck = agents.hold("sw2" as PatchbayAgentId); // still running when the close comes
    await h.gates.close(patchbaySessionId);
    expect(h.state().sessions).toEqual([]);
    await stuck.finish();
    await h.pool.stop("sw2" as PatchbayAgentId);
  });

  it("an open while the agent's row holds work attaches once it is done", async () => {
    const agents = agentsQueue();
    const h = harness({ agentSettled: agents.settled });
    await h.pool.connect(spec({ declare: { loadSession: true }, turn: [{ type: "chunk", text: "hi" }] }, "sw3"));
    const patchbaySessionId = await h.sessions.createSession("sw3" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "first" });
    h.sessions.invalidateAgent("sw3" as PatchbayAgentId); // its sessions detach, as a restart's would
    const restart = agents.hold("sw3" as PatchbayAgentId);
    h.gates.activate(patchbaySessionId);
    await sleep(50);
    expect(h.sessions.isLive(patchbaySessionId)).toBe(false);
    expect(h.state().sessions[0]!.busy).toEqual(["open"]);
    await restart.finish();
    for (let i = 0; i < 100 && !h.sessions.isLive(patchbaySessionId); i++) await sleep(20);
    expect(h.sessions.isLive(patchbaySessionId)).toBe(true);
    await h.pool.stop("sw3" as PatchbayAgentId);
  });
});

describe("open — one ceremony for every entrance", () => {
  const LOAD: FakeAgentScript = { declare: { loadSession: true }, turn: [{ type: "chunk", text: "remembered" }] };

  async function untilLive(h: ReturnType<typeof harness>, patchbaySessionId: PatchbaySessionId): Promise<void> {
    const start = Date.now();
    while (!h.sessions.isLive(patchbaySessionId)) {
      if (Date.now() - start > 3000) throw new Error(`${patchbaySessionId} never attached`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("pinned open hydrates the session without moving the pointer, and asks for its agent", async () => {
    const asked: string[] = [];
    const pinned = new Set<string>();
    const h = harness({ pinned, onConnectForSession: (id) => asked.push(id) });
    await h.pool.connect(spec(LOAD, "op1"));
    const older = await h.sessions.createSession("op1" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(older, { text: "first" });
    const current = await h.sessions.createSession("op1" as PatchbayAgentId, "Fake Agent", cwd);
    expect(h.state().activePatchbaySessionId).toBe(current);
    h.sessions.invalidateAgent("op1" as PatchbayAgentId);

    pinned.add(older);
    h.gates.open(older, { pin: true }); // "Open in new window"
    await untilLive(h, older);
    expect(h.state().activePatchbaySessionId).toBe(current); // the sidebar didn't move
    expect(asked).toEqual([older]);

    await h.pool.stop("op1" as PatchbayAgentId);
  });

  it("plain open is a click: pointer, ladder, and the connect ask", async () => {
    const asked: string[] = [];
    const h = harness({ onConnectForSession: (id) => asked.push(id) });
    await h.pool.connect(spec(LOAD, "op2"));
    const patchbaySessionId = await h.sessions.createSession("op2" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "first" });
    h.sessions.invalidateAgent("op2" as PatchbayAgentId);

    h.gates.open(patchbaySessionId); // the palette pick, the drawer click
    await untilLive(h, patchbaySessionId);
    expect(h.state().activePatchbaySessionId).toBe(patchbaySessionId);
    expect(asked).toEqual([patchbaySessionId]);

    await h.pool.stop("op2" as PatchbayAgentId);
  });

  it("an agent coming up hydrates every session on view — pinned included, not only the pointer", async () => {
    const pinned = new Set<string>();
    const h = harness({ pinned });
    await h.pool.connect(spec(LOAD, "op3"));
    const shown = await h.sessions.createSession("op3" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(shown, { text: "first" });
    const other = await h.sessions.createSession("op3" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(other, { text: "second" });
    expect(h.state().activePatchbaySessionId).toBe(other);
    // The agent goes down; the pinned window opens while it's off — nothing
    // to attach to yet, so open can only ask for the connect.
    await h.pool.stop("op3" as PatchbayAgentId);
    h.sessions.invalidateAgent("op3" as PatchbayAgentId);
    pinned.add(shown);
    h.gates.open(shown, { pin: true });
    expect(h.sessions.isLive(shown)).toBe(false);

    await h.pool.connect(spec(LOAD, "op3"));
    await h.gates.reattachViewed("op3" as PatchbayAgentId); // what the status-running hook runs after its list sync
    expect(h.sessions.isLive(shown)).toBe(true); // pinned
    expect(h.sessions.isLive(other)).toBe(true); // the pointer
    expect(h.state().activePatchbaySessionId).toBe(other);

    await h.pool.stop("op3" as PatchbayAgentId);
  });
});

describe("chunk rendering honesty (G4/G10/G11)", () => {
  async function chunkHarness(patchbayAgentId: PatchbayAgentId) {
    const h = harness();
    await h.pool.connect(spec({ declare: {}, turn: [] }, patchbayAgentId));
    const patchbaySessionId = await h.sessions.createSession(patchbayAgentId, "Fake Agent", cwd);
    // the agent names its session its own way on the wire
    const sessionId = h.sessions.sessionIdOf(patchbaySessionId)!;
    const push = (update: Record<string, unknown>) => h.sessions.handleUpdate(patchbayAgentId, sessionId, readUpdate(update));
    return { h, patchbaySessionId, handle: sessionId, push, blocks: () => h.state().transcripts[patchbaySessionId] ?? [] };
  }

  it("an update from a different agent under the same session id is dropped — ids are only unique per connection", async () => {
    const { h, handle: sessionId, push, blocks } = await chunkHarness("ch-owner" as PatchbayAgentId);
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "mine" } });
    expect(blocks()).toHaveLength(1);
    // Same agent id string, different agent: spec-legal collision — must
    // never write into this transcript.
    h.sessions.handleUpdate(
      "intruder" as PatchbayAgentId,
      sessionId,
      readUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "not mine" } }),
    );
    expect(blocks()).toHaveLength(1);
    await h.pool.stop("ch-owner" as PatchbayAgentId);
  });

  it("a failed turn says why on its turn line — the error's data included (#80)", async () => {
    const h = harness();
    await h.pool.connect(spec({ promptError: { code: -32603, message: "Internal error", data: { details: "process exited with code 1" } } }, "ch-err"));
    const patchbaySessionId = await h.sessions.createSession("ch-err" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "go" }).catch(() => {});
    const end = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "turnEnd");
    expect(end).toMatchObject({ stopReason: "error", error: "Internal error — process exited with code 1" });
    await h.pool.stop("ch-err" as PatchbayAgentId);
  });

  it("an update without a status leaves the call's status as it was; one for a call never announced is pending (#80)", async () => {
    const { h, push, blocks } = await chunkHarness("ch-status" as PatchbayAgentId);
    push({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Run", kind: "execute", status: "in_progress" });
    // progress only — input streaming in, output arriving: still running
    push({ sessionUpdate: "tool_call_update", toolCallId: "t1", rawInput: { command: "ls" } });
    push({ sessionUpdate: "tool_call_update", toolCallId: "t1", rawOutput: "a\nb" });
    expect(blocks()[0]).toMatchObject({ kind: "toolCall", status: "in_progress", title: "Run", toolKind: "execute", output: "a\nb" });
    push({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    expect(blocks()[0]).toMatchObject({ status: "completed" });
    push({ sessionUpdate: "tool_call_update", toolCallId: "never-announced", title: "Late" });
    expect(blocks()[1]).toMatchObject({ kind: "toolCall", title: "Late", status: "pending", toolKind: "other" });
    await h.pool.stop("ch-status" as PatchbayAgentId);
  });

  it("a command the agent runs itself fills a terminal inside its card, from the call's _meta (#80)", async () => {
    const { h, push, blocks } = await chunkHarness("ch-term" as PatchbayAgentId);
    push({ sessionUpdate: "tool_call", toolCallId: "c1", title: "npm test", kind: "execute", status: "in_progress", content: [{ type: "terminal", terminalId: "c1" }] });
    push({ sessionUpdate: "tool_call_update", toolCallId: "c1", _meta: { terminal_output_delta: { terminal_id: "c1", data: "running…\n" } } });
    push({ sessionUpdate: "tool_call_update", toolCallId: "c1", _meta: { terminal_output_delta: { terminal_id: "c1", data: "1 passed\n" } } });
    const live = blocks().find((b) => b.kind === "terminal");
    expect(live).toMatchObject({ id: "term-block-c1", command: "npm test", output: "running…\n1 passed\n", running: true });
    push({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", _meta: { terminal_exit: { terminal_id: "c1", exit_code: 0, signal: null } } });
    expect(blocks().find((b) => b.kind === "terminal")).toMatchObject({ running: false, exitCode: 0 });
    // the card still embeds it by the agent's id — no ghost line
    expect(blocks().find((b) => b.kind === "toolCall")).toMatchObject({ content: [{ kind: "terminal", terminalId: "c1" }] });
    await h.pool.stop("ch-term" as PatchbayAgentId);
  });

  it("what the agent addresses to the model alone is its own part, never woven into its prose (#80)", async () => {
    const { h, push, blocks } = await chunkHarness("ch-model" as PatchbayAgentId);
    push({ sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "Here is the plan. " } });
    push({ sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "context dump", annotations: { audience: ["assistant"] } } });
    push({ sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "Done.", annotations: { audience: ["user", "assistant"] } } });
    push({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read",
      content: [{ type: "content", content: { type: "text", text: "raw for the model", annotations: { audience: ["assistant"] } } }],
    });
    expect(blocks().map((b) => b.kind)).toEqual(["text", "agentPart", "text", "toolCall"]);
    expect(blocks()[1]).toMatchObject({ part: { kind: "text", text: "context dump", forModel: true } });
    expect(textOf(blocks()[2])).toBe("Done.");
    expect(blocks()[3]).toMatchObject({ content: [{ kind: "text", text: "raw for the model", forModel: true }] });
    await h.pool.stop("ch-model" as PatchbayAgentId);
  });

  it("a link in an agent's message stays one link — brackets in its name, spaces in its target", async () => {
    const { h, push, blocks } = await chunkHarness("ch-link" as PatchbayAgentId);
    push({ sessionUpdate: "agent_message_chunk", content: { type: "resource_link", name: "notes [draft].md", uri: "file:///w/my notes (1).md" } });
    expect(textOf(blocks()[0])).toBe("[notes \\[draft\\].md](<file:///w/my notes (1).md>)");
    await h.pool.stop("ch-link" as PatchbayAgentId);
  });

  it("replayed image and embedded-resource chunks land as structured parts in the SAME bubble", async () => {
    const { h, push, blocks } = await chunkHarness("ch-parts" as PatchbayAgentId);
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "see " }, messageId: "m1" });
    push({ sessionUpdate: "user_message_chunk", content: { type: "image", data: png, mimeType: "image/png" }, messageId: "m1" });
    push({
      sessionUpdate: "user_message_chunk",
      content: { type: "resource", resource: { uri: "file:///ws/ctx.ts", text: "const c = 1;" } },
      messageId: "m1",
    });
    push({ sessionUpdate: "user_message_chunk", content: { type: "audio", data: "x", mimeType: "audio/wav" }, messageId: "m1" });
    expect(blocks()).toHaveLength(1);
    const user = blocks()[0]!;
    expect(user.kind).toBe("user");
    const parts = user.kind === "user" ? user.parts : [];
    expect(parts[0]).toEqual({ kind: "text", text: "see " });
    expect(parts[1]).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect((parts[1] as { file?: string }).file).toMatch(/\.png$/);
    expect(parts[2]).toEqual({ kind: "context", label: "file:///ws/ctx.ts", text: "const c = 1;" });
    expect(parts[3]).toEqual({ kind: "unrendered", type: "audio" });
    await h.pool.stop("ch-parts" as PatchbayAgentId);
  });

  it("live chips ride the sent bubble as parts — image, attachment, context, then prose", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "chunk", text: "ok" }] }, "sm-parts"));
    const patchbaySessionId = await h.sessions.createSession("sm-parts" as PatchbayAgentId, "Fake Agent", cwd);
    await h.sessions.addContext(patchbaySessionId, {
      id: "img-1",
      kind: "image",
      label: "pasted image",
      content: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
      mimeType: "image/png",
    });
    await h.sessions.addContext(patchbaySessionId, {
      id: "att-1",
      kind: "attachment",
      label: "notes.md",
      path: "/ws/notes.md",
    });
    await h.sessions.addContext(patchbaySessionId, {
      id: "sel-1",
      kind: "selection",
      label: "Selection: a.ts:1-2",
      content: "const x = 1;",
    });
    await h.gates.prompt(patchbaySessionId, { text: "what is this?" });
    const user = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "user");
    expect(user?.kind === "user" && user.parts).toEqual([
      { kind: "image", mimeType: "image/png", file: "img-1.png" },
      { kind: "attachment", name: "notes.md", path: "/ws/notes.md" },
      { kind: "context", label: "Selection: a.ts:1-2", text: "const x = 1;" },
      { kind: "text", text: "what is this?" },
    ]);
    await h.pool.stop("sm-parts" as PatchbayAgentId);
  });

  it("whitespace-only chunks never open a run — no blank Thought accordion (G11)", async () => {
    const { h, push, blocks } = await chunkHarness("ch1" as PatchbayAgentId);
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" } });
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "\n\n  " } });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } });
    expect(blocks()).toEqual([]);
    // …but an open run still takes mid-stream whitespace: real spacing
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "part one" } });
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "\n\n" } });
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "part two" } });
    expect(blocks()).toHaveLength(1);
    expect(textOf(blocks()[0])).toBe("part one\n\npart two");
    // and a no-op chunk must not sever a neighboring prose run
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer " } });
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" } });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continues" } });
    expect(blocks()).toHaveLength(2);
    expect(textOf(blocks()[1])).toBe("answer continues");
    await h.pool.stop("ch1" as PatchbayAgentId);
  });

  it("non-text thought content is never a silent drop: it renders as a part that stays a thought (G11, #45)", async () => {
    const { h, push, blocks } = await chunkHarness("ch2" as PatchbayAgentId);
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "image", data: "x", mimeType: "image/png" } });
    expect(blocks()).toHaveLength(1);
    expect(blocks()[0]).toMatchObject({ kind: "agentPart", thought: true, part: { kind: "image", mimeType: "image/png" } });
    await h.pool.stop("ch2" as PatchbayAgentId);
  });

  it("agent prose rides the wire-extension rewriter: a chunk-split vendor wrapper lands as fence attributes", async () => {
    // The rewrite itself is gated in augment-code-snippet.test.ts; this
    // locks the DOOR — deltas route through the run's rewriter (split
    // anywhere), and sealRun flushes a withheld tail when a tool call
    // interrupts the run instead of letting it vanish.
    const { h, push, blocks } = await chunkHarness("ch7" as PatchbayAgentId);
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Look:\n\n<augment_code_sni" } });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: 'ppet path="a.ts" mode="EXCERPT">\n```ts\n1\n' } });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "```\n</augment_code_snippet>" } });
    expect(textOf(blocks()[0])).toBe('Look:\n\n```ts path="a.ts" excerpt\n1\n```\n');
    // a tail the rewriter is still withholding when prose is interrupted:
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\ntail <augment_code" } });
    expect(textOf(blocks()[0])).toBe('Look:\n\n```ts path="a.ts" excerpt\n1\n```\n\n\ntail ');
    push({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read", status: "pending" });
    expect(textOf(blocks()[0])).toBe('Look:\n\n```ts path="a.ts" excerpt\n1\n```\n\n\ntail <augment_code');
    await h.pool.stop("ch7" as PatchbayAgentId);
  });

  it("a replayed user resource_link mention merges INTO the prompt bubble as @name (G10b)", async () => {
    // Parts of one message share a messageId on the wire (verified:
    // claude-agent-acp replays composer positional parts under one id).
    const { h, push, blocks } = await chunkHarness("ch3" as PatchbayAgentId);
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "please read " }, messageId: "m1" });
    push({
      sessionUpdate: "user_message_chunk",
      content: { type: "resource_link", uri: "file:///ws/a.ts", name: "a.ts" },
      messageId: "m1",
    });
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: " and fix it" }, messageId: "m1" });
    expect(blocks()).toHaveLength(1);
    // One wire message, one bubble: the mention is its own structured part
    // between the merged prose spans.
    expect(blocks()[0]).toMatchObject({
      kind: "user",
      parts: [
        { kind: "text", text: "please read " },
        { kind: "mention", name: "a.ts", uri: "file:///ws/a.ts" },
        { kind: "text", text: " and fix it" },
      ],
    });
    await h.pool.stop("ch3" as PatchbayAgentId);
  });

  it("a messageId change splits adjacent user messages — cancelled turns never fuse", async () => {
    // The cancelled-turn shape: two prompts with nothing between them (the
    // turn produced no output). Claude additionally interleaves its own
    // interruption marker as a separate message — the marker is a turn
    // fact, never a bubble (outside a replay window it adds nothing: the
    // live turn's own turnEnded already said cancelled).
    const { h, push, blocks } = await chunkHarness("ch5" as PatchbayAgentId);
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "in this starting" }, messageId: "m1" });
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "[Request interrupted by user]" }, messageId: "m2" });
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "again?" }, messageId: "m3" });
    expect(blocks()).toHaveLength(2);
    expect(blocks()[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "in this starting" }] });
    expect(blocks()[1]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "again?" }] });
    await h.pool.stop("ch5" as PatchbayAgentId);
  });

  it("a replayed interruption marker closes its turn as cancelled — the chip, not the raw text", async () => {
    // Live cancel shows the real turnEnded's "cancelled" line; the marker
    // the agent stores instead must replay to the same rendering (live
    // cancel and its later replay render identically).
    const h = harness();
    await h.pool.connect(
      spec(
        {
          declare: { loadSession: true },
          // the agent echoes the marker as its own user-role message during
          // the turn — dropped live (inFlight), durably recorded for replay
          turn: [{ type: "userEcho", text: "[Request interrupted by user]" }],
        },
        "sm-int",
      ),
    );
    const patchbaySessionId = await h.sessions.createSession("sm-int" as PatchbayAgentId, "Fake Agent", cwd);
    await h.gates.prompt(patchbaySessionId, { text: "do the thing" });

    await h.pool.restart("sm-int" as PatchbayAgentId);
    await h.gates.reload(patchbaySessionId);

    const blocks = h.state().transcripts[patchbaySessionId]!;
    // prompt bubble, then the cancelled boundary — the marker text nowhere
    expect(blocks[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "do the thing" }] });
    expect(blocks[1]).toMatchObject({ kind: "turnEnd", stopReason: "cancelled", startedAt: null });
    expect(
      blocks.some(
        (b) => b.kind === "user" && b.parts.some((p) => p.kind === "text" && p.text.includes("interrupted")),
      ),
    ).toBe(false);
    await h.pool.stop("sm-int" as PatchbayAgentId);
  });

  it("id-less user chunks never merge — one bubble per message (auggie shape)", async () => {
    // Agents that omit messageId replay whole messages per chunk; merging
    // them fused adjacent cancelled prompts into one bubble.
    const { h, push, blocks } = await chunkHarness("ch6" as PatchbayAgentId);
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "still same?" } });
    push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "?" } });
    expect(blocks()).toHaveLength(2);
    expect(blocks()[0]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "still same?" }] });
    expect(blocks()[1]).toMatchObject({ kind: "user", parts: [{ kind: "text", text: "?" }] });
    await h.pool.stop("ch6" as PatchbayAgentId);
  });

  it("a messageId change splits adjacent agent messages — a closing fence never glues to the next heading", async () => {
    // The mermaid-corruption shape: message N ends with ``` (no trailing
    // newline — models end fenced blocks at the fence), message N+1 opens
    // with a heading. Fused into one block, the glued ```## line un-closes
    // the fence and the code block swallows the following prose.
    const { h, push, blocks } = await chunkHarness("ch7" as PatchbayAgentId);
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "```mermaid\nflowchart TD\n" }, messageId: "a1" });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A --> B\n```" }, messageId: "a1" });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "## 4. Next section" }, messageId: "a2" });
    expect(blocks()).toHaveLength(2);
    expect(textOf(blocks()[0])).toBe("```mermaid\nflowchart TD\nA --> B\n```");
    expect(textOf(blocks()[1])).toBe("## 4. Next section");
    await h.pool.stop("ch7" as PatchbayAgentId);
  });

  it("a messageId change splits adjacent thought messages the same way", async () => {
    const { h, push, blocks } = await chunkHarness("ch8" as PatchbayAgentId);
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "first thought" }, messageId: "t1" });
    push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "second thought" }, messageId: "t2" });
    expect(blocks()).toHaveLength(2);
    expect(textOf(blocks()[0])).toBe("first thought");
    expect(textOf(blocks()[1])).toBe("second thought");
    await h.pool.stop("ch8" as PatchbayAgentId);
  });

  it("id-less agent chunks keep merging — no boundary on the wire means no guessed split", async () => {
    // Live they're stream deltas; replayed they may lawfully be the recorded
    // chunk log played back. Splitting on a guess shreds prose mid-fence —
    // only a proven messageId change splits (runBlockFor).
    const { h, push, blocks } = await chunkHarness("ch9" as PatchbayAgentId);
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one " } });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "message" } });
    expect(blocks()).toHaveLength(1);
    expect(textOf(blocks()[0])).toBe("one message");
    // …and an id arriving mid-run pins the run: the next id change splits
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " with id" }, messageId: "a1" });
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new message" }, messageId: "a2" });
    expect(blocks()).toHaveLength(2);
    expect(textOf(blocks()[0])).toBe("one message with id");
    expect(textOf(blocks()[1])).toBe("new message");
    await h.pool.stop("ch9" as PatchbayAgentId);
  });

  it("an agent resource_link renders as a markdown link in the prose run (G10b)", async () => {
    const { h, push, blocks } = await chunkHarness("ch4" as PatchbayAgentId);
    push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "see " } });
    push({
      sessionUpdate: "agent_message_chunk",
      content: { type: "resource_link", uri: "file:///ws/b.ts", name: "b.ts" },
    });
    expect(blocks()).toHaveLength(1);
    expect(textOf(blocks()[0])).toBe("see [b.ts](file:///ws/b.ts)");
    await h.pool.stop("ch4" as PatchbayAgentId);
  });
});

describe("harnessEnvelopeTag — injected user-role envelope classification", () => {
  it("matches a single harness envelope (nested foreign tags included)", () => {
    const text =
      "<task-notification>\n<task-id>abc</task-id>\n<output-file>/tmp/x.output</output-file>\n<result>done</result>\n</task-notification>";
    expect(harnessEnvelopeTag(text)).toBe("task-notification");
  });

  it("matches a sequence of sibling envelopes (slash-command echo shape)", () => {
    const text =
      '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>\n<local-command-stdout>Set model</local-command-stdout>';
    expect(harnessEnvelopeTag(text)).toBe("command-name");
  });

  it("matches system-reminder with surrounding whitespace and self-closing elements", () => {
    expect(harnessEnvelopeTag("  <system-reminder>context</system-reminder>\n")).toBe("system-reminder");
    expect(harnessEnvelopeTag("<command-args/>")).toBe("command-args");
  });

  it("rejects anything a human plausibly typed — conservative by design", () => {
    expect(harnessEnvelopeTag("fix the login bug")).toBeNull();
    expect(harnessEnvelopeTag("what does <b>bold</b> mean here, in this html?")).toBeNull();
    expect(harnessEnvelopeTag("<div>some pasted html</div> plus my question")).toBeNull();
    expect(harnessEnvelopeTag("<unclosed>never ends")).toBeNull();
    expect(harnessEnvelopeTag("")).toBeNull();
  });
});

// ── a session's files live with it (#78): what the user gives a session —
// a pasted image, a dropped file — sits in the session's own folder on
// patchbay's disk, not the OS temp directory, and leaves with the session.
describe("a session's files live with the session", () => {
  const PNG = Buffer.from("fake-png-bytes").toString("base64");
  /** Folder removals are fire-and-forget from the store's operations. */
  const gone = async (path: string) => {
    for (let i = 0; i < 100 && existsSync(path); i++) await new Promise((r) => setTimeout(r, 10));
    return !existsSync(path);
  };
  const echoedKinds = (h: ReturnType<typeof harness>, patchbaySessionId: PatchbaySessionId) => {
    const echoed = h.state().transcripts[patchbaySessionId]!.find((b) => b.kind === "text");
    return JSON.parse(echoed?.kind === "text" ? echoed.text : "[]") as Array<Record<string, string>>;
  };

  it("a staged image is sent from the session's folder — a temp cleanup meanwhile costs only its preview", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: { promptCapabilities: { image: true } }, turn: [{ type: "echoBlockKinds" }] }, "f78a"));
    const patchbaySessionId = await h.sessions.createSession("f78a" as PatchbayAgentId, "Fake Agent", cwd);
    const chipId = `chip-f78a-${Date.now()}`;
    await h.sessions.addContext(patchbaySessionId, { id: chipId, kind: "image", label: "Image", content: PNG, mimeType: "image/png" });
    // the OS empties its temp directory while the chip waits
    await rm(join(ATTACHMENTS_DIR, imageFileName(chipId, "image/png")), { force: true });

    await h.gates.prompt(patchbaySessionId, { text: "what is this?" });
    expect(echoedKinds(h, patchbaySessionId)).toEqual([{ type: "image", mimeType: "image/png" }, { type: "text" }]);
    await h.pool.stop("f78a" as PatchbayAgentId);
  });

  it("an image an agent takes only as a link points at the session's own copy, which outlives the turn", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "echoBlockKinds" }] }, "f78b"));
    const patchbaySessionId = await h.sessions.createSession("f78b" as PatchbayAgentId, "Fake Agent", cwd);
    await h.sessions.addContext(patchbaySessionId, { id: "chip-f78b", kind: "image", label: "Image", content: PNG, mimeType: "image/png" });
    const path = join(h.files.dirOf("f78b" as PatchbayAgentId, h.sessions.sessionIdOf(patchbaySessionId)!, cwd), "chip-f78b.png");

    await h.gates.prompt(patchbaySessionId, { text: "look" });
    expect(echoedKinds(h, patchbaySessionId)[0]).toMatchObject({ type: "resource_link", uri: pathToFileURL(path).toString() });
    expect(existsSync(path)).toBe(true);
    await h.pool.stop("f78b" as PatchbayAgentId);
  });

  it("a dropped file lands in the session's folder, and its chip links it there", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "echoBlockKinds" }] }, "f78c"));
    const patchbaySessionId = await h.sessions.createSession("f78c" as PatchbayAgentId, "Fake Agent", cwd);
    await h.sessions.addDroppedFile(patchbaySessionId, {
      chipId: "chip-f78c",
      name: "my notes.txt",
      mimeType: "text/plain",
      base64: Buffer.from("notes").toString("base64"),
    });
    const path = join(h.files.dirOf("f78c" as PatchbayAgentId, h.sessions.sessionIdOf(patchbaySessionId)!, cwd), "chip-f78c-my_notes.txt");
    expect(await readFile(path, "utf8")).toBe("notes");
    expect(h.state().contextChips[patchbaySessionId]).toEqual([
      { id: "chip-f78c", kind: "attachment", label: "File: my notes.txt", path, mimeType: "text/plain" },
    ]);

    await h.gates.prompt(patchbaySessionId, { text: "read it" });
    expect(echoedKinds(h, patchbaySessionId)[0]).toMatchObject({ type: "resource_link", uri: pathToFileURL(path).toString() });
    await h.pool.stop("f78c" as PatchbayAgentId);
  });

  it("the folder leaves with its session — deleted, or its agent removed — and stays through a close", async () => {
    const h = harness();
    const agent = "f78d" as PatchbayAgentId;
    await h.pool.connect(spec({ turn: [{ type: "echoBlockKinds" }], declare: { sessionCapabilities: { list: {}, delete: {}, close: {} } } }, "f78d"));
    const deleted = await h.sessions.createSession(agent, "Fake Agent", cwd);
    const closed = await h.sessions.createSession(agent, "Fake Agent", cwd);
    const removed = await h.sessions.createSession(agent, "Fake Agent", cwd);
    const folderOf = (patchbaySessionId: PatchbaySessionId) => h.files.dirOf(agent, h.sessions.sessionIdOf(patchbaySessionId)!, cwd);
    for (const patchbaySessionId of [deleted, closed, removed]) {
      await h.sessions.addContext(patchbaySessionId, { id: `chip-${patchbaySessionId}`, kind: "image", label: "Image", content: PNG, mimeType: "image/png" });
    }
    await h.gates.prompt(deleted, { text: "a record the agent keeps" }); // the agent deletes what it stored
    const [deletedFolder, closedFolder, removedFolder] = [deleted, closed, removed].map(folderOf);

    await h.gates.delete(deleted);
    expect(await gone(deletedFolder!)).toBe(true);
    await h.gates.close(closed);
    expect(existsSync(closedFolder!)).toBe(true);
    expect(existsSync(removedFolder!)).toBe(true);

    h.sessions.forgetAgentSessions(agent);
    expect(await gone(removedFolder!)).toBe(true);
    expect(await gone(closedFolder!)).toBe(true);
    await h.pool.stop(agent);
  });

  it("a session gone from its agent's list loses its folder at the walk — even one no window held", async () => {
    const h = harness();
    await h.pool.connect(spec({ declare: { sessionCapabilities: { list: {} } } }, "f78e"));
    // a session the agent no longer has, whose folder an earlier window left
    const stray = await h.files.put("f78e" as PatchbayAgentId, "deleted-elsewhere", cwd, "chip.png", PNG);
    const kept = await h.sessions.createSession("f78e" as PatchbayAgentId, "Fake Agent", cwd);
    await h.sessions.addContext(kept, { id: "chip-f78e", kind: "image", label: "Image", content: PNG, mimeType: "image/png" });

    await h.sessions.syncAgentSessions("f78e" as PatchbayAgentId);
    expect(await gone(stray)).toBe(true);
    expect(existsSync(join(h.files.dirOf("f78e" as PatchbayAgentId, h.sessions.sessionIdOf(kept)!, cwd), "chip-f78e.png"))).toBe(true);
    await h.pool.stop("f78e" as PatchbayAgentId);
  });

  it("a never-prompted session minted again keeps its staged file, now under its new id", async () => {
    const continuity = new SessionContinuityStore(new MemoryKV());
    const h = harness({ continuityStore: continuity });
    await h.pool.connect(spec({ declare: ROOTS_CAPS, turn: [{ type: "echoRoots" }] }, "f78f"));
    const patchbaySessionId = await h.sessions.createSession("f78f" as PatchbayAgentId, "Fake Agent", cwd);
    const before = h.sessions.sessionIdOf(patchbaySessionId)!;
    await h.sessions.addContext(patchbaySessionId, { id: "chip-f78f", kind: "image", label: "Image", content: PNG, mimeType: "image/png" });

    await h.gates.addRoot(patchbaySessionId, "/repo/backend"); // a zero-turn session takes new roots by a fresh mint
    const after = h.sessions.sessionIdOf(patchbaySessionId)!;
    expect(after).not.toBe(before);
    const path = join(h.files.dirOf("f78f" as PatchbayAgentId, after, cwd), "chip-f78f.png");
    expect(continuity.read("f78f" as PatchbayAgentId, after)?.chips).toEqual([
      { kind: "image", id: "chip-f78f", label: "Image", mimeType: "image/png", path },
    ]);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(h.files.dirOf("f78f" as PatchbayAgentId, before, cwd))).toBe(false);
    await h.pool.stop("f78f" as PatchbayAgentId);
  });
});
