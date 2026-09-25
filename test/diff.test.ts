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

  // A newline ends a line, it doesn't open one — the count wc -l, git and
  // VS Code give. Read the other way, a new 40-line file counted +41: the
  // phantom empty line only cancels when both sides end in a newline.
  it("a trailing newline ends the last line — a new file of n lines is +n", () => {
    const r = computeLineDiff("", "hello\n");
    expect(r.additions).toBe(1);
    expect(r.lines).toEqual([{ kind: "add", text: "hello" }]);
    expect(computeLineDiff("", "a\nb\nc\n")).toMatchObject({ additions: 3, deletions: 0 });
    expect(computeLineDiff("a\nb\nc\n", "")).toMatchObject({ additions: 0, deletions: 3 });
  });

  it("only one trailing newline is a terminator — a blank last line still counts", () => {
    expect(computeLineDiff("", "a\n\n")).toMatchObject({ additions: 2 });
  });

  it("adding or dropping only the final newline changes no line", () => {
    expect(computeLineDiff("a\nb", "a\nb\n")).toMatchObject({ additions: 0, deletions: 0 });
  });

  // Measured before the trim: one changed line cost 393 ms / ~200 MB at
  // 5,000 lines and ~2 s / ~800 MB at 10,000, synchronously on the
  // extension host — agents that send whole files send them twice per edit.
  it("a one-line change in a huge file costs a scan, not a quadratic table", () => {
    const n = 50_000;
    const old = Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";
    const t0 = performance.now();
    const r = computeLineDiff(old, old.replace("line 25000\n", "CHANGED\n"));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r).toMatchObject({ additions: 1, deletions: 1 });
    expect(r.lines).toHaveLength(n + 1);
  });

  it("the shared start and end stay in the preview, in order, around the change", () => {
    expect(computeLineDiff("a\nb\nc\nd", "a\nb\nX\nd").lines).toEqual([
      { kind: "context", text: "a" },
      { kind: "context", text: "b" },
      { kind: "del", text: "c" },
      { kind: "add", text: "X" },
      { kind: "context", text: "d" },
    ]);
    // a repeated line on the seam is counted once, never twice
    expect(computeLineDiff("x\nx\nx", "x\nx")).toMatchObject({ additions: 0, deletions: 1 });
  });

  it("CRLF and LF are the same line boundary — mixed-source sides never mark every line changed", () => {
    // agent-normalized LF content vs the same file read from disk as CRLF
    expect(computeLineDiff("a\r\nb\r\nc\r\n", "a\nb\nc\n")).toMatchObject({
      additions: 0,
      deletions: 0,
    });
    expect(computeLineDiff("a\r\nb\r\nc\r\n", "a\nB\nc\n")).toMatchObject({
      additions: 1,
      deletions: 1,
    });
  });
});
