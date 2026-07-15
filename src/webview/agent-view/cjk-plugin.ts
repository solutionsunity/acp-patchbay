// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Streamdown's CJK plugin: CommonMark's emphasis rules mis-parse **bold**
// and ~~strikethrough~~ adjacent to CJK punctuation (Chinese/Japanese/
// Korean) — these remark plugins fix the boundary handling. No effect on
// non-CJK text. (Arabic/RTL is a different concern entirely, handled by
// Streamdown's own per-block direction detection — dir="auto" in
// AgentMarkdown.)
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import type { CjkPlugin } from "streamdown";

export const cjkPlugin: CjkPlugin = {
  name: "cjk",
  type: "cjk",
  remarkPlugins: [], // deprecated field, kept empty — the ordered lists below are the API
  // must run before remarkGfm (modifies emphasis handling)
  remarkPluginsBefore: [remarkCjkFriendly],
  // must run after remarkGfm (strikethrough boundary fix)
  remarkPluginsAfter: [remarkCjkFriendlyGfmStrikethrough],
};
