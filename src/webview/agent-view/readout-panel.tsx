// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// One read-out chip and its panel — the shell both of the read-out strip's
// chips share. A Radix Popover (dismissal, Escape, focus and placement are
// Radix's), anchored to the whole strip rather than to its chip, so every
// panel grows up from the strip over the chat at the strip's full width: one
// panel shape, whichever chip opened it. Open-state is the strip's — the
// chips are siblings and only one panel is ever open.
import type { ReactNode, RefObject } from "react";
import { Icon } from "../shared/icon";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function ReadoutPanel(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The strip — every panel's anchor. */
  anchor: RefObject<HTMLDivElement | null>;
  /** The chip — the panel's trigger. */
  chip: ReactNode;
  /** Names the panel apart from its siblings (ui-gate, styling). */
  className: string;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger asChild>{props.chip}</PopoverTrigger>
      {/* Radix types the ref non-null (React 18's RefObject); the strip is
          mounted before any chip inside it can open a panel. */}
      <PopoverAnchor virtualRef={props.anchor as RefObject<HTMLDivElement>} />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={0}
        className={`overlay-panel ${props.className} w-[var(--radix-popover-trigger-width)] rounded-none border-x-0 bg-[var(--pb-panel)] p-0 shadow-none`}
        // Focus returns to the chip only when it has nowhere else to be. On
        // a sibling-chip click the sibling's open can land before this
        // panel sees the outside click, so Radix would hand focus back to
        // this chip — which reads as focus-outside to the sibling's fresh
        // panel and closes it.
        onCloseAutoFocus={(e) => {
          if (document.activeElement !== null && document.activeElement !== document.body) e.preventDefault();
        }}
      >
        <div className="head">
          <span className="title">{props.title}</span>
          <button className="close" title="Close" onClick={() => props.onOpenChange(false)}>
            <Icon name="close" />
          </button>
        </div>
        <div className="items">{props.children}</div>
      </PopoverContent>
    </Popover>
  );
}
