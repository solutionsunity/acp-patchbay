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
      placeholder: "Connect an agent to start",
    });
    expect(composerControls(session, agent({ status: "stopped" }), false).enabled).toBe(false);
    expect(composerControls(session, null, false)).toEqual({
      enabled: false,
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
