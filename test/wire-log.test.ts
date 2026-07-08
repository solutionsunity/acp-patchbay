// Wire-log gate: redaction happens at the seam (an injected secret never
// reaches the sink), the TTL turns it off by itself, and oversized frames
// are truncated honestly — plus the pool tap end-to-end over the fake agent.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import { WireLog, WIRE_LOG_TTL_MS } from "../src/orchestrator/wire-log";
import type { FakeAgentScript } from "./fake-agent/main";
import { stubFsTerminalHooks } from "./support/stub-hooks";

function harness() {
  const lines: string[] = [];
  const states: { active: boolean; until: string | null }[] = [];
  const log = new WireLog(
    () => ({ appendLine: (l: string) => lines.push(l) }),
    (active, until) => states.push({ active, until }),
  );
  return { log, lines, states };
}

describe("WireLog", () => {
  it("masks registered secrets before a byte reaches the sink", () => {
    const { log, lines } = harness();
    log.registerSecret("sk-super-secret-value");
    log.enable();
    log.frame("claude", "→", '{"env":[{"name":"KEY","value":"sk-super-secret-value"}]}');
    const frame = lines.find((l) => l.includes("claude"))!;
    expect(frame).not.toContain("sk-super-secret-value");
    expect(frame).toContain("•••");
  });

  it("skips masking tiny values — they would shred unrelated content", () => {
    const { log, lines } = harness();
    log.registerSecret("ab"); // too short to be a credential
    log.enable();
    log.frame("claude", "→", '{"x":"ab"}');
    expect(lines.find((l) => l.includes("claude"))).toContain('"ab"');
  });

  it("drops frames while inactive and turns itself off at the TTL", () => {
    vi.useFakeTimers();
    try {
      const { log, lines, states } = harness();
      log.frame("claude", "→", "{}"); // inactive — dropped
      expect(lines).toEqual([]);
      log.enable();
      expect(states.at(-1)).toMatchObject({ active: true });
      expect(states.at(-1)!.until).not.toBeNull();
      vi.advanceTimersByTime(WIRE_LOG_TTL_MS + 1);
      expect(states.at(-1)).toEqual({ active: false, until: null });
      log.frame("claude", "→", "{}");
      expect(lines.some((l) => l.includes("{}"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("extend re-arms the deadline; extending while off is a no-op", () => {
    vi.useFakeTimers();
    try {
      const { log, states } = harness();
      log.extend(); // off — nothing happens
      expect(states).toEqual([]);
      log.enable();
      vi.advanceTimersByTime(WIRE_LOG_TTL_MS - 1000);
      log.extend();
      vi.advanceTimersByTime(WIRE_LOG_TTL_MS - 1000);
      expect(log.active).toBe(true); // would have expired without the extend
      vi.advanceTimersByTime(2000);
      expect(log.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("truncates oversized frames with an honest marker", () => {
    const { log, lines } = harness();
    log.enable();
    log.frame("claude", "←", "x".repeat(10_000));
    const frame = lines.find((l) => l.includes("claude"))!;
    expect(frame).toContain("[truncated — 10000 chars total]");
    expect(frame.length).toBeLessThan(9_000);
  });
});

// ── pool tap, end-to-end over the fake agent ────────────────────────────────

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "patchbay-wire-"));
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

function spec(script: FakeAgentScript, agentId: string): LaunchSpec {
  return {
    agentId,
    name: "Fake Agent",
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    cwd,
  };
}

describe("AgentPool wire tap", () => {
  it("hands complete frames in both directions to onWireFrame while active", async () => {
    const frames: { direction: string; line: string }[] = [];
    let active = false;
    const pool = new AgentPool({
      onStatusChanged: () => {},
      onDeclaredCaptured: () => {},
      onSessionUpdate: () => {},
      wireLogActive: () => active,
      onWireFrame: (_agentId, direction, line) => frames.push({ direction, line }),
      ...stubFsTerminalHooks(),
    });
    await pool.connect(spec({}, "tap")); // tap inactive during connect — nothing captured
    expect(frames).toEqual([]);

    active = true;
    await pool.newSession("tap", cwd);
    const out = frames.filter((f) => f.direction === "→");
    const back = frames.filter((f) => f.direction === "←");
    expect(out.some((f) => f.line.includes('"session/new"'))).toBe(true);
    expect(back.some((f) => f.line.includes("sessionId"))).toBe(true);
    // every captured frame is a whole JSON document, never a torn chunk
    for (const f of frames) expect(() => JSON.parse(f.line)).not.toThrow();

    await pool.stop("tap");
  });
});
