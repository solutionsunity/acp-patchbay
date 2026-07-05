import { describe, expect, it } from "vitest";
import { computeLineDiff } from "../src/orchestrator/diff";

describe("computeLineDiff", () => {
  it("an all-new file is all additions", () => {
    const r = computeLineDiff("", "a\nb");
    expect(r.additions).toBe(2);
    expect(r.deletions).toBe(0);
    expect(r.lines).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
  });

  it("identical content is all context, no changes", () => {
    const r = computeLineDiff("a\nb\nc", "a\nb\nc");
    expect(r.additions).toBe(0);
    expect(r.deletions).toBe(0);
    expect(r.lines.every((l) => l.kind === "context")).toBe(true);
  });

  it("a single changed line in the middle shows as del+add around context", () => {
    const r = computeLineDiff("a\nb\nc", "a\nX\nc");
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(1);
    expect(r.lines).toEqual([
      { kind: "context", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "X" },
      { kind: "context", text: "c" },
    ]);
  });

  it("appending lines only adds, never touches existing context", () => {
    const r = computeLineDiff("a\nb", "a\nb\nc\nd");
    expect(r.deletions).toBe(0);
    expect(r.additions).toBe(2);
    expect(r.lines.filter((l) => l.kind === "context")).toHaveLength(2);
  });

  it("deleting the whole file is all deletions", () => {
    const r = computeLineDiff("a\nb\nc", "");
    expect(r.deletions).toBe(3);
    expect(r.additions).toBe(0);
  });

  it("a trailing newline is a real empty final line, not a quirk to hide", () => {
    const r = computeLineDiff("", "hello\n");
    expect(r.additions).toBe(2);
    expect(r.lines).toEqual([
      { kind: "add", text: "hello" },
      { kind: "add", text: "" },
    ]);
  });
});
