// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Streamdown's code-highlighter plugin, backed by Shiki's JavaScript regex
// engine — the CSP decision deferred earlier, made here: the JS engine needs no
// `wasm-unsafe-eval`, so the webview CSP stays exactly as authored
// (webview-host.ts). The grammar set is curated, not bundled-everything:
// each grammar is real bundle weight, and an unknown language degrades
// honestly to plain text rather than a wrong guess.
import {
  createHighlighterCore,
  type HighlighterCore,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { CodeHighlighterPlugin } from "streamdown";

import langBash from "@shikijs/langs/bash";
import langCss from "@shikijs/langs/css";
import langDiff from "@shikijs/langs/diff";
import langGo from "@shikijs/langs/go";
import langHtml from "@shikijs/langs/html";
import langJavascript from "@shikijs/langs/javascript";
import langJson from "@shikijs/langs/json";
import langMarkdown from "@shikijs/langs/markdown";
import langPython from "@shikijs/langs/python";
import langRust from "@shikijs/langs/rust";
import langTsx from "@shikijs/langs/tsx";
import langTypescript from "@shikijs/langs/typescript";
import langYaml from "@shikijs/langs/yaml";
import themeDark from "@shikijs/themes/dark-plus";
import themeLight from "@shikijs/themes/light-plus";

const LANGS = [
  langBash,
  langCss,
  langDiff,
  langGo,
  langHtml,
  langJavascript,
  langJson,
  langMarkdown,
  langPython,
  langRust,
  langTsx,
  langTypescript,
  langYaml,
];

/** Every name + alias the loaded grammars answer to (sh, py, ts, …).
 * Exported for the code-block custom renderer's language list — the two
 * must cover the same set or a fence would highlight but lose its
 * path/excerpt attributes (or vice versa). */
export const SUPPORTED = new Set(
  LANGS.flatMap((l) => l.flatMap((g) => [g.name, ...(g.aliases ?? [])])),
);

/** [light, dark] — matching VS Code's own default Light+/Dark+ pair, so
 * highlighted code reads native next to the editor. */
export const SHIKI_THEMES = [themeLight, themeDark] as const;

let core: HighlighterCore | null = null;
let loading: Promise<void> | null = null;

function ensureCore(): Promise<void> {
  loading ??= createHighlighterCore({
    langs: LANGS,
    themes: [...SHIKI_THEMES],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).then((h) => {
    core = h;
  });
  return loading;
}

function tokensFor(h: HighlighterCore, code: string, language: string) {
  return h.codeToTokens(code, {
    lang: language as never, // guarded by supportsLanguage below
    themes: { light: themeLight, dark: themeDark },
  });
}

/** Streamdown calls `highlight` per code block: sync tokens once the core is
 * ready, `null` + callback during the initial async load. */
export const shikiPlugin: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getSupportedLanguages: () => [...SUPPORTED] as never,
  supportsLanguage: (language) => SUPPORTED.has(language),
  getThemes: () => [themeLight, themeDark],
  highlight: ({ code, language }, callback) => {
    if (!SUPPORTED.has(language)) return { tokens: code.split("\n").map((l) => [{ content: l }]) };
    if (core !== null) return tokensFor(core, code, language);
    void ensureCore().then(() => {
      if (core !== null && callback !== undefined) callback(tokensFor(core, code, language));
    });
    return null;
  },
};
