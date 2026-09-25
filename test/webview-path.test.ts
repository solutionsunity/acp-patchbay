// Display labels for paths (files panel, tool-call file rows): relative to the
// longest containing workspace root, by whole segments only.
import { describe, expect, it } from "vitest";
import { splitPath } from "../src/webview/shared/path";

describe("splitPath", () => {
  it("relativizes against the longest root that contains the path", () => {
    expect(splitPath("/ws/app/src/a.ts", ["/ws", "/ws/app"])).toEqual({ base: "a.ts", dir: "src" });
  });

  it("a root claims whole segments only — /ws/app never claims /ws/application", () => {
    expect(splitPath("/ws/application/a.ts", ["/ws/app"])).toEqual({ base: "a.ts", dir: "/ws/application" });
  });

  it("a file at a root has no dir; outside every root the dir stays absolute", () => {
    expect(splitPath("/ws/a.ts", ["/ws"])).toEqual({ base: "a.ts", dir: "" });
    expect(splitPath("/tmp/x/a.ts", ["/ws"])).toEqual({ base: "a.ts", dir: "/tmp/x" });
  });

  it("Windows separators and a root given with a trailing separator both work", () => {
    expect(splitPath("C:\\ws\\src\\a.ts", ["C:\\ws"])).toEqual({ base: "a.ts", dir: "src" });
    expect(splitPath("/ws/src/a.ts", ["/ws/"])).toEqual({ base: "a.ts", dir: "src" });
  });
});
