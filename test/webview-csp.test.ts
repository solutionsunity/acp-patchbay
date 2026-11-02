// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The webviews' content security policy is authored in one place and never
// widened silently: every directive is pinned here, so a change to the
// policy is a change to this test, made on purpose. The UI gate renders
// under the same policy, and no other file writes one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { webviewCsp } from "../src/orchestrator/webview-csp";
import { filesUnder } from "./support/source-files";

const HOME = fileURLToPath(new URL("../src/orchestrator/webview-csp.ts", import.meta.url));

describe("the webview policy", () => {
  it("is exactly what was decided — no eval, no inline script, no network", () => {
    expect(webviewCsp("SOURCE", "NONCE").split("; ")).toEqual([
      "default-src 'none'",
      "style-src SOURCE 'unsafe-inline'",
      "script-src 'nonce-NONCE' 'strict-dynamic'",
      "img-src SOURCE data:",
      "font-src SOURCE;",
    ]);
  });

  it("is written in one place, which the webview host and the UI gate both use", () => {
    const code = (file: string) => readFileSync(file, "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*)/.test(line));
    const directive = /\b(default|script|style|img|font|connect|frame|media|worker|object)-src\b/;
    const files = [...filesUnder(fileURLToPath(new URL("../src/", import.meta.url)), /\.tsx?$/), ...filesUnder(fileURLToPath(new URL("../scripts/", import.meta.url)), /\.m?js$/)];
    expect(files.filter((file) => file !== HOME && code(file).some((line) => directive.test(line)))).toEqual([]);
    for (const user of ["../src/orchestrator/webview-host.ts", "../scripts/ui-gate/shots.mjs"]) {
      expect(code(fileURLToPath(new URL(user, import.meta.url))).some((line) => line.includes("webviewCsp("))).toBe(true);
    }
  });
});
