// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

import { describe, expect, it } from "vitest";
import { gateRefusal, isRefusal } from "../src/orchestrator/client-replies";

const what = "command `sudo make && sudo ls`";

describe("gateRefusal — what the agent hears when a gate says no", () => {
  it("the user's Reject is the user's", () => {
    const err = gateRefusal("rejected", what);
    expect(err).toMatchObject({ code: -32803, message: `The user rejected the ${what}` });
    expect(isRefusal(err)).toBe(true);
  });

  it("a rule's deny names the rule, not the user (#157)", () => {
    const err = gateRefusal({ denied: [{ kind: "command", pattern: "sudo *", verdict: "deny" }] }, what);
    expect(err).toMatchObject({ code: -32803, message: `A rule denies the ${what} (rule: \`sudo *\`)` });
    expect(isRefusal(err)).toBe(true);
  });

  it("several deciding rules are each named once; a word rule reads as a word", () => {
    const sudo = { kind: "word", pattern: "sudo", verdict: "deny" } as const;
    const err = gateRefusal({ denied: [sudo, { kind: "command", pattern: "make", verdict: "deny" }, sudo] }, what);
    expect(err.message).toBe(`A rule denies the ${what} (rules: \`word sudo\`, \`make\`)`);
  });

  it("a stopped turn is a cancel, not a refusal of the request", () => {
    expect(gateRefusal("cancelled", what)).toMatchObject({ code: -32800 });
  });
});
