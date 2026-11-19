// What the two choices around the command rules say of themselves: the
// warning a change must show before commands run unasked, the line that
// says how the layers come out, and the header's mark with what its click
// does (#165).
import { describe, expect, it } from "vitest";
import { unaskedChip } from "../src/webview/agent-view/unasked";
import { LAYER_REACH, policySummary, policyWarning } from "../src/webview/settings/command-policy-view";
import { DEFAULT_COMMAND_POLICY, DEFAULT_COMMAND_POLICY_LAYERS, type CommandPolicyLayersView } from "../src/shared/protocol";

describe("policyWarning — said before commands run unasked, and only then", () => {
  it("turning always-allow on warns, naming where it reaches and that deny rules are set aside", () => {
    for (const layer of ["workspace", "machine"] as const) {
      const warning = policyWarning({ kind: "alwaysAllow", on: true }, layer);
      expect(warning?.body).toContain(`in ${LAYER_REACH[layer]}`);
      expect(warning?.body).toContain("deny rules included");
      expect(warning?.confirm).toBe("Turn on");
    }
  });

  it("allow for what no rule decides warns that a deny rule stops only what is read", () => {
    const warning = policyWarning({ kind: "unruled", verdict: "allow" }, "machine");
    expect(warning?.body).toContain("a deny rule stops only what Patchbay can read");
    expect(warning?.body).toContain("in every workspace on this machine");
  });

  it("a change that tightens, or hands the choice back, warns of nothing", () => {
    expect(policyWarning({ kind: "alwaysAllow", on: false }, "machine")).toBeNull();
    expect(policyWarning({ kind: "unruled", verdict: "ask" }, "workspace")).toBeNull();
    expect(policyWarning({ kind: "unruled", verdict: "deny" }, "workspace")).toBeNull();
    expect(policyWarning({ kind: "unruled", verdict: null }, "workspace")).toBeNull();
  });
});

describe("policySummary — how the layers come out here", () => {
  const layers = (over: Partial<CommandPolicyLayersView>): CommandPolicyLayersView => ({ ...DEFAULT_COMMAND_POLICY_LAYERS, ...over });

  it("names whose choice stands, and what it does", () => {
    expect(policySummary(DEFAULT_COMMAND_POLICY_LAYERS)).toBe("Here: a command no rule decides asks, as a card (this machine's choice).");
    expect(policySummary(layers({ workspace: { alwaysAllow: false, unruled: "deny" }, effective: { alwaysAllow: false, unruled: "deny" } }))).toBe(
      "Here: a command no rule decides is refused without asking (this workspace's choice).",
    );
  });

  it("always-allow is the whole answer while it is on", () => {
    expect(policySummary(layers({ effective: { alwaysAllow: true, unruled: "deny" } }))).toBe('Here: every command runs without asking — "Always allow commands" is on.');
  });
});

describe("unaskedChip — the header's mark", () => {
  it("is there only while commands run without asking", () => {
    expect(unaskedChip(DEFAULT_COMMAND_POLICY)).toBeNull();
    expect(unaskedChip({ alwaysAllow: false, unruled: "deny" })).toBeNull();
  });

  it("turns always-allow off in one click; a choice with no one switch opens its page", () => {
    expect(unaskedChip({ alwaysAllow: true, unruled: "ask" })?.click).toBe("stopAlwaysAllow");
    expect(unaskedChip({ alwaysAllow: true, unruled: "allow" })?.click).toBe("stopAlwaysAllow");
    expect(unaskedChip({ alwaysAllow: false, unruled: "allow" })?.click).toBe("openCommands");
  });
});
