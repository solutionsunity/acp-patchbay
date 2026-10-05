// How the views read an agent's busy state (agent-work.ts): the upgrade
// chip's two states and the chat pane's progress line, across what the
// agent's queue can hold.
import { describe, expect, it } from "vitest";
import type { AgentSummary } from "../src/shared/protocol";
import { chatPaneProgress, upgradeOffer } from "../src/webview/shared/agent-work";
import type { PatchbayAgentId, PatchbaySessionId } from "../src/shared/ids";

const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  id: "a1" as PatchbayAgentId,
  name: "Claude",
  status: "running",
  needsAuth: false,
  authMethods: [],
  busy: [],
  ...over,
});

describe("upgradeOffer", () => {
  it("offers the update while idle, and nothing without one", () => {
    expect(upgradeOffer(agent({ update: { from: "1.0.0", to: "1.2.0" } }))).toEqual({
      upgrading: false,
      from: "1.0.0",
      to: "1.2.0",
    });
    expect(upgradeOffer(agent())).toBeNull();
    expect(upgradeOffer(undefined)).toBeNull();
  });

  it("says an upgrade is under way — waiting or running, offer or not", () => {
    const upgrading = { upgrading: true, to: "1.2.0" };
    expect(upgradeOffer(agent({ busy: [{ kind: "upgrade", to: "1.2.0" }] }))).toEqual(upgrading);
    expect(upgradeOffer(agent({ busy: [{ kind: "connect" }, { kind: "upgrade", to: "1.2.0" }] }))).toEqual(upgrading);
    expect(
      upgradeOffer(agent({ update: { from: "1.0.0", to: "1.2.0" }, busy: [{ kind: "upgrade", to: "1.2.0" }] })),
    ).toEqual(upgrading);
  });
});

describe("chatPaneProgress", () => {
  it("names what the agent's queue runs now, while the chat waits on it", () => {
    const line = (busy: AgentSummary["busy"]) => chatPaneProgress({ patchbayAgentId: "a1" as PatchbayAgentId }, agent({ status: "stopped", busy }));
    expect(line([{ kind: "connect" }])).toBe("Connecting Claude…");
    expect(line([{ kind: "restart" }])).toBe("Restarting Claude…");
    expect(line([{ kind: "upgrade", to: "1.2.0" }, { kind: "connect" }])).toBe("Upgrading Claude to 1.2.0…");
    expect(line([{ kind: "upgrade" }])).toBe("Upgrading Claude…");
    expect(line([{ kind: "login" }])).toBe("Logging in to Claude…");
    expect(line([{ kind: "logout" }])).toBe("Logging out of Claude…");
    expect(line([{ kind: "verify" }, { kind: "connect" }])).toBe("Verifying Claude…");
    expect(line([{ kind: "stop" }])).toBe("Stopping Claude…");
    expect(line([{ kind: "remove" }])).toBe("Removing Claude…");
  });

  it("adds the launch phase while the process starts", () => {
    expect(
      chatPaneProgress(
        { patchbayAgentId: "a1" as PatchbayAgentId },
        agent({ status: "reconnecting", detail: "downloading the agent package…", busy: [{ kind: "connect" }] }),
      ),
    ).toBe("Connecting Claude… — downloading the agent package…");
  });

  it("once the agent runs, says the chat itself is opening — whatever else the agent is busy with", () => {
    expect(chatPaneProgress({ patchbayAgentId: "a1" as PatchbayAgentId }, agent())).toBe("Starting a chat with Claude…");
    expect(chatPaneProgress({ patchbayAgentId: "a1" as PatchbayAgentId }, agent({ busy: [{ kind: "verify" }] }))).toBe("Starting a chat with Claude…");
    expect(chatPaneProgress({ patchbayAgentId: "a1" as PatchbayAgentId, forPatchbaySessionId: "s1" as PatchbaySessionId }, agent())).toBe("Opening the session…");
    // The row gone mid-start (removed in Settings): the id stands in.
    expect(chatPaneProgress({ patchbayAgentId: "a1" as PatchbayAgentId }, undefined)).toBe("Starting a chat with a1…");
  });
});
