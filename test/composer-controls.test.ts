// The composer gate (composer-controls.ts): every reachable state of the
// facts it consumes, named — the running-but-logged-out case is the one a
// live test caught after the auth authority made that state durable; the
// new-chat-in-flight case is the one that let words typed during
// "Connecting…" land in the previous session's draft.
import { describe, expect, it } from "vitest";
import { composerControls, newChatInFlight } from "../src/webview/agent-view/composer/composer-controls";
import type { AgentSummary, SessionSummary } from "../src/shared/protocol";

const session: SessionSummary = {
  id: "s1",
  agentId: "a1",
  title: "T",
  live: false,
  updatedAt: "2026-07-21T00:00:00Z",
};
const agent = (over: Partial<AgentSummary>): AgentSummary => ({
  id: "a1",
  name: "Claude",
  status: "running",
  needsAuth: false,
  ...over,
});

describe("composerControls", () => {
  it("running + needsAuth locks the box with the login pointer — the reconnected-but-logged-out state (caught live)", () => {
    const c = composerControls(session, agent({ needsAuth: true }), false);
    expect(c.enabled).toBe(false);
    expect(c.placeholder).toContain("needs login");
    expect(c.placeholder).toContain("Claude");
  });

  it("running + clean auth: enabled, message placeholder", () => {
    const c = composerControls(session, agent({}), false);
    expect(c.enabled).toBe(true);
    expect(c.placeholder).toContain("Message Claude");
  });

  it("no session, or a non-running agent, locks with the connect hint — whatever needsAuth says", () => {
    expect(composerControls(null, agent({}), false)).toEqual({
      enabled: false,
      stop: false,
      placeholder: "Connect an agent to start",
    });
    expect(composerControls(session, agent({ status: "stopped" }), false).enabled).toBe(false);
    expect(composerControls(session, null, false)).toEqual({
      enabled: false,
      stop: false,
      placeholder: "Connect an agent to start",
    });
    // Stopped + logged out (the card right after Logout): the login hint
    // still wins over the generic connect hint — it names the real next step.
    const stoppedLocked = composerControls(session, agent({ status: "stopped", needsAuth: true }), false);
    expect(stoppedLocked.enabled).toBe(false);
    expect(stoppedLocked.placeholder).toContain("needs login");
  });

  it("auth resolving re-enables — the login-then-prompt recovery", () => {
    const locked = composerControls(session, agent({ needsAuth: true }), false);
    const cleared = composerControls(session, agent({ needsAuth: false }), false);
    expect(locked.enabled).toBe(false);
    expect(cleared.enabled).toBe(true);
  });

  // Send and Stop have opposite preconditions: Send needs a healthy agent
  // ready for a prompt, Stop needs only a turn in flight on a live process.
  // The lock is per agent, a turn is per session — a second session's RPC
  // settling auth_required raises the lock while this session's prompt is
  // still streaming, and that turn's only exit is Stop (issue #24).
  it("a live turn on a running-but-locked agent keeps Stop open while Send stays shut", () => {
    const c = composerControls({ ...session, live: true }, agent({ needsAuth: true }), false);
    expect(c.enabled).toBe(false);
    expect(c.stop).toBe(true);
  });

  it("Stop follows the turn, not the lock: closed with no live turn, closed on a dead process", () => {
    expect(composerControls(session, agent({}), false).stop).toBe(false);
    expect(composerControls({ ...session, live: true }, agent({}), false).stop).toBe(true);
    // The process is gone, so there is nothing to cancel — the turn will
    // settle on its own teardown path.
    expect(composerControls({ ...session, live: true }, agent({ status: "stopped" }), false).stop).toBe(false);
    expect(composerControls(null, agent({}), false).stop).toBe(false);
  });

  it("a new chat in flight locks the box and names the starting agent — no session exists yet", () => {
    // The agent is still spawning (reconnecting) or already running and
    // waiting on session/new: either way the box is locked with the reason.
    for (const status of ["reconnecting", "running"] as const) {
      const c = composerControls(null, agent({ status }), true);
      expect(c.enabled).toBe(false);
      expect(c.placeholder).toBe("Starting Claude…");
    }
    // Agent row gone mid-start (removed in Settings): still locked, generic name.
    expect(composerControls(null, null, true).placeholder).toBe("Starting a chat…");
  });
});

describe("newChatInFlight", () => {
  it("a New-chat connect (connecting or failed, not yet dismissed) is in flight; a session-click connect is not", () => {
    expect(newChatInFlight({ agentId: "a1", status: "connecting" })).toBe(true);
    expect(newChatInFlight({ agentId: "a1", status: "failed", reason: "boom" })).toBe(true);
    expect(newChatInFlight({ agentId: "a1", status: "connecting", forSessionId: "s1" })).toBe(false);
    expect(newChatInFlight(null)).toBe(false);
    expect(newChatInFlight(undefined)).toBe(false); // snapshots minted before the field existed
  });
});
