// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Wheel-zoom and drag-pan over what it holds, with the zoom in/out/reset
// rail — one for every surface that shows a diagram: a chat's diagram and
// its fullscreen view, and the diagram opened in the editor area.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icon";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

const PANZOOM_BTN =
  "flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

/** Wheel-zoom + drag-pan wrapper with the zoom in/out/reset rail (vendored
 * from Streamdown's pan-zoom container). */
export function PanZoom({ children, fullscreen = false }: { children: ReactNode; fullscreen?: boolean }) {
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
