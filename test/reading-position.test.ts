// A session's reading place (#132): what the chat records as it leaves a
// session, and how much of the transcript it mounts to land there again.
import { describe, expect, it } from "vitest";
import { readingPosition, windowHolding } from "../src/webview/agent-view/chat/reading-position";

const rows = [
  { item: "a", top: -300, bottom: -100 },
  { item: "b", top: -88, bottom: 40 },
  { item: "c", top: 52, bottom: 400 },
];

describe("readingPosition", () => {
  it("records the row at the top edge and how far into it the edge sits", () => {
    expect(readingPosition(false, rows, 0)).toEqual({ item: "b", offset: 88 });
  });

  it("a session following its end has no position", () => {
    expect(readingPosition(true, rows, 0)).toBeNull();
  });

  it("an edge in the gap between rows names the next row, before its top", () => {
    expect(readingPosition(false, rows, 45)).toEqual({ item: "c", offset: -7 });
  });

  it("a row that rendered nothing is passed over", () => {
    const empty = [{ item: "gone", top: 0, bottom: 0 }, ...rows];
    expect(readingPosition(false, empty, -10)).toEqual({ item: "b", offset: 78 });
  });

  it("no row on screen is no position", () => {
    expect(readingPosition(false, [], 0)).toBeNull();
    expect(readingPosition(false, rows, 500)).toBeNull();
  });
});

describe("windowHolding", () => {
  const items = ["a", "b", "c", "d", "e"];

  it("mounts the newest items back to the one landed on", () => {
    expect(windowHolding(items, "b")).toBe(4);
    expect(windowHolding(items, "e")).toBe(1);
    expect(windowHolding(items, "a")).toBe(items.length);
  });

  it("an item the transcript no longer has has no window — the chat stays at the end", () => {
    expect(windowHolding(items, "gone")).toBeNull();
  });
});
