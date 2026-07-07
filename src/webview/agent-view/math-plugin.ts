// Streamdown's math plugin: remark-math parses TeX delimiters, rehype-katex
// typesets them (KaTeX CSS + woff2 fonts ride the agent-view bundle — the
// rehype plugin must sit in the parse pipeline, so unlike mermaid this
// cannot be lazy-loaded).
//
// singleDollarTextMath is OFF, deliberately: this extension's users include
// accountants and operations — "costs $5 and $10 total" must never typeset
// "5 and " as a formula. Silently corrupting financial prose is worse than
// an engineer seeing raw single-$ TeX; $$…$$ (inline or display) still
// renders as math.
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import type { MathPlugin } from "streamdown";

export const katexPlugin: MathPlugin = {
  name: "katex",
  type: "math",
  remarkPlugin: [remarkMath, { singleDollarTextMath: false }],
  rehypePlugin: rehypeKatex,
};
