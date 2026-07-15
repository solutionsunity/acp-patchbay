// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Wire extension: `<augment_code_snippet path="…" mode="EXCERPT">` — a
// vendor render directive Augment's models are prompted to wrap around
// every code excerpt they present. Augment's own client parses it into an
// excerpt card; on a spec ACP wire it is raw text inside
// `agent_message_chunk`, and any faithful markdown renderer shows the tag
// literally. Wire-verified 2026-07-14: authored by the model, not by any
// tool — it appears with the context engine attached and detached alike
// (dossier § repro).
//
// The rewrite HONORS the directive instead of stripping it: the wrapper is
// dropped and its `path` (+ EXCERPT mode) is hoisted into the wrapped
// fence's info string as generic attributes (```tsx path="…" excerpt) —
// the webview's code block renders those with zero vendor knowledge.
// Anything that doesn't match the full observed shape (open tag, newline,
// fence line) passes through raw: degrade-to-absent, never a guess.
//
// Streaming: chunk boundaries can split the tag anywhere, so this is a
// stateful rewriter, not a regex — it holds back the one suffix that could
// still become a tag and releases it the moment it disambiguates (or at
// HOLD_CAP: real tags plus a fence line are far smaller, so an unresolved
// hold that long is not our shape). The holder (session-manager's open
// prose run) must call `flush()` when the run closes, so a stream dying
// mid-tag still lands its tail — raw, honestly.
//
// Adopted 2026-07-14. RETIRE when Auggie stops emitting the wrapper over
// ACP (re-test on version change: prompt for any code excerpt and grep the
// message stream for the tag). Retirement = delete this file + its line in
// extensions/index.ts; the webview's path=/excerpt fence attributes are
// generic and stay.
//
// Dossier: docs/acp-agents-notes/auggie.md § Proprietary render directive
// in message text. Vendor report: pending (ride the TKT-66153 channel).
import type { ProseRewriter } from "./index";

const OPEN_NAME = "<augment_code_snippet";
const CLOSE_TAG = "</augment_code_snippet>";
/** A real open tag + fence line fits in a fraction of this; an unresolved
 * hold this long is some other text that merely shares a prefix. */
const HOLD_CAP = 1024;

/** Attribute value off the open tag. The capture excludes quotes, so the
 * value can't break out of the fence attribute it becomes. */
const attr = (tag: string, name: string): string | null =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

type Step =
  | { kind: "emit"; text: string; consumed: number }
  | { kind: "hold" }
  | { kind: "raw" }; // not our shape — emit the "<" and move on

export function createAugmentSnippetRewriter(): ProseRewriter {
  let held = "";
  let depth = 0; // open wrappers whose close tag is still owed

  /** Decides what `rest` (buffer suffix starting at "<") is. */
  const classify = (rest: string): Step => {
    // -- closing tag: owed one → swallow it; unpaired → raw prose --
    if (rest.length < CLOSE_TAG.length) {
      if (CLOSE_TAG.startsWith(rest)) return { kind: "hold" };
    } else if (rest.startsWith(CLOSE_TAG)) {
      if (depth === 0) return { kind: "raw" };
      depth--;
      return { kind: "emit", text: "", consumed: CLOSE_TAG.length };
    }
    // -- opening tag --
    if (rest.length <= OPEN_NAME.length) {
      return OPEN_NAME.startsWith(rest) ? { kind: "hold" } : { kind: "raw" };
    }
    if (!rest.startsWith(OPEN_NAME) || !/[\s>]/.test(rest[OPEN_NAME.length]!)) {
      return { kind: "raw" };
    }
    const gt = rest.indexOf(">");
    if (gt === -1) return { kind: "hold" }; // tag still streaming in
    const tag = rest.slice(0, gt + 1);
    // one newline, then the fence line the wrapper annotates
    let at = gt + 1;
    if (rest[at] === "\r") at++;
    if (rest[at] === undefined) return { kind: "hold" };
    if (rest[at] !== "\n") return { kind: "emit", text: tag, consumed: tag.length }; // not the shape
    at++;
    const lineEnd = rest.indexOf("\n", at);
    const line = lineEnd === -1 ? rest.slice(at) : rest.slice(at, lineEnd);
    const fence = /^(`{3,})(.*)$/.exec(line.trimEnd());
    if (lineEnd === -1) {
      // fence line still streaming — keep holding while it could be one
      return fence !== null || "```".startsWith(line) ? { kind: "hold" } : { kind: "emit", text: tag, consumed: tag.length };
    }
    if (fence === null) return { kind: "emit", text: tag, consumed: tag.length };
    // full shape — drop the wrapper, hoist path/mode onto the fence
    const path = attr(tag, "path");
    const info = fence[2]!.trim();
    const hoisted =
      path !== null && info !== ""
        ? `${info} path="${path}"${attr(tag, "mode")?.toUpperCase() === "EXCERPT" ? " excerpt" : ""}`
        : info;
    depth++;
    return { kind: "emit", text: `${fence[1]!}${hoisted}\n`, consumed: lineEnd + 1 };
  };

  return {
    push(text: string): string {
      const buf = held + text;
      held = "";
      let out = "";
      let i = 0;
      while (i < buf.length) {
        const lt = buf.indexOf("<", i);
        if (lt === -1) {
          out += buf.slice(i);
          break;
        }
        out += buf.slice(i, lt);
        const rest = buf.slice(lt);
        const step = classify(rest);
        if (step.kind === "hold") {
          if (rest.length > HOLD_CAP) return out + rest; // pathology valve
          held = rest;
          break;
        }
        if (step.kind === "raw") {
          out += "<";
          i = lt + 1;
        } else {
          out += step.text;
          i = lt + step.consumed;
        }
      }
      return out;
    },
    flush(): string {
      const tail = held;
      held = "";
      return tail;
    },
  };
}
