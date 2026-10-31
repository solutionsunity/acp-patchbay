// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The capability one-liner says each row as the matrix shows it — one
// reading (capabilityState), so the line and the matrix never disagree.
import { describe, expect, it } from "vitest";
import { agentSubtitle, capabilityOneLiner } from "../src/shared/capability-format";
import type { CapabilityCell, CapabilityMatrix } from "../src/shared/protocol";

const cell = (declared: boolean, used: boolean, suspect?: boolean): CapabilityCell => ({ declared, used, ...(suspect ? { suspect } : {}) });
const matrix = (over: Partial<CapabilityMatrix>) =>
  new Proxy({ ...over } as CapabilityMatrix, { get: (t, k: string) => (t as Record<string, CapabilityCell>)[k] ?? cell(false, false) });

describe("capabilityOneLiner", () => {
  it("says each row as the matrix does — suspect included, a used mark the agent never declared read as undeclared (#135)", () => {
    expect(
      capabilityOneLiner(
        matrix({
          "fs.readTextFile": cell(true, true),
          "fs.writeTextFile": cell(true, true),
          terminal: cell(true, false, true),
          "session.fork": cell(false, true),
        }),
      ),
    ).toBe("fs ✓ · terminal suspect · fork —");
    expect(capabilityOneLiner(matrix({ "fs.readTextFile": cell(true, true), terminal: cell(true, false), "session.fork": cell(true, true) }))).toBe(
      "fs declared, not used · terminal declared, not used · fork ✓ used",
    );
  });
});

describe("agentSubtitle", () => {
  it("is one line for every list of agents: its status's word, else what it proved, else its status (#135)", () => {
    expect(agentSubtitle({ status: "reconnecting", detail: "downloading…" })).toBe("downloading…");
    expect(agentSubtitle({ status: "running" })).toBe("ready");
    expect(agentSubtitle({ status: "untested" })).toBe("never connected");
    expect(agentSubtitle({ status: "stopped", capabilities: matrix({ "session.fork": cell(true, true) }) })).toBe("fs — · terminal — · fork ✓ used");
    expect(agentSubtitle({ status: "crashed" })).toBe("crashed");
  });
});
