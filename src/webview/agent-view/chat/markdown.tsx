// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The ONE Streamdown configuration — every piece of agent-authored prose
// (message and thought chunks only; tool calls, diffs, and plans never
// enter the markdown parser) renders through here, so rendering policy has
// exactly one home.
import { createContext, useContext, type MouseEvent } from "react";
import { defaultRehypePlugins, Streamdown, type ThemeInput } from "streamdown";
import type { Plugin, PluggableList } from "unified";
import { Icon } from "../../shared/icon";
import { driveHrefAsFileUrl, isLocalHref } from "../../../shared/local-link";
import { cjkPlugin } from "../cjk-plugin";
import { shikiPlugin, SHIKI_THEMES, SUPPORTED } from "../highlighter";
import { katexPlugin } from "../math-plugin";
import { MermaidBlock } from "../mermaid-block";
import { ChatCodeBlock } from "./code-block";

/** Streamdown's control icons re-pointed at Codicons — one icon set across
 * the whole extension (no second icon set), same
 * rule as swapping Lucide out of shadcn components. */
const SD_ICONS = {
  CheckIcon: () => <Icon name="check" />,
  CopyIcon: () => <Icon name="copy" />,
  DownloadIcon: () => <Icon name="desktop-download" />,
  ExternalLinkIcon: () => <Icon name="link-external" />,
  Loader2Icon: () => <Icon name="loading" spin />,
  Maximize2Icon: () => <Icon name="screen-full" />,
  RotateCcwIcon: () => <Icon name="refresh" />,
  XIcon: () => <Icon name="close" />,
  ZoomInIcon: () => <Icon name="zoom-in" />,
  ZoomOutIcon: () => <Icon name="zoom-out" />,
};

/** Module-level so Streamdown's memo isn't broken by a fresh array per
 * render (same rule as SD_ICONS). ChatCodeBlock takes every highlighted
 * language because custom renderers are the only path Streamdown hands the
 * fence's meta to — it renders the built-in block unless the fence carries
 * `path=` attributes (code-block.tsx). */
const RENDERERS = [
  { language: "mermaid", component: MermaidBlock },
  { language: [...SUPPORTED], component: ChatCodeBlock },
];

type HastNode = { tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

/** A Windows drive path in a link is taken by every URL reader for a `C:`
 * scheme — sanitize would strip it — so it is carried as its file: URI. */
function driveLinks() {
  const visit = (node: HastNode): void => {
    const href = node.tagName === "a" ? node.properties?.href : undefined;
    const url = typeof href === "string" ? driveHrefAsFileUrl(href) : null;
    if (url !== null) node.properties!.href = url;
    node.children?.forEach(visit);
  };
  return visit;
}

const [sanitize, schema] = defaultRehypePlugins.sanitize as [Plugin, { protocols?: Record<string, string[]> }];

/** Streamdown's own steps less `harden`: as Streamdown configures it, it
 * allows every prefix and protocol, so it guards nothing sanitize doesn't —
 * yet it resolves each relative link against a placeholder origin, turning
 * `../ui/a.ts` into `/ui/a.ts` and dropping a bare `a.ts`. Sanitize
 * stays the guard (no script, no handler, no scheme off its list), its list
 * widened by `file` — a local link is opened by the host, never the page. */
const REHYPE: PluggableList = [
  defaultRehypePlugins.raw!,
  driveLinks,
  [sanitize, { ...schema, protocols: { ...schema.protocols, href: [...(schema.protocols?.href ?? []), "file"] } }],
];

/** Opens a local link (a path, a file: URI) for the transcript it sits in —
 * the host resolves it against where that agent works. Null outside one. */
export const LocalLinks = createContext<((href: string) => void) | null>(null);

export function AgentMarkdown({ text, live }: { text: string; live: boolean }) {
  const openLocal = useContext(LocalLinks);
  // VS Code opens a webview's web links itself and drops every other
  // scheme silently — a local link is taken here and handed to the host.
  // The href is read as written, never as the page resolved it.
  const onClick = (e: MouseEvent) => {
    const href = (e.target as Element).closest("a[href]")?.getAttribute("href");
    if (openLocal === null || href == null || !isLocalHref(href)) return;
    e.preventDefault();
    openLocal(href);
  };
  return (
    <div className="contents" onClick={onClick}>
    <Streamdown
      // Always block mode ("streaming"), even after the turn ends: static
      // mode renders ONE wrapper whose dir="auto" is detected over the
      // whole message — a first Latin character would flip a following
      // Arabic paragraph to LTR the moment the stream completed. Per-block
      // parsing keeps per-block direction; the caret alone tracks live-ness.
      mode="streaming"
      isAnimating={live}
      caret="block"
      // per-block first-strong-character direction detection — Arabic (and
      // any RTL) prose renders right-to-left without a global setting
      dir="auto"
      shikiTheme={SHIKI_THEMES as unknown as [ThemeInput, ThemeInput]}
      plugins={{
        code: shikiPlugin,
        math: katexPlugin,
        cjk: cjkPlugin,
        // ```mermaid renders through the vendored copy of Streamdown's own
        // block (mermaid-block.tsx: pan/zoom, fullscreen, copy, download —
        // plus the Open-in-editor action upstream has no slot for)
        renderers: RENDERERS,
      }}
      // controls default on — table copy-as-CSV/Markdown is load-bearing for
      // the accountants/operations half of the audience
      icons={SD_ICONS}
      lineNumbers={false}
      rehypePlugins={REHYPE}
      // VS Code's workbench already interposes its own trusted-domain
      // prompt on every external link a webview opens — Streamdown's
      // link-safety modal would double-gate the same click (and renders
      // links as <button>, breaking anchor semantics/styling).
      linkSafety={{ enabled: false }}
    >
      {text}
    </Streamdown>
    </div>
  );
}
