// ```mermaid blocks — source-copied from Streamdown 2.5.0's built-in
// mermaid block (MIT, Vercel) and adapted, the same house pattern as the
// shadcn components (stack.md: source-copied, never a black-box dep).
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
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useActions } from "../shared/actions";
import { useCopy } from "../shared/use-copy";
import { Icon } from "../shared/icon";
import { renderMermaid } from "./mermaid-loader";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

const ACTION_BTN =
  "cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground";
const PANZOOM_BTN =
  "flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

/** Wheel-zoom + drag-pan wrapper with the zoom in/out/reset rail (vendored
 * from Streamdown's pan-zoom container). */
function PanZoom({ children, fullscreen = false }: { children: ReactNode; fullscreen?: boolean }) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const outerRef = useRef<HTMLDivElement>(null);
  const start = useRef({ x: 0, y: 0 });

  const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

  useEffect(() => {
    const el = outerRef.current;
    if (el === null) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale((z) => clamp(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
  }, []);
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const dx = e.clientX - start.current.x;
      const dy = e.clientY - start.current.y;
      start.current = { x: e.clientX, y: e.clientY };
      setPos((p) => ({ x: p.x + dx, y: p.y + dy }));
    },
    [dragging],
  );
  const endDrag = useCallback(() => setDragging(false), []);
  const reset = () => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  };

  return (
    <div
      className={`relative flex flex-col overflow-hidden ${fullscreen ? "h-full w-full" : "min-h-28 w-full"}`}
      ref={outerRef}
      style={{ cursor: dragging ? "grabbing" : "grab" }}
    >
      <div
        className={`absolute z-10 flex flex-col gap-1 rounded-md border border-border bg-background/80 p-1 ${fullscreen ? "bottom-4 left-4" : "bottom-2 left-2"}`}
      >
        <button
          type="button"
          className={PANZOOM_BTN}
          disabled={scale >= MAX_ZOOM}
          onClick={() => setScale((z) => clamp(z + ZOOM_STEP))}
          title="Zoom in"
        >
          <Icon name="zoom-in" />
        </button>
        <button
          type="button"
          className={PANZOOM_BTN}
          disabled={scale <= MIN_ZOOM}
          onClick={() => setScale((z) => clamp(z - ZOOM_STEP))}
          title="Zoom out"
        >
          <Icon name="zoom-out" />
        </button>
        <button type="button" className={PANZOOM_BTN} onClick={reset} title="Reset zoom and pan">
          <Icon name="refresh" />
        </button>
      </div>
      <div
        role="application"
        className="flex flex-1 items-center justify-center transition-transform duration-150 ease-out"
        style={{
          transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
          transformOrigin: "center center",
          touchAction: "none",
          willChange: "transform",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {children}
      </div>
    </div>
  );
}

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

/** Download dropdown — SVG / PNG / MMD, closing on outside click. */
function DownloadMenu({ source, svg }: { source: string; svg: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (ref.current !== null && !e.composedPath().includes(ref.current)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = async (format: "svg" | "png" | "mmd") => {
    setOpen(false);
    if (format === "mmd") downloadFile("diagram.mmd", source, "text/plain");
    else if (format === "svg") downloadFile("diagram.svg", svg, "image/svg+xml");
    else downloadFile("diagram.png", await svgToPng(svg), "image/png");
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={ACTION_BTN}
        onClick={() => setOpen((v) => !v)}
        title="Download diagram"
      >
        <Icon name="desktop-download" />
      </button>
      {open && (
        <div className="absolute top-full right-0 z-10 mt-1 min-w-[120px] overflow-hidden rounded-md border border-border bg-background shadow-lg">
          {(["svg", "png", "mmd"] as const).map((format) => (
            <button
              key={format}
              type="button"
              className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40"
              onClick={() => void pick(format)}
            >
              {format.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Fullscreen portal — Escape closes; note this fills the *webview* (the
 * sidebar column), which is why "Open in editor" exists alongside it. */
function FullscreenButton({ svg }: { svg: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={ACTION_BTN}
        onClick={() => setOpen(true)}
        title="View fullscreen"
      >
        <Icon name="screen-full" />
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex flex-col bg-background/95">
            <button
              type="button"
              className="absolute top-4 right-4 z-10 rounded-md p-2 text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
              onClick={() => setOpen(false)}
              title="Exit fullscreen"
            >
              <Icon name="close" />
            </button>
            <div className="size-full p-4">
              <PanZoom fullscreen>
                {/* mermaid sanitizes its output (securityLevel strict, the default) */}
                <div dangerouslySetInnerHTML={{ __html: svg }} />
              </PanZoom>
            </div>
          </div>,
          document.body,
        )}
    </>
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
