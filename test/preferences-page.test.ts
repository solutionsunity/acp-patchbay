// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Every preference has its control on the Preferences page: the page reads
// it (`prefs.<key>`), or the tool-display routes it renders one select per
// name it. A preference added without either fails here, not in a user's
// hands.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../src/shared/protocol";
import { TOOL_DISPLAY_ROUTES } from "../src/shared/tool-display";

describe("the Preferences page", () => {
  it("has a control for every preference", async () => {
    const page = await readFile(new URL("../src/webview/settings/preferences.tsx", import.meta.url), "utf8");
    const routed = new Set<string>(TOOL_DISPLAY_ROUTES.map((r) => r.preference));
    const without = Object.keys(DEFAULT_PREFERENCES).filter((key) => !page.includes(`prefs.${key}`) && !routed.has(key));
    expect(without).toEqual([]);
  });
});
