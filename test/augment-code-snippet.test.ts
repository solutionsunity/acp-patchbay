// Wire-extension gate: the augment_code_snippet streaming rewriter — full
// shape rewritten (wrapper dropped, path/mode hoisted onto the fence),
// everything else byte-identical, and chunk boundaries anywhere must not
// change the result (the reason it's a stateful rewriter, not a regex).
import { describe, expect, it } from "vitest";
import { createAugmentSnippetRewriter } from "../src/orchestrator/extensions/augment-code-snippet";

/** Runs `text` through a fresh rewriter in one push, flush appended —
 * everything a run would ever emit for it. */
function rewrite(text: string): string {
  const r = createAugmentSnippetRewriter();
  return r.push(text) + r.flush();
}

const WRAPPED =
  'Look:\n\n<augment_code_snippet path="src/a.ts" mode="EXCERPT">\n```ts\nconst x = 1;\n```\n</augment_code_snippet>\n\nDone.';
const REWRITTEN = 'Look:\n\n```ts path="src/a.ts" excerpt\nconst x = 1;\n```\n\n\nDone.';

describe("augment_code_snippet rewriter", () => {
  it("rewrites the full shape: wrapper dropped, path + excerpt hoisted onto the fence", () => {
    expect(rewrite(WRAPPED)).toBe(REWRITTEN);
  });

  it("is chunking-invariant: any split point yields the identical result", () => {
    for (let at = 1; at < WRAPPED.length; at++) {
      const r = createAugmentSnippetRewriter();
      const out = r.push(WRAPPED.slice(0, at)) + r.push(WRAPPED.slice(at)) + r.flush();
      expect(out, `split at ${at}`).toBe(REWRITTEN);
    }
  });

  it("passes unrelated text through byte-identical, including bare < and near-miss tags", () => {
    for (const text of [
      "plain prose, 2 < 3 and <div> markup",
      "<augment_other_tag>not ours</augment_other_tag>",
      "trailing partial <aug", // held, then flushed raw
      "```ts\nconst a = b < c;\n```",
    ]) {
      expect(rewrite(text)).toBe(text);
    }
  });

  it("degrades to raw when the open tag is not followed by a fence", () => {
    const text = '<augment_code_snippet path="x.ts">\nnot a fence\n';
    expect(rewrite(text)).toBe(text);
  });

  it("leaves an unpaired closing tag alone", () => {
    const text = "prose </augment_code_snippet> more";
    expect(rewrite(text)).toBe(text);
  });

  it("omits the excerpt token when mode is absent", () => {
    expect(rewrite('<augment_code_snippet path="x.ts">\n```ts\na\n```\n</augment_code_snippet>')).toBe(
      '```ts path="x.ts"\na\n```\n',
    );
  });

  it("drops the wrapper without annotating when path is absent or the fence has no info", () => {
    expect(rewrite('<augment_code_snippet mode="EXCERPT">\n```ts\na\n```\n</augment_code_snippet>')).toBe(
      "```ts\na\n```\n",
    );
    expect(rewrite('<augment_code_snippet path="x.ts">\n```\na\n```\n</augment_code_snippet>')).toBe(
      "```\na\n```\n",
    );
  });

  it("handles several snippets in one stream", () => {
    const one = '<augment_code_snippet path="a.ts" mode="EXCERPT">\n```ts\n1\n```\n</augment_code_snippet>';
    expect(rewrite(`${one}\nand\n${one}`)).toBe(
      '```ts path="a.ts" excerpt\n1\n```\n\nand\n```ts path="a.ts" excerpt\n1\n```\n',
    );
  });

  it("flush surrenders a mid-tag hold raw — a dying stream loses nothing", () => {
    const r = createAugmentSnippetRewriter();
    expect(r.push('text <augment_code_snippet path="a')).toBe("text ");
    expect(r.flush()).toBe('<augment_code_snippet path="a');
    expect(r.flush()).toBe("");
  });

  it("caps a pathological hold instead of stalling the stream forever", () => {
    const r = createAugmentSnippetRewriter();
    const stuck = `<augment_code_snippet ${"x".repeat(2000)}`; // never closes
    expect(r.push(stuck)).toBe(stuck);
    expect(r.flush()).toBe("");
  });
});
