// A tool call's location line lands on a real editor line however far it
// points (issue #41); how the wire's line is read is the reader tests'.
import { describe, expect, it } from "vitest";
import { editorLineOf, folderShownIn } from "../src/orchestrator/tool-locations";

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

// #171: a folder outside the workspace was a silent click — the Explorer
// reveals only workspace folders and says nothing for any other.
describe("folderShownIn", () => {
  it("a workspace folder is revealed in the Explorer, local or remote", () => {
    expect(folderShownIn(true, false)).toBe("explorer");
    expect(folderShownIn(true, true)).toBe("explorer");
  });

  it("a folder outside it opens in the file manager where that sees the same disk — and is named in a message where it can't", () => {
    expect(folderShownIn(false, false)).toBe("file-manager");
    expect(folderShownIn(false, true)).toBe("message");
  });
});
