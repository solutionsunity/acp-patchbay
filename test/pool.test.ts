// P2 gate: pool against the fake agent — connect, capture declared,
// crash → visible → one-action restart, two concurrent sessions on one connection.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import type { AgentStatus, DeclaredCapabilities } from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { stubFsTerminalHooks } from "./support/stub-hooks";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "patchbay-pool-"));
});
afterAll(() => rm(cwd, { recursive: true, force: true }));

interface Recorded {
  statuses: Array<{ status: AgentStatus; detail?: string }>;
  declared: DeclaredCapabilities[];
  updates: SessionNotification[];
}

function makePool(): { pool: AgentPool; rec: Recorded } {
  const rec: Recorded = { statuses: [], declared: [], updates: [] };
  const pool = new AgentPool({
    onStatusChanged: (_id, status, detail) => rec.statuses.push({ status, detail }),
    onDeclaredCaptured: (_id, declared) => rec.declared.push(declared),
    onSessionUpdate: (_id, n) => rec.updates.push(n),
    ...stubFsTerminalHooks(),
  });
  return { pool, rec };
}

function spec(script: FakeAgentScript, agentId = "fake"): LaunchSpec {
  return {
    agentId,
    name: "Fake Agent",
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    cwd,
  };
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("AgentPool", () => {
  it("connects and captures the declared table from initialize", async () => {
    const { pool, rec } = makePool();
    const declared = await pool.connect(
      spec({
        declare: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          mcpCapabilities: { http: true },
          sessionCapabilities: { fork: {} },
        },
      }),
    );

    expect(declared.loadSession).toBe(true);
    expect(declared.promptImage).toBe(true);
    expect(declared.promptAudio).toBe(false);
    expect(declared.promptEmbeddedContext).toBe(true);
    expect(declared.mcpHttp).toBe(true);
    expect(declared.mcpSse).toBe(false);
    expect(declared.sessionFork).toBe(true);
    expect(declared.sessionResume).toBe(false);
    expect(rec.declared).toHaveLength(1);
    expect(pool.get("fake")?.status).toBe("running");
    expect(rec.statuses.map((s) => s.status)).toEqual(["reconnecting", "running"]);

    await pool.stop("fake");
    expect(pool.get("fake")?.status).toBe("stopped");
  });

  it("streams a scripted turn and completes with end_turn", async () => {
    const { pool, rec } = makePool();
    await pool.connect(
      spec({
        turn: [
          { type: "chunk", text: "part one " },
          { type: "chunk", text: "part two" },
        ],
      }),
    );
    const { sessionId } = await pool.newSession("fake", cwd);
    const response = await pool.prompt("fake", sessionId, [
      { type: "text", text: "go" },
    ]);

    expect(response.stopReason).toBe("end_turn");
    const texts = rec.updates
      .filter((u) => u.sessionId === sessionId)
      .map((u) =>
        u.update.sessionUpdate === "agent_message_chunk" &&
        u.update.content.type === "text"
          ? u.update.content.text
          : "",
      );
    expect(texts.join("")).toBe("part one part two");
    await pool.stop("fake");
  });

  it("crash is visible the moment it happens; restart is one action", async () => {
    const { pool, rec } = makePool();
    await pool.connect(spec({}, "crashy"));
    const { sessionId } = await pool.newSession("crashy", cwd);

    await expect(
      pool.prompt("crashy", sessionId, [{ type: "text", text: "__crash__" }]),
    ).rejects.toThrow();

    const crashed = await waitFor(() =>
      pool.get("crashy")?.status === "crashed" ? pool.get("crashy") : undefined,
    );
    expect(crashed.detail).toMatch(/exited 1/);
    expect(rec.statuses.some((s) => s.status === "crashed")).toBe(true);

    // one action: restart reconnects and re-captures declared
    const declared = await pool.restart("crashy");
    expect(declared).toBeTruthy();
    expect(pool.get("crashy")?.status).toBe("running");
    expect(rec.declared).toHaveLength(2);
    await pool.stop("crashy");
  });

  it("intentional stop reads as stopped, never crashed", async () => {
    const { pool, rec } = makePool();
    await pool.connect(spec({}, "stoppy"));
    await pool.stop("stoppy");
    expect(pool.get("stoppy")?.status).toBe("stopped");
    expect(rec.statuses.every((s) => s.status !== "crashed")).toBe(true);
  });

  it("runs two concurrent sessions over one connection, updates routed by id", async () => {
    const { pool, rec } = makePool();
    await pool.connect(
      spec(
        {
          turn: [
            { type: "chunk", text: "tick " },
            { type: "chunk", text: "tock" },
          ],
          stepDelayMs: 15,
        },
        "multi",
      ),
    );

    const [a, b] = await Promise.all([
      pool.newSession("multi", cwd),
      pool.newSession("multi", cwd),
    ]);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(pool.get("multi")?.sessions).toHaveLength(2);

    const [ra, rb] = await Promise.all([
      pool.prompt("multi", a.sessionId, [{ type: "text", text: "A" }]),
      pool.prompt("multi", b.sessionId, [{ type: "text", text: "B" }]),
    ]);
    expect(ra.stopReason).toBe("end_turn");
    expect(rb.stopReason).toBe("end_turn");

    for (const id of [a.sessionId, b.sessionId]) {
      const text = rec.updates
        .filter((u) => u.sessionId === id)
        .map((u) =>
          u.update.sessionUpdate === "agent_message_chunk" &&
          u.update.content.type === "text"
            ? u.update.content.text
            : "",
        )
        .join("");
      expect(text).toBe("tick tock");
    }
    await pool.stop("multi");
  });

  it("cancel mid-turn yields stopReason cancelled", async () => {
    const { pool } = makePool();
    await pool.connect(
      spec(
        {
          turn: [
            { type: "chunk", text: "one" },
            { type: "chunk", text: "two" },
            { type: "chunk", text: "three" },
          ],
          stepDelayMs: 200,
        },
        "cancelly",
      ),
    );
    const { sessionId } = await pool.newSession("cancelly", cwd);
    const turn = pool.prompt("cancelly", sessionId, [{ type: "text", text: "go" }]);
    await new Promise((r) => setTimeout(r, 120));
    await pool.cancel("cancelly", sessionId);
    const response = await turn;
    expect(response.stopReason).toBe("cancelled");
    await pool.stop("cancelly");
  });
});
