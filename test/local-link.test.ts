// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { driveHrefAsFileUrl, isLocalHref } from "../src/shared/local-link";
import { localLinkTarget } from "../src/orchestrator/local-link";

describe("isLocalHref — what VS Code would drop from a webview (#159)", () => {
  it("paths and file: URIs are local", () => {
    for (const href of ["plan.md", "./a/b.md", "../ui/plan.md", "/abs/x.md", "file:///C:/x/y.md", "file:///tmp/a.md", "FILE:///tmp/a.md", "my%20notes.md"]) {
      expect(isLocalHref(href), href).toBe(true);
    }
  });

  it("what VS Code opens itself, and an in-page anchor, are not", () => {
    for (const href of ["https://example.com", "http://x", "mailto:a@b.c", "vscode:extension/x", "command:workbench.action.quit", "#heading", "//cdn.example.com/x", ""]) {
      expect(isLocalHref(href), href).toBe(false);
    }
  });
});

describe("driveHrefAsFileUrl — a Windows drive path as the file: URI a URL reader keeps", () => {
  it("backslashes, as written or as Markdown encodes them, and slashes", () => {
    expect(driveHrefAsFileUrl("C:%5CUsers%5Cme%5Cmy%20plan.md")).toBe("file:///C:/Users/me/my%20plan.md");
    expect(driveHrefAsFileUrl("C:\\Users\\me\\my plan.md")).toBe("file:///C:/Users/me/my%20plan.md");
    expect(driveHrefAsFileUrl("c:/x/%D8%AE%D8%B7%D8%A9.md:3")).toBe("file:///c:/x/%D8%AE%D8%B7%D8%A9.md:3");
  });

  it("anything else is no drive path", () => {
    for (const href of ["src/a.ts", "/abs/x.md", "file:///C:/x.md", "https://example.com", "C:", "mailto:a@b.c"]) {
      expect(driveHrefAsFileUrl(href), href).toBeNull();
    }
  });
});

describe("localLinkTarget — the file a local link names", () => {
  const base = resolve(tmpdir(), "project-api");

  it("a relative path resolves against where the agent works, a sibling project too", () => {
    expect(localLinkTarget("../project-ui/.agents/plans/example-change.md", base)).toEqual({
      path: resolve(base, "..", "project-ui", ".agents", "plans", "example-change.md"),
    });
  });

  it("percent-encoding is decoded; a name with a lone % stays as written", () => {
    expect(localLinkTarget("docs/my%20plan%20%D8%AE%D8%B7%D8%A9.md", base)).toEqual({ path: resolve(base, "docs", "my plan خطة.md") });
    expect(localLinkTarget("docs/خطة 100%.md", base)).toEqual({ path: resolve(base, "docs", "خطة 100%.md") });
  });

  it("a file: URI names its path", () => {
    const file = resolve(tmpdir(), "a b.md");
    expect(localLinkTarget(pathToFileURL(file).href, base)).toEqual({ path: file });
  });

  it("#L42 is the line, a range its first; any other fragment opens at the top", () => {
    expect(localLinkTarget("src/a.ts#L42", base)).toEqual({ path: resolve(base, "src", "a.ts"), line: 42 });
    expect(localLinkTarget("src/a.ts#L42-L50", base)).toEqual({ path: resolve(base, "src", "a.ts"), line: 42 });
    expect(localLinkTarget("src/a.ts#L42C3-L50C1", base)).toEqual({ path: resolve(base, "src", "a.ts"), line: 42 });
    expect(localLinkTarget("README.md#setup", base)).toEqual({ path: resolve(base, "README.md") });
    expect(localLinkTarget("src/a.ts#L0", base)).toEqual({ path: resolve(base, "src", "a.ts") });
  });

  it("a :42 or :42:7 suffix is the line, on a path or a file: URI", () => {
    expect(localLinkTarget("src/a.ts:42", base)).toEqual({ path: resolve(base, "src", "a.ts"), line: 42 });
    expect(localLinkTarget("src/a.ts:42:7", base)).toEqual({ path: resolve(base, "src", "a.ts"), line: 42 });
    const file = resolve(tmpdir(), "a b.ts");
    expect(localLinkTarget(`${pathToFileURL(file).href}:9`, base)).toEqual({ path: file, line: 9 });
  });

  it.runIf(process.platform === "win32")("a drive path, carried as its file: URI, names the file", () => {
    expect(localLinkTarget(driveHrefAsFileUrl("C:%5CUsers%5Cme%5Cmy%20plan.md:3")!, base)).toEqual({ path: "C:\\Users\\me\\my plan.md", line: 3 });
  });

  it("no link to a file here: a web link, a bare anchor", () => {
    expect(localLinkTarget("https://example.com/a.md", base)).toBeNull();
    expect(localLinkTarget("#L3", base)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("a file: URI on another host names nothing here", () => {
    expect(localLinkTarget("file://server/share/a.md", base)).toBeNull();
  });
});
