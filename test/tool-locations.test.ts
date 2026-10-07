// A tool call's location line lands on a real editor line however far it
// points (issue #41); how the wire's line is read is the reader tests'.
import { describe, expect, it } from "vitest";
import { editorLineOf } from "../src/orchestrator/tool-locations";

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
