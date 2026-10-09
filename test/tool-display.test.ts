// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, type ToolCallDisplay } from "../src/shared/protocol";
import { DISPLAY_LADDER, joinsRuns, showsWholeTitle, startsOpen, TOOL_DISPLAY_ROUTES, toolCallDisplay } from "../src/shared/tool-display";

describe("tool-call display routing (#96)", () => {
  it("a routed kind follows its preference; every other kind stays grouped", () => {
    const prefs = { ...DEFAULT_PREFERENCES, executeCalls: "uncollapsed" as const };
    expect(toolCallDisplay("execute", prefs)).toBe("uncollapsed");
    expect(toolCallDisplay("read", prefs)).toBe("grouped");
    expect(toolCallDisplay("execute", DEFAULT_PREFERENCES)).toBe("grouped");
  });

  it("each kind is routed at most once", () => {
    const kinds = TOOL_DISPLAY_ROUTES.map((r) => r.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("the ladder: each step keeps what the one before it adds", () => {
    const steps: ToolCallDisplay[] = ["grouped", "ungrouped-truncated", "ungrouped-untruncated", "uncollapsed"];
    expect(DISPLAY_LADDER).toEqual(steps);
    expect(steps.map((s) => [joinsRuns(s), showsWholeTitle(s), startsOpen(s)])).toEqual([
      [true, false, false],
      [false, false, false],
      [false, true, false],
      [false, true, true],
    ]);
  });
});
