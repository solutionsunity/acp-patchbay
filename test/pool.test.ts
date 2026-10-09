// P2 gate: pool against the fake agent — connect, capture declared,
// crash → visible → one-action restart, two concurrent sessions on one connection.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionUpdateFact } from "../src/orchestrator/readers/session-update";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import type { AgentStatus } from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { stubFsTerminalHooks } from "./support/stub-hooks";
import type { PatchbayAgentId } from "../src/shared/ids";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "patchbay-pool-"));
});
afterAll(() => rm(cwd, { recursive: true, force: true }));

interface Recorded {
  statuses: Array<{ status: AgentStatus; detail?: string }>;
  /** One entry per fresh `initialize` answer captured. */
  declared: string[];
  updates: { sessionId: string; update: SessionUpdateFact }[];
}

function agentText(update: SessionUpdateFact): string {
  return update.kind === "chunk" && update.channel === "agent" && update.content.type === "text" ? update.content.text : "";
}

function makePool(): { pool: AgentPool; rec: Recorded } {
  const rec: Recorded = { statuses: [], declared: [], updates: [] };
  const pool = new AgentPool({
    onStatusChanged: (_id, status, detail) => rec.statuses.push({ status, detail }),
    onDeclaredCaptured: (id) => rec.declared.push(id),
    onSessionUpdate: (_id, sessionId, update) => rec.updates.push({ sessionId, update }),
    ...stubFsTerminalHooks(),
  });
  return { pool, rec };
}

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
    expect(pool.get("fake" as PatchbayAgentId)?.status).toBe("running");
    expect(rec.statuses.map((s) => s.status)).toEqual(["reconnecting", "running"]);

    await pool.stop("fake" as PatchbayAgentId);
    expect(pool.get("fake" as PatchbayAgentId)?.status).toBe("stopped");
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
    const { sessionId } = await pool.newSession("fake" as PatchbayAgentId, cwd);
    const response = await pool.prompt("fake" as PatchbayAgentId, sessionId, [
      { type: "text", text: "go" },
    ]);

    expect(response.stopReason).toBe("end_turn");
    const texts = rec.updates
      .filter((u) => u.sessionId === sessionId)
      .map((u) => agentText(u.update));
    expect(texts.join("")).toBe("part one part two");
    await pool.stop("fake" as PatchbayAgentId);
  });

  it("crash is visible the moment it happens; restart is one action", async () => {
    const { pool, rec } = makePool();
    await pool.connect(spec({}, "crashy"));
    const { sessionId } = await pool.newSession("crashy" as PatchbayAgentId, cwd);

    await expect(
      pool.prompt("crashy" as PatchbayAgentId, sessionId, [{ type: "text", text: "__crash__" }]),
    ).rejects.toThrow();

    const crashed = await waitFor(() =>
      pool.get("crashy" as PatchbayAgentId)?.status === "crashed" ? pool.get("crashy" as PatchbayAgentId) : undefined,
    );
    expect(crashed.detail).toMatch(/exited 1/);
    expect(rec.statuses.some((s) => s.status === "crashed")).toBe(true);

    // one action: restart reconnects and re-captures declared
    const declared = await pool.restart("crashy" as PatchbayAgentId);
    expect(declared).toBeTruthy();
    expect(pool.get("crashy" as PatchbayAgentId)?.status).toBe("running");
    expect(rec.declared).toHaveLength(2);
    await pool.stop("crashy" as PatchbayAgentId);
  });

  it("intentional stop reads as stopped, never crashed", async () => {
    const { pool, rec } = makePool();
    await pool.connect(spec({}, "stoppy"));
    await pool.stop("stoppy" as PatchbayAgentId);
    expect(pool.get("stoppy" as PatchbayAgentId)?.status).toBe("stopped");
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
      pool.newSession("multi" as PatchbayAgentId, cwd),
      pool.newSession("multi" as PatchbayAgentId, cwd),
    ]);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(pool.get("multi" as PatchbayAgentId)?.sessions).toHaveLength(2);

    const [ra, rb] = await Promise.all([
      pool.prompt("multi" as PatchbayAgentId, a.sessionId, [{ type: "text", text: "A" }]),
      pool.prompt("multi" as PatchbayAgentId, b.sessionId, [{ type: "text", text: "B" }]),
    ]);
    expect(ra.stopReason).toBe("end_turn");
    expect(rb.stopReason).toBe("end_turn");

    for (const id of [a.sessionId, b.sessionId]) {
      const text = rec.updates
        .filter((u) => u.sessionId === id)
        .map((u) => agentText(u.update))
        .join("");
      expect(text).toBe("tick tock");
    }
    await pool.stop("multi" as PatchbayAgentId);
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
    const { sessionId } = await pool.newSession("cancelly" as PatchbayAgentId, cwd);
    const turn = pool.prompt("cancelly" as PatchbayAgentId, sessionId, [{ type: "text", text: "go" }]);
    await new Promise((r) => setTimeout(r, 120));
    await pool.cancel("cancelly" as PatchbayAgentId, sessionId);
    const response = await turn;
    expect(response.stopReason).toBe("cancelled");
    await pool.stop("cancelly" as PatchbayAgentId);
  });

  // P16: a failure's reason is readable inline — the crashed entry keeps the
  // process's own last words (stderr tail) for the row to show.
  it("a crash keeps the stderr tail on the entry", async () => {
    const recorded: AgentStatus[] = [];
    const pool = new AgentPool({
      onStatusChanged: (_id, status) => recorded.push(status),
      onDeclaredCaptured: () => {},
      onSessionUpdate: () => {},
      ...stubFsTerminalHooks(),
    });
    await expect(
      pool.connect({
        patchbayAgentId: "doomed" as PatchbayAgentId,
        name: "Doomed",
        command: process.execPath,
        // write-callback → exit: the last words are flushed before death,
        // so the tail is deterministic here
        args: ["-e", 'process.stderr.write("boom: config missing\\n", () => process.exit(1));'],
        env: {},
        cwd,
      }),
    ).rejects.toThrow();
    expect(recorded).toContain("crashed");
    expect(pool.get("doomed" as PatchbayAgentId)?.stderrTail.join("\n")).toContain("boom: config missing");
  });

  // The classic silent hang — a CLI doing first-run setup against a TTY it
  // doesn't have — is told by what it writes, not by a clock: the card says
  // so while the connect waits, and only a stop ends the wait.
  it("an agent that writes something other than ACP before answering is named, and waits for its stop", async () => {
    const { pool, rec } = makePool();
    const connecting = pool.connect({
      patchbayAgentId: "mute" as PatchbayAgentId,
      name: "Mute",
      command: process.execPath,
      args: ["-e", 'process.stdout.write("Welcome! Choose a theme:\\n"); process.stdin.resume();'],
      env: {},
      cwd,
    });
    const settled = connecting.then(() => "connected", () => "failed");
    await waitFor(() => rec.statuses.find((s) => s.detail?.includes("first-run setup")));
    expect(pool.get("mute" as PatchbayAgentId)?.status).toBe("reconnecting");
    await pool.stop("mute" as PatchbayAgentId);
    expect(await settled).toBe("failed");
    expect(pool.get("mute" as PatchbayAgentId)?.status).toBe("stopped");
  });

  // Runtime seam: whatever the resolver returns IS what spawns — proven by
  // resolving a spec that could never spawn into one that does. Warmup and
  // the real launch read the same resolved spec by construction (the seam
  // runs once, ahead of both).
  it("spawns the resolver's spec, not the incoming one", async () => {
    const pool = new AgentPool(
      {
        onStatusChanged: () => {},
        onDeclaredCaptured: () => {},
        onSessionUpdate: () => {},
        ...stubFsTerminalHooks(),
      },
      undefined,
      { resolveLaunch: async (s) => spec({}, s.patchbayAgentId) },
    );
    const declared = await pool.connect({
      patchbayAgentId: "resolved" as PatchbayAgentId,
      name: "Resolved",
      command: "patchbay-no-such-launcher",
      args: [],
      env: {},
      cwd,
    });
    expect(declared).toBeDefined();
    expect(pool.get("resolved" as PatchbayAgentId)?.status).toBe("running");
    // The entry snapshot holds the resolved spec — what actually ran.
    expect(pool.get("resolved" as PatchbayAgentId)?.spec.command).toBe(process.execPath);
    await pool.stop("resolved" as PatchbayAgentId);
  });

  it("a resolver throw is the connect failure, honestly labeled", async () => {
    const statuses: Array<{ status: AgentStatus; detail?: string }> = [];
    const pool = new AgentPool(
      {
        onStatusChanged: (_id, status, detail) => statuses.push({ status, detail }),
        onDeclaredCaptured: () => {},
        onSessionUpdate: () => {},
        ...stubFsTerminalHooks(),
      },
      undefined,
      {
        resolveLaunch: async () => {
          throw new Error("node did not answer --version");
        },
      },
    );
    await expect(pool.connect(spec({}, "no-runtime"))).rejects.toThrow(/launch prerequisite unavailable/);
    const crashed = statuses.find((s) => s.status === "crashed");
    expect(crashed?.detail).toContain("node did not answer --version");
  });
});

