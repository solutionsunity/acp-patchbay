// The ONE Streamdown configuration — every piece of agent-authored prose
// (message and thought chunks only; tool calls, diffs, and plans never
// enter the markdown parser) renders through here, so rendering policy has
// exactly one home.
import { Streamdown, type ThemeInput } from "streamdown";
import { Icon } from "../../shared/icon";
import { cjkPlugin } from "../cjk-plugin";
import { shikiPlugin, SHIKI_THEMES, SUPPORTED } from "../highlighter";
import { katexPlugin } from "../math-plugin";
import { MermaidBlock } from "../mermaid-block";
import { ChatCodeBlock } from "./code-block";

/** Streamdown's control icons re-pointed at Codicons — one icon set across
 * the whole extension (ui-rendering-strategy: no second icon set), same
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

export function AgentMarkdown({ text, live }: { text: string; live: boolean }) {
  return (
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
      // VS Code's workbench already interposes its own trusted-domain
      // prompt on every external link a webview opens — Streamdown's
      // link-safety modal would double-gate the same click (and renders
      // links as <button>, breaking anchor semantics/styling).
      linkSafety={{ enabled: false }}
    >
      {text}
    </Streamdown>
  );
}
