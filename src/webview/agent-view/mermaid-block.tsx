// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// ```mermaid blocks — source-copied from Streamdown 2.5.0's built-in
// mermaid block (MIT, Vercel) and adapted, the same house pattern as the
// shadcn components (source-copied, never a black-box dep).
// Vendored because upstream's actions row is hardcoded (download / copy /
// fullscreen) with no extension slot, and this block needs one more action:
// "Open in editor" — the fullscreen portal maxes out at the sidebar
// column's width, while an editor-area panel can actually let a big
// diagram breathe. The `data-streamdown` attributes are kept so the shared
// chrome CSS (theme.css) and the ui-gate selectors apply unchanged.
// Differences from upstream, all deliberate:
// - engine is patchbay's lazy loader (mermaid-loader.ts), never a bundled
//   mermaid — and an incomplete fence mid-stream shows the source dimmed
//   (mermaid never sees partial input, so no error can flash while
//   streaming);
// - a parse failure renders the honest fallback: the reason and the
//   source, never mermaid's bomb (suppressErrorRendering in the loader);
// - eager render, not upstream's render-when-scrolled-into-view — the
//   transcript is the only scroller and blocks are static once complete;
// - Codicons via Icon, matching every other control in the extension.
import { useEffect, useId, useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useActions } from "../shared/actions";
import { useCopy } from "../shared/use-copy";
import { Icon } from "../shared/icon";
import { PanZoom } from "../shared/pan-zoom";
import { renderMermaid } from "./mermaid-loader";

const ACTION_BTN =
  "cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground";


function downloadFile(name: string, content: Blob | string, type: string): void {
  const blob = typeof content === "string" ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** SVG → PNG at 5× via canvas (vendored from Streamdown's exporter). */
function svgToPng(svg: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width * 5;
      canvas.height = img.height * 5;
      const ctx = canvas.getContext("2d");
      if (ctx === null) {
        reject(new Error("no 2D canvas context for PNG export"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) =>
        blob !== null ? resolve(blob) : reject(new Error("PNG blob creation failed")),
      );
    };
    img.onerror = () => reject(new Error("SVG failed to load for PNG export"));
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
  });
}

const FORMATS = ["svg", "png", "mmd"] as const;

/** The download menu — SVG / PNG / MMD. */
function DownloadMenu({ source, svg }: { source: string; svg: string }) {
  const pick = async (format: (typeof FORMATS)[number]) => {
    if (format === "mmd") downloadFile("diagram.mmd", source, "text/plain");
    else if (format === "svg") downloadFile("diagram.svg", svg, "image/svg+xml");
    else downloadFile("diagram.png", await svgToPng(svg), "image/png");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={ACTION_BTN} title="Download diagram">
          <Icon name="desktop-download" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {FORMATS.map((format) => (
          <DropdownMenuItem key={format} onSelect={() => void pick(format)}>
            {format.toUpperCase()}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The fullscreen view — it fills the *webview* (the sidebar column),
 * which is why "Open in editor" exists alongside it. */
function FullscreenButton({ svg }: { svg: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className={ACTION_BTN} title="View fullscreen">
          <Icon name="screen-full" />
        </button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="inset-0 flex h-full w-full max-w-none max-h-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none border-0 bg-background/95 p-4"
      >
        <DialogTitle className="sr-only">Diagram</DialogTitle>
        <PanZoom fullscreen>
          {/* mermaid sanitizes its output (securityLevel strict, the default) */}
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        </PanZoom>
      </DialogContent>
    </Dialog>
  );
}

type RenderState =
  | { kind: "pending" }
  | { kind: "ok"; svg: string }
  | { kind: "failed"; reason: string };

export function MermaidBlock({ code, isIncomplete }: { code: string; isIncomplete: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [state, setState] = useState<RenderState>({ kind: "pending" });
  const [attempt, setAttempt] = useState(0); // Retry bumps it
  const send = useActions();
  const { copied, copy } = useCopy();

  useEffect(() => {
    if (isIncomplete) return undefined;
    let alive = true;
    setState({ kind: "pending" });
    renderMermaid(`mmd-${id}-${attempt}`, code).then(
      ({ svg }) => {
        if (alive) setState({ kind: "ok", svg });
      },
      (err: unknown) => {
        if (alive) setState({ kind: "failed", reason: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, [code, isIncomplete, id, attempt]);

  if (isIncomplete || state.kind === "pending") {
    return (
      <div className="my-4 rounded-lg border border-border bg-sidebar p-2">
        <div className="fence-hd flex h-6 items-center gap-1 px-1 font-mono lowercase">
          mermaid <Icon name="loading" spin />
        </div>
        <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">
          {code}
        </pre>
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="my-4 rounded-lg border border-border bg-sidebar p-2">
        <div className="flex items-center gap-1.5 px-1 py-0.5 text-xs text-warn">
          <Icon name="warning" /> diagram didn't parse — source shown ({state.reason.split("\n")[0]})
          <button
            type="button"
            className="cursor-pointer rounded px-1.5 text-[11px] transition-colors hover:bg-muted"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </button>
        </div>
        <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 text-xs">
          {code}
        </pre>
      </div>
    );
  }

  return (
    <div
      className="group relative my-4 flex w-full flex-col gap-2 rounded-xl border border-border bg-sidebar p-2"
      data-streamdown="mermaid-block"
    >
      <div className="flex h-6 items-center">
        <span className="ml-1 font-mono lowercase">mermaid</span>
      </div>
      <div className="pointer-events-none sticky top-2 z-10 -mt-10 flex h-8 items-center justify-end">
        <div
          className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/80 px-1.5 py-1"
          data-streamdown="mermaid-block-actions"
        >
          <DownloadMenu source={code} svg={state.svg} />
          <button type="button" className={ACTION_BTN} onClick={() => copy(code)} title="Copy source">
            <Icon name={copied ? "check" : "copy"} />
          </button>
          <button
            type="button"
            className={ACTION_BTN}
            onClick={() => send({ kind: "openDiagram", svg: state.svg })}
            title="Open in editor — full size"
          >
            <Icon name="link-external" />
          </button>
          <FullscreenButton svg={state.svg} />
        </div>
      </div>
      <div className="rounded-md border border-border bg-background" data-streamdown="mermaid">
        <PanZoom>
          {/* mermaid sanitizes its output (securityLevel strict, the default) */}
          <div dangerouslySetInnerHTML={{ __html: state.svg }} />
        </PanZoom>
      </div>
    </div>
  );
}
