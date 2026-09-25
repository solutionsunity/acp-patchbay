// A tool call's location line: kept from the wire 1-based, and landed on a
// real editor line however far it points (issue #41).
import { describe, expect, it } from "vitest";
import { editorLineOf, toolLocationsOf } from "../src/orchestrator/tool-locations";

describe("toolLocationsOf", () => {
  it("keeps the path and the line; 0 reads as the first line; no line stays none", () => {
    expect(
      toolLocationsOf([
        { path: "/ws/a.ts", line: 42 },
        { path: "/ws/b.ts", line: 0 },
        { path: "/ws/c.ts", line: null },
        { path: "/ws/d.ts" },
      ]),
    ).toEqual([
      { path: "/ws/a.ts", line: 42 },
      { path: "/ws/b.ts", line: 1 },
      { path: "/ws/c.ts", line: null },
      { path: "/ws/d.ts", line: null },
    ]);
  });
});

describe("editorLineOf", () => {
  it("a 1-based line lands on the 0-based editor line", () => {
    expect(editorLineOf(1, 10)).toBe(0);
    expect(editorLineOf(10, 10)).toBe(9);
  });

  it("a line past the end opens at the last line, never fails", () => {
    expect(editorLineOf(500, 10)).toBe(9);
  });

  it("below the first line clamps to the first; an empty document still has line 0", () => {
    expect(editorLineOf(0, 10)).toBe(0);
    expect(editorLineOf(3, 0)).toBe(0);
  });
});