describe("AgentPool — stopping", () => {
  it("a process stops once: a stop asked for while it goes down gets that same stop", async () => {
    const { pool, rec } = makePool();
    await pool.connect(spec({}, "twice"));
    const first = pool.stop("twice" as PatchbayAgentId);
    expect(pool.stop("twice" as PatchbayAgentId)).toBe(first);
    await first;
    const reported = rec.statuses.length;
    await pool.stop("twice" as PatchbayAgentId);
    expect(rec.statuses).toHaveLength(reported);
  });

  it("a launch whose signal has already aborted never starts", async () => {
    const { pool, rec } = makePool();
    const controller = new AbortController();
    controller.abort(new Error("stopped by test"));
    await expect(pool.connect(spec({}, "never"), { signal: controller.signal })).rejects.toThrow("stopped by test");
    expect(pool.get("never" as PatchbayAgentId)).toBeUndefined();
    expect(rec.statuses).toEqual([]);
  });

  it("a signal stops a launch in its launch phase: nothing spawns, the entry reads stopped", async () => {
    const statuses: Array<{ status: AgentStatus; detail?: string }> = [];
    let phase!: (label: string) => void;
    let release!: () => void;
    const pool = new AgentPool(
      {
        onStatusChanged: (_id, status, detail) => statuses.push({ status, detail }),
        onDeclaredCaptured: () => {},
        onSessionUpdate: () => {},
        ...stubFsTerminalHooks(),
      },
      undefined,
      {
        resolveLaunch: (s, onPhase) => {
          phase = onPhase;
          onPhase("downloading Fake 1.0…");
          return new Promise((resolve) => (release = () => resolve(spec({}, s.patchbayAgentId))));
        },
      },
    );
    const controller = new AbortController();
    const connecting = pool.connect(spec({}, "mid-download"), { signal: controller.signal });
    controller.abort(new Error("stopped by test"));
    await expect(connecting).rejects.toThrow("stopped by test");
    expect(pool.get("mid-download" as PatchbayAgentId)?.status).toBe("stopped");
    // The resolver runs on unwatched — its download is the cache's — and
    // neither its late label nor its spec moves the stopped launch.
    phase("downloading Fake 1.0… 90%");
    release();
    await new Promise((r) => setTimeout(r, 300));
    expect(pool.get("mid-download" as PatchbayAgentId)?.status).toBe("stopped");
    expect(pool.get("mid-download" as PatchbayAgentId)?.detail).toBeUndefined();
    expect(statuses.map((s) => s.status)).toEqual(["reconnecting", "reconnecting", "stopped"]);
  });

  // A launcher shaped like the registry's npx launch, so the connect warms
  // it first: the stand-in sleeps where a real one would download, and
  // records its pid. A shebang script — POSIX only.
  it.skipIf(process.platform === "win32")(
    "a signal during the launcher warmup kills the warmup, and nothing spawns",
    async () => {
      const bin = await mkdtemp(join(tmpdir(), "patchbay-warm-"));
      const pidFile = join(bin, "pid");
      await writeFile(
        join(bin, "npx"),
        `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 30000);\n`,
      );
      await chmod(join(bin, "npx"), 0o755);
      const { pool, rec } = makePool();
      const controller = new AbortController();
      const connecting = pool.connect(
        // PATH holds only the stand-in, so the cache check finds no npm to
        // ask and touches nothing.
        { patchbayAgentId: "warm" as PatchbayAgentId, name: "Warm", command: join(bin, "npx"), args: ["-y", "fake-pkg@1.0.0"], env: { PATH: bin }, cwd },
        { signal: controller.signal },
      );
      const pid = Number(await waitFor(() => readFile(pidFile, "utf8").then((t) => t || undefined, () => undefined)));
      controller.abort(new Error("stopped by test"));
      await expect(connecting).rejects.toThrow("stopped by test");
      expect(() => process.kill(pid, 0)).toThrow();
      expect(pool.get("warm" as PatchbayAgentId)?.status).toBe("stopped");
      expect(rec.statuses.map((s) => s.status)).not.toContain("running");
      await rm(bin, { recursive: true, force: true });
    },
  );

  // A stand-in launcher that fails its install the way npm does: the
  // connect fails with the launcher's own words on the card, and the agent
  // is never spawned onto the failure.
  it.skipIf(process.platform === "win32")(
    "a launcher that can't install its package fails the connect in its own words",
    async () => {
      const bin = await mkdtemp(join(tmpdir(), "patchbay-warm-"));
      const runs = join(bin, "runs");
      await writeFile(
        join(bin, "npx"),
        `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(runs)}, "run\\n");\nprocess.stderr.write("npm error code ENOENT\\nnpm error enoent Could not read package.json\\n");\nprocess.exitCode = 1;\n`,
      );
      await chmod(join(bin, "npx"), 0o755);
      const { pool, rec } = makePool();
      await expect(
        pool.connect({ patchbayAgentId: "broken" as PatchbayAgentId, name: "Broken", command: join(bin, "npx"), args: ["-y", "fake-pkg@1.0.0"], env: { PATH: bin }, cwd }),
      ).rejects.toThrow("npm error enoent Could not read package.json");
      expect(rec.statuses.at(-1)).toEqual({ status: "crashed", detail: "npx couldn't install the package (exit 1)" });
      expect(pool.get("broken" as PatchbayAgentId)?.stderrTail).toEqual([
        "npm error code ENOENT",
        "npm error enoent Could not read package.json",
      ]);
      // The warmup ran, its first try and three retries; the agent itself
      // never did.
      expect((await readFile(runs, "utf8")).trim().split("\n")).toHaveLength(4);
      await rm(bin, { recursive: true, force: true });
    },
  );

  it("a call cut off by its connection's own stop is no evidence against the capability", async () => {
    const evidence: string[] = [];
    const pool = new AgentPool({
      onStatusChanged: () => {},
      onDeclaredCaptured: () => {},
      onSessionUpdate: () => {},
      onCapabilityEvidence: (_id, row, kind) => evidence.push(`${row}:${kind}`),
      ...stubFsTerminalHooks(),
    });
    await pool.connect(
      spec(
        { declare: { promptCapabilities: { image: true } }, turn: [{ type: "chunk", text: "slow" }], stepDelayMs: 5000 },
        "cut-off",
      ),
    );
    const { sessionId } = await pool.newSession("cut-off" as PatchbayAgentId, cwd);
    const turn = pool.prompt("cut-off" as PatchbayAgentId, sessionId, [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
    const cut = expect(turn).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    await pool.stop("cut-off" as PatchbayAgentId);
    await cut;
    expect(evidence.filter((e) => e.startsWith("prompt.image"))).toEqual([]);
  });
});
