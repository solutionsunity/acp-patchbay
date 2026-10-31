// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Wheel-zoom and drag-pan over what it holds, with the zoom in/out/reset
// rail — one for every surface that shows a diagram: a chat's diagram and
// its fullscreen view, and the diagram opened in the editor area.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icon";

/** Where a diagram is shown — each zooms its own way. In chat (inline and
 * fullscreen) in even steps around the centre, eased; the editor-area page,
 * there to read a large diagram, from a fifth to ten times in ×1.1 steps
 * around the pointer, fitted to the window, and a double-click goes back to
 * the start. */
type PanZoomSurface = "inline" | "fullscreen" | "page";

interface Zoom {
  min: number;
  max: number;
  /** The next scale, one step in (+1) or out (−1). */
  step: (scale: number, dir: 1 | -1) => number;
  /** Zoom keeps the point under the pointer (the rail: the centre) fixed. */
  anchored: boolean;
}

const CENTRED: Zoom = { min: 0.5, max: 3, step: (z, dir) => z + dir * 0.1, anchored: false };
const ZOOMS: Record<PanZoomSurface, Zoom> = {
  inline: CENTRED,
  fullscreen: CENTRED,
  page: { min: 0.2, max: 10, step: (z, dir) => (dir > 0 ? z * 1.1 : z / 1.1), anchored: true },
};

interface View {
  scale: number;
  x: number;
  y: number;
}

const START: View = { scale: 1, x: 0, y: 0 };

const PANZOOM_BTN =
  "flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

/** Wheel-zoom + drag-pan wrapper with the zoom in/out/reset rail (vendored
 * from Streamdown's pan-zoom container). */
export function PanZoom({ children, surface = "inline" }: { children: ReactNode; surface?: PanZoomSurface }) {
  const zoom = ZOOMS[surface];
  const [view, setView] = useState<View>(START);
  const [dragging, setDragging] = useState(false);
  const outerRef = useRef<HTMLDivElement>(null);
  const start = useRef({ x: 0, y: 0 });

  /** One step in or out, about a point of the surface (client coordinates;
   * the centre when none is given). */
  const stepAt = useCallback(
    (dir: 1 | -1, at?: { x: number; y: number }) => {
      setView((v) => {
        const scale = Math.min(zoom.max, Math.max(zoom.min, zoom.step(v.scale, dir)));
        const box = outerRef.current?.getBoundingClientRect();
        if (!zoom.anchored || box === undefined) return { ...v, scale };
        const px = (at?.x ?? box.left + box.width / 2) - box.left;
        const py = (at?.y ?? box.top + box.height / 2) - box.top;
        return { scale, x: px - (px - v.x) * (scale / v.scale), y: py - (py - v.y) * (scale / v.scale) };
      });
    },
    [zoom],
  );

  useEffect(() => {
    const el = outerRef.current;
    if (el === null) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stepAt(e.deltaY < 0 ? 1 : -1, { x: e.clientX, y: e.clientY });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stepAt]);

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
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    },
    [dragging],
  );
  const endDrag = useCallback(() => setDragging(false), []);
  const reset = () => setView(START);
  const chat = surface !== "page";

  return (
    <div
      className={`relative flex flex-col overflow-hidden ${surface === "inline" ? "min-h-28 w-full" : "h-full w-full"}`}
      ref={outerRef}
      style={{ cursor: dragging ? "grabbing" : "grab" }}
      onDoubleClick={chat ? undefined : (e) => (e.target as Element).closest("button") === null && reset()}
    >
      <div
        className={`absolute z-10 flex flex-col gap-1 rounded-md border border-border bg-background/80 p-1 ${surface === "inline" ? "bottom-2 left-2" : "bottom-4 left-4"}`}
      >
        <button
          type="button"
          className={PANZOOM_BTN}
          disabled={view.scale >= zoom.max}
          onClick={() => stepAt(1)}
          title="Zoom in"
        >
          <Icon name="zoom-in" />
        </button>
        <button
          type="button"
          className={PANZOOM_BTN}
          disabled={view.scale <= zoom.min}
          onClick={() => stepAt(-1)}
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
        className={`flex flex-1 items-center justify-center ${chat ? "transition-transform duration-150 ease-out" : "min-h-0"}`}
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transformOrigin: zoom.anchored ? "0 0" : "center center",
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
