// The composer gate (composer-controls.ts): every reachable state of the
// facts it consumes, named — the running-but-logged-out case is the one a
// live test caught after the auth authority made that state durable.
import { describe, expect, it } from "vitest";
import { composerControls } from "../src/webview/agent-view/composer/composer-controls";
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
    const c = composerControls(session, agent({ needsAuth: true }));
    expect(c.enabled).toBe(false);
    expect(c.placeholder).toContain("needs login");
    expect(c.placeholder).toContain("Claude");
  });

  it("running + clean auth: enabled, message placeholder", () => {
    const c = composerControls(session, agent({}));
    expect(c.enabled).toBe(true);
    expect(c.placeholder).toContain("Message Claude");
  });

  it("no session, or a non-running agent, locks with the connect hint — whatever needsAuth says", () => {
    expect(composerControls(null, agent({}))).toEqual({
      enabled: false,
      placeholder: "Connect an agent to start",
    });
    expect(composerControls(session, agent({ status: "stopped" })).enabled).toBe(false);
    expect(composerControls(session, null)).toEqual({
      enabled: false,
      placeholder: "Connect an agent to start",
    });
    // Stopped + logged out (the card right after Logout): the login hint
    // still wins over the generic connect hint — it names the real next step.
    const stoppedLocked = composerControls(session, agent({ status: "stopped", needsAuth: true }));
    expect(stoppedLocked.enabled).toBe(false);
    expect(stoppedLocked.placeholder).toContain("needs login");
  });

  it("auth resolving re-enables — the login-then-prompt recovery", () => {
    const locked = composerControls(session, agent({ needsAuth: true }));
    const cleared = composerControls(session, agent({ needsAuth: false }));
    expect(locked.enabled).toBe(false);
    expect(cleared.enabled).toBe(true);
  });
});
