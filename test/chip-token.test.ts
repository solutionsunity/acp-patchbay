// What a staged attachment reads as in the prompt box (chip-token.ts): the
// file's own name, with its lines for a selection — one short word, never
// the path the chip's label carries.
import { describe, expect, it } from "vitest";
import { chipTitle, chipToken, selectionOffer } from "../src/webview/agent-view/composer/chip-token";

describe("selectionOffer", () => {
  it("one selection is offered as its file and lines", () => {
    expect(selectionOffer({ file: "/ws/src/a.ts", ranges: [{ startLine: 3, endLine: 9 }] })).toEqual({
      label: "a.ts:3-9",
      title: "Live IDE selection — click to add it to context",
    });
    expect(selectionOffer({ file: "/ws/src/a.ts", ranges: [{ startLine: 4, endLine: 4 }] }).label).toBe("a.ts:4");
  });

  it("several say how many more a click adds, and that each is added", () => {
    const ranges = [{ startLine: 7, endLine: 12 }, { startLine: 25, endLine: 41 }, { startLine: 50, endLine: 50 }];
    expect(selectionOffer({ file: "/ws/config.json", ranges })).toEqual({
      label: "config.json:7-12 +2",
      title: "3 selections in the editor — click to add each to context",
    });
  });
});

describe("chipToken", () => {
  it("a selection reads as its file and lines — one line as one number", () => {
    const selection = (sourceUri: string) => chipToken({ id: "c", kind: "selection", label: "Selection: …", content: "x", sourceUri });
    expect(selection("file:///ws/src/xyz.go#L12-34")).toBe("@xyz.go:12-34");
    expect(selection("file:///ws/src/xyz.go#L7-7")).toBe("@xyz.go:7");
    expect(selection("file:///C:/ws/a%20b.ts#L1-2")).toBe("@a b.ts:1-2");
  });

  it("the current file reads as its name", () => {
    expect(chipToken({ id: "c", kind: "file", label: "File: /ws/a.ts", content: "x", sourceUri: "file:///ws/a.ts" })).toBe("@a.ts");
  });

  it("a snapshot with no file behind it reads as its kind — never a guessed name", () => {
    expect(chipToken({ id: "c", kind: "diagnostics", label: "Problems (3)", content: "x" })).toBe("@problems");
    expect(chipToken({ id: "c", kind: "selection", label: "Selection", content: "x" })).toBe("@selection");
    expect(chipToken({ id: "c", kind: "selection", label: "Selection", content: "x", sourceUri: "untitled:Untitled-1#L1-2" })).toBe("@selection");
  });

  it("an image reads as its file's name where it has one", () => {
    expect(chipToken({ id: "c", kind: "image", label: "Image: shot.png", content: "", mimeType: "image/png" })).toBe("@shot.png");
    expect(chipToken({ id: "c", kind: "image", label: "Image (image/png)", content: "", mimeType: "image/png" })).toBe("@image");
  });

  it("an attached file or folder reads as its own name", () => {
    expect(chipToken({ id: "c", kind: "attachment", label: "File: notes.txt", name: "notes.txt", path: "/s/chip-1-notes.txt" })).toBe("@notes.txt");
  });

  it("the hover says where a file is and what a snapshot is of — an image's is the image, so no words", () => {
    expect(chipTitle({ id: "c", kind: "attachment", label: "File: notes.txt", name: "notes.txt", path: "/home/u/notes.txt" })).toBe("/home/u/notes.txt");
    expect(chipTitle({ id: "c", kind: "selection", label: "Selection: /ws/a.ts:1-2", content: "x" })).toBe("Selection: /ws/a.ts:1-2");
    expect(chipTitle({ id: "c", kind: "image", label: "Image: shot.png", content: "", mimeType: "image/png" })).toBe("");
  });
});
