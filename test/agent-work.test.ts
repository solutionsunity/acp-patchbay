// How the views read an agent's busy state (agent-work.ts): the version
// chip's states and the chat pane's progress line, across what the agent's
// queue can hold.
import { describe, expect, it } from "vitest";
import type { AgentSummary } from "../src/shared/protocol";
import { chatPaneProgress, versionChip } from "../src/webview/shared/agent-work";
import type { PatchbayAgentId, PatchbaySessionId } from "../src/shared/ids";

const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  id: "a1" as PatchbayAgentId,
  name: "Claude",
  status: "running",
  needsAuth: false,
  authMethods: [],
  version: {},
  busy: [],
  ...over,
});

describe("versionChip", () => {
  it("a registry agent shows its pin, a custom one what it reported — both in the tooltip, never compared", () => {
    // Auggie on 2026-10-29: pinned 0.36.0, reports 0.36.0 (commit 7c61e5bb)
    expect(versionChip(agent({ version: { pinned: "0.36.0", reported: "0.36.0 (commit 7c61e5bb)" } }))).toEqual({
      kind: "version",
      shown: "0.36.0",
      title: "Claude: pinned 0.36.0 (ACP registry) · reports 0.36.0 (commit 7c61e5bb)",
    });
    expect(versionChip(agent({ version: { reported: "2.1.0" } }))).toEqual({ kind: "version", shown: "2.1.0", title: "Claude: reports 2.1.0" });
    // never connected: the pin is known, what it reports isn't yet
    expect(versionChip(agent({ version: { pinned: "0.36.0" } }))).toMatchObject({
      shown: "0.36.0",
      title: "Claude: pinned 0.36.0 (ACP registry) · reports its version once connected",
    });
  });

  it("nothing known, no chip: a custom command never connected", () => {
    expect(versionChip(agent())).toBeNull();
    expect(versionChip(undefined)).toBeNull();
  });

  it("is the upgrade while the registry is ahead of the pin", () => {
    expect(versionChip(agent({ version: { pinned: "1.0.0", reported: "1.0.0" }, update: { from: "1.0.0", to: "1.2.0" } }))).toEqual({
      kind: "update",
      from: "1.0.0",
      to: "1.2.0",
      title: "Upgrade Claude to 1.2.0 — pinned 1.0.0 (ACP registry) · reports 1.0.0",
    });
  });

  it("says a move of the version is under way — waiting or running, offer or not", () => {
    const upgrading = { kind: "moving", text: "upgrading to 1.2.0…" };
    expect(versionChip(agent({ busy: [{ kind: "upgrade", to: "1.2.0" }] }))).toEqual(upgrading);
    expect(versionChip(agent({ busy: [{ kind: "connect" }, { kind: "upgrade", to: "1.2.0" }] }))).toEqual(upgrading);
    expect(
      versionChip(agent({ version: { pinned: "1.0.0" }, update: { from: "1.0.0", to: "1.2.0" }, busy: [{ kind: "upgrade", to: "1.2.0" }] })),
    ).toEqual(upgrading);
    expect(versionChip(agent({ busy: [{ kind: "reset", to: "1.2.0" }] }))).toEqual({ kind: "moving", text: "resetting to 1.2.0…" });
    expect(versionChip(agent({ busy: [{ kind: "goBack", to: "1.0.0" }] }))).toEqual({ kind: "moving", text: "going back to 1.0.0…" });
    expect(versionChip(agent({ busy: [{ kind: "upgrade" }] }))).toEqual({ kind: "moving", text: "upgrading…" });
  });
});

describe("chatPaneProgress", () => {
  it("names what the agent's queue runs now, while the chat waits on it", () => {
    const line = (busy: AgentSummary["busy"]) => chatPaneProgress({ patchbayAgentId: "a1" as PatchbayAgentId }, agent({ status: "stopped", busy }));
    expect(line([{ kind: "connect" }])).toBe("Connecting Claude…");
    expect(line([{ kind: "restart" }])).toBe("Restarting Claude…");
    expect(line([{ kind: "upgrade", to: "1.2.0" }, { kind: "connect" }])).toBe("Upgrading Claude to 1.2.0…");
    expect(line([{ kind: "upgrade" }])).toBe("Upgrading Claude…");
    expect(line([{ kind: "reset", to: "1.2.0" }])).toBe("Resetting Claude to the ACP registry's 1.2.0…");
    expect(line([{ kind: "goBack", to: "1.0.0" }])).toBe("Taking Claude back to 1.0.0…");
    expect(line([{ kind: "login" }])).toBe("Logging in to Claude…");
    expect(line([{ kind: "logout" }])).toBe("Logging out of Claude…");
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
    expect(chatPaneProgress({ patchbayAgentId: "a1" as PatchbayAgentId }, agent({ busy: [{ kind: "login" }] }))).toBe("Starting a chat with Claude…");
    expect(chatPaneProgress({ patchbayAgentId: "a1" as PatchbayAgentId, forPatchbaySessionId: "s1" as PatchbaySessionId }, agent())).toBe("Opening the session…");
    // The row gone mid-start (removed in Settings): the id stands in.
    expect(chatPaneProgress({ patchbayAgentId: "a1" as PatchbayAgentId }, undefined)).toBe("Starting a chat with a1…");
  });
});
